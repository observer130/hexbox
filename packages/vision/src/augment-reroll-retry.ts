/**
 * 「刷新后第一次查不到强度」**先别清标签**：排一次重认（纯函数，可单测）
 *
 * ── 真机缺陷（2026-10-11，用户局内实测）──────────────────────────────────
 *
 * 单卡刷新（reroll）后的重认偶发"这一次没认出/查不到强度"：
 *
 *   检测到卡2 刷新（结构距离 0.0735）→ 重新识别（12ms）→ 卡2 → **不画（查不到强度）**
 *   🧹 清空强度标签：原因=刷新后查不到强度（卡2）      ← 屏幕上的标签当场消失
 *   检测到卡2 刷新（结构距离 0.0735）→ 重新识别（12ms）→ 卡2 → S（选取率 11.2%）
 *
 * 两次 OCR 拿到的名字与分数**完全一样**（0.598 / 0.082），差别只在"这一次查表
 * 查不到" —— 也就是说这一次失败很可能是**暂时的**（表刚被换掉/还没建好、
 * 一帧画面不理想），而用户的观感是"标签闪一下又回来"。
 *
 * 所以：**同一张卡的第一次失败不立刻清，先保住上一帧的标签并排队重认一次；
 * 第二次仍然失败才清。**
 *
 * ⚠️ 底线（不能因为"宽容一次"把原始 bug 放回来）：真刷新后确实查不到强度时
 *    **最终必须清掉那张卡的标签** —— 所以额度只有一次，第二次失败就
 *    `drop`（见 `decideRerollRetry` 的测试与 `mergeRefreshedCards` 的语义：
 *    `augmentId = null` → 那张卡的标签必然消失）。
 *
 * ⚠️ 本文件必须保持**浏览器安全**（渲染端 worker 会 import 同族模块）：
 * 只依赖纯计算，不碰 Electron / fs。
 */

import { fingerprintDistance, type AugmentCardFingerprint } from './augment-reroll.ts';

export interface RerollRetryInput {
  /** 本帧被重认的卡片序号（渲染端 `RecognizedReport.refreshed`）。 */
  readonly refreshed: readonly number[];
  /**
   * 其中"这次**会掉标签**"的序号（认不出 / 查不到强度，且本来有标签）。
   *
   * 由调用方算好传进来（它手上才有强度表）：本模块只管"给不给一次重试机会"。
   */
  readonly wouldDrop: readonly number[];
  /** **这块面板里已经重试过**的卡片序号（第二次失败就必须清）。 */
  readonly retried: readonly number[];
}

export interface RerollRetryDecision {
  /** 现在就按"掉标签"处理（= 已经重试过一次，底线在此）。 */
  readonly drop: readonly number[];
  /** 先保住上一帧的值、排队一次重认的卡片序号。 */
  readonly retry: readonly number[];
}

/**
 * 决定"哪些卡再给一次机会、哪些卡现在就清"。
 *
 * 规则（只有一条，别再加油添醋）：
 *   · `wouldDrop` 里的卡，**没重试过** → `retry`（这次保留旧标签、请求重认一次）；
 *   · **已经重试过** → `drop`（真刷新后确实查不到强度 → 必须清）。
 * 不在 `wouldDrop` 里的卡（认得出、有强度）不参与：它们的标签照常更新。
 * 越界/重复/非整数序号忽略（一次坏数据不许把整批标签搞乱）。
 */
export function decideRerollRetry(input: RerollRetryInput): RerollRetryDecision {
  const retried = new Set(input.retried);
  const drop: number[] = [];
  const retry: number[] = [];
  const seen = new Set<number>();
  for (const i of input.wouldDrop) {
    if (!Number.isInteger(i) || i < 0 || seen.has(i)) continue;
    seen.add(i);
    if (retried.has(i)) drop.push(i);
    else retry.push(i);
  }
  return { drop, retry };
}

/* ------------------------------------------------------------------ */
/* 重认之后"基线指纹"只能前进，不许被回退（同一次刷新只许触发一次重认）      */
/* ------------------------------------------------------------------ */

export interface RerollBaselineInput {
  /** 触发这次重认**之前**的基线（= 上一次识别那一帧的指纹）。 */
  readonly previous: readonly (AugmentCardFingerprint | null)[] | null | undefined;
  /** 判定"变了"的那一帧的指纹（`maybeDetectReroll` 的 `current`）。 */
  readonly detection: readonly (AugmentCardFingerprint | null)[] | null | undefined;
  /** 渲染端在**重认报告**里回传的指纹（`RecognizedReport.fingerprints`）。 */
  readonly reported: readonly (AugmentCardFingerprint | null)[] | null | undefined;
}

/**
 * 重认报告回传的指纹**能不能当新基线**（单调保护，2026-10-11）。
 *
 * ── 为什么需要 ──────────────────────────────────────────────────────────
 *
 * 主进程在判定"某张卡刷新了"的那一刻已经把基线推进到**检测帧**（那一帧已经是
 * 新内容）；随后重认报告回来时又会用渲染端回传的指纹覆盖基线。正常情况下两者
 * 是同一帧（距离≈0），但渲染端回传的是"最近一帧**门控画面**"的指纹 ——
 * 若它恰好是**变化之前**的那一帧，基线就被**倒回旧内容**，于是同一张卡的
 * **同一次刷新**会被再检出一次（真机日志里同一个距离 0.0735 出现两次）。
 *
 * ── 判据（一行）────────────────────────────────────────────────────────
 *
 * `reported` 到**检测帧**的距离 ≤ 到**旧基线**的距离 → 采信；
 * 否则说明它比检测帧更像"变化之前的内容" → **拒绝**（保持基线前进）。
 * 缺任何一侧（还没建立基线 / 旧渲染端不带指纹 / 检测帧无指纹）→ 采信
 * （与接线前的行为完全一致，绝不因为缺数据把基线卡住）。
 */
export function shouldAdoptReportedBaseline(input: RerollBaselineInput): boolean {
  const reported = input.reported;
  if (!reported || reported.length === 0) return false;
  const detection = input.detection;
  const previous = input.previous;
  if (!detection || detection.length === 0 || !previous || previous.length === 0) return true;
  const worstTo = (other: readonly (AugmentCardFingerprint | null)[]): number => {
    const n = Math.min(reported.length, other.length);
    let worst = 0;
    for (let i = 0; i < n; i++) {
      worst = Math.max(worst, fingerprintDistance(reported[i] ?? null, other[i] ?? null));
    }
    return worst;
  };
  return worstTo(detection) <= worstTo(previous);
}
