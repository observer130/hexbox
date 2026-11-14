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
