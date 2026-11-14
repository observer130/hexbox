/**
 * 等可写流**彻底关闭**（Windows 上删文件前的必要步骤）
 *
 * 为什么不能直接 `await once(stream, 'close')`：如果流已经因为**错误**关闭，
 * `close` 事件已经发过，再等一次就永远不 resolve —— 更新下载失败路径会卡在
 * "正在下载更新…"，错误弹窗与手动下载页永远不出现（审查 P1）。
 *
 * `finished()` 对"已关闭 / 已销毁"的流会立即返回（或抛出已发生的错误），
 * 再加一个超时兜底，保证任何边缘情况都不会挂住调用方。
 */

import { finished } from 'node:stream/promises';
import type { Writable } from 'node:stream';

/** 等待可写流关闭的兜底超时（正常情况是毫秒级）。 */
export const WRITABLE_CLOSE_TIMEOUT_MS = 2_000;

/**
 * 等 `stream` 关闭；已关闭则立即返回，出错关闭也视为"已关闭"，**永不拒绝**。
 *
 * @param stream 目标可写流（调用方负责先 `destroy()`/`end()`）
 * @param timeoutMs 兜底超时；超时后照样返回（调用方继续做清理）
 */
export async function waitWritableClosed(
  stream: Writable,
  timeoutMs: number = WRITABLE_CLOSE_TIMEOUT_MS,
): Promise<void> {
  if (stream.closed) return;
  const closed = finished(stream).catch(() => undefined);
  await Promise.race([
    closed,
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    }),
  ]);
}
