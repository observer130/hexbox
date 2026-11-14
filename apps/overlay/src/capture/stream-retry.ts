/**
 * 屏幕流重建策略（纯函数）
 *
 * 背景（审查 P1）：`getDisplayMedia` 的 track 在游戏切分辨率 / 窗口↔全屏时会被
 * 系统结束。旧实现只把 `stream=null` 并打一行"将重建"——**没有任何代码真的重建**，
 * 于是本局标签静默失效到结束。
 *
 * 这里只放"第几次重试、等多久、什么时候放弃"的判据，便于单测；
 * 真正 `getDisplayMedia` 的调用在 `worker.ts`（浏览器 API，CI 不可测）。
 */

/** 最多尝试重建几次（含成功机会）；用尽后明确报错而不是无声空转。 */
export const STREAM_REBUILD_MAX_ATTEMPTS = 5;

/** 首次重试的等待时间；之后指数退避。 */
export const STREAM_REBUILD_BASE_DELAY_MS = 1_000;

/** 单次重试等待上限（避免指数退避到几分钟）。 */
export const STREAM_REBUILD_MAX_DELAY_MS = 8_000;

/**
 * 第 `attempt` 次重建前应等待多久（1-based）。
 *
 * 返回 `null` = 超过最大次数，调用方应放弃并明确报错。
 * 非法输入（0/负数/小数/NaN/Infinity）返回 `null`，由调用方按"不重试"处理。
 */
export function streamRebuildDelayMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  if (attempt > STREAM_REBUILD_MAX_ATTEMPTS) return null;
  const delay = STREAM_REBUILD_BASE_DELAY_MS * 2 ** (attempt - 1);
  return Math.min(STREAM_REBUILD_MAX_DELAY_MS, delay);
}
