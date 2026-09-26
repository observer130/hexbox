/**
 * 坐标换算
 *
 * 这是整个截屏方案**最容易出错**的地方，原因：
 *   1. 截屏分辨率 ≠ 屏幕逻辑分辨率（实测倍率 2.0）
 *   2. 游戏窗口可能小于显示器，存在窗口偏移
 *   3. DPI 缩放（1.5）会再叠一层
 *
 * 处理策略：内部一律用**归一化坐标**（0..1）作为中间表示，
 * 与分辨率彻底解耦；只在最后一步换算到屏幕绝对坐标。
 */

import type { CaptureGeometry, Rect } from './types.ts';

/**
 * 截屏像素 → 归一化（0..1）。
 *
 * 归一化后与分辨率无关，跨设备/跨缩放稳定，因此作为内部通用表示。
 */
export function toNormalized(
  px: number,
  py: number,
  geo: CaptureGeometry,
): { x: number; y: number } {
  if (geo.captureWidth <= 0 || geo.captureHeight <= 0) {
    return { x: 0, y: 0 };
  }
  return { x: px / geo.captureWidth, y: py / geo.captureHeight };
}

/** 归一化 → 截屏像素。 */
export function toCapturePixels(
  nx: number,
  ny: number,
  geo: CaptureGeometry,
): { x: number; y: number } {
  return { x: nx * geo.captureWidth, y: ny * geo.captureHeight };
}

/**
 * 归一化矩形 → **屏幕逻辑坐标**矩形。
 *
 * 这是绘制覆盖层时真正要用的坐标：Electron 的窗口定位用的是
 * 屏幕逻辑坐标（DIP），不是物理像素。
 */
export function normalizedRectToScreen(rect: Rect, geo: CaptureGeometry): Rect {
  return {
    x: geo.windowX + rect.x * geo.windowWidth,
    y: geo.windowY + rect.y * geo.windowHeight,
    w: rect.w * geo.windowWidth,
    h: rect.h * geo.windowHeight,
  };
}

/** 截屏像素矩形 → 归一化矩形。 */
export function captureRectToNormalized(rect: Rect, geo: CaptureGeometry): Rect {
  if (geo.captureWidth <= 0 || geo.captureHeight <= 0) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  return {
    x: rect.x / geo.captureWidth,
    y: rect.y / geo.captureHeight,
    w: rect.w / geo.captureWidth,
    h: rect.h / geo.captureHeight,
  };
}

/**
 * 从截屏尺寸与窗口信息推导换算参数。
 *
 * @param captureWidth  截屏图像宽（像素）
 * @param captureHeight 截屏图像高（像素）
 * @param window        被截窗口在屏幕逻辑坐标下的矩形
 */
export function makeGeometry(
  captureWidth: number,
  captureHeight: number,
  window: { x: number; y: number; width: number; height: number },
): CaptureGeometry {
  return {
    captureWidth,
    captureHeight,
    windowX: window.x,
    windowY: window.y,
    windowWidth: window.width,
    windowHeight: window.height,
  };
}

/**
 * 把矩形按边距**收缩**（负边距即扩张）。
 *
 * 用于从卡片外框取内部头像区域 —— 卡片边框会干扰匹配，
 * 必须往里缩一点。
 */
export function insetRect(rect: Rect, dx: number, dy = dx): Rect {
  const w = Math.max(0, rect.w - dx * 2);
  const h = Math.max(0, rect.h - dy * 2);
  return { x: rect.x + dx, y: rect.y + dy, w, h };
}

/** 两个矩形是否重叠（用于去重检测结果）。 */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 矩形面积。 */
export function rectArea(r: Rect): number {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

/** 矩形中心点。 */
export function rectCenter(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}
