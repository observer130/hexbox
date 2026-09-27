/**
 * geometry 测试
 *
 * 这是截屏方案最容易出错的一环（分辨率/DPI/窗口偏移三重换算），
 * 因此测试要覆盖真实实测参数，而不只是理想情况。
 *
 * 实测环境：显示器 2294×960 @1.5 DPI，截屏 4587×1920（倍率 ≈2.0）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  captureRectToNormalized,
  insetRect,
  makeGeometry,
  normalizedRectToScreen,
  rectArea,
  rectCenter,
  rectsOverlap,
  toCapturePixels,
  toNormalized,
} from './geometry.ts';
import { windowRectToCapture } from './win-geometry.ts';
import type { Rect } from './types.ts';

/** 实测环境：全屏窗口。 */
const REAL = makeGeometry(4587, 1920, { x: 0, y: 0, width: 2294, height: 960 });

test('toNormalized：截屏像素 → 0..1', () => {
  const p = toNormalized(4587, 1920, REAL);
  assert.equal(p.x, 1);
  assert.equal(p.y, 1);

  const half = toNormalized(4587 / 2, 1920 / 2, REAL);
  assert.ok(Math.abs(half.x - 0.5) < 1e-9);
  assert.ok(Math.abs(half.y - 0.5) < 1e-9);
});

test('toNormalized/toCapturePixels：往返一致', () => {
  const px = 1234;
  const py = 567;
  const n = toNormalized(px, py, REAL);
  const back = toCapturePixels(n.x, n.y, REAL);
  assert.ok(Math.abs(back.x - px) < 1e-9);
  assert.ok(Math.abs(back.y - py) < 1e-9);
});

test('toNormalized：尺寸为 0 时返回 0（不产生 NaN/Infinity）', () => {
  const bad = makeGeometry(0, 0, { x: 0, y: 0, width: 100, height: 100 });
  const p = toNormalized(10, 10, bad);
  assert.equal(p.x, 0);
  assert.equal(p.y, 0);
  assert.ok(Number.isFinite(p.x));
});

test('normalizedRectToScreen：全屏窗口下的换算', () => {
  // 屏幕中间的 10% 宽矩形
  const screen = normalizedRectToScreen({ x: 0.45, y: 0.4, w: 0.1, h: 0.2 }, REAL);
  assert.ok(Math.abs(screen.x - 0.45 * 2294) < 1e-9);
  assert.ok(Math.abs(screen.y - 0.4 * 960) < 1e-9);
  assert.ok(Math.abs(screen.w - 0.1 * 2294) < 1e-9);
  assert.ok(Math.abs(screen.h - 0.2 * 960) < 1e-9);
});

test('normalizedRectToScreen：窗口有偏移时叠加偏移', () => {
  // 游戏窗口不是全屏：位于 (100, 50)，尺寸 1280×720
  const geo = makeGeometry(2560, 1440, { x: 100, y: 50, width: 1280, height: 720 });
  const screen = normalizedRectToScreen({ x: 0, y: 0, w: 0.5, h: 0.5 }, geo);
  assert.equal(screen.x, 100); // 必须加窗口偏移
  assert.equal(screen.y, 50);
  assert.equal(screen.w, 640);
  assert.equal(screen.h, 360);
});

test('normalizedRectToScreen：右下角端点应落在窗口右下', () => {
  const geo = makeGeometry(2560, 1440, { x: 100, y: 50, width: 1280, height: 720 });
  const r = normalizedRectToScreen({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, geo);
  assert.equal(r.x + r.w, 100 + 1280);
  assert.equal(r.y + r.h, 50 + 720);
});

test('captureRectToNormalized：截屏像素矩形 → 归一化', () => {
  const n = captureRectToNormalized({ x: 2293.5, y: 960, w: 2293.5, h: 960 }, REAL);
  assert.ok(Math.abs(n.x - 0.5) < 1e-9);
  assert.ok(Math.abs(n.y - 0.5) < 1e-9);
  assert.ok(Math.abs(n.w - 0.5) < 1e-9);
  assert.ok(Math.abs(n.h - 0.5) < 1e-9);
});

test('captureRectToNormalized：尺寸为 0 时安全返回', () => {
  const bad = makeGeometry(0, 0, { x: 0, y: 0, width: 1, height: 1 });
  const n = captureRectToNormalized({ x: 1, y: 1, w: 1, h: 1 }, bad);
  assert.deepEqual(n, { x: 0, y: 0, w: 0, h: 0 });
});

test('insetRect：收缩四周（用于避开卡片边框）', () => {
  const r = insetRect({ x: 0.1, y: 0.2, w: 0.4, h: 0.6 }, 0.05);
  assert.ok(Math.abs(r.x - 0.15) < 1e-9);
  assert.ok(Math.abs(r.y - 0.25) < 1e-9);
  assert.ok(Math.abs(r.w - 0.3) < 1e-9);
  assert.ok(Math.abs(r.h - 0.5) < 1e-9);
});

test('insetRect：过度收缩时钳到 0，不产生负数宽高', () => {
  const r = insetRect({ x: 0.4, y: 0.4, w: 0.1, h: 0.1 }, 0.2);
  assert.equal(r.w, 0);
  assert.equal(r.h, 0);
  assert.ok(r.w >= 0 && r.h >= 0);
});

test('rectsOverlap：重叠/相邻/分离', () => {
  const a = { x: 0, y: 0, w: 1, h: 1 };
  assert.equal(rectsOverlap(a, { x: 0.5, y: 0.5, w: 1, h: 1 }), true);
  assert.equal(rectsOverlap(a, { x: 1, y: 0, w: 1, h: 1 }), false); // 仅相切不算重叠
  assert.equal(rectsOverlap(a, { x: 5, y: 5, w: 0.1, h: 0.1 }), false);
});

test('rectArea / rectCenter', () => {
  const r = { x: 0.1, y: 0.2, w: 0.4, h: 0.5 };
  assert.ok(Math.abs(rectArea(r) - 0.2) < 1e-9);
  const c = rectCenter(r);
  assert.ok(Math.abs(c.x - 0.3) < 1e-9);
  assert.ok(Math.abs(c.y - 0.45) < 1e-9);
});

test('makeGeometry：完整保留窗口信息', () => {
  const g = makeGeometry(100, 200, { x: 1, y: 2, width: 3, height: 4 });
  assert.equal(g.captureWidth, 100);
  assert.equal(g.captureHeight, 200);
  assert.equal(g.windowX, 1);
  assert.equal(g.windowY, 2);
  assert.equal(g.windowWidth, 3);
  assert.equal(g.windowHeight, 4);
});

test('windowRectToCapture：window 形态恒等', () => {
  // window 快照形态（winShare ≥ 0.9）:窗口归一化 = 截屏归一化
  const capture = { width: 1600, height: 900 };
  const windowRect = { x: 0, y: 0, width: 1600, height: 900 };
  const display = { bounds: { x: 0, y: 0, width: 1600, height: 900 }, scaleFactor: 1 };
  const r: Rect = { x: 0.25, y: 0.1, w: 0.05, h: 0.08 };
  assert.deepEqual(windowRectToCapture(r, capture, windowRect, display), r);
});

test('windowRectToCapture：display 形态平移缩放（真机口径）', () => {
  // 真机:截屏 3413×1920 ≈ 显示器逻辑 2400×1350 的等比缩放,
  // 窗口逻辑 1600×900 @ (313,1)（GetWindowRect 直出）。
  // 窗口在截屏里的归一化范围: nx0=313/2400≈0.1304, nw=1600/2400≈0.6667。
  // 窗口内 0.5 → 截屏 0.1304 + 0.5×0.6667 ≈ 0.4638。
  const capture = { width: 3413, height: 1920 };
  const windowRect = { x: 313, y: 1, width: 1600, height: 900 };
  const display = { bounds: { x: 0, y: 0, width: 2400, height: 1350 }, scaleFactor: 1.5 };
  const r: Rect = { x: 0.5, y: 0.5, w: 0.1, h: 0.1 };
  const out = windowRectToCapture(r, capture, windowRect, display);
  assert.ok(Math.abs(out.x - (313 / 2400 + 0.5 * (1600 / 2400))) < 1e-9, `out.x=${out.x}`);
  assert.ok(Math.abs(out.w - 0.1 * (1600 / 2400)) < 1e-9);
  assert.ok(Math.abs(out.y - (1 / 1350 + 0.5 * (900 / 1350))) < 1e-9);
});

test('windowRectToCapture：无窗口矩形时恒等（兜底口径）', () => {
  const capture = { width: 3413, height: 1920 };
  const display = { bounds: { x: 0, y: 0, width: 2400, height: 1350 }, scaleFactor: 1.5 };
  const r: Rect = { x: 0.3, y: 0.2, w: 0.04, h: 0.07 };
  assert.deepEqual(windowRectToCapture(r, capture, null, display), r);
});
