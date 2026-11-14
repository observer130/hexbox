/**
 * 像素采样与统计小工具（纯函数，零 Node/Electron 依赖）
 *
 * 审计 P3：`lumaAt` 曾在 `grid.ts` / `champ-select-cards.ts` / `augment-presence.ts`
 * 各写一份，`median` 在 `augment-label.ts` / `champ-select-cards.ts` 各写一份。
 * 这些函数的语义（Rec.601 权重、中位数取整/空数组约定）是识别判据的地基，
 * 多份实现迟早漂移，因此收敛到这里**唯一一份**。
 *
 * 约定（不要改，改了要重标定门控/卡片判据）：
 *   - 亮度 = 0.299R + 0.587G + 0.114B（Rec.601 近似），输入是 RGBA 四通道；
 *   - 中位数偶数个取中间两值均值；空数组调用方决定语义（见两个包装函数）。
 */

import type { Bitmap } from './types.ts';

/** 按 RGBA 字节 + 宽度取亮度（0..255）。 */
export function lumaAtRgba(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
): number {
  const i = (y * width + x) * 4;
  return 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
}

/** 按位图坐标取亮度（`Bitmap` 已带宽度）。 */
export function lumaAt(bmp: Bitmap, x: number, y: number): number {
  return lumaAtRgba(bmp.data, bmp.width, x, y);
}

/**
 * 中位数（空数组 → `null`；**不改动入参** —— 自己拷一份排序）。
 *
 * 用于"取一排卡片的基准值"这类调用方：入参可能还要复用。
 */
export function medianOrNull(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * 中位数（空数组 → `NaN`；**原地排序**入参）。
 *
 * 用于"临时采样数组一次性消费"的热路径（省一次拷贝）；调用方已按上面约定
 * 用 `Number.isNaN` 判"取不到样"。需要保留入参时用 {@link medianOrNull}。
 */
export function medianInPlace(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  return values.length % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
}
