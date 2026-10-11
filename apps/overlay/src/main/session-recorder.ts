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

  const env =
    options.env ??
    Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('HEXBOX_'))) as Record<string, string>;

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
      appendFileSync(
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
      appendFileSync(apiPath, JSON.stringify({ ...sample, atMs: rel(sample.atMs) }) + '\n');
    },
    edge(e): void {
      appendFileSync(edgePath, JSON.stringify({ atMs: rel(e.atMs), kind: e.kind }) + '\n');
    },
    phase(p): void {
      appendFileSync(phasePath, JSON.stringify({ ...p, atMs: rel(p.atMs) }) + '\n');
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
