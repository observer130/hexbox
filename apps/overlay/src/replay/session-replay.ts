/**
 * **会话闭环回放**：把一局录制喂给**线上同一个 `AugmentController`**
 * （不需要游戏 / 窗口 / 管理员；纯 Node，秒级跑完一局）
 *
 * 这一层是"用录制替代每局真机"的关键：控制器里那段代码是**同一条**（触发状态机、
 * 门控边沿、关闭确认、节流、单卡刷新、强度表、标签几何），只是把四样环境依赖
 * 换成会话里的数据：
 *
 * | 线上 | 回放 |
 * |---|---|
 * | `Date.now()` | `createVirtualClock()`（时间只在驱动器推进时走） |
 * | 屏幕流（隐藏窗口 + `getDisplayMedia`） | 帧库（灰度高帧 PNG）+ **线上同一份**识别纯函数 |
 * | 2999 HTTP | `api.jsonl`（按虚拟时间回答"最近一次采样"） |
 * | LCU/2999 认英雄 | `session.json` 里存的那一局身份留档 |
 *
 * ⚠️ **时基（最容易错的一处）**：回放的虚拟时钟**从会话零点（= 录制里第一个事件的时刻）
 * 起步**，不早也不晚。控制器的每一个 `x - startedAt` 字段（`reroll.events` /
 * `recognized` / `apiLog`）都因此落在**与会话产物同一个时基**上 —— 于是
 * `report.json`、`edges.jsonl`、`frames.idx.jsonl`、标签推送时刻可以直接对表。
 *
 * 曾经的写法是 `startMs = firstEvent(api/帧/边沿) - 1000`（想跳过"还没开始"的空档），
 * 后果是**整份报告被平移**：真机会话 `20261012-213155` 的首个 api 采样在会话第 7389ms，
 * 而会话零点（首条 phase 采样）在 0 → 回放的 `startedAt` 落在 6389ms，所有
 * `x - startedAt` 字段集体少了 6389ms：单卡刷新读出来"比面板出现还早 3.5 秒"，
 * 与 golden 对比时 5 次重随**每次都差 6392ms**。空档本身不用跳 —— 它会被如实记进
 * `gaps`（帧库没覆盖到这里），跳过它反而把时基搞错了。
 *
 * ⚠️ 三条诚实边界（回放结论必须连着它们一起读）：
 *   1. **帧库决定保真度**：回放只能看到录下来的帧。录制器存的是"门控当时真正看的
 *      那些帧"（见 `session-recorder.ts`），所以**trace 回放**与真机逐位一致；而
 *      **改采样节奏**的闭环回放只能看到帧库覆盖到的地方（报告里给 `frameGaps`）。
 *   2. **没有原生帧就没有标签**：`session.json` 若没有原生帧（旧会话/只录了门控），
 *      识别会明确报"缺原生帧"，报告里标注 `labelsUnavailable` —— 不假装跑过。
 *   3. **窗口/合成类问题测不了**：置顶、DWM 卡顿、`getDisplayMedia` 帧率、
 *      多显示器 DPI、打包路径 —— 那些仍需一局真机（见 docs/SESSION-REPLAY.md）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createVirtualClock,
  decodePng,
  detectAugmentPanelInRegions,
  detectPanelPresenceInRegions,
  encodeGrayPng,
  gateCanvasWidth,
  grayToBitmap,
  augmentWatchFingerprints,
  parseApiTraceCsv,
  parseFramesIndexJsonl,
  parseSessionMeta,
  parseTimelineCsv,
  reconnectStep,
  rectFromCrop,
  rectToCrop,
  regionsInCrop,
  PANEL_ROW_REGION,
  RECONNECT_PHASE,
  type AugmentCardFingerprint,
  type AugmentNameFingerprint,
  type AugmentSessionApiSample,
  type AugmentSessionFrameRef,
  type AugmentSessionMeta,
  type AugmentSessionPanelEdge,
  type AugmentSessionPhaseSample,
  type Bitmap,
  type PanelCard,
  type PanelDetection,
  type PanelPresence,
  type Rect,
  type VirtualClock,
} from '@hexbox/vision';
import type { ChampionIdentity } from '@hexbox/lcu';

import {
  AugmentController,
  type AugmentCaptureFactoryInput,
  type AugmentCaptureSource,
  type AugmentControllerDeps,
  type AugmentLiveData,
  type AugmentReadingEvent,
} from '../main/augment-controller.ts';
import { bitmapPixels, recognizeOpen, recognizeReroll } from '@hexbox/vision';
import type { AugmentFrame } from '../main/augment-stream.ts';
import type { LabelOverlayMsg } from '../main/label-overlay.ts';

/* ------------------------------------------------------------------ */
/* 重连判定回放（把录到的**相位序列**喂给线上那条纯判定）                */
/* ------------------------------------------------------------------ */

export interface ReconnectTimelineResult {
  /** 录到的相位采样条数（0 = 这份会话判定不了，**不是**"通过"）。 */
  readonly samples: number;
  /** 其中读不到相位的条数（`phase: null`）—— 阶段门会保持上一阶段，故不喂给重连判定。 */
  readonly unreadable: number;
  /** 录到过哪些相位（去重、按首次出现顺序）。 */
  readonly observed: readonly string[];
  /** 进入过几次 `Reconnect`（"记账"次数）。 */
  readonly gaps: number;
  /** 触发了几次恢复动作（真实录制里没有 Reconnect 时必须为 0）。 */
  readonly recoveries: number;
}

/**
 * 把会话里录到的相位序列喂给 `reconnectStep()`（线上同一条纯判定）。
 *
 * 为什么这算"回放"而不是"重新实现"：`reconnectStep` 是**线上同一个纯函数**（有单测），
 * 这里只把**录到的相位**按顺序喂进去（与把真机 2999 采样喂给触发状态机是同一手法）——
 * 判据与状态位（`armed`）都在那个函数里。这段以前住在脚本里，而"判据住在脚本里
 * → 没有 CI 覆盖"正是本仓库踩过的坑（见 `session-golden.ts` 的注释），所以它搬进了
 * 这个有单测的文件。
 *
 * ⚠️ **只报能判定的东西**：恢复那一刻链路是 `failed` 还是"在跑但抓帧不可用"
 * 没有录进会话，而这两者决定的动作**互斥**（重置熔断 / 停掉重建）—— 所以这里
 * 不猜那个状态，只报"该不该恢复、恢复了几次"。动作由 `pollOnce` 在**当时**按
 * 真实状态决定（见 `decideReconnectChainAction`）。
 *
 * `phase: null` 的采样（那次读不到相位）不喂给判定：真实链路里阶段门会保持上一阶段，
 * 重连判定看到的也仍是上一阶段。
 */
export function replayReconnectTimeline(
  phases: readonly AugmentSessionPhaseSample[],
): ReconnectTimelineResult {
  let armed = false;
  let recoveries = 0;
  let unreadable = 0;
  const observed: string[] = [];

  for (const sample of phases) {
    const phase = sample.phase;
    if (phase === null) {
      unreadable++;
      continue;
    }
    if (!observed.includes(phase)) observed.push(phase);
    const step = reconnectStep({
      armed,
      phase,
      // 只关心"该不该恢复"：链路状态不影响这一步（`recover` 与状态无关，动作才相关）
      chainState: 'running',
      championKnown: true,
    });
    armed = step.armed;
    if (step.recover) recoveries++;
  }

  return {
    samples: phases.length,
    unreadable,
    observed,
    gaps: phases.filter((p) => p.phase === RECONNECT_PHASE).length,
    recoveries,
  };
}

/* ------------------------------------------------------------------ */
/* 会话加载                                                            */
/* ------------------------------------------------------------------ */

export interface LoadedSession {
  readonly dir: string;
  readonly meta: AugmentSessionMeta;
  readonly frames: readonly AugmentSessionFrameRef[];
  readonly api: readonly AugmentSessionApiSample[];
  readonly edges: readonly AugmentSessionPanelEdge[];
  readonly phase: readonly AugmentSessionPhaseSample[];
  readonly notes: readonly string[];
}

function readJsonl<T>(path: string, keep: (o: T) => boolean): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try {
      const o = JSON.parse(t) as T;
      if (keep(o)) out.push(o);
    } catch {
      /* 坏行跳过（回放不该因为一行坏 JSON 整体失败） */
    }
  }
  return out;
}

/**
 * 读取会话目录（`session.json` + `frames.idx.jsonl` + `api.jsonl` + `edges.jsonl` + `phase.jsonl`）。
 *
 * 兼容两代产物：`api.jsonl` 缺失时退回 `api-trigger.csv`（录制工具的历史留档），
 * `edges.jsonl` 缺失时退回 `timeline.csv` 的边沿列。
 */
export function loadSession(dir: string): LoadedSession {
  const notes: string[] = [];
  const metaPath = join(dir, 'session.json');
  const meta = parseSessionMeta(
    existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {},
    { region: PANEL_ROW_REGION, altRegion: PANEL_ROW_REGION },
  );
  if (!existsSync(metaPath)) notes.push('缺 session.json → 几何/触发方式按默认值（可能与录制时不同）');

  const idxPath = join(dir, 'frames.idx.jsonl');
  const parsed = existsSync(idxPath)
    ? parseFramesIndexJsonl(readFileSync(idxPath, 'utf8'))
    : { frames: [], skipped: 0 };
  if (parsed.skipped > 0) notes.push(`frames.idx.jsonl 有 ${parsed.skipped} 行坏数据（已跳过）`);
  if (parsed.frames.length === 0) notes.push('**没有帧库**（frames.idx.jsonl）→ 门控回放会一帧都取不到');

  let api: AugmentSessionApiSample[] = readJsonl<AugmentSessionApiSample>(
    join(dir, 'api.jsonl'),
    (o) => typeof o?.atMs === 'number' && typeof o?.gameTime === 'number',
  );
  if (api.length === 0 && existsSync(join(dir, 'api-trigger.csv'))) {
    api = parseApiTraceCsv(readFileSync(join(dir, 'api-trigger.csv'), 'utf8'));
    notes.push(`api.jsonl 缺失 → 用 api-trigger.csv（${api.length} 条采样）`);
  }

  let edges: AugmentSessionPanelEdge[] = readJsonl<AugmentSessionPanelEdge>(
    join(dir, 'edges.jsonl'),
    (o) => typeof o?.atMs === 'number' && (o?.kind === 'open' || o?.kind === 'close'),
  );
  if (edges.length === 0 && existsSync(join(dir, 'timeline.csv'))) {
    edges = parseTimelineCsv(readFileSync(join(dir, 'timeline.csv'), 'utf8')).edges;
    if (edges.length > 0) notes.push(`edges.jsonl 缺失 → 用 timeline.csv 的边沿（${edges.length} 条）`);
  }

  const phase = readJsonl<AugmentSessionPhaseSample>(join(dir, 'phase.jsonl'), (o) => typeof o?.atMs === 'number');
  api = [...api].sort((a, b) => a.atMs - b.atMs);
  edges = [...edges].sort((a, b) => a.atMs - b.atMs);
  return { dir, meta, frames: parsed.frames, api, edges, phase, notes };
}

/* ------------------------------------------------------------------ */
/* 帧库 → 像素                                                        */
/* ------------------------------------------------------------------ */

/** 帧库读取器（按需解码 + 缓存最近一帧）。 */
export class FrameStore {
  private readonly cache = new Map<string, Bitmap | null>();
  private readonly dir: string;
  private readonly frames: readonly AugmentSessionFrameRef[];

  constructor(dir: string, frames: readonly AugmentSessionFrameRef[]) {
    this.dir = dir;
    this.frames = frames;
  }

  /** 在时刻 `atMs` **应看到**的那一帧（取"不晚于它"的最近一帧）。 */
  frameAt(atMs: number, kind: 'gating' | 'native' = 'gating'): AugmentSessionFrameRef | null {
    let best: AugmentSessionFrameRef | null = null;
    for (const f of this.frames) {
      if (f.kind !== kind) continue;
      if (f.atMs <= atMs && (!best || f.atMs > best.atMs)) best = f;
    }
    return best;
  }

  /**
   * 识别请求（虚拟时刻 `atMs`）**该用的那张原生帧**。
   *
   * ⚠️ 录制里的原生帧是**识别请求现场抓的**（`capture/worker.ts` 的 `readFull()`：
   * 请求 → 抓帧 → 回传），所以它的 `atMs` 天生比请求时刻**晚几十毫秒**。
   * 真机会话 `20261012-213155` 实测：5 次单卡重随的"请求 → 原生帧"=
   * `21106-21050 / 34306-34250 / 35508-35450 / 417951-417950 / 421151-421150` = 1~58ms。
   *
   * 只按"不晚于当前时刻"选帧会得到两种坏结果：
   *   · 明明下一张原生帧就是这次请求的答案，却报"原生帧过期"（本会话 5 次单卡重随全都中）；
   *   · 更糟：退而取**上一张**（刷新前那一帧）并"识别成功" → 报告读起来全绿，内容却是旧的。
   * 所以先认"请求之后的第一张"（`NATIVE_GRAB_LOOKAHEAD_MS` 内 = 这次请求抓的），
   * 取不到才回退到"不晚于当前时刻"的最近一张（那条路仍受 `MAX_NATIVE_FRAME_AGE_MS` 约束）。
   *
   * 代价（必须连着结论读）：请求之后的第一张**未必**是这次请求抓的 —— 窗口内若正好有
   * 下一次请求的答案，就会借到它。窗口取 500ms（远大于实测的几十毫秒抓帧延迟，又小于
   * 两次请求的最小间隔 400ms 的一倍多），并且**每一次借用都会被记进报告**
   * （`nativeLookahead`），不静默。
   */
  nativeForRecognize(
    atMs: number,
  ): { readonly ref: AugmentSessionFrameRef; readonly lookahead: boolean } | null {
    let future: AugmentSessionFrameRef | null = null;
    for (const f of this.frames) {
      if (f.kind !== 'native' || f.atMs < atMs) continue;
      if (future === null || f.atMs < future.atMs) future = f;
    }
    if (future && future.atMs - atMs <= NATIVE_GRAB_LOOKAHEAD_MS) {
      return { ref: future, lookahead: true };
    }
    const past = this.frameAt(atMs, 'native');
    return past ? { ref: past, lookahead: false } : null;
  }

  /** 帧库在某个时刻之后还有没有帧（诊断"帧库没覆盖到这里"）。 */
  hasAfter(atMs: number): boolean {
    return this.frames.some((f) => f.atMs > atMs);
  }

  /**
   * 解码一帧。
   *
   * ⚠️ 缓存**有上限**（2026-10-12 审查发现）：一局的帧库可达上千帧，
   * 一帧解出来是 `w*h*4` 字节（1/3 画布上约 0.5MB）——不设上限就是**几百 MB** 常驻，
   * 而回放本来可以只留最近几帧（`frameAt` 只会重复投递最近的帧）。
   */
  bitmap(ref: AugmentSessionFrameRef): Bitmap | null {
    const key = `${ref.kind}/${ref.file}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    let bmp: Bitmap | null = null;
    const path = join(this.dir, ref.file);
    try {
      const img = decodePng(new Uint8Array(readFileSync(path)));
      bmp = { width: img.width, height: img.height, data: img.data };
    } catch {
      bmp = null;
    }
    if (this.cache.size >= FRAME_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, bmp);
    return bmp;
  }
}

/** 解码缓存上限（帧数）。 */
const FRAME_CACHE_MAX = 4;

/**
 * 原生帧允许的最大时效（ms）。
 *
 * 取 `STALE_FRAME_MS`(1500) 同一量级：超过它就说明帧库里没有"这一刻"
 * 的原生帧，拿旧的重认只会得到与录制相反的结论。
 */
const MAX_NATIVE_FRAME_AGE_MS = 1500;

/**
 * 原生帧的"请求 → 抓帧"允许的前瞻窗口（ms）。
 *
 * 录制里的原生帧是识别请求**现场抓的**，所以它比请求时刻晚几十毫秒（见
 * `FrameStore.nativeForRecognize`）。窗口太小 = 每次重随都判"原生帧过期"；
 * 窗口太大 = 可能借到下一次请求的答案。取 500ms：实测抓帧延迟 1~58ms，
 * 而两次识别请求的最小间隔是重随轮询 400ms（借用的每一次都会计数上报）。
 */
const NATIVE_GRAB_LOOKAHEAD_MS = 500;

/* ------------------------------------------------------------------ */
/* 回放用的四个注入实现                                                */
/* ------------------------------------------------------------------ */

export interface ReplayCaptureOptions {
  readonly session: LoadedSession;
  readonly store: FrameStore;
  readonly clock: VirtualClock;
  readonly library: readonly AugmentNameFingerprint[];
  /** 帧投递统计（回放报告要报出去）。 */
  readonly frameStats: {
    frameReuses: number;
    uniqueFrames: number;
    maxFrameAgeMs: number;
    staleNativeFrames: number;
    /** 原生帧取自"请求之后那一张"的次数（录制是现场抓帧，见 `nativeForRecognize`）。 */
    nativeLookahead: number;
  };
  /** 帧库覆盖不到的采样点（"帧库没覆盖到这里"）——诊断用。 */
  readonly onGap?: (atMs: number) => void;
  readonly onRecognizeNote?: (line: string) => void;
}

/**
 * 帧库驱动的截屏源（`AugmentCaptureSource` 的回放实现）。
 *
 * 行为对齐 `capture/worker.ts` 的 tick：
 *   取"当前虚拟时刻应看到的那一帧" → 检测（**线上同一份** `detectAugmentPanelInRegions`，
 *   含主区/备用区两次搜索）→ 未命中时算"面板仍在"信号 → 算每卡指纹 → 回传。
 * 识别（`recognize()`）走 **P0.5 抽出的线上纯函数核心**（`recognizeOpen`/`recognizeReroll`）。
 */
export function createReplayCapture(
  opts: ReplayCaptureOptions,
  deps: AugmentCaptureFactoryInput,
): AugmentCaptureSource {
  const { session, store, clock } = opts;
  const region = session.meta.region;
  const altRegion = session.meta.altRegion;
  const regions: Rect[] = region.w > 0 && region.h > 0 ? [region] : [PANEL_ROW_REGION];
  if (altRegion.w > 0 && altRegion.h > 0) regions.push(altRegion);

  let intervalMs = deps.startIntervalMs;
  let timerId: number | null = null;
  let stopped = false;
  let frames = 0;
  let lastFrameAt = 0;
  let watchRects: readonly Rect[] | null = null;
  let frozenRects: readonly Rect[] | null = null;
  let latestCards: PanelCard[] = [];
  let lastHitCards: PanelCard[] = [];
  let latestGatingBmp: Bitmap | null = null;
  /** 本帧卡片矩形的**帧库基底**版本（与 `latestGatingBmp` 同坐标系）。 */
  let latestFingerprintRects: readonly Rect[] | null = null;
  let latestFingerprints: readonly (AugmentCardFingerprint | null)[] = [];
  let recognizeCount = 0;
  /** 上一次投递的帧时刻（用于把"同一帧被重复投递"记下来）。 */
  let lastDeliveredAtMs = -1;

  const schedule = (): void => {
    if (stopped || intervalMs <= 0 || timerId !== null) return;
    timerId = clock.setTimeout(() => {
      timerId = null;
      tick();
      schedule();
    }, intervalMs);
  };

  const tick = (): void => {
    const now = clock.now();
    const ref = store.frameAt(now);
    if (!ref) {
      opts.onGap?.(now);
      return;
    }
    const bmp = store.bitmap(ref);
    if (!bmp) {
      opts.onGap?.(now);
      return;
    }
    // 帧库可能是裁剪存档 → 检测在**裁剪坐标**下做、卡片矩形换算回画布坐标。
    // ⚠️ 覆盖不全时**跳过这一帧**（`regionsInCrop` 的契约：部分覆盖会让检测范围
    //    比线上小 ⇒ 假阴性；悄悄用缩小后的区域才是真错）。
    const inCrop = regionsInCrop(region, altRegion, ref.crop);
    if (!inCrop) {
      opts.onGap?.(now);
      return;
    }
    // ⚠️ 重复投递（帧库比请求的节奏稀疏）必须**可见**：帧的时刻用 `ref.atMs`
    //    而不是 `clock.now()` —— 否则控制器的 `STALE_FRAME_MS` 过期保护在回放里
    //    永不触发，而"同一帧投递了 6 次"在报告里完全看不出来（审查发现的假绿）。
    const ageMs = now - ref.atMs;
    if (ref.atMs === lastDeliveredAtMs) {
      opts.frameStats.frameReuses++;
    } else {
      opts.frameStats.uniqueFrames++;
    }
    opts.frameStats.maxFrameAgeMs = Math.max(opts.frameStats.maxFrameAgeMs, ageMs);
    lastDeliveredAtMs = ref.atMs;

    const hit = detectAugmentPanelInRegions(bmp, [inCrop.region, inCrop.altRegion]);
    const det: PanelDetection = {
      found: hit.detection.found,
      cards: hit.detection.cards.map((c) => ({ ...c, rect: rectFromCrop(c.rect, ref.crop) })),
      bands: hit.detection.bands,
      reason: hit.detection.reason,
    };
    // "面板仍在"的独立信号：只在卡片判据未命中时算（与线上同一条件）
    let presence: PanelPresence | undefined;
    if (!det.found) {
      const p = detectPanelPresenceInRegions(bmp, [inCrop.region, inCrop.altRegion]).presence;
      presence = { ...p };
    }
    latestCards = det.cards.map((c) => ({ ...c }));
    if (det.found && det.cards.length > 0) lastHitCards = det.cards.map((c) => ({ ...c }));
    latestGatingBmp = bmp;
    latestFingerprintRects = det.cards.map((c) => rectToCrop(c.rect, ref.crop) ?? c.rect);
    // 指纹：`watchRects` 已经是**帧库基底**（见 `recognizeOpen` 的返回值说明），直接用即可
    latestFingerprints = augmentWatchFingerprints(
      bmp,
      watchRects,
      // 指纹判据只看"面板是否在屏 + 卡片数是否与冻结矩形数一致"（在纯函数里）
      { found: det.found, cards: det.cards.map((c) => ({ rect: rectToCrop(c.rect, ref.crop) ?? c.rect })) },
    );

    frames++;
    const sincePrevMs = lastFrameAt === 0 ? 0 : ref.atMs - lastFrameAt;
    lastFrameAt = ref.atMs;
    deps.deps.onFrame({
      found: det.found,
      cards: det.cards,
      bands: det.bands,
      reason: det.reason,
      // 帧的**真实采集时刻**（线上就是这一语义；用 clock.now() 会把"旧帧重放"伪装成新帧）
      atMs: ref.atMs,
      detectMs: 1,
      grabMs: 1,
      width: bmp.width,
      height: bmp.height,
      frames,
      sincePrevMs,
      fingerprints: latestFingerprints,
      ...(presence ? { presence } : {}),
    } satisfies AugmentFrame);
  };

  const recognize = (o: { readonly only?: readonly number[] } = {}): void => {
    const only = o.only && o.only.length > 0 ? o.only : null;
    recognizeCount++;
    const atMs = clock.now();
    // ⚠️ 原生帧的选取见 `nativeForRecognize`：录制里的原生帧是**这次请求现场抓的**，
    //    所以"请求之后的第一张"才是这次识别的答案（只往后看会天天判过期）。
    const pick = store.nativeForRecognize(atMs);
    const ref = pick?.ref ?? null;
    if (ref && pick?.lookahead) opts.frameStats.nativeLookahead++;
    if (!ref) {
      // ⚠️ 明确报"缺原生帧"（而不是假装认不出）：报告里能据此区分
      //    "识别判据问题" 与 "会话没录到原生帧"。
      deps.deps.onRecognized(
        only
          ? {
              ok: false,
              reason: '回放：会话里没有这一时刻的原生帧（单卡重随无法重认）',
              cards: [],
              tookMs: 0,
              origin: 'reroll',
              refreshed: [...only],
              fingerprints: latestFingerprints,
            }
          : {
              ok: false,
              reason: '回放：会话里没有这一时刻的原生帧（整批识别无法重跑）',
              cards: [],
              tookMs: 0,
              origin: 'open',
              fingerprints: latestFingerprints,
            },
      );
      return;
    }
    // ⚠️ 原生帧过期：帧库里最新的那张原生帧比当前虚拟时刻早得太多（例如单卡重随时只有开边沿那一张）。
    //    那时 OCR 出来的是**刷新前**的名字，合并后档位不变 → 报告读起来是
    //    "重随检测到、重认成功、标签没变"，与录制**相反**却全绿。所以宁可报失败。
    const nativeAgeMs = clock.now() - ref.atMs;
    if (nativeAgeMs > MAX_NATIVE_FRAME_AGE_MS) {
      opts.frameStats.staleNativeFrames++;
      const why =
        `回放：原生帧过期（旧 ${nativeAgeMs}ms > ${MAX_NATIVE_FRAME_AGE_MS}ms）` +
        (only ? '（单卡重随无法重认）' : '（整批识别无法重跑）');
      deps.deps.onRecognized(
        only
          ? { ok: false, reason: why, cards: [], tookMs: 0, origin: 'reroll', refreshed: [...only], fingerprints: latestFingerprints }
          : { ok: false, reason: why, cards: [], tookMs: 0, origin: 'open', fingerprints: latestFingerprints },
      );
      return;
    }
    const native = store.bitmap(ref);
    if (!native) {
      deps.deps.onRecognized({
        ok: false,
        reason: '回放：原生帧解码失败',
        cards: [],
        tookMs: 0,
        origin: only ? 'reroll' : 'open',
        ...(only ? { refreshed: [...only] } : {}),
        fingerprints: latestFingerprints,
      });
      return;
    }
    const pixels = bitmapPixels(native);
    if (only) {
      const out = recognizeReroll({
        pixels,
        only,
        latestCards,
        frozenRects,
        library: opts.library,
        fingerprints: latestFingerprints,
        tookMs: 0,
      });
      for (const n of out.notes) opts.onRecognizeNote?.(n);
      deps.deps.onRecognized(out.report);
      return;
    }
    const out = recognizeOpen({
      pixels,
      regions,
      library: opts.library,
      // 卡片矩形是**画布坐标**（原生帧与搜索区都在画布坐标下）
      gatingCards: lastHitCards,
      // 指纹基底则跟**帧库位图**走（裁剪存档时是裁剪坐标）—— 两者必须各自配对，
      // 拿画布矩形去采裁剪位图会静默取错像素（审查发现）。
      fingerprintBasis: { bitmap: latestGatingBmp, rects: latestFingerprintRects },
      frozenRects,
      watchRects,
      fingerprints: latestFingerprints,
      tookMs: 0,
    });
    if (out.note !== null) opts.onRecognizeNote?.(out.note);
    frozenRects = out.frozenRects;
    watchRects = out.watchRects;
    latestFingerprints = out.fingerprints;
    deps.deps.onRecognized(out.report);
  };

  return {
    start: async (): Promise<boolean> => {
      stopped = false;
      // 渲染端在"不取帧"时也会报"门控已就绪"（api 模式等它，不能用"有没有帧"判断）
      deps.deps.onStatus(
        intervalMs <= 0
          ? `门控已就绪（回放，不取帧）：待触发后开始，帧库 ${session.frames.length} 帧`
          : `门控已启动（回放）：每 ${intervalMs}ms 一帧，帧库 ${session.frames.length} 帧`,
      );
      schedule();
      return true;
    },
    setCadence: (ms: number): void => {
      const next = Number.isFinite(ms) && ms > 0 ? Math.max(50, Math.round(ms)) : 0;
      if (next === intervalMs) return;
      intervalMs = next;
      if (timerId !== null) {
        clock.clearTimeout(timerId);
        timerId = null;
      }
      schedule();
    },
    recognize,
    unwatch: (): void => {
      watchRects = null;
      frozenRects = null;
      latestCards = [];
      lastHitCards = [];
      latestGatingBmp = null;
      latestFingerprints = [];
    },
    stop: (): void => {
      stopped = true;
      if (timerId !== null) {
        clock.clearTimeout(timerId);
        timerId = null;
      }
    },
  };
}

/**
 * `api.jsonl` 驱动的 2999 客户端（按虚拟时间回答"最近一次采样"）。
 *
 * 语义与线上一致：**还没进到第一个采样之前返回 null**（线上那一段是真的连不上 2999），
 * 之后的每一刻都返回"不晚于当前时刻的最近一次采样"（真机是 1Hz 轮询，等价于保持上一次读数）。
 */
export function createReplayLiveData(session: LoadedSession, clock: VirtualClock): AugmentLiveData {
  const samples = session.api;
  let lastError: string | null = null;
  const sampleAt = (): AugmentSessionApiSample | null => {
    const now = clock.now();
    let best: AugmentSessionApiSample | null = null;
    for (const s of samples) {
      if (s.atMs <= now && (!best || s.atMs > best.atMs)) best = s;
    }
    return best;
  };
  return {
    async getPlayerState() {
      const s = sampleAt();
      if (!s) {
        lastError = '回放：这一刻还没有 2999 采样';
        return null;
      }
      lastError = null;
      return {
        gameMode: 'KIWI',
        gameTime: s.gameTime,
        level: s.level,
        isDead: s.isDead,
        respawnTimer: s.respawnTimer,
        championName: session.meta.champion?.name ?? '',
        riotId: '',
      };
    },
    async getChampionNames() {
      const c = session.meta.champion;
      if (!c || c.id <= 0) return null;
      return { rawChampionName: '', championName: c.name, myChampionName: c.name };
    },
    get lastError() {
      return lastError;
    },
  };
}

/* ------------------------------------------------------------------ */
/* 驱动器                                                              */
/* ------------------------------------------------------------------ */

export interface ReplayFrameRow {
  readonly atMs: number;
  readonly found: boolean;
  readonly state: string;
  readonly edge: 'open' | 'close' | null;
  readonly cadenceLabel: string;
  readonly intervalMs: number;
  readonly reason: string;
}

export interface ReplayLabelPush {
  readonly atMs: number;
  readonly active: boolean;
  readonly texts: readonly string[];
  readonly subs: readonly string[];
  readonly why: string;
}

export interface ReplayReport {
  readonly dir: string;
  readonly meta: AugmentSessionMeta;
  readonly notes: readonly string[];
  readonly startMs: number;
  readonly endMs: number;
  /**
   * 会话零点 → 第一个留档事件之间的空档（ms）。
   *
   * 它只说明"这一段没有任何留档"（帧库缺口也会落在这一段），**不是**用来挪时基的：
   * 时基永远是会话零点，见文件头。
   */
  readonly leadInMs: number;
  readonly frames: readonly ReplayFrameRow[];
  readonly edges: readonly AugmentSessionPanelEdge[];
  readonly labels: readonly ReplayLabelPush[];
  readonly recognizeCalls: number;
  /** 帧库覆盖不到的采样点数（"这段虚拟时间没帧可看"）。 */
  readonly gaps: number;
  /**
   * 同一帧被**重复投递**的次数（帧库比请求的节奏稀疏时发生）。
   *
   * 为什么要单独报：只看"采样 N 帧"看不出“其实只有 M 帧画面”——
   * 而"帧库决定保真度"正是靠这个数字被检验的。
   */
  readonly frameReuses: number;
  /** 唯一帧数（真正看到了多少幅画面）。 */
  readonly uniqueFrames: number;
  /** 投递过的帧里最大的"当前时刻 - 帧采集时刻"（ms）。 */
  readonly maxFrameAgeMs: number;
  /** 因"原生帧过期"而拒绝重跑识别的次数。 */
  readonly staleNativeFrames: number;
  /** 原生帧取自"请求之后那一张"（= 录制那次请求现场抓的帧）的次数。 */
  readonly nativeLookahead: number;
  /** 驱动器是否因上限提前收工（true = 报告尾部可能少一段，结论要打折）。 */
  readonly truncated: boolean;
  readonly snapshot: ReturnType<AugmentController['snapshot']>;
  readonly elapsedRealMs: number;
  /** 回放里"识别拿不到原生帧"的次数（>0 说明会话没录原生帧）。 */
  readonly labelsUnavailable: number;
}

export interface RunReplayOptions {
  readonly session: LoadedSession;
  readonly library: readonly AugmentNameFingerprint[];
  /**
   * 虚拟时钟的起点在**会话时基**上的取值。
   *
   * 默认 `0`（= 会话零点）。合成会话（不是从真机录出来的、零点本身没有意义）才需要显式给 ——
   * 那时给的是"切片自己的零点"，好让状态机与切片里的帧/采样对齐。
   * ⚠️ 真机会话**不要**动它：控制器把 `startedAt` 当成 `x - startedAt` 的基准，挪起点
   *    等于把报告整体平移（见文件头"时基"）。
   */
  readonly startMs?: number;
  /** 跑到哪（默认 = 最后一个事件 + 5s）。 */
  readonly endMs?: number;
  readonly dataDir?: string;
  /** 预加载的图鉴/英雄详情（回放测试可注入合成数据，不依赖 `data/`）。 */
  readonly loadData?: AugmentControllerDeps['loadData'];
  readonly log?: (line: string) => void;
}

/**
 * 跑一次闭环回放：**线上的 `AugmentController`** + 虚拟时钟 + 帧库 + 录下来的 2999。
 */
export async function runReplaySession(options: RunReplayOptions): Promise<ReplayReport> {
  const { session } = options;
  const realSetImmediate = setImmediate;
  const clock = createVirtualClock(options.startMs ?? 0);
  const uninstall = clock.install();
  const store = new FrameStore(session.dir, session.frames);

  const frames: ReplayFrameRow[] = [];
  const edges: AugmentSessionPanelEdge[] = [];
  const labels: ReplayLabelPush[] = [];
  let gaps = 0;
  let recognizeCalls = 0;
  let labelsUnavailable = 0;
  /** 帧投递统计（重复投递 / 最大帧龄 / 过期原生帧）—— 审查发现的假绿靠它们才能被看见。 */
  const frameStats = {
    frameReuses: 0,
    uniqueFrames: 0,
    maxFrameAgeMs: 0,
    staleNativeFrames: 0,
    nativeLookahead: 0,
  };

  // ⚠️ `endMs` 只看链路自己的时间线（api / 帧 / 边沿）：phase 采样会一直写到链路收工之后，
  //    拿它定终点会让回放多跑一大段"链路已经不在"的虚拟时间。
  const lastEvent = Math.max(
    session.api.at(-1)?.atMs ?? 0,
    session.frames.at(-1)?.atMs ?? 0,
    session.edges.at(-1)?.atMs ?? 0,
  );
  const firstEvent = Math.min(
    session.api[0]?.atMs ?? Number.POSITIVE_INFINITY,
    session.frames[0]?.atMs ?? Number.POSITIVE_INFINITY,
    session.edges[0]?.atMs ?? Number.POSITIVE_INFINITY,
    session.phase[0]?.atMs ?? Number.POSITIVE_INFINITY,
  );
  // ⚠️ 默认**就是会话零点**（见文件头"时基"）：控制器据此得到的 `startedAt` 与会话产物
  //    的零点重合，`x - startedAt` 那些字段才和 `edges.jsonl` / `frames.idx.jsonl` 可比。
  //    别为了"跳过空档"把它挪到第一个事件之前 —— 那只会把整份报告平移（真机踩过 6.4s）。
  const startMs = options.startMs ?? 0;
  const endMs = options.endMs ?? lastEvent + 5000;
  /** 会话开始到第一个留档事件之间的空档（真实的"这段没有留档"，别拿它去挪时基）。 */
  const leadInMs = Number.isFinite(firstEvent) ? Math.max(0, firstEvent - startMs) : 0;
  clock.advanceTo(startMs);

  try {
    const controller = new AugmentController({
      dataDir: options.dataDir ?? process.cwd(),
      trigger: session.meta.trigger,
      inMatch: () => true,
      now: () => clock.now(),
      resolveGeometry: async () => ({
        display: replayDisplay(session.meta),
        windowPhysical: session.meta.windowPhysical,
        region: session.meta.region,
        altRegion: session.meta.altRegion,
        targetWidth: session.meta.gating?.width ?? 960,
      }),
      createCapture: (input) =>
        createReplayCapture(
          {
            session,
            store,
            clock,
            frameStats,
            library: options.library,
            onGap: () => {
              gaps++;
            },
            onRecognizeNote: (line) => options.log?.(`[replay] ${line}`),
          },
          input,
        ),
      liveData: () => createReplayLiveData(session, clock),
      // 认英雄：用会话里存的那一局身份（回放没有 LCU/2999；认不出就一张标签都不画）
      loadData: options.loadData,
      resolveIdentity: async (): Promise<ChampionIdentity> => {
        const c = session.meta.champion;
        if (!c || c.id <= 0) {
          return {
            championId: 0,
            source: 'none',
            matchedBy: '',
            championName: '',
            championAlias: '',
            reason: '回放：会话里没有英雄身份留档',
          };
        }
        return {
          championId: c.id,
          source: 'activePlayer-raw',
          matchedBy: `回放留档（${c.source}）`,
          championName: c.name,
          championAlias: '',
          reason: `会话留档：英雄 #${c.id}（录制时来源 ${c.source}）`,
        };
      },
      onReading: (e: AugmentReadingEvent) => {
        frames.push({
          atMs: e.atMs,
          found: e.found,
          state: e.state,
          edge: e.edge,
          cadenceLabel: e.cadenceLabel,
          intervalMs: e.intervalMs,
          reason: e.reason,
        });
        if (e.edge) edges.push({ atMs: e.atMs, kind: e.edge });
      },
      labels: {
        push: (msg: LabelOverlayMsg) => {
          labels.push({
            atMs: clock.now(),
            active: msg.active,
            texts: msg.labels.map((l) => l.text),
            subs: msg.labels.map((l) => l.sub),
            why: msg.diag ?? '',
          });
        },
        clear: (why: string) => {
          labels.push({ atMs: clock.now(), active: false, texts: [], subs: [], why });
        },
      },
      log: (line) => options.log?.(line),
      // ⚠️ 告警也必须走同一个出口：否则它会直接打到 stdout，--json 的输出就不是
      //    合法 JSON 了（机器可读模式必须干净）——这个坑当场踩到过。
      warn: (line) => options.log?.(line),
    });

    const startedAtReal = Date.now();
    let started = false;
    const startPromise = controller.start(1).then((s) => {
      started = true;
      return s;
    });

    // 驱动器：跑一个到期任务 → 让出给事件循环（`await` 链才能推进）→ 再跑下一个。
    //
    // ⚠️ "没有到期任务"**不等于**结束：`controller.start()` 里有一串 await
    //    （读数据、认英雄、算几何），它们的续体要等事件循环推进之后才会排新的定时器。
    //    所以这里先让出一次再判断（旧写法在第一个 tick 就 break，回放出来是
    //    "0 帧采样、0 次识别"，看起来像回放坏了）。
    const maxSteps = 2_000_000;
    let truncated = false;
    for (let i = 0; i < maxSteps; i++) {
      const due = clock.nextDueAt();
      if (due !== null && due > endMs) break;
      if (due === null) {
        if (started && !controller.running) break;
        if (i > 100_000) {
          // ⚠️ 静默提前收工是不允许的：报告会少一段而看不出来（审查发现）。
          truncated = true;
          break;
        }
        await new Promise((r) => realSetImmediate(r));
        continue;
      }
      clock.runNext();
      await new Promise((r) => realSetImmediate(r));
    }
    if (clock.nextDueAt() !== null && (clock.nextDueAt() ?? 0) > endMs) truncated = truncated;
    clock.advanceTo(endMs);
    await new Promise((r) => realSetImmediate(r));
    if (started) await startPromise.catch(() => undefined);
    const snap = controller.snapshot();
    controller.stop('回放结束', { clearLabels: false });
    labelsUnavailable = snap.recognized.filter((r) => !r.ok && /原生帧/.test(r.reason)).length;
    recognizeCalls = snap.recognized.length;
    return {
      dir: session.dir,
      meta: session.meta,
      notes: session.notes,
      startMs,
      endMs,
      leadInMs,
      frames,
      edges,
      labels,
      recognizeCalls,
      gaps,
      frameReuses: frameStats.frameReuses,
      uniqueFrames: frameStats.uniqueFrames,
      maxFrameAgeMs: frameStats.maxFrameAgeMs,
      staleNativeFrames: frameStats.staleNativeFrames,
      nativeLookahead: frameStats.nativeLookahead,
      truncated,
      snapshot: snap,
      elapsedRealMs: Date.now() - startedAtReal,
      labelsUnavailable,
    };
  } finally {
    uninstall();
  }
}

/** 回放用的显示器描述（只是几何数据的容器；champion 标签坐标换算会用到）。 */
function replayDisplay(meta: AugmentSessionMeta): Electron.Display {
  const d = meta.display;
  return {
    id: 1,
    bounds: { x: 0, y: 0, width: d?.width ?? (meta.gating?.width ?? 960) * 3, height: d?.height ?? (meta.gating?.height ?? 540) * 3 },
    workArea: d?.workArea ?? { x: 0, y: 0, width: 1920, height: 1080 },
    size: { width: d?.width ?? 1920, height: d?.height ?? 1080 },
    scaleFactor: d?.scaleFactor ?? 1,
    rotation: 0,
    internal: false,
    label: 'replay',
    // 这些字段在 Electron 的 Display 里存在，回放不需要真实值
    accelerometerSupport: 'unknown',
    colorDepth: 24,
    colorSpace: 'srgb',
    depthPerComponent: 8,
    detected: true,
    displayFrequency: 60,
    monochrome: false,
    touchSupport: 'unknown',
  } as unknown as Electron.Display;
}

/** 会话里存的英雄名册（回放要按 id 取中文名时用）。 */
export function sessionChampionNames(session: LoadedSession): readonly { id: number; name: string }[] {
  const c = session.meta.champion;
  return c && c.id > 0 ? [{ id: c.id, name: c.name }] : [];
}

/** 诊断：把会话几何写成一行（回放报告头部用）。 */
export function describeSessionGeometry(session: LoadedSession): string {
  const g = session.meta.gating;
  return (
    `门控画布 ${g ? `${g.width}x${g.height}` : '未知'}，搜索区 ${JSON.stringify(session.meta.region)}` +
    `，帧库 ${session.frames.length} 帧（门控 ${session.frames.filter((f) => f.kind === 'gating').length}` +
    `/原生 ${session.frames.filter((f) => f.kind === 'native').length}）`
  );
}

/** 供测试/工具构造合成会话（把内存里的位图当成"帧库"）。 */
export function makeMemoryFrameRef(input: {
  seq: number;
  atMs: number;
  kind: 'gating' | 'native';
  file: string;
  bmp: Bitmap;
  crop?: Rect;
}): AugmentSessionFrameRef {
  return {
    seq: input.seq,
    atMs: input.atMs,
    kind: input.kind,
    file: input.file,
    crop: input.crop ?? { x: 0, y: 0, w: 1, h: 1 },
  };
}

/** 供工具把位图写进会话目录前的编码（录制器与测试共用）。 */
export function encodeFrameGray(bmp: Bitmap): Uint8Array {
  const gray = new Uint8Array(bmp.width * bmp.height);
  for (let i = 0, p = 0; p < gray.length; p++, i += 4) {
    gray[p] = Math.round(0.299 * bmp.data[i]! + 0.587 * bmp.data[i + 1]! + 0.114 * bmp.data[i + 2]!);
  }
  return encodeGrayPng({ width: bmp.width, height: bmp.height, gray }, 2);
}

/** 门控画布宽度（回放/录制两侧都用线上那一份口径）。 */
export function replayGateWidth(nativeWidth: number, targetScale = 1 / 3, minWidth = 960): number {
  return gateCanvasWidth(nativeWidth, { targetScale, minWidth });
}

/** 位图 → 灰度位图（录制/测试用；与 `png.ts` 的 `bitmapToGray` 同一口径）。 */
export function toGrayBitmap(bmp: Bitmap): Bitmap {
  const gray = new Uint8Array(bmp.width * bmp.height);
  for (let i = 0, p = 0; p < gray.length; p++, i += 4) {
    gray[p] = Math.round(0.299 * bmp.data[i]! + 0.587 * bmp.data[i + 1]! + 0.114 * bmp.data[i + 2]!);
  }
  return grayToBitmap({ width: bmp.width, height: bmp.height, gray });
}
