/**
 * 覆盖窗自测标签的几何测试（CI 里 Electron 跑不起来，但"自测看不见"
 * 绝不能是几何算错造成的假象 —— 所以几何必须被单测锁住）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { labelOverlaySelftestLabels, type SelfTestWorkArea } from './label-selftest.ts';

/** 真机分辨率（2294×960 DIP @1.5 → 3440×1440 物理；任务栏占 48）。 */
const REAL: SelfTestWorkArea = { x: 0, y: 0, width: 2294, height: 912 };
/** 副显示器（工作区原点不是 0,0）。 */
const SECOND: SelfTestWorkArea = { x: 1920, y: 120, width: 1920, height: 1080 };
/** 小屏。 */
const SMALL: SelfTestWorkArea = { x: 0, y: 0, width: 800, height: 600 };

function inside(wa: SelfTestWorkArea, l: { x: number; y: number; w: number; h: number }): boolean {
  return (
    l.x >= wa.x &&
    l.y >= wa.y &&
    l.x + l.w <= wa.x + wa.width &&
    l.y + l.h <= wa.y + wa.height
  );
}

test('labelOverlaySelftestLabels：左/中/右三个标签，字母 L/C/R', () => {
  const labels = labelOverlaySelftestLabels(REAL);
  assert.equal(labels.length, 3);
  assert.deepEqual(
    labels.map((l) => l.text),
    ['L', 'C', 'R'],
  );
  assert.deepEqual(
    labels.map((l) => l.sub),
    ['左 可见', '中 可见', '右 可见'],
  );
});

test('labelOverlaySelftestLabels：三个标签全部完整落在工作区内（多显示器原点也对）', () => {
  for (const wa of [REAL, SECOND, SMALL]) {
    for (const l of labelOverlaySelftestLabels(wa)) {
      assert.ok(inside(wa, l), `标签 ${l.text} 越界: ${JSON.stringify(l)} in ${JSON.stringify(wa)}`);
    }
  }
});

test('labelOverlaySelftestLabels：左 < 中 < 右，且互不重叠', () => {
  const [left, center, right] = labelOverlaySelftestLabels(REAL);
  assert.ok(left !== undefined && center !== undefined && right !== undefined);
  assert.ok(left.x < center.x && center.x < right.x);
  assert.ok(left.x + left.w <= center.x);
  assert.ok(center.x + center.w <= right.x);
});

test('labelOverlaySelftestLabels：字足够大（1080p 下高 ≥100px，不可能"看不见"）', () => {
  const labels = labelOverlaySelftestLabels(SECOND);
  for (const l of labels) assert.ok(l.h >= 100, `标签 ${l.text} 太小: h=${l.h}`);
});

test('labelOverlaySelftestLabels：小屏按比例缩小（不出负数、不留 0 尺寸）', () => {
  for (const l of labelOverlaySelftestLabels(SMALL)) {
    assert.ok(l.w > 0 && l.h > 0);
    assert.ok(l.x >= 0 && l.y >= 0);
  }
});

test('labelOverlaySelftestLabels：纯函数（同输入同输出，颜色互不相同）', () => {
  const a = labelOverlaySelftestLabels(REAL);
  const b = labelOverlaySelftestLabels(REAL);
  assert.deepEqual(a, b);
  assert.equal(new Set(a.map((l) => l.color)).size, 3);
});
