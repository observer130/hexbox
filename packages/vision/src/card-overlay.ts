/**
 * 选人阶段覆盖层布局（纯函数）
 *
 * 职责：给定识别到的卡片（归一化矩形）与该英雄的胜率数据，
 * 计算覆盖层要绘制的标签（屏幕逻辑坐标 + 内容）。
 *
 * 为什么放 vision 而不是主进程：布局含坐标换算与边界约束，
 * 是可单测的纯逻辑 —— 主进程只做截屏与 IPC（CI 跑不了）。
 */

import type { Rect } from './types.ts';
import type { CaptureGeometry } from './types.ts';
import { normalizedRectToScreen } from './geometry.ts';
/** 一个待绘制标签（屏幕逻辑坐标）。 */
export interface CardLabel {
  /** 标签矩形（屏幕逻辑坐标,DIP）。 */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** 主文本：胜率（如 "57.2%"）或 "暂无数据"。 */
  readonly text: string;
  /** 辅助文本：英雄名。 */
  readonly sub: string;
  /** 有官方统计时绿色,无数据时灰色（renderer 据此配色）。 */
  readonly hasData: boolean;
  /** 对应卡片的 championId（调试/日志用）。 */
  readonly championId: number;
}

export interface CardLabelOptions {
  /** 该英雄的选人阶段信息（core/champSelectInfo 的产物）。 */
  readonly name: string;
  readonly winRate: number;
  readonly hasData: boolean;
  readonly championId: number;
  /** 下方留白（DIP,标签与卡片底边的间距）。 */
  readonly gap?: number;
  /** 标签高度（DIP）。 */
  readonly labelHeight?: number;
  /** 标签宽度（DIP）。默认 `LABEL_WIDTH`（紧凑定宽）。 */
  readonly labelWidth?: number;
}

/**
 * 卡片标签宽度的**可选上限**（DIP）。
 *
 * ⚠️ 默认**不**使用它：卡片标签默认与卡片**同宽**（用户 2026-10-04 明确要求：
 * "显示宽度太窄了，最好和英雄卡片的宽度一致"）。保留此常量只是给调用方一个
 * 可显式传入的上限（见 `CardLabelOptions.labelWidth`）。
 *
 * 历史：默认值曾从"卡宽"改成 132（当时反馈"太宽"）—— 但那次真正的问题是
 * 标签**位置**压在卡片内容上；位置修好后用户确认希望与卡片同宽。
 */
export const LABEL_WIDTH = 132;

/**
 * 卡片标签与**检测框**下缘的默认间距（DIP）。
 *
 * ⚠️ 真机实测（2026-10-04，3413×1920 截屏）：检测框（y=477..1269）包住整张
 * 卡片，框内自上而下为「立绘 → 职业图标（y≈993..1037）→ 英雄名
 * （y≈1073..1100）→ 卡片圆角底边（≈1280）」。检测框下缘 1269 距圆角底边仅
 * 约 11 像素，所以间距只需**一点点**即可让标签落在卡片外。
 *
 * ⚠️ 历史踩坑（连改错五次方向，务必先读）：
 *   1. 6 →（在几何正确时）标签刚好贴住卡片底边，可用；曾在错误的前提下
 *      误判为"压住英雄名"；
 *   2. 233 等大值 → 在**错误几何**（把截屏当整屏、纵向刻度差 2 倍）下算出
 *      的 y 超出可用高度，被"贴底夹紧"→ 真机上标签掉到**右下角**
 *      （用户报告的现象）；
 *   3. 真正的根因不在这个常数，而是 `findGameWindowRect` 因 PowerShell
 *      抛错返回 null（见 win-geometry.ts 的 Add-Type 修复）。
 *
 * 现在几何基准正确（见 win-geometry.ts：选人界面由**客户端窗口**绘制），
 * 本值 14 使标签上缘落在卡片圆角底边下方约 8 像素。
 */
export const CARD_LABEL_GAP = 14;

/**
 * 卡片矩形（归一化）→ 下方标签（屏幕逻辑坐标）。
 *
 * 宽度**默认与卡片同宽**（用户要求）；显式传入 `labelWidth` 时按它收缩，
 * 但不超过卡宽。位置在检测框下缘 + `CARD_LABEL_GAP`；
 * 底部放不下时翻到卡片上方，并保证始终完整落在工作区内。
 */
export function cardLabelFor(
  cardRect: Rect,
  geo: CaptureGeometry,
  workArea: { x: number; y: number; width: number; height: number },
  options: CardLabelOptions,
): CardLabel {
  const gap = options.gap ?? CARD_LABEL_GAP;
  const h = options.labelHeight ?? 34;
  const card = normalizedRectToScreen(cardRect, geo);

  const pct = options.hasData
    ? `${(options.winRate * 100).toFixed(1)}%`
    : '暂无数据';

  // 默认与卡片同宽；显式给了 labelWidth 就按它收缩（不超卡宽）
  const w =
    options.labelWidth === undefined ? card.w : Math.min(card.w, options.labelWidth);
  const bottom = workArea.y + workArea.height;

  let y = card.y + card.h + gap;
  // 底部放不下 → 画到卡片上方
  if (y + h > bottom) {
    y = card.y - gap - h;
  }
  // 上下都放不下（卡片极高 / 间距很大 / 工作区很小）→ 贴底部，保证可见。
  // ⚠️ 这里必须同时夹住**上缘**：间距调到 233 DIP 后，翻转分支会算出
  // 负 y（标签被推到屏幕上边缘之外），真机上表现为"标签消失"。
  if (y < workArea.y || y + h > bottom) {
    y = bottom - h;
  }
  if (y < workArea.y) y = workArea.y;

  return {
    x: card.x + (card.w - w) / 2,
    y,
    w,
    h,
    text: pct,
    sub: options.name,
    hasData: options.hasData,
    championId: options.championId,
  };
}

/** 顶栏槽位标签选项（紧凑版,槽位盒只有 ~90 逻辑像素宽）。 */
export interface SlotLabelOptions {
  readonly name: string;
  readonly winRate: number;
  readonly hasData: boolean;
  readonly championId: number;
  /** 标签高度（DIP）。默认 26。 */
  readonly labelHeight?: number;
  /** 标签与槽位底缘的间距（DIP）。默认 4。 */
  readonly gap?: number;
}

/**
 * 顶栏槽位矩形（**截屏归一化**）→ 下方紧凑标签（屏幕逻辑坐标）。
 *
 * 与 cardLabelFor 的区别：
 *   - 输入是截屏空间的槽位矩形（调用方先用 win-geometry 的
 *     windowRectToCapture 把窗口归一化的槽位几何变换过来 ——
 *     与识别用同一坐标系,标签与头像必然对齐）;
 *   - 标签更紧凑（高 26、单行,渲染端据此缩字号）;
 *   - **不做上下翻转**：顶栏在屏幕最上方,下方必然有空间;
 *     越出工作区底缘时把 y 夹回工作区内（防御极端窗口位置）。
 */
export function slotLabelFor(
  captureSlotRect: Rect,
  geo: CaptureGeometry,
  workArea: { x: number; y: number; width: number; height: number },
  options: SlotLabelOptions,
): CardLabel {
  const gap = options.gap ?? 4;
  const h = options.labelHeight ?? 26;
  const slot = normalizedRectToScreen(captureSlotRect, geo);

  const pct = options.hasData ? `${(options.winRate * 100).toFixed(1)}%` : '暂无数据';
  // 槽位盒很窄（~90 DIP）,标签以槽位为中心、至少 56 宽,
  // 保证「54.6%」「暂无数据」单行放得下
  const w = Math.max(56, slot.w);

  let y = slot.y + slot.h + gap;
  // 防御：极端窗口位置下夹回工作区（顶栏场景正常不会触发）
  if (y + h > workArea.y + workArea.height) {
    y = workArea.y + workArea.height - h;
  }

  return {
    x: slot.x + slot.w / 2 - w / 2,
    y,
    w,
    h,
    text: pct,
    sub: options.name,
    hasData: options.hasData,
    championId: options.championId,
  };
}
