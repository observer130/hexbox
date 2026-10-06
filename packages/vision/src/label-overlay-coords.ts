/**
 * 覆盖层画布的**纯计算**（渲染端与主进程共用，CI 里可单测）
 *
 * 为什么单独成文件 —— 两处都踩过、都要能被测试盯住：
 *
 * 1. **画布位图尺寸只取决于窗口自身**。`canvas.width/height` 是**物理像素**，
 *    必须等于 `窗口内尺寸 × devicePixelRatio`；HTML 默认是 300×150。
 *    一旦没人设它（脚本没加载、或只在某条"只推一次"的消息里设），
 *    按 2294×912 算出来的标签坐标就全落在画布之外 —— 真机表现正是
 *    "报告里画了、屏幕上什么都没有"（2026-10-05）。
 * 2. **主进程给的是屏幕绝对坐标，渲染端画的是窗口内坐标**。这块画布铺满
 *    显示器工作区，所以两者只差一个 `workArea` 原点；游戏在主显示器时
 *    原点恰是 0,0，一切"看起来都对"，换到副屏才错位 —— 这种事只能靠
 *    一处换算 + 单测，不能靠每处调用各自记得减一次。
 */

import type { Rect } from './types.ts';

/** 画布位图尺寸（物理像素）。 */
export interface CanvasBitmapSize {
  readonly width: number;
  readonly height: number;
}

/**
 * 窗口内逻辑尺寸（CSS px / DIP）+ devicePixelRatio → 画布位图尺寸。
 *
 * 规则（每条都对应一种真实故障）：
 *   · `dpr` 缺失/非法（NaN、≤0）→ 按 1（与 `window.devicePixelRatio || 1` 同义）；
 *   · 四舍五入到整数 —— 画布尺寸只能是整数像素；
 *   · **下限 1×1**：窗口还没布局完（或最小化）时 `innerWidth` 可能是 0，
 *     把 0 写进 `canvas.width` 会让之后所有绘制静默失效。
 */
export function canvasBitmapSize(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): CanvasBitmapSize {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return {
    width: Math.max(1, Math.round((Number.isFinite(cssWidth) ? cssWidth : 0) * scale)),
    height: Math.max(1, Math.round((Number.isFinite(cssHeight) ? cssHeight : 0) * scale)),
  };
}

/**
 * 屏幕绝对坐标（DIP）→ **窗口内坐标**（DIP）。
 *
 * 只平移、不改尺寸：画布铺满工作区，所以 `origin` 就是该显示器工作区原点。
 * 泛型只为保留调用方的附加字段（胜率文本、档位配色、卡片 ID 等），
 * 不改变任何几何。
 */
export function toWindowRelativeLabels<T extends Rect>(
  labels: readonly T[],
  origin: { readonly x: number; readonly y: number },
): T[] {
  return labels.map((l) => ({ ...l, x: l.x - origin.x, y: l.y - origin.y }));
}
