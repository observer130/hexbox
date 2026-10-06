/**
 * 覆盖层画布纯计算的测试。
 *
 * 这一层锁的是真机事故（2026-10-05「画了但屏幕上什么都没有」）的两个前提：
 *   1. 画布位图尺寸 = 窗口内尺寸 × DPR（含 0 尺寸 / 非法 DPR 的兜底）；
 *   2. 主进程的**屏幕绝对**坐标 → 渲染端的**窗口内**坐标（副屏原点非 0 时）。
 * 渲染端本身在 CI 里跑不起来（Electron + 管理员 + 真实桌面），所以这两件事
 * 只能在这里被盯住。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canvasBitmapSize, toWindowRelativeLabels } from './label-overlay-coords.ts';

/** 真机：2294×912 DIP @1.5 → 3441×1368 物理像素。 */
const REAL_W = 2294;
const REAL_H = 912;

test('canvasBitmapSize：位图尺寸 = 窗口内尺寸 × DPR（真机 2294×912 @1.5）', () => {
  assert.deepEqual(canvasBitmapSize(REAL_W, REAL_H, 1.5), { width: 3441, height: 1368 });
});

test('canvasBitmapSize：DPR=1 时与逻辑尺寸相同', () => {
  assert.deepEqual(canvasBitmapSize(1280, 720, 1), { width: 1280, height: 720 });
});

test('canvasBitmapSize：四舍五入到整数像素', () => {
  // 1920×1080 @1.25 → 2400×1350（恰好整数）；1301 @1.5 → 1951.5 → 1952
  assert.deepEqual(canvasBitmapSize(1301, 867, 1.5), { width: 1952, height: 1301 });
});

test('canvasBitmapSize：非法/缺失 DPR 退化为 1（不做 0 倍或 NaN 画布）', () => {
  for (const dpr of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(canvasBitmapSize(800, 600, dpr), { width: 800, height: 600 }, `dpr=${dpr}`);
  }
});

test('canvasBitmapSize：尺寸下限 1×1（窗口尚未布局时 innerWidth 可能是 0）', () => {
  assert.deepEqual(canvasBitmapSize(0, 0, 1.5), { width: 1, height: 1 });
  assert.deepEqual(canvasBitmapSize(Number.NaN, 100, 1), { width: 1, height: 100 });
});

test('canvasBitmapSize：与「画布默认 300×150」明确不同（默认值 = 没人设过尺寸）', () => {
  const real = canvasBitmapSize(REAL_W, REAL_H, 1.5);
  assert.notEqual(real.width, 300);
  assert.notEqual(real.height, 150);
});

test('toWindowRelativeLabels：主显示器（原点 0,0）坐标不变，附加字段保留', () => {
  const labels = [{ x: 32, y: 356, w: 300, h: 200, text: 'L', color: '#4ade80' }];
  const out = toWindowRelativeLabels(labels, { x: 0, y: 0 });
  assert.deepEqual(out, labels);
  assert.equal(out[0]?.color, '#4ade80');
});

test('toWindowRelativeLabels：工作区原点非 0（副屏/任务栏）时按原点平移', () => {
  const labels = [{ x: 1952, y: 476, w: 300, h: 200 }];
  const out = toWindowRelativeLabels(labels, { x: 1920, y: 120 });
  assert.deepEqual(out, [{ x: 32, y: 356, w: 300, h: 200 }]);
});

test('toWindowRelativeLabels：只平移 x/y（w/h 与顺序不变）', () => {
  const labels = [
    { x: 100, y: 100, w: 10, h: 20 },
    { x: 200, y: 300, w: 30, h: 40 },
  ];
  const out = toWindowRelativeLabels(labels, { x: 50, y: 60 });
  assert.deepEqual(
    out.map((l) => [l.w, l.h]),
    [
      [10, 20],
      [30, 40],
    ],
  );
  assert.deepEqual(out[1], { x: 150, y: 240, w: 30, h: 40 });
});
