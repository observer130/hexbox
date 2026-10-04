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

/** 卡片标签的默认宽度（DIP）：够放下「100.0%」，且不横贯整张卡片。 */
export const LABEL_WIDTH = 132;

/**
 * 卡片矩形（归一化）→ 下方标签（屏幕逻辑坐标）。
 *
 * ⚠️ 标签**不与卡片同宽**：真机反馈"标签宽度太大"（卡片宽约 333 DIP，
 * 整条横贯卡片下方非常突兀）。改为**紧凑定宽**并相对卡片水平居中；
 * 仅当卡片本身比它更窄时才收缩到卡宽。
 * 位置仍在卡片下缘 + gap；底部放不下时翻到卡片上方。
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

  const w = Math.min(card.w, options.labelWidth ?? LABEL_WIDTH);

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
