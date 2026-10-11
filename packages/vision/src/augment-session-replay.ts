/**
 * 会话**回放引擎**（纯函数；不需要游戏、Electron、管理员、网络）
 *
 * 分工（很重要，别在这里再写一份判据）：
 *   · 本文件只做**驱动与记账**：把会话里的（帧判定 / 2999 采样 / 门控边沿）
 *     按虚拟时钟喂给**线上那几份纯函数**，把结果与指标收出来；
 *   · 判据本身一律来自 `augment-panel.ts`（门控 + 两个信号的去抖）、
 *     `augment-cadence.ts`（pixel 节流 / api 间隔）、`augment-trigger.ts`（API 触发记账）。
 *     这个项目踩过"诊断脚本与主流程两份实现"的坑，所以这里**绝不**复制阈值或状态机。
 *
 * 覆盖范围（诚实边界）：
 *   · `replayApiTrigger()`：2999 触发状态机 + 门控边沿 → 开关截屏序列、消耗记账、指标。
 *     这是"某一次海克斯为什么没抓到"的离线答案。
 *   · `replayPanelGating()`：门控帧序列 → 边沿 + 节流档位（**只含 tracker + cadence**）。
 *     单卡刷新（reroll）与其重试记账、识别、强度表、标签**不在这里** ——
 *     那一段由 `scripts/replay-session.mts` 跑**真正的 `AugmentController`**（P1），
 *     否则就是第二份实现。
 */

import { createPanelTracker, type PanelDetection } from './augment-panel.ts';
import type { PanelPresence } from './augment-presence.ts';
import { createCadencePolicy, type CadenceMode } from './augment-cadence.ts';
import {
  AUGMENT_TRIGGER_DEFAULTS,
  createAugmentTrigger,
  type AugmentTriggerConfig,
} from './augment-trigger.ts';
import type {
  AugmentSessionApiSample,
  AugmentSessionPanelEdge,
  AugmentTimelineRow,
} from './augment-session.ts';

/* ------------------------------------------------------------------ */
/* 触发状态机回放（2999 + 门控边沿）                                    */
/* ------------------------------------------------------------------ */

/** 一次事件处理后的状态（`kind` 说明这一步是采样还是边沿）。 */
export interface AugmentTriggerStep {
  readonly atMs: number;
  readonly kind: 'sample' | 'open' | 'close';
  readonly gameTime: number | null;
  readonly level: number | null;
  readonly isDead: boolean | null;
  /** 处理完这一步之后的触发状态。 */
  readonly capture: boolean;
  /** 与上一步相比 `capture`/`pending`/`reason` 是否变化（线上据此下发 IPC）。 */
  readonly changed: boolean;
  readonly pending: readonly number[];
  readonly reason: string;
}

/** 一次"开截屏 → 关截屏"的窗口。 */
export interface AugmentTriggerWindow {
  readonly openAtMs: number;
  /** 到会话结束还开着时为 null。 */
  readonly closeAtMs: number | null;
  readonly openReason: string;
  readonly closeReason: string | null;
  /** 这一窗里发生过几次"面板出现"（门控边沿）。 */
  readonly panelEdges: number;
}

export interface AugmentTriggerMismatch {
  readonly atMs: number;
  readonly recorded: boolean;
  readonly replayed: boolean;
}

export interface AugmentTriggerMetrics {
  readonly samples: number;
  readonly edges: number;
  /** 开截屏的次数（= 截屏窗口数）。 */
  readonly windows: number;
  /** 累计"开着截屏"的时长（ms）——api 模式的成本就看它。 */
  readonly armedMs: number;
  /** 第一次开截屏的时刻（null = 整局没开过）。 */
  readonly firstOpenAtMs: number | null;
  /** 每个 offer 等级**被选完**（门控关边沿消耗）的时刻。 */
  readonly consumed: readonly { readonly level: number; readonly atMs: number }[];
  /**
   * 中途启动时被**按"已选"丢弃**的开局那次（`gameTime > midGameStartSec`）。
   *
   * 它和 `consumed` 必须分开：一个是"真的弹过面板并选完"，一个是"工具起来晚了，
   * 那一次我们没看到"。混在一起会得出"开局那次选完了"的错误结论。
   */
  readonly initDropped: readonly { readonly level: number; readonly atMs: number }[];
  /** 结束时仍未被消耗的 offer 等级 —— **"哪一个海克斯没抓到"的直接答案**。 */
  readonly unconsumed: readonly number[];
  /** 与录制时线上判定不一致的采样（有 golden 时才有意义）。 */
  readonly mismatches: readonly AugmentTriggerMismatch[];
  readonly mismatchCount: number;
  /**
   * 差异的**方向**（这两条比总数有用得多）：
   *   · `missedRecorded` = 录像开着截屏、回放却关着 → **漏开**（会漏掉一整次海克斯，严重）；
   *   · `extraArmed` = 录像关着、回放开着 → 多取了一些帧（只是成本）。
   *
   * ⚠️ 没有门控边沿时这两个数都**不可信**：开/关窗口只能靠 45 秒超时收场，
   * 于是"多开"会系统性偏大（真机上是"关边沿 → 消耗 → 立刻关"）。
   */
  readonly missedRecorded: number;
  readonly extraArmed: number;
}

export interface AugmentTriggerReplay {
  readonly steps: readonly AugmentTriggerStep[];
  readonly windows: readonly AugmentTriggerWindow[];
  readonly metrics: AugmentTriggerMetrics;
}

export interface ReplayApiTriggerInput {
  readonly samples: readonly AugmentSessionApiSample[];
  readonly edges?: readonly AugmentSessionPanelEdge[];
  readonly config?: AugmentTriggerConfig;
  /**
   * 同一时刻既有边沿又有采样时的处理顺序。
   *
   * 默认 `edge-first`：门控帧与 2999 轮询是两条独立异步路径，真机上两侧顺序不定；
   * 边沿先处理时"这一刻面板已经关了"会被算进同一时刻的采样，与线上的
   * "关边沿 → 下一次轮询看到新 pending"一致（真机 `api-trigger.csv` 里
   * `选完（等级 N）` 与该采样同时出现，就是这个形态）。
   */
  readonly order?: 'edge-first' | 'sample-first';
}

/**
 * 回放 2999 触发状态机。
 *
 * @returns 逐事件状态 + 截屏窗口 + 指标（含"与录制判定不一致的采样"）。
 *
 * ⚠️ `metrics.mismatches` 的语义是**行为差异报告**，不是"失败"：
 * 录制是历史版本的状态机跑出来的（真机留档 `api-trigger.csv` 是 2026-10-05 的，
 * 而"升级定向开窗"是 2026-10-12 才加的），所以对旧留档回放**必然**有差异 ——
 * 那正是这个工具的价值（把"改一行会影响哪几局"变成一条可读的清单）。
 */
export function replayApiTrigger(input: ReplayApiTriggerInput): AugmentTriggerReplay {
  const order = input.order ?? 'edge-first';
  const trigger = createAugmentTrigger(input.config ?? {});
  const edges = input.edges ?? [];

  type Event =
    | { readonly atMs: number; readonly seq: number; readonly kind: 'sample'; readonly s: AugmentSessionApiSample }
    | { readonly atMs: number; readonly seq: number; readonly kind: 'open' | 'close' };

  const events: Event[] = [
    ...input.samples.map((s, i) => ({ atMs: s.atMs, seq: i * 2, kind: 'sample' as const, s })),
    ...edges.map((e, i) => ({
      atMs: e.atMs,
      seq: i * 2 + (order === 'edge-first' ? -1 : 1),
      kind: e.kind,
    })),
  ].sort((a, b) => a.atMs - b.atMs || a.seq - b.seq);

  const steps: AugmentTriggerStep[] = [];
  const consumed: { level: number; atMs: number }[] = [];
  const initDropped: { level: number; atMs: number }[] = [];
  const mismatches: AugmentTriggerMismatch[] = [];
  let missedRecorded = 0;
  let extraArmed = 0;
  let reason = '常态：不截屏';

  for (const e of events) {
    const before = [...trigger.pending];
    let changed = false;
    let gameTime: number | null = null;
    let level: number | null = null;
    let isDead: boolean | null = null;

    if (e.kind === 'sample') {
      const d = trigger.onSample(
        {
          gameTime: e.s.gameTime,
          level: e.s.level,
          isDead: e.s.isDead,
          respawnTimer: e.s.respawnTimer,
        },
        e.atMs,
      );
      changed = d.changed;
      reason = d.reason;
      gameTime = e.s.gameTime;
      level = e.s.level;
      isDead = e.s.isDead;
      if (e.s.capture !== undefined && e.s.capture !== trigger.capture) {
        mismatches.push({ atMs: e.atMs, recorded: e.s.capture, replayed: trigger.capture });
        if (e.s.capture) missedRecorded++;
        else extraArmed++;
      }
    } else if (e.kind === 'open') {
      // ⚠️ `notePanelOpen()` 不返回决策（线上也不需要）—— 所以这一步的 reason
      //    沿用上一步：它没有改变任何决策文本，编一个反而会让日志失实。
      trigger.notePanelOpen(e.atMs);
    } else {
      const d = trigger.notePanelClosed(e.atMs);
      changed = d.changed;
      reason = d.reason;
    }

    // ⚠️ `pending` 有**两条**移除路径，必须分开记（混在一起会得出"开局那次被选完了"
    //    这种错误结论）：
    //      · 门控**关边沿** → `notePanelClosed()` 真的消耗一次（`consumed`）；
    //      · 采样第一次看到 `gameTime > midGameStartSec` → 中途启动的初始化把
    //        开局那次按"已选"丢弃（`initDropped`）——它**不是**一次选择。
    for (const lv of before) {
      if (trigger.pending.includes(lv)) continue;
      if (e.kind === 'close') consumed.push({ level: lv, atMs: e.atMs });
      else initDropped.push({ level: lv, atMs: e.atMs });
    }
    steps.push({
      atMs: e.atMs,
      kind: e.kind,
      gameTime,
      level,
      isDead,
      capture: trigger.capture,
      changed,
      pending: trigger.pending,
      reason,
    });
  }

  // 窗口与"开着截屏的时长"从**已经算好的 steps** 反推（不在循环里记账 ——
  // 两处都记必然会漂移，而这类漂移在真机上表现为"日志与指标对不上"）。
  const mutable: {
    openAtMs: number;
    closeAtMs: number | null;
    openReason: string;
    closeReason: string | null;
    panelEdges: number;
  }[] = [];
  let armedMs = 0;
  let firstOpenAtMs: number | null = null;
  /** 当前还开着的那一窗在 `mutable` 里的下标（`null` = 没开着）。 */
  let openIdx: number | null = null;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const prev = steps[i - 1];
    if (prev?.capture === true) armedMs += Math.max(0, s.atMs - prev.atMs);
    if (s.capture) {
      if (openIdx === null) {
        mutable.push({ openAtMs: s.atMs, closeAtMs: null, openReason: s.reason, closeReason: null, panelEdges: 0 });
        openIdx = mutable.length - 1;
        if (firstOpenAtMs === null) firstOpenAtMs = s.atMs;
      } else if (s.kind === 'open') {
        mutable[openIdx]!.panelEdges++;
      }
    } else if (openIdx !== null) {
      const w = mutable[openIdx]!;
      w.closeAtMs = s.atMs;
      w.closeReason = s.reason;
      openIdx = null;
    }
  }
  // 到会话结束仍开着的那一窗：`closeAtMs` 保持 null（`armedMs` 已按步累计到最后一步）

  return {
    steps,
    windows: mutable.map((w) => ({ ...w })),
    metrics: {
      samples: input.samples.length,
      edges: edges.length,
      windows: mutable.length,
      armedMs,
      firstOpenAtMs,
      consumed,
      initDropped,
      unconsumed: [...trigger.pending],
      mismatches,
      mismatchCount: mismatches.length,
      missedRecorded,
      extraArmed,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 门控帧序列回放（tracker + 节流；**不含** reroll/识别/标签）           */
/* ------------------------------------------------------------------ */

/** 一帧的输入（检测结果由调用方用**线上检测器**从帧库算出来）。 */
export interface AugmentGatingFrameInput {
  readonly atMs: number;
  readonly detection: PanelDetection;
  readonly presence?: PanelPresence | null;
}

export interface AugmentGatingReplayOptions {
  readonly cadence?: { readonly idleMs: number; readonly activeMs: number; readonly probeMs: number; readonly tailMs: number };
  /** 面板停留期间的采样间隔（线上 `HEXBOX_AUGMENT_REROLL_POLL_MS`）。 */
  readonly rerollPollMs?: number;
  /** 录制时的 timeline.csv 行（有则做逐帧黄金对照）。 */
  readonly recorded?: readonly AugmentTimelineRow[];
  /** 黄金对照的容差（ms）：两边帧序可能差一帧，允许在容差内配对。 */
  readonly toleranceMs?: number;
}

export interface AugmentGatingStep {
  readonly atMs: number;
  readonly state: 'closed' | 'open';
  readonly edge: 'open' | 'close' | null;
  readonly found: boolean;
  readonly hits: number;
  readonly misses: number;
  readonly presenceHolds: number;
  readonly mode: CadenceMode;
  readonly intervalMs: number;
  readonly reason: string;
}

export interface AugmentGatingMismatch {
  readonly atMs: number;
  readonly field: 'found' | 'state' | 'edge';
  readonly recorded: string;
  readonly replayed: string;
}

export interface AugmentGatingReplay {
  readonly steps: readonly AugmentGatingStep[];
  readonly edges: readonly AugmentSessionPanelEdge[];
  readonly metrics: {
    readonly frames: number;
    readonly openFrames: number;
    readonly openEdges: number;
    readonly closeEdges: number;
    readonly msByMode: Readonly<Record<CadenceMode, number>>;
    /** 开着面板的时间里，实际下发的是"重随轮询"间隔的帧数（节流是否被面板接管）。 */
    readonly rerollPollFrames: number;
    readonly mismatches: readonly AugmentGatingMismatch[];
    readonly mismatchCount: number;
  };
}

/** 面板在屏时线上强制用重随轮询间隔（覆盖节流策略给出的值）。 */
const DEFAULT_CADENCE = { idleMs: 1000, activeMs: 250, probeMs: 6000, tailMs: 20_000 } as const;

/**
 * 回放门控帧序列：每帧喂**线上** `createPanelTracker()`，再按**线上**
 * `createCadencePolicy()` + "面板停留 → 重随轮询"的规则算这一帧的采样间隔。
 *
 * 为什么值得有：边沿与节流是"面板在不在、多久看一次"的全部逻辑，也是真机上
 * 最容易出现"翻牌动画被判成关闭""假阳性把节奏顶到高频"这类缺陷的地方。
 * 序列化之后这些都能在 CI 里逐帧断言。
 */
export function replayPanelGating(
  frames: readonly AugmentGatingFrameInput[],
  options: AugmentGatingReplayOptions = {},
): AugmentGatingReplay {
  const tracker = createPanelTracker();
  const cadence = createCadencePolicy({ ...DEFAULT_CADENCE, ...(options.cadence ?? {}) });
  const pollMs = options.rerollPollMs ?? 400;
  const steps: AugmentGatingStep[] = [];
  const edges: AugmentSessionPanelEdge[] = [];
  const msByMode: Record<CadenceMode, number> = { idle: 0, probe: 0, active: 0 };
  let lastAtMs = 0;
  let openFrames = 0;
  let rerollPollFrames = 0;

  for (const f of frames) {
    const reading = tracker.push(f.detection, f.presence ?? null);
    const cad = cadence.onReading(reading, f.atMs);
    msByMode[cad.mode] += Math.max(0, f.atMs - lastAtMs);
    lastAtMs = f.atMs;
    const intervalMs = reading.state === 'open' ? pollMs : cad.intervalMs;
    if (reading.state === 'open') {
      openFrames++;
      if (intervalMs === pollMs) rerollPollFrames++;
    }
    if (reading.edge) edges.push({ atMs: f.atMs, kind: reading.edge });
    steps.push({
      atMs: f.atMs,
      state: reading.state,
      edge: reading.edge,
      found: reading.found,
      hits: reading.hits,
      misses: reading.misses,
      presenceHolds: reading.presenceHolds,
      mode: cad.mode,
      intervalMs,
      reason: reading.reason,
    });
  }

  const mismatches = compareGatingToTimeline(steps, options.recorded ?? [], options.toleranceMs ?? 120);
  return {
    steps,
    edges,
    metrics: {
      frames: frames.length,
      openFrames,
      openEdges: edges.filter((e) => e.kind === 'open').length,
      closeEdges: edges.filter((e) => e.kind === 'close').length,
      msByMode,
      rerollPollFrames,
      mismatches,
      mismatchCount: mismatches.length,
    },
  };
}

/**
 * 逐帧黄金对照：把回放结果与录制时的 timeline 行按时间**就近配对**。
 *
 * ⚠️ 帧库采样时刻与录制时不一定逐位一致（帧库可能按固定间隔录、而线上是
 * 事件驱动的间隔），所以配对允许 `toleranceMs`。配不上对的一律**不判**（既不
 * 算对也不算错）—— 宁可少报，也不要因为采样点对不齐而造出假红。
 */
export function compareGatingToTimeline(
  replay: readonly AugmentGatingStep[],
  recorded: readonly AugmentTimelineRow[],
  toleranceMs: number,
): AugmentGatingMismatch[] {
  if (recorded.length === 0) return [];
  const out: AugmentGatingMismatch[] = [];
  for (const r of recorded) {
    let best: AugmentGatingStep | null = null;
    let bestDt = Number.POSITIVE_INFINITY;
    for (const s of replay) {
      const dt = Math.abs(s.atMs - r.atMs);
      if (dt < bestDt) {
        bestDt = dt;
        best = s;
      }
    }
    if (!best || bestDt > toleranceMs) continue;
    if (best.found !== r.found) {
      out.push({ atMs: r.atMs, field: 'found', recorded: String(r.found), replayed: String(best.found) });
    }
    if (r.state !== '' && best.state !== r.state) {
      out.push({ atMs: r.atMs, field: 'state', recorded: r.state, replayed: best.state });
    }
    if ((r.edge ?? null) !== best.edge) {
      out.push({ atMs: r.atMs, field: 'edge', recorded: String(r.edge), replayed: String(best.edge) });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 会话级摘要（CLI 打印用；纯函数）                                     */
/* ------------------------------------------------------------------ */

export interface AugmentSessionSummary {
  readonly version: number;
  readonly trigger: string;
  readonly frames: { readonly gating: number; readonly native: number };
  readonly apiSamples: number;
  readonly edges: number;
  readonly phaseSamples: number;
  readonly rerolls: number;
  readonly spanMs: number;
  readonly offerLevels: readonly number[];
}

/** 会话摘要（CLI 第一屏）。 */
export function summarizeSession(session: {
  readonly meta: { readonly version: number; readonly trigger: string };
  readonly frames: readonly { readonly kind: 'gating' | 'native'; readonly atMs: number }[];
  readonly api: readonly { readonly atMs: number }[];
  readonly edges: readonly { readonly atMs: number }[];
  readonly phase: readonly unknown[];
  readonly rerolls: readonly unknown[];
}): AugmentSessionSummary {
  const gating = session.frames.filter((f) => f.kind === 'gating').length;
  return {
    version: session.meta.version,
    trigger: session.meta.trigger,
    frames: { gating, native: session.frames.length - gating },
    apiSamples: session.api.length,
    edges: session.edges.length,
    phaseSamples: session.phase.length,
    rerolls: session.rerolls.length,
    spanMs: sessionSpanMs(session.frames, session.api, session.edges),
    offerLevels: [...AUGMENT_TRIGGER_DEFAULTS.offerLevels],
  };
}

/** 内部：会话摘要里的"时长"（最后一个事件 - 第一个事件）。 */
export function sessionSpanMs(frames: readonly { readonly atMs: number }[],
  api: readonly { readonly atMs: number }[],
  edges: readonly { readonly atMs: number }[]): number {
  const times = [...frames.map((f) => f.atMs), ...api.map((a) => a.atMs), ...edges.map((e) => e.atMs)];
  if (times.length === 0) return 0;
  return Math.max(...times) - Math.min(...times);
}
