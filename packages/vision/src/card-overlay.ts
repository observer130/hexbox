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
}

/**
 * 卡片矩形（归一化）→ 下方标签（屏幕逻辑坐标）。
 *
 * 标签宽度 = 卡片宽度（视觉上与卡片对齐）；位置在卡片下缘 + gap。
 * 若标签超出所在显示器底部（窗口贴边）,改画在卡片**上方**。
 */
export function cardLabelFor(
  cardRect: Rect,
  geo: CaptureGeometry,
  workArea: { x: number; y: number; width: number; height: number },
  options: CardLabelOptions,
): CardLabel {
  const gap = options.gap ?? 6;
  const h = options.labelHeight ?? 34;
  const card = normalizedRectToScreen(cardRect, geo);

  const pct = options.hasData
    ? `${(options.winRate * 100).toFixed(1)}%`
    : '暂无数据';

  let y = card.y + card.h + gap;
  // 底部放不下 → 画到卡片上方
  if (y + h > workArea.y + workArea.height) {
    y = card.y - gap - h;
  }
  // 仍越界（理论上不会）→ 贴显示器底部
  if (y + h > workArea.y + workArea.height) {
    y = workArea.y + workArea.height - h;
  }

  return {
    x: card.x,
    y,
    w: card.w,
    h,
    text: pct,
    sub: options.name,
    hasData: options.hasData,
    championId: options.championId,
  };
}
