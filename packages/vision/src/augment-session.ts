/**
 * 录制会话（session）：数据模型 + **纯解析** + 坐标映射
 *
 * 为什么需要它（2026-10-11，用户提出"用录制 + 回放替代每局真机验证"）：
 * 局内链路的每一个坑都是花一整局真机换来的（见 docs/AUGMENT-PANEL.md），而
 * `pnpm test` 只能覆盖纯函数 —— 判据/阈值/节奏/识别/标签的**组合行为**至今
 * 只能靠"再打一局"。会话把一局对局变成可复算的输入：
 *
 *   frames（门控帧，灰度）+ api（2999 采样）+ edges（门控边沿）
 *   + phase（LCU 阶段/英雄身份）+ meta（几何与配置）
 *
 * 本文件只做**三件事**（都不碰 fs / Electron / 网络，所以 CI 能跑）：
 *   1. 定义会话目录里的数据形状（`AUGMENT_SESSION_VERSION`）；
 *   2. 把文本解析成数据（api-trigger.csv / timeline.csv / frames.idx.jsonl / session.json）；
 *   3. 裁剪帧 ⇄ 门控画布 的归一化坐标映射（帧库为省体积只存搜索区那一块）。
 *
 * ⚠️ 回放必须调**线上同一份**纯函数（`augment-panel.ts` / `augment-ocr.ts` /
 * `augment-reroll.ts` / `augment-trigger.ts` / `augment-tier-label.ts`）——
 * 这个项目踩过"诊断脚本与主流程两份实现"的坑，绝不允许为回放再写一份判据。
 */

import type { PanelCard } from './augment-panel.ts';
import type { Rect } from './types.ts';

/** 会话格式版本（不兼容时回放工具应明确拒绝，而不是猜）。 */
export const AUGMENT_SESSION_VERSION = 1;

/* ------------------------------------------------------------------ */
/* 数据形状                                                            */
/* ------------------------------------------------------------------ */

/** `session.json`：这一局是怎么采的（回放要能复原几何与配置）。 */
export interface AugmentSessionMeta {
  readonly version: number;
  /** 录制开始时刻（ISO）。 */
  readonly startedAt: string;
  /** 触发方式（`api` = 常态零取帧）。 */
  readonly trigger: 'api' | 'pixel';
  /** 门控帧的缩放（相对流原生宽度）与画布尺寸。 */
  readonly gating: {
    readonly targetScale: number;
    readonly minWidth: number;
    readonly width: number;
    readonly height: number;
  } | null;
  /** 帧库里每张图**覆盖**门控画布的哪一块（归一化）。整幅存档时为 {0,0,1,1}。 */
  readonly frameCrop: Rect;
  /** 线上运行时的两个搜索区（帧库是裁剪存档，回放要按它换算回去）。 */
  readonly region: Rect;
  readonly altRegion: Rect;
  /** 游戏窗口物理矩形（算屏幕坐标用；探不到为 null）。 */
  readonly windowPhysical: { x: number; y: number; width: number; height: number } | null;
  readonly display: {
    readonly width: number;
    readonly height: number;
    readonly scaleFactor: number;
    readonly workArea: { x: number; y: number; width: number; height: number };
  } | null;
  /** 文字识别库与强度表的版本（回放要能解释"为什么这次认不出"）。 */
  readonly data: { readonly nameLibraryEntries: number; readonly tierDataDate: string } | null;
  /** 本局英雄（认错英雄 = 整局显示别人的强度表，所以必须存档）。 */
  readonly champion: { readonly id: number; readonly source: string; readonly name: string } | null;
  /** 环境变量快照（`HEXBOX_AUGMENT_*` 全部）—— 回放的可复现性靠它。 */
  readonly env: Readonly<Record<string, string>>;
  /** 自由备注（录制工具写"这一局发生了什么"，方便人工核对）。 */
  readonly notes?: readonly string[];
}

/** 帧库里的一帧。 */
export interface AugmentSessionFrameRef {
  readonly seq: number;
  /** 该帧的采集时刻（与 api/edges 同一时基：录制起点起算的毫秒）。 */
  readonly atMs: number;
  /** `gating` = 门控帧（灰度，裁剪存档）；`native` = 识别用的原生分辨率帧。 */
  readonly kind: 'gating' | 'native';
  /** 相对会话目录的文件名。 */
  readonly file: string;
  /**
   * 该图在**门控画布归一化坐标**下的覆盖区域（只存搜索区时 < 1）。
   *
   * 回放把它当"位图 = 画布的这一块"来用：交给检测器的搜索区要换算进裁剪坐标，
   * 检测出的卡片矩形要换算回画布坐标（否则标签几何全错）。
   */
  readonly crop: Rect;
  /** 录制时**线上**的门控判定（黄金对照：回放结果应与它一致）。 */
  readonly found?: boolean;
  readonly reason?: string;
  /** 录制时检出的卡片（裁剪坐标；黄金对照用）。 */
  readonly cards?: readonly PanelCard[];
}

/** 一次 2999 采样（api 触发状态机的输入 + 当时的判定（黄金对照））。 */
export interface AugmentSessionApiSample {
  /** 录制起点起算的毫秒（`createAugmentTrigger().onSample(sample, nowMs)` 的 `nowMs`）。 */
  readonly atMs: number;
  readonly gameTime: number;
  readonly level: number;
  readonly isDead: boolean;
  readonly respawnTimer: number;
  /** 该采样时**线上**的判定（`api-trigger.csv` 的 capture 列）。 */
  readonly capture?: boolean;
  /** 该采样时**线上**的未选集合（`pending` 列）。 */
  readonly pending?: readonly number[];
  /** 该采样时的判定原因（`reason` 列）。 */
  readonly reason?: string;
}

/** 门控边沿（驱动触发状态机的 `notePanelOpen` / `notePanelClosed`）。 */
export interface AugmentSessionPanelEdge {
  readonly atMs: number;
  readonly kind: 'open' | 'close';
}

/** LCU 阶段 / 选人会话 / 英雄身份的一次采样。 */
export interface AugmentSessionPhaseSample {
  readonly atMs: number;
  readonly phase: string | null;
  readonly pickState?: 'picking' | 'locked' | 'unknown';
  readonly championId?: number;
  readonly championSource?: string;
}

/** 一次"某张卡被刷新"的线上记录（黄金对照）。 */
export interface AugmentSessionRerollRow {
  readonly atMs: number;
  readonly indexes: readonly number[];
  readonly distance: readonly number[];
}

/**
 * 一帧的**像素载荷**（渲染端 → 主进程 → 帧库）。
 *
 * 为什么是"灰度字节"而不是位图/PNG：渲染端没有 `node:zlib`（编码要在主进程做），
 * 而链路的全部判据只看亮度 —— 传 `width*height` 字节就够（1/3 画布上约 0.5MB/帧，
 * 原生帧约 5MB/帧）。**姿态**（`found`/`reason`/`cards`）一起带上，回放时可以逐帧对照。
 */
export interface AugmentSessionFramePayload {
  readonly atMs: number;
  readonly kind: 'gating' | 'native';
  readonly gray: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** 该图覆盖门控画布的哪一块（整幅存档 = {0,0,1,1}）。 */
  readonly crop: Rect;
  /** 录制时线上那一帧的判定（黄金对照）。 */
  readonly found?: boolean;
  readonly reason?: string;
  readonly cards?: readonly PanelCard[];
}

/** 整局会话（内存形态；`frames` 只引用文件名，位图由调用方按需解码）。 */
export interface AugmentSession {
  readonly meta: AugmentSessionMeta;
  readonly frames: readonly AugmentSessionFrameRef[];
  readonly api: readonly AugmentSessionApiSample[];
  readonly edges: readonly AugmentSessionPanelEdge[];
  readonly phase: readonly AugmentSessionPhaseSample[];
  readonly rerolls: readonly AugmentSessionRerollRow[];
}

/* ------------------------------------------------------------------ */
/* CSV / JSONL 解析（纯文本进、数据出）                                 */
/* ------------------------------------------------------------------ */

/**
 * 极简 CSV 解析（支持双引号包裹与 `""` 转义）。
 *
 * 为什么要自己写：会话里的 `reason` 列含**中文逗号与英文逗号**，而
 * `api-trigger.csv` 的历史版本里 `pending` 列（`[0,7,11,15]`）**没有加引号**
 * —— 于是同一份文件里既有"正确转义"的行，也有"多出一个字段"的行。
 * 天真的 `split(',')` 会把那一局数据解析错，而错得看不出来（见 `parseApiTraceCsv`）。
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      // CRLF：吃掉 \r\n 里的 \n
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0]!.trim() === ''));
}

/** 表头名 → 列号（解析按**列名**而不是位置：格式加列不该让解析错位）。 */
function headerIndex(header: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  header.forEach((h, i) => m.set(h.trim(), i));
  return m;
}

function num(v: string | undefined, fallback = 0): number {
  const n = Number((v ?? '').trim());
  return Number.isFinite(n) ? n : fallback;
}

/** 解析 `[0,7,11,15]` / `[]` / `[15]`。 */
export function parsePendingList(raw: string | undefined): number[] {
  const s = (raw ?? '').trim();
  const m = /^\[(.*)\]$/.exec(s);
  if (!m) return [];
  const body = m[1]!.trim();
  if (body === '') return [];
  return body
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x));
}

/**
 * 解析 `api-trigger.csv`（录制工具产物）。
 *
 * ⚠️ 两代格式都必须能吃（真机留档里两代都有）：
 *   · 现在：`pending` 走 `csvField` → `"[0,7,11,15]"`（带引号，标准 CSV）；
 *   · 旧版：`pending` **未转义** → 一行的字段数比表头多；`split(',')` 会把
 *     `[0` / `7` / `11` / `15]` 拆成四列而**不报错**（真机留档
 *     `debug/augment/api-trigger.csv` 就是这种）。这里把"从 pending 列起、
 *     直到出现 `]`"的字段**合回**一个字段再解析。
 */
export function parseApiTraceCsv(text: string): AugmentSessionApiSample[] {
  const rows = parseCsvRows(text);
  const header = rows[0];
  if (!header) return [];
  const idx = headerIndex(header);
  const at = idx.get('ms') ?? 0;
  const out: AugmentSessionApiSample[] = [];
  for (const raw of rows.slice(1)) {
    const row = [...raw];
    if (row.length <= at) continue;
    // 合回被逗号拆散的 pending（旧版未转义）：标准形态是完整的一格 `[...]`，
    // 否则说明这一格被拆了 —— 一直合到出现 `]` 为止。
    const pendingAt = 6;
    if (row.length > pendingAt && !/^\[[^\]]*\]$/.test((row[pendingAt] ?? '').trim())) {
      const rest = row.splice(pendingAt);
      const joined = rest.join(',');
      const end = joined.indexOf(']');
      row.push(end >= 0 ? joined.slice(0, end + 1) : '');
      row.push(end >= 0 ? joined.slice(end + 1).replace(/^,/, '') : '');
    }
    const name = (n: string): string | undefined => {
      const i = idx.get(n);
      return i === undefined ? undefined : row[i];
    };
    const captureRaw = name('capture');
    out.push({
      atMs: num(row[at]),
      gameTime: num(row[idx.get('gameTime') ?? 1]),
      level: num(row[idx.get('level') ?? 2]),
      isDead: (row[idx.get('isDead') ?? 3] ?? '').trim() === '1',
      respawnTimer: num(row[idx.get('respawnTimer') ?? 4]),
      ...(captureRaw !== undefined && captureRaw.trim() !== ''
        ? { capture: captureRaw.trim() === '1' }
        : {}),
      ...(name('pending') !== undefined ? { pending: parsePendingList(name('pending')) } : {}),
      ...(name('reason') !== undefined ? { reason: name('reason')!.trim() } : {}),
    });
  }
  return out;
}

/** `timeline.csv` 的一行（录制工具的门控时间线；黄金对照用）。 */
export interface AugmentTimelineRow {
  readonly atMs: number;
  readonly found: boolean;
  readonly cards: number;
  readonly state: string;
  readonly edge: 'open' | 'close' | null;
  readonly reason: string;
}

/**
 * 解析 `timeline.csv` → 行 + **门控边沿**。
 *
 * 边沿是触发状态机的输入（`notePanelOpen` / `notePanelClosed`），所以旧留档
 * （只有 timeline、没有独立的 edges.jsonl）也能用来回放。列按**名字**取，
 * 因此录制工具加列（presence / presenceHolds / …）不影响解析。
 */
export function parseTimelineCsv(text: string): {
  rows: AugmentTimelineRow[];
  edges: AugmentSessionPanelEdge[];
} {
  const all = parseCsvRows(text);
  const header = all[0];
  if (!header) return { rows: [], edges: [] };
  const idx = headerIndex(header);
  const at = idx.get('ms') ?? 0;
  const found = idx.get('found');
  const cards = idx.get('cards');
  const state = idx.get('state');
  const edge = idx.get('edgeEvent');
  const reason = idx.get('reason');
  const rows: AugmentTimelineRow[] = [];
  const edges: AugmentSessionPanelEdge[] = [];
  for (const row of all.slice(1)) {
    const e = (edge === undefined ? '' : row[edge] ?? '').trim();
    const atMs = num(row[at]);
    if (e === 'open' || e === 'close') edges.push({ atMs, kind: e });
    rows.push({
      atMs,
      found: (found === undefined ? '0' : row[found] ?? '0').trim() === '1',
      cards: num(cards === undefined ? undefined : row[cards]),
      state: (state === undefined ? '' : row[state] ?? '').trim(),
      edge: e === 'open' || e === 'close' ? e : null,
      reason: (reason === undefined ? '' : row[reason] ?? '').trim(),
    });
  }
  return { rows, edges };
}

/** 解析 `frames.idx.jsonl`（每行一帧）。坏行**跳过并计数**，不整体失败。 */
export function parseFramesIndexJsonl(text: string): {
  frames: AugmentSessionFrameRef[];
  skipped: number;
} {
  const frames: AugmentSessionFrameRef[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try {
      const o = JSON.parse(t) as Partial<AugmentSessionFrameRef>;
      if (
        typeof o.atMs !== 'number' ||
        typeof o.file !== 'string' ||
        (o.kind !== 'gating' && o.kind !== 'native')
      ) {
        skipped++;
        continue;
      }
      frames.push({
        seq: typeof o.seq === 'number' ? o.seq : frames.length,
        atMs: o.atMs,
        kind: o.kind,
        file: o.file,
        crop: o.crop ?? { x: 0, y: 0, w: 1, h: 1 },
        ...(typeof o.found === 'boolean' ? { found: o.found } : {}),
        ...(typeof o.reason === 'string' ? { reason: o.reason } : {}),
        ...(Array.isArray(o.cards) ? { cards: o.cards } : {}),
      });
    } catch {
      skipped++;
    }
  }
  frames.sort((a, b) => a.atMs - b.atMs || a.seq - b.seq);
  return { frames, skipped };
}

/** 解析 `session.json`（容错：缺字段给默认值，**不抛**，回放时按缺失能力降级）。 */
export function parseSessionMeta(json: unknown, fallback: {
  readonly region: Rect;
  readonly altRegion: Rect;
}): AugmentSessionMeta {
  const o = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;
  const g = (o['gating'] ?? null) as Record<string, unknown> | null;
  const d = (o['display'] ?? null) as Record<string, unknown> | null;
  const wa = (d?.['workArea'] ?? null) as Record<string, unknown> | null;
  const numOr = (v: unknown, f: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : f);
  return {
    version: numOr(o['version'], AUGMENT_SESSION_VERSION),
    startedAt: typeof o['startedAt'] === 'string' ? o['startedAt'] : '',
    trigger: o['trigger'] === 'api' ? 'api' : 'pixel',
    gating:
      g && typeof g['width'] === 'number' && typeof g['height'] === 'number'
        ? {
            targetScale: numOr(g['targetScale'], 1 / 3),
            minWidth: numOr(g['minWidth'], 960),
            width: numOr(g['width'], 0),
            height: numOr(g['height'], 0),
          }
        : null,
    frameCrop: isRect(o['frameCrop']) ?? { x: 0, y: 0, w: 1, h: 1 },
    region: isRect(o['region']) ?? fallback.region,
    altRegion: isRect(o['altRegion']) ?? fallback.altRegion,
    windowPhysical: (o['windowPhysical'] ?? null) as AugmentSessionMeta['windowPhysical'],
    display: d
      ? {
          width: numOr(d['width'], 0),
          height: numOr(d['height'], 0),
          scaleFactor: numOr(d['scaleFactor'], 1),
          workArea: {
            x: numOr(wa?.['x'], 0),
            y: numOr(wa?.['y'], 0),
            width: numOr(wa?.['width'], 0),
            height: numOr(wa?.['height'], 0),
          },
        }
      : null,
    data: (o['data'] ?? null) as AugmentSessionMeta['data'],
    champion: (o['champion'] ?? null) as AugmentSessionMeta['champion'],
    env: (typeof o['env'] === 'object' && o['env'] !== null
      ? (o['env'] as Record<string, string>)
      : {}),
    ...(Array.isArray(o['notes']) ? { notes: o['notes'] as string[] } : {}),
  };
}

function isRect(v: unknown): Rect | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const ok = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  return ok(r['x']) && ok(r['y']) && ok(r['w']) && ok(r['h'])
    ? { x: r['x'], y: r['y'], w: r['w'], h: r['h'] }
    : null;
}

/* ------------------------------------------------------------------ */
/* 坐标映射：裁剪帧 ⇄ 门控画布（归一化）                                */
/* ------------------------------------------------------------------ */

/**
 * 画布归一化矩形 → 裁剪图归一化矩形（`null` = 与裁剪区无交集，**不要**硬算）。
 *
 * 帧库只存搜索区那一块（省体积），所以检测器看到的位图坐标与线上不同。
 * 所有几何（卡片矩形、标签、屏幕坐标）都必须在**画布坐标**下算，
 * 因此这里给出双向映射；映射错了的表现是"标签整体偏移"，很难看出来。
 */
export function rectToCrop(rect: Rect, crop: Rect): Rect | null {
  if (crop.w <= 0 || crop.h <= 0) return null;
  const x0 = Math.max(rect.x, crop.x);
  const y0 = Math.max(rect.y, crop.y);
  const x1 = Math.min(rect.x + rect.w, crop.x + crop.w);
  const y1 = Math.min(rect.y + rect.h, crop.y + crop.h);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  return {
    x: (x0 - crop.x) / crop.w,
    y: (y0 - crop.y) / crop.h,
    w: (x1 - x0) / crop.w,
    h: (y1 - y0) / crop.h,
  };
}

/** 裁剪图归一化矩形 → 画布归一化矩形（`rectToCrop` 的逆；不做交集裁剪）。 */
export function rectFromCrop(rect: Rect, crop: Rect): Rect {
  return {
    x: crop.x + rect.x * crop.w,
    y: crop.y + rect.y * crop.h,
    w: rect.w * crop.w,
    h: rect.h * crop.h,
  };
}

/**
 * 线上两个搜索区 → 裁剪图坐标下的搜索区。
 *
 * ⚠️ 要求裁剪区**完整覆盖**两个搜索区（不是"有交集"）：只覆盖一部分时，
 * 检测器能看到的候选范围比线上小 —— 回放会**比真机更悲观**，而且卡片矩形
 * 会从另一个搜索区换算出来（几何整体偏移）。这两种都很难看出来，
 * 所以覆盖不全时**明确返回 null**，由调用方"跳过这一帧并计数"。
 */
export function regionsInCrop(
  region: Rect,
  altRegion: Rect,
  crop: Rect,
): { region: Rect; altRegion: Rect } | null {
  if (!cropContains(crop, region) || !cropContains(crop, altRegion)) return null;
  const a = rectToCrop(region, crop);
  const b = rectToCrop(altRegion, crop);
  if (!a || !b) return null;
  return { region: a, altRegion: b };
}

/** `crop` 是否**完整包含** `rect`（容差 1e-9，吸收浮点误差）。 */
export function cropContains(crop: Rect, rect: Rect): boolean {
  const eps = 1e-9;
  return (
    rect.x >= crop.x - eps &&
    rect.y >= crop.y - eps &&
    rect.x + rect.w <= crop.x + crop.w + eps &&
    rect.y + rect.h <= crop.y + crop.h + eps
  );
}
