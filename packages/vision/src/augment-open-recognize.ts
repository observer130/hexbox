/**
 * 开边沿**整批识别**的两个纯决策（可单测）
 *
 * ── 为什么需要（2026-10-11 真机回归：面板在屏 25.7 秒，一个标签都没画）──────
 *
 * 真机日志（打包版，一局真实对局的第一块面板）：
 *
 * ```
 * ▶ 面板出现 #1 @18.5s — 3 张卡片：内部暗(30/25/39) 边框亮(126/131/123)   ← 门控（1/3 分辨率）判据命中两帧
 * 🔎 全分辨率识别 未命中（79ms，?x?）：卡片内部不够暗(40 ≥ 40)            ← 原生重检（1:1）对**同一块面板**判"不在"
 * 🧹 清空强度标签：原因=重识别失败（开边沿整批没有可画结果：卡片内部不够暗(40 ≥ 40)）
 * …（此后 25.7 秒门控持续"卡片判据失效但**面板信号仍在**"托底，期间卡片判据仍反复单帧命中）
 * ◀ 面板消失 #1 @44.2s
 * ```
 *
 * 这里其实是**两条独立的缺陷**，都在本文件里各给一个纯决策：
 *
 * 1. **同一块面板、两个分辨率、同一条阈值**（`resolveOpenRecognizeCards()`）：
 *    门控在 1/3 分辨率上量到 39（< 40 → 命中），原生重检在 1:1 上量到 **40**
 *    （`>= 40` → 失败）。而"面板在屏"这件事**门控才是权威**：开边沿由它给出
 *    （连续 2 帧卡片判据命中），原生重检存在的意义只是**拿到更精确的卡片矩形**。
 *    它说"不"的时候不该把整块面板判成"没有"，而应退回门控刚验过的矩形继续 OCR——
 *    矩形是**归一化**的，1/3 分辨率下的矩形在原生帧上同样可用（只是精度差几像素）。
 *
 * 2. **一块面板只识别一次**（`decideOpenRecognitionRetry()`）：那次识别一旦落在
 *    翻牌动画中间帧上（真机日志：`…本帧那一个是翻牌动画中间帧`）就永远没有第二次，
 *    面板在屏 25.7 秒也一个标签都不画。修法是"在**有界预算**内、只在门控判据命中的
 *    稳定帧上重试" —— 不是恢复"常态每秒重复开截屏"（那会退回旧行为，且旧行为本身
 *    有 `sawPanel=false` 的记账缺陷，见 `augment-trigger.ts` 的开局分支注释）。
 *
 * ⚠️ 两个决策都**只做选择**：不发 IPC、不读环境变量、不碰时间（`nowMs` 由调用方给）。
 */

import type { PanelCard } from './augment-panel.ts';

/* ------------------------------------------------------------------ */
/* 1. 原生重检失败 → 退回门控刚验过的矩形                                */
/* ------------------------------------------------------------------ */

export type OpenRecognizeSource = 'native' | 'gating' | 'none';

export interface OpenRecognizeResolution {
  /** 用谁的矩形继续 OCR：原生重检 / 门控兜底 / 没有可用的。 */
  readonly source: OpenRecognizeSource;
  readonly cards: readonly PanelCard[];
  /** 人读原因（写日志；兜底必须留一行，否则复盘时看不到"其实用的是门控矩形"）。 */
  readonly reason: string;
}

/**
 * 决定"整批识别用哪一组卡片矩形"。
 *
 * @param input.native 原生（1:1）重检结果（`detectAugmentPanelInRegions` 在原生帧上的输出）
 * @param input.gating 门控**最近一次判据命中**的卡片（调用方保证"命中"语义；空 = 没有）
 * @param input.minCards 至少几张卡才算一批（默认 `PANEL_THRESHOLDS.minCards`）
 */
export function resolveOpenRecognizeCards(input: {
  readonly native: {
    readonly found: boolean;
    readonly cards: readonly PanelCard[];
    readonly reason: string;
  };
  readonly gating: readonly PanelCard[];
  readonly minCards?: number;
}): OpenRecognizeResolution {
  const minCards = input.minCards ?? 2;
  if (input.native.found && input.native.cards.length >= minCards) {
    return { source: 'native', cards: input.native.cards, reason: input.native.reason };
  }
  if (input.gating.length >= minCards) {
    return {
      source: 'gating',
      cards: input.gating,
      reason:
        `原生重检未通过（${input.native.reason}），但门控刚验过 ${input.gating.length} 张卡片` +
        '（同一块面板：开边沿是门控给的）→ 用门控矩形兜底识别',
    };
  }
  return {
    source: 'none',
    cards: [],
    reason: `原生重检未通过（${input.native.reason}），门控也没有可用的卡片矩形` +
      `（${input.gating.length} 张 < ${minCards}）`,
  };
}

/* ------------------------------------------------------------------ */
/* 2. 开边沿识别失败 → 在有界预算内、只在稳定帧上重试                     */
/* ------------------------------------------------------------------ */

export const OPEN_RECOGNIZE_RETRY_DEFAULTS = {
  /** 一块面板最多识别几次（含开边沿那一次）。 */
  maxAttempts: 3,
  /** 两次识别之间的最小间隔（ms）—— 比一次识别（实测 60~90ms）宽裕得多。 */
  minGapMs: 400,
  /** 开边沿之后多久就不再重试（ms）：面板内容随时可能被选掉，别追太久。 */
  budgetMs: 5000,
} as const;

export interface OpenRecognizeRetryInput {
  /** 门控此刻是否仍认定面板在屏（`reading.state === 'open'`）。 */
  readonly panelOpen: boolean;
  /** 本帧门控的卡片判据是否命中（真机教训：翻牌动画帧是识别失败的主因，等稳定帧）。 */
  readonly settledFrame: boolean;
  /** 本批识别出的**有名字**的卡数（OCR 成功；查不到强度不算失败，重试无用）。 */
  readonly namedCards: number;
  /** 期望的卡数（开边沿那一帧门控检出的卡片数）。 */
  readonly expectedCards: number;
  /** 已经发起过几次识别（含开边沿那一次）。 */
  readonly attempts: number;
  /** 是否已有一次识别在飞行中（渲染端还没回传）。 */
  readonly pending: boolean;
  /** 开边沿时刻（与 `nowMs` 同一时基）。 */
  readonly openEdgeAtMs: number;
  /** 上一次识别的发起时刻（null = 还没发起过）。 */
  readonly lastAttemptAtMs: number | null;
  readonly nowMs: number;
  readonly maxAttempts?: number;
  readonly minGapMs?: number;
  readonly budgetMs?: number;
}

export interface OpenRecognizeRetryDecision {
  readonly retry: boolean;
  readonly reason: string;
}

/**
 * 决定"这一帧要不要再发起一次整批识别"。
 *
 * 顺序写死（每条都有真机来源）：
 *   1. 面板不在了 → 不重试（`◀ 面板消失` 之后内容已经无关）；
 *   2. 本帧不是**稳定帧**（门控卡片判据没命中）→ 不重试 —— 那正是翻牌动画中间帧，
 *      重试只会再失败一次（真机日志里"认不准"的两次尝试都落在动画帧上）；
 *   3. 已经有名字了（`namedCards >= expectedCards`）→ 不重试（不白跑 OCR）；
 *   4. 已有一次在飞行中 / 次数用完 / 超出预算 / 距上次太近 → 不重试。
 */
export function decideOpenRecognitionRetry(
  input: OpenRecognizeRetryInput,
): OpenRecognizeRetryDecision {
  const maxAttempts = input.maxAttempts ?? OPEN_RECOGNIZE_RETRY_DEFAULTS.maxAttempts;
  const minGapMs = input.minGapMs ?? OPEN_RECOGNIZE_RETRY_DEFAULTS.minGapMs;
  const budgetMs = input.budgetMs ?? OPEN_RECOGNIZE_RETRY_DEFAULTS.budgetMs;

  if (!input.panelOpen) return { retry: false, reason: '面板不在屏（不重试）' };
  if (input.expectedCards <= 0) {
    return { retry: false, reason: '门控没给出卡片数（没有可识别的目标）→ 不重试' };
  }
  if (input.namedCards >= input.expectedCards) {
    return {
      retry: false,
      reason: `${input.namedCards}/${input.expectedCards} 张已认出名字（不重试）`,
    };
  }
  if (!input.settledFrame) {
    return { retry: false, reason: '本帧不是稳定帧（卡片判据未命中，像翻牌动画）→ 等下一帧' };
  }
  if (input.pending) return { retry: false, reason: '上一次识别还在飞行中' };
  if (input.attempts >= maxAttempts) {
    return { retry: false, reason: `已识别 ${input.attempts} 次（上限 ${maxAttempts}）` };
  }
  const sinceOpen = input.nowMs - input.openEdgeAtMs;
  if (sinceOpen > budgetMs) {
    return {
      retry: false,
      reason: `开边沿已过 ${Math.round(sinceOpen)}ms（预算 ${budgetMs}ms）→ 不再重试`,
    };
  }
  if (input.lastAttemptAtMs !== null && input.nowMs - input.lastAttemptAtMs < minGapMs) {
    return {
      retry: false,
      reason:
        `距上次识别仅 ${Math.round(input.nowMs - input.lastAttemptAtMs)}ms` +
        `（下限 ${minGapMs}ms）→ 下一帧再说`,
    };
  }
  return {
    retry: true,
    reason:
      `开边沿识别没拿到名字（${input.namedCards}/${input.expectedCards}），本帧是稳定帧` +
      ` → 第 ${input.attempts + 1}/${maxAttempts} 次重试`,
  };
}
