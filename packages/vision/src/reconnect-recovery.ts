/**
 * 重连恢复的**纯判定**（思路来自对同类工具重连恢复服务的调研）
 *
 * ── 为什么需要它（真机形态）────────────────────────────────────────────────
 *
 * 客户端重启型重连会走 `Reconnect` 相位再回到 `InProgress`。这期间真实发生过的事：
 *   · 屏幕流早就断了，`AugmentController` 那一代已经作废 —— 标签再也不会出现；
 *   · 我们**本局放弃**（`failed`）的闩锁还在：即使流恢复了，本局也不会再起；
 *   · `myChampionId` 可能是 0（重连时选人会话已消失，而 2999 那一刻还没起来）。
 * 三个问题各修一处都不够：必须**只在一个明确的时机**统一处理，且不能误触发。
 *
 * ── 借来的那条规则（参考实现的重连恢复服务）────────────────────────────────
 *
 *   · **动作只在 `InProgress` 上做**：`Reconnect` 本身只"记账"，不恢复；
 *   · **遇到选人/终局相位直接清位**：避免"选人 → 进局"这种正常转移被当成重连恢复；
 *   · **恢复时先重置本局熔断**（原文：进程中断后熔断/重试限制不再可信）；
 *   · 英雄身份**优先本局缓存**，缺了才去 2999 兜底。
 *
 * 单测锁住的核心不变量：**一次重连只恢复一次**（`armed` 必须被消费掉）——
 * 否则每 2 秒轮询都会重跑一遍恢复，日志刷屏之外还会反复重推标签。
 */

import { AUGMENT_CHAIN_PHASES, type AugmentChainState } from './visibility.ts';

/** 重连相位（LCU gameflow-phase 的字面量，客户端重启型重连会经过它）。 */
export const RECONNECT_PHASE = 'Reconnect';

/**
 * "仍在**局内流程**但**不是**重连恢复时机"的相位（只影响日志措辞）。
 *
 * 与 `AUGMENT_CHAIN_PHASES` 的区别：那两个是"局内链路要跑"的相位，
 * 这里多算了选人与开局 —— 它们同样属于"这一局还没结束"，所以
 * 复位原因是"时机不对"，而不是"离开对局"（排查时这两句话指向完全不同的结论）。
 */
const STILL_IN_MATCH_FLOW: readonly string[] = [
  ...AUGMENT_CHAIN_PHASES,
  'ChampSelect',
  'GameStart',
];

/** 本轮判定的归类，只用于日志。 */
export type ReconnectStage = 'idle' | 'gap' | 'recovered' | 'normal';

export interface ReconnectStepInput {
  /** 上一轮是否已经"记账"过（进入过 `Reconnect` 且还没被消费）。 */
  readonly armed: boolean;
  /** 本轮**已应用**的阶段（走过阶段门之后的那个值）。 */
  readonly phase: string;
  /** 局内链路的启停状态（`failed` = 本局放弃了，恢复时必须重置）。 */
  readonly chainState: AugmentChainState;
  /** 本局英雄身份是否已经知道（`myChampionId > 0`）。 */
  readonly championKnown: boolean;
}

export interface ReconnectStep {
  /** 下一轮的 `armed`（**必须**存回去）。 */
  readonly armed: boolean;
  /** 本轮是否执行恢复动作。 */
  readonly recover: boolean;
  /** 是否要重置"本局不重试"的熔断（仅当它确实是 `failed`）。 */
  readonly resetChainFuse: boolean;
  /** 英雄身份是否可以直接用本局缓存（true = 不必去 2999 兜底）。 */
  readonly heroFromCache: boolean;
  readonly stage: ReconnectStage;
  /** 人类可读的原因（直接进日志；不恢复时也要能看出为什么）。 */
  readonly reason: string;
}

/**
 * 推进一次重连判定。
 *
 * 调用时机：**每一轮拿到已应用的 `phase` 之后**（与阶段门同一个节拍），
 * 把返回值里的 `armed` 存回进程状态。
 */
export function reconnectStep(input: ReconnectStepInput): ReconnectStep {
  const { phase, chainState, championKnown } = input;

  if (phase === RECONNECT_PHASE) {
    return {
      armed: true,
      recover: false,
      resetChainFuse: false,
      heroFromCache: championKnown,
      stage: 'gap',
      reason: '进入重连相位（先记账，等回到对局中再恢复；重连期间不做任何动作）',
    };
  }

  if (phase === 'InProgress') {
    if (!input.armed) {
      return {
        armed: false,
        recover: false,
        resetChainFuse: false,
        heroFromCache: championKnown,
        stage: 'normal',
        reason: '对局中（不是重连恢复，无需动作）',
      };
    }
    // 消费掉这次记账：**一次重连只恢复一次**
    const fuse = chainState === 'failed';
    return {
      armed: false,
      recover: true,
      resetChainFuse: fuse,
      heroFromCache: championKnown,
      stage: 'recovered',
      reason:
        '重连后回到对局中 → 执行恢复' +
        (fuse ? '（本局链路曾被判 failed，先重置熔断）' : '（链路状态正常）') +
        (championKnown ? '；英雄身份复用本局缓存' : '；英雄身份缺失，需要 2999 兜底'),
    };
  }

  // 其余相位：选人 / 开局 / 大厅 / 匹配 / 终局 —— 一律复位，绝不在这里恢复
  //
  // 措辞分两类，因为它们在排查时含义完全不同：
  //   · 仍在局内流程（选人 / 开局）：是"时机不对"，不是故障；
  //   · 已离开局内流程（大厅 / 结算 / None）：是"这一局结束了"，本来就该复位。
  const stillInMatchFlow = STILL_IN_MATCH_FLOW.includes(phase);
  return {
    armed: false,
    recover: false,
    resetChainFuse: false,
    heroFromCache: championKnown,
    stage: 'idle',
    reason: stillInMatchFlow
      ? `相位 ${phase} 不属于重连恢复时机（只在 InProgress 上恢复）`
      : `相位 ${phase} → 离开对局，复位重连追踪（避免选人/终局误触发）`,
  };
}

/* ------------------------------------------------------------------ */
/* 恢复时对**局内链路**做什么（借来的两条：重置重试状态 + 停掉僵尸捕获）      */
/* ------------------------------------------------------------------ */

/**
 * 抓帧状态（**字面量与 `apps/overlay` 的 `AugmentCaptureState` 一致**）。
 *
 * 为什么在 vision 里重写一份：`vision` 不能依赖 `apps/`（依赖方向是反的）。
 * 两边字面量必须一致 —— 有单测锁住这三个值，改一边不改另一边会当场变红。
 */
export type ReconnectCaptureState = 'idle' | 'stream' | 'unavailable';

export interface ReconnectChainAction {
  /** 本局链路曾被判 `failed`（本局不重试）→ 重置成 `idle`，允许本局重新起。 */
  readonly resetFuse: boolean;
  /** 链路"在跑"但抓帧不可用（僵尸会话）→ 停掉这一代，下一轮用**新令牌**重起。 */
  readonly restartSession: boolean;
  readonly reason: string;
}

/**
 * 重连恢复时该对局内链路做什么（纯函数）。
 *
 * 两种真机形态（参考实现里对应"重置流重试状态"与"停掉僵尸捕获"两个动作）：
 *
 *   ① `failed`：启动就失败了，本局被记成"不再重试"。**进程中断后这个结论不再可信**
 *      —— 重连本身就是"环境变了"，所以要允许本局再试一次。
 *   ② `running` + 抓帧 `unavailable`：状态机以为在跑，屏幕上却永远不会有帧
 *      （典型：客户端重启后原来的屏幕流目标已经失效）。只重置状态没用，
 *      必须**真的把这一代停掉**（收干净它的流），下一轮才会用新令牌重建。
 *
 * ⚠️ 二者**互斥**（单测锁住）：上游状态机里 `running` 与 `failed` 不可能同时成立，
 * 同时做两件事只会让日志与真实原因对不上。
 */
export function decideReconnectChainAction(input: {
  readonly chainState: AugmentChainState;
  readonly captureState: ReconnectCaptureState;
}): ReconnectChainAction {
  if (input.chainState === 'failed') {
    return {
      resetFuse: true,
      restartSession: false,
      reason: '本局链路曾判 failed（本局不重试）→ 重置熔断，允许本局重新起链路',
    };
  }
  if (input.chainState === 'running' && input.captureState === 'unavailable') {
    return {
      resetFuse: false,
      restartSession: true,
      reason: '链路在跑但抓帧不可用（僵尸会话）→ 停掉这一代，下一轮用新令牌重建',
    };
  }
  if (input.chainState === 'running') {
    return {
      resetFuse: false,
      restartSession: false,
      reason: `链路在跑且抓帧可用（${input.captureState}）→ 什么都不动`,
    };
  }
  return {
    resetFuse: false,
    restartSession: false,
    reason: `链路状态 ${input.chainState} 无需处理`,
  };
}
