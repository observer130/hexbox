/**
 * `pixels.ts` 单测
 *
 * 这是识别判据的地基（亮度/中位数），多条链路共享一份实现后必须锁住：
 * Rec.601 权重、RGBA 步长、中位数奇偶/空数组/是否改入参。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lumaAt, lumaAtRgba, medianInPlace, medianOrNull } from './pixels.ts';

/** 造一张 2x1 的位图：左像素纯红、右像素纯白。 */
function twoPixelBitmap() {
  return {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([255, 0, 0, 255, 255, 255, 255, 255]),
  };
}

test('lumaAtRgba：Rec.601 权重与 RGBA 步长（红 255 → 76.245）', () => {
  const bmp = twoPixelBitmap();
  assert.equal(lumaAtRgba(bmp.data, bmp.width, 0, 0), 0.299 * 255);
  assert.equal(lumaAtRgba(bmp.data, bmp.width, 1, 0), 255);
});

test('lumaAt：按位图坐标取亮度，与 lumaAtRgba 一致', () => {
  const bmp = twoPixelBitmap();
  assert.equal(lumaAt(bmp, 0, 0), lumaAtRgba(bmp.data, 2, 0, 0));
  assert.equal(lumaAt(bmp, 1, 0), 255);
});

test('medianOrNull：奇数/偶数/单元素/空数组；不改动入参', () => {
  assert.equal(medianOrNull([]), null);
  assert.equal(medianOrNull([7]), 7);
  assert.equal(medianOrNull([3, 1, 2]), 2);
  assert.equal(medianOrNull([4, 1, 3, 2]), 2.5);
  const input = [3, 1, 2];
  medianOrNull(input);
  assert.deepEqual(input, [3, 1, 2], 'medianOrNull 不许原地排序');
});

test('medianInPlace：空数组 → NaN；偶数取均值；允许原地排序', () => {
  assert.ok(Number.isNaN(medianInPlace([])));
  assert.equal(medianInPlace([3, 1, 2]), 2);
  assert.equal(medianInPlace([4, 1, 3, 2]), 2.5);
  const input = [3, 1, 2];
  medianInPlace(input);
  assert.deepEqual(input, [1, 2, 3], 'medianInPlace 明确原地排序（省拷贝的热路径约定）');
});
