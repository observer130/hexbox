/**
 * **会话录制器**（主进程侧；`HEXBOX_AUGMENT_RECORD=1` 才建）
 *
 * 把一局对局录成"可回放的一等输入"，而不是"事后看的一堆图"：
 *
 * ```
 * debug/sessions/<时间>-<英雄>/
 *   session.json      几何 + 配置 + 环境变量快照 + 身份留档（回放要能复原现场）
 *   frames.idx.jsonl  每帧一行：atMs / kind / file / crop（+ 录制当时的判定，黄金对照）
 *   gating/NNNNNN.png **门控真正看到的那些帧**（1/3 画布，灰度）
 *   native/NNNNNN.png 识别用的原生帧（灰度；一次面板 3~5 张）
 *   api.jsonl         2999 采样（触发状态机的输入 + 当时的判定）
 *   edges.jsonl       门控边沿（开/关；驱动 `notePanelOpen/Closed`）
 *   phase.jsonl       LCU 阶段采样（回放/复盘"什么时候进的局"）
 *   report.json       收工时的控制器快照（回放做 golden 比对用）
 * ```
 *
 * ⚠️ 三个刻意的决定（都是为了"回放 = 线上同一份输入"）：
 *   1. **录门控取帧的那一帧，不做定时录屏**：定时录（固定 2~4fps）录到的时刻与门控
 *      实际取帧的时刻对不上，边沿/节流/单卡刷新的**时间关系**就被改了；逐个门控帧落盘
 *      在语义上就是 trace，回放逐位一致。代价是"改采样节奏"的闭环回放只能看到帧库覆盖处
 *      （报告里给缺口数）。
 *   2. **存整幅门控画布**（不裁到搜索区）：卡片矩形/指纹/标签全在画布归一化坐标下，
 *      裁剪存档会给"补贴图坐标换算"这种静默偏移留口子。体积靠**灰度**（1 字节/像素）省。
 *   3. **灰度高帧 PNG**：链路的全部判据只看亮度，灰度在语义上无损（`png.test.ts` 锁了）。
 *
 * ⚠️ 产物在 `debug/`（gitignored）：**含个人信息**（对局画面），只在本机用于回放。
 *    提交进仓库的 fixture 一律是"裁到搜索区的小图"，见 `packages/vision/fixtures/`。
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  encodeGrayPng,
  type AugmentSessionFramePayload,
  type PanelCard,
  type Rect,
} from '@hexbox/vision';

export interface SessionRecorderMeta {
  readonly trigger: 'api' | 'pixel';
  readonly gating: { readonly targetScale: number; readonly minWidth: number; readonly width: number; readonly height: number } | null;
  readonly region: Rect;
  readonly altRegion: Rect;
  readonly windowPhysical: { x: number; y: number; width: number; height: number } | null;
  readonly display: {
    readonly width: number;
    readonly height: number;
    readonly scaleFactor: number;
    readonly workArea: { x: number; y: number; width: number; height: number };
  } | null;
  readonly data: { readonly nameLibraryEntries: number; readonly tierDataDate: string } | null;
  readonly champion: { readonly id: number; readonly source: string; readonly name: string } | null;
  readonly notes?: readonly string[];
}

export interface SessionRecorder {
  readonly dir: string;
  /**
   * 补写/修正会话元数据（重写 `session.json`，已写的帧/采样不受影响）。
   *
   * 为什么需要它：录制器**必须在 `controller.start()` 之前就存在**
   * （否则 pixel 模式的第一帧、api 模式的第一次 2999 采样会丢），
   * 而几何/英雄/数据版本要等它跑起来之后才知道 —— 所以分两步写。
   */
  setMeta(patch: Partial<SessionRecorderMeta>): void;
  /** 一帧的灰度像素落盘（渲染端经 IPC 递过来）。 */
  frame(payload: AugmentSessionFramePayload): void;
  /** 一次 2999 采样（触发状态机的输入 + 当时的判定）。 */
  api(sample: {
    readonly atMs: number;
    readonly gameTime: number;
    readonly level: number;
    readonly isDead: boolean;
    readonly respawnTimer: number;
    readonly capture: boolean;
    readonly pending: readonly number[];
    readonly reason: string;
  }): void;
  /** 门控边沿（开/关）。 */
  edge(e: { readonly atMs: number; readonly kind: 'open' | 'close' }): void;
  /** LCU 阶段采样。 */
  phase(p: {
    readonly atMs: number;
    readonly phase: string | null;
    readonly championId?: number;
    readonly championSource?: string;
  }): void;
  /** 收工：写 `report.json`（控制器快照；回放做 golden 比对）。 */
  close(report: unknown): void;
  /** 已录帧数（诊断/收工汇总）。 */
  readonly frames: { readonly gating: number; readonly native: number };
}

/** 时间戳目录名（本地时区，人读友好；不含任何个人信息）。 */
function stamp(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

export interface CreateRecorderOptions {
  /** `debug/sessions` 所在目录（通常是仓库根的 `debug/sessions`）。 */
  readonly rootDir: string;
  readonly meta: SessionRecorderMeta;
  /** 子目录名后缀（一般给英雄名/ID；给空则只有时间戳）。 */
  readonly suffix?: string;
  /** 记录的环境变量快照（默认取 `HEXBOX_AUGMENT_*`）。 */
  readonly env?: Readonly<Record<string, string>>;
  readonly log?: (line: string) => void;
}

/**
 * 录制元数据里**绝不该出现明文**的环境变量键。
 *
 * `HEXBOX_LCU_CREDENTIALS`（及 `_FILE`）的值是 `<端口>:<token>` ——
 * 录制产物是要发出来排查的（`debug/sessions/<ts>/`），
 * 截图与回放都会被拷来拷去，令牌不能跟着走。
 */
const SENSITIVE_ENV_KEY = /(CREDENTIAL|TOKEN|PASSWORD|SECRET|APIKEY|_KEY$)/i;

/** 敏感值替换成的占位符（保留"这个变量被设过"这一诊断信息）。 */
export const REDACTED_ENV_VALUE = '[redacted]';

/**
 * 会话元数据里的环境变量快照（**纯函数**）。
 *
 * 只收 `HEXBOX_*`（与以前一致），但把可能带凭证的键**脱敏**。
 * 以前这里是 `Object.entries(process.env).filter(k.startsWith('HEXBOX_'))`，
 * 于是开了 `HEXBOX_AUGMENT_RECORD=1` 就会把 LCU 令牌**明文**写进
 * `session.json`（AGENTS.md 明确要求不得提交本地 LCU token）。
 */
export function redactRecorderEnv(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith('HEXBOX_')) continue;
    if (typeof value !== 'string') continue;
    out[key] = SENSITIVE_ENV_KEY.test(key) ? REDACTED_ENV_VALUE : value;
  }
  return out;
}

/**
 * 追加一行文本；**任何失败都只返回错误、绝不抛出**（纯 I/O 助手，可单测）。
 *
 * 为什么必须吞掉：`frame()` 运行在 `ipcMain.on('augment:worker-record')` 回调里，
 * `api()`/`edge()`/`phase()` 运行在 `void poll()` 的 promise 里 —— 那里抛出的
 * 异常分别是**主进程未捕获异常**与**未处理的 rejection**，会直接杀掉悬浮窗
 * （磁盘满、杀软锁文件、目录被删都很常见）。录制是诊断工具，绝不该能杀进程。
 */
export function appendLineSafely(
  path: string,
  line: string,
): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  try {
    appendFileSync(path, line);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 建一个会话目录并开始录制。
 *
 * 目录名只含时间戳与（可选的）英雄名 —— 不写玩家名/ID，避免产物里出现身份信息。
 */
export function createSessionRecorder(options: CreateRecorderOptions): SessionRecorder {
  const now = new Date();
  const name = `${stamp(now)}${options.suffix ? `-${options.suffix}` : ''}`;
  const dir = join(options.rootDir, name);
  mkdirSync(join(dir, 'gating'), { recursive: true });
  mkdirSync(join(dir, 'native'), { recursive: true });

  // ⚠️ 脱敏后再落盘（见 `redactRecorderEnv`）：录制产物会被发出来排查
  const env = redactRecorderEnv(options.env ?? process.env);

  const idxPath = join(dir, 'frames.idx.jsonl');
  const apiPath = join(dir, 'api.jsonl');
  const edgePath = join(dir, 'edges.jsonl');
  const phasePath = join(dir, 'phase.jsonl');
  let seq = 0;
  let gating = 0;
  let native = 0;
  /**
   * 会话起点（**第一个事件**的绝对时钟）。
   *
   * ⚠️ 四类产物（帧 / 2999 / 边沿 / 阶段）必须共用同一个零点：各归一化各的，就会出现
   * "边沿与帧差了几秒"这种查不出来的错位（回放的时间关系全靠它们）。
   */
  let firstAtMs: number | null = null;
  const rel = (atMs: number): number => {
    if (firstAtMs === null) firstAtMs = atMs;
    return Math.max(0, Math.round(atMs - firstAtMs));
  };

  const log = options.log ?? ((line: string): void => console.log(line));
  log(`[record] 🎥 会话录制已开启 → ${dir}`);

  /**
   * 追加一行 JSONL，**失败只告警一次、绝不抛**。
   *
   * 每个文件只告警一次：帧率高，磁盘满/被杀软锁住时否则会瞬间刷满日志。
   */
  const warnedAppend = new Set<string>();
  const append = (path: string, line: string): void => {
    const r = appendLineSafely(path, line);
    if (r.ok || warnedAppend.has(path)) return;
    warnedAppend.add(path);
    log(`[record] ⚠ 追加写盘失败（${path}）：${r.error}（后续同类错误不再重复打印）`);
  };

  /** 当前已落盘的元数据（`setMeta` 在其上打补丁）。 */
  let meta: SessionRecorderMeta = options.meta;
  const writeMeta = (): void => {
    const text =
      JSON.stringify(
        {
          version: 1,
          startedAt: now.toISOString(),
          trigger: meta.trigger,
          gating: meta.gating,
          frameCrop: { x: 0, y: 0, w: 1, h: 1 },
          region: meta.region,
          altRegion: meta.altRegion,
          windowPhysical: meta.windowPhysical,
          display: meta.display,
          data: meta.data,
          champion: meta.champion,
          env,
          notes: [
            '门控帧 = 门控**真正看到**的那些帧（1/3 画布，灰度，整幅）；原生帧 = 识别用的整幅帧',
            '回放：node --experimental-strip-types scripts/replay-session.mts <本目录>',
            ...(meta.notes ?? []),
          ],
        },
        null,
        2,
      ) + '\n';
    writeFileSync(join(dir, 'session.json'), text);
  };
  writeMeta();

  return {
    get dir(): string {
      return dir;
    },
    setMeta(patch: Partial<SessionRecorderMeta>): void {
      meta = { ...meta, ...patch };
      try {
        writeMeta();
      } catch (e) {
        log(`[record] ⚠ 会话元数据写盘失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    /**
     * 一帧落盘。
     *
     * ⚠️ **同步**编码 + 同步写盘，会在主进程占用几十毫秒（实测：
     * 1/3 画布 1529×640 约 6\u20138ms、原生 4587×1920 约 **47ms**）。
     * 为什么接受这个代价：它只发生在面板出现/翻牌时（玩家正在选，不在打），
     * 而改成异步写会引入"退出时尾巴帧还在队列里"的丢数据风险
     * （**真机教训**：一整局产物曾因为退出路径没落盘而全丢）。
     * 实在嫌慢就把原生帧降到 1/2 分辨率并在 `session.json` 里注明 —— 但那会降低回放的 OCR 保真度，不是白拿的。
     */
    frame(payload: AugmentSessionFramePayload): void {
      const t = rel(payload.atMs);
      const padded = String(t).padStart(8, '0');
      const file = `${payload.kind}/${padded}-${seq++}.png`;
      try {
        writeFileSync(
          join(dir, file),
          encodeGrayPng({ width: payload.width, height: payload.height, gray: payload.gray }, 2),
        );
      } catch (e) {
        log(`[record] ⚠ 帧写盘失败（${file}）：${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (payload.kind === 'gating') gating++;
      else native++;
      append(
        idxPath,
        JSON.stringify({
          seq: seq - 1,
          atMs: t,
          kind: payload.kind,
          file,
          crop: payload.crop,
          ...(payload.found !== undefined ? { found: payload.found } : {}),
          ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
          ...(payload.cards !== undefined ? { cards: payload.cards as readonly PanelCard[] } : {}),
        }) + '\n',
      );
    },
    api(sample): void {
      append(apiPath, JSON.stringify({ ...sample, atMs: rel(sample.atMs) }) + '\n');
    },
    edge(e): void {
      append(edgePath, JSON.stringify({ atMs: rel(e.atMs), kind: e.kind }) + '\n');
    },
    phase(p): void {
      append(phasePath, JSON.stringify({ ...p, atMs: rel(p.atMs) }) + '\n');
    },
    close(report): void {
      try {
        writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      } catch {
        /* 收工路径不抛 */
      }
      log(`[record] 🎥 会话录制收工：门控帧 ${gating} / 原生帧 ${native} → ${dir}`);
    },
    get frames() {
      return { gating, native };
    },
  };
}

/** 录制开关（`HEXBOX_AUGMENT_RECORD=1|true|on`）。 */
export function recordEnabled(): boolean {
  const v = (process.env['HEXBOX_AUGMENT_RECORD'] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** 录制目录（`HEXBOX_AUGMENT_RECORD_DIR` 可改；默认仓库根 `debug/sessions`）。 */
export function recordRootDir(repoRoot: string): string {
  const custom = process.env['HEXBOX_AUGMENT_RECORD_DIR'];
  return custom && custom.trim() !== '' ? custom : join(repoRoot, 'debug', 'sessions');
}
