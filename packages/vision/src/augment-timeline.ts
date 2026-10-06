/**
 * 局内链路 ⇄ 标签的**时间轴回放**（纯函数；回归测试与诊断脚本共用）
 *
 * ── 为什么需要它（2026-10-06 真机缺陷）──────────────────────────────────────
 *
 * 用户报的现象是"**面板刚弹出、标签刚画上，随即被清掉**"（比上一轮的"几秒后
 * 才消失"更严重）。这条链路的清空来源不止一处，而**主进程在 CI 里跑不起来**
 * （Electron + 管理员 + 真实桌面），所以没有真机就只能靠推断 —— 上一次就是这样
 * 漏掉了"在途启动的回调把新起的链路一起收掉"这条缝。
 *
 * 于是把"**阶段轮询序列 + 面板状态**"喂给**线上同一份纯函数**
 * （`createStageGate` / `augmentChainTransition` / `labelProducerFor` /
 * `augmentStartIsStale` / `augmentStopClearsLabels` / `createPanelTracker`），
 * 按主进程 `pollOnce()` 的顺序逐轮跑一遍，输出**动作序列与清空序列**。
 *
 * ⚠️ 它**不参与运行时**：只做验证。三件事必须与主进程保持同序（改主进程时同步改这里）：
 *   ① 门 → 画布归属（换手清空）→ 启停状态机；
 *   ② `start()` 是**异步**的（`startRounds` 轮后才落地），期间阶段可能反复变化；
 *   ③ 链路**停止不再清标签**（由 `augmentStopClearsLabels()` 决定；
 *      `chainStopClears: true` = **改前**的无条件清空，留作对照）。
 */

import { AUGMENT_CLEAR_REASONS, augmentStopClearsLabels, type AugmentClearReason } from './augment-clear.ts';
import { createPanelTracker } from './augment-panel.ts';
import {
  augmentChainTransition,
  augmentStartIsStale,
  createStageGate,
  labelProducerFor,
  type AugmentChainState,
  type AugmentPanelState,
  type LabelProducer,
} from './visibility.ts';

/** 一轮轮询的输入（真机上来自 `/lol-gameflow/v1/session` 与截屏门控）。 */
export interface AugmentTimelineStep {
  /** 本轮喂给阶段门的**原始读数**：`null` = 读失败（**不是**"不在对局"）。 */
  readonly sample: string | null;
  /**
   * 本轮面板门控**认定**面板在屏（省略 = 本轮没采到帧，门控状态不动）。
   *
   * 与真实链路一致：只有链路活着且流已就绪（`running`）时才有帧可判 ——
   * 启动途中/已收工时传 `panelFound` 也不会被采纳。
   */
  readonly panelFound?: boolean;
}

export interface AugmentTimelineOptions {
  /**
   * 每次启动要几轮才落地（`start()` 是异步的；真机冷启动最长约 10 秒 = 5 轮）。
   *
   * 传数组 = 按**第几次启动**取值（用完取最后一个值）—— 用来复现真实组合：
   * "第一次冷启动慢（探窗口 + 建流 + 等就绪），第二次快"。
   */
  readonly startRounds?: number | readonly number[];
  /**
   * 在途启动的回调落地规则：
   *   · `'token'`（默认 = 现行为）：令牌不一致 → **什么都不做**（只作废自己那一代）；
   *   · `'stop-current'`（**改前**）：令牌不一致就去 `stop()` —— 会把期间新起的
   *     那一代连流带标签一起收掉（真机"闪一下就没了"的来源，留作对照）。
   */
  readonly staleStartRule?: 'token' | 'stop-current';
  /** 链路停止时是否连带清空标签（`true` = **改前**的无条件清空；默认 false）。 */
  readonly chainStopClears?: boolean;
  /** 每轮间隔（ms；只用于时间轴展示，默认 2000 = 主进程的 `POLL_MS`）。 */
  readonly roundMs?: number;
  readonly augmentEnabled?: boolean;
}

/** 一条在途启动的回调落地方式。 */
export type AugmentStartSettlement = 'running' | 'failed' | 'stale-ignored' | 'stale-stop';

/** 一轮回放的结果（与主进程同一轮里的判定一一对应）。 */
export interface AugmentTimelineRound {
  readonly round: number;
  readonly atMs: number;
  /** 本轮原始读数。 */
  readonly sample: string | null;
  /** 门输出的阶段（下游全部只看它）。 */
  readonly stage: string;
  /** 本轮是否"没有采纳读数、保持了上一阶段"。 */
  readonly held: boolean;
  /** 启停动作。 */
  readonly action: 'start' | 'stop' | 'none';
  /** 本轮落地的在途启动回调（可能多个）。 */
  readonly settled: readonly AugmentStartSettlement[];
  /** 本轮之后的会话号（令牌）。 */
  readonly session: number;
  /** 本轮之后的**链路状态**（与启停状态机一致）。 */
  readonly state: AugmentChainState;
  /** 链路是否活着（控制器 `isRunning`：`start()` 一调用就 true）。 */
  readonly chainAlive: boolean;
  readonly producer: LabelProducer;
  readonly handover: boolean;
  readonly panel: AugmentPanelState;
  readonly panelEdge: 'open' | 'close' | null;
  /** 本轮结束时屏幕上有没有强度标签。 */
  readonly labelsOnScreen: boolean;
  /** 本轮发生的清空（原因词表里的字面量）。 */
  readonly clears: readonly AugmentClearReason[];
}

/** 整段回放的汇总（断言就看这几个数）。 */
export interface AugmentTimelineReport {
  readonly rounds: readonly AugmentTimelineRound[];
  readonly actions: readonly ('start' | 'stop' | 'none')[];
  readonly starts: number;
  readonly stops: number;
  /**
   * 门输出是**局内阶段**时的 stop 次数 —— **必须恒为 0**：
   * 局内稳定读到时链路一次都不许停（真机"面板开着、标签被清掉"的直接来源）。
   */
  readonly stopsWhileInGame: number;
  /** 在途启动回调发出的 stop 次数（改前会把新一代一起收掉）。 */
  readonly staleStops: number;
  /** 被正确忽略的过期启动回调次数（现行为）。 */
  readonly staleIgnored: number;
  /** 清空原因序列（顺序即时间顺序）。 */
  readonly clears: readonly AugmentClearReason[];
  readonly clearCount: number;
  readonly labelsOnScreen: boolean;
  readonly chainAlive: boolean;
}

/** 局内阶段（与 `visibility.ts` 的 `AUGMENT_CHAIN_PHASES` 一致；这里只需判定）。 */
function isInGameStage(stage: string): boolean {
  return stage === 'InProgress' || stage === 'Reconnect';
}

/**
 * 跑一段时间轴回放（纯函数；见文件头注）。
 *
 * 语义与主进程 `pollOnce()` + `applyAugmentChain()` 同序：
 *   在途启动落地 → 阶段门 → 画布归属（换手即清）→ 启停状态机 → 面板门控边沿。
 */
export function replayAugmentTimeline(
  steps: readonly AugmentTimelineStep[],
  options: AugmentTimelineOptions = {},
): AugmentTimelineReport {
  const roundMs = options.roundMs ?? 2000;
  const staleRule = options.staleStartRule ?? 'token';
  const augmentEnabled = options.augmentEnabled ?? true;
  const startRounds = options.startRounds ?? 0;
  const roundsFor = (startIndex: number): number => {
    if (typeof startRounds === 'number') return startRounds;
    if (startRounds.length === 0) return 0;
    return startRounds[Math.min(startIndex, startRounds.length - 1)] ?? 0;
  };

  const gate = createStageGate();
  const tracker = createPanelTracker();

  let state: AugmentChainState = 'idle';
  let session = 0;
  let lastProducer: LabelProducer | null = null;
  /**
   * 控制器是否活着（`isRunning`）：`start()` 一被调用就 true（它先置位再 await），
   * `stop()` 置 false。⚠️ 它与 `state`（主进程的启停状态机）**不是一回事**：
   * 在途启动期间 `state === 'starting'` 而链路已经"活着"。
   */
  let chainAlive = false;
  /** 在途启动（令牌 + 落地轮次）；真实代码里就是那几个并发的 `start()` promise。 */
  const pending: { readonly token: number; readonly due: number }[] = [];
  let startIndex = 0;
  let labelsOnScreen = false;

  const clears: AugmentClearReason[] = [];
  const out: AugmentTimelineRound[] = [];
  let staleStops = 0;
  let staleIgnored = 0;
  let stopsWhileInGame = 0;

  /**
   * 链路停止（主进程 `augment.stop(...)` / 过期回调的 `stop()`）。
   *
   * ⚠️ 控制器 `stop()` 是**幂等**的：本来就没在跑时早退，连清标签都不会做。
   * 返回是否**真的**清了标签。
   */
  const onChainStop = (): boolean => {
    const wasAlive = chainAlive;
    chainAlive = false;
    tracker.reset();
    if (!wasAlive) return false;
    if (!augmentStopClearsLabels(options.chainStopClears === true ? true : undefined)) return false;
    clears.push(AUGMENT_CLEAR_REASONS.chainStop);
    labelsOnScreen = false;
    return true;
  };

  for (const [roundIndex, step] of steps.entries()) {
    const atMs = roundIndex * roundMs;
    const settled: AugmentStartSettlement[] = [];
    const roundClears: AugmentClearReason[] = [];
    let roundStops = 0;

    // ── ① 在途启动的回调落地（真实时间轴上可能落在任意两轮之间）──────────
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      if (!p || p.due > roundIndex) continue;
      pending.splice(i, 1);
      if (augmentStartIsStale(p.token, session)) {
        if (staleRule === 'stop-current') {
          // 改前：看到"新世代"就 stop() → 把期间新起的会话连流带标签一起收掉。
          // ⚠️ 那条 stop 不改 `augmentState`（真实代码里过期回调直接 return），
          // 所以链路已死而状态还停在 running —— 真机日志会说"已就绪"，其实整局没了。
          staleStops++;
          roundStops++;
          settled.push('stale-stop');
          if (onChainStop()) roundClears.push(AUGMENT_CLEAR_REASONS.chainStop);
        } else {
          // 现行为：令牌不一致 → 什么都不做（本代自己的流已由控制器按令牌收干净）
          staleIgnored++;
          settled.push('stale-ignored');
        }
        continue;
      }
      if (!chainAlive) {
        // 本代已被 stop()（离开对局 / 被期间的新会话顶掉）：`start()` 自行收场并
        // 上报 unavailable → 主进程记 failed（本局不再重试）
        state = 'failed';
        settled.push('failed');
        continue;
      }
      state = 'running';
      settled.push('running');
    }

    // ── ② 阶段门（读失败保持、离开要连续确认）──────────────────────────
    const gated = gate.push(step.sample);

    // ── ③ 画布归属：换手即清空（**唯一的"阶段驱动"清空**）───────────────
    const panel: AugmentPanelState = chainAlive ? tracker.state : 'unknown';
    const ownership = labelProducerFor(gated.stage, panel, lastProducer, { augmentEnabled });
    if (ownership.handover) {
      clears.push(AUGMENT_CLEAR_REASONS.stageHandover);
      labelsOnScreen = false;
      roundClears.push(AUGMENT_CLEAR_REASONS.stageHandover);
    }
    lastProducer = ownership.producer;

    // ── ④ 启停状态机（启动只需一次；停止要"确认离开"）──────────────────
    const t = augmentChainTransition(state, session, gated.stage, { augmentEnabled });
    session = t.generation;
    state = t.state;
    const action = t.action;
    if (t.action === 'stop') {
      roundStops++;
      if (onChainStop()) roundClears.push(AUGMENT_CLEAR_REASONS.chainStop);
    } else if (t.action === 'start') {
      chainAlive = true; // 控制器 `start()` 先置 isRunning 再 await
      pending.push({ token: t.token, due: roundIndex + roundsFor(startIndex) });
      startIndex++;
    }
    if (isInGameStage(gated.stage)) stopsWhileInGame += roundStops;

    // ── ⑤ 面板门控边沿（只有链路活着且流已就绪才有帧）────────────────────
    let panelEdge: 'open' | 'close' | null = null;
    if (chainAlive && state === 'running' && step.panelFound !== undefined) {
      const reading = tracker.push({
        found: step.panelFound,
        cards: [],
        bands: 0,
        reason: '回放',
      });
      panelEdge = reading.edge;
      if (reading.edge === 'open') labelsOnScreen = true;
      if (reading.edge === 'close') {
        clears.push(AUGMENT_CLEAR_REASONS.panelClosed);
        roundClears.push(AUGMENT_CLEAR_REASONS.panelClosed);
        labelsOnScreen = false;
      }
    }

    out.push({
      round: roundIndex,
      atMs,
      sample: step.sample,
      stage: gated.stage,
      held: gated.held,
      action,
      settled,
      session,
      state,
      chainAlive,
      producer: ownership.producer,
      handover: ownership.handover,
      panel: chainAlive ? tracker.state : 'unknown',
      panelEdge,
      labelsOnScreen,
      clears: roundClears,
    });
  }

  return {
    rounds: out,
    actions: out.map((r) => r.action),
    starts: out.filter((r) => r.action === 'start').length,
    stops: out.filter((r) => r.action === 'stop').length + staleStops,
    stopsWhileInGame,
    staleStops,
    staleIgnored,
    clears,
    clearCount: clears.length,
    labelsOnScreen,
    chainAlive,
  };
}
