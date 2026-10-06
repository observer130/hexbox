/**
 * 多候选搜索区的**回退语义**测试
 *
 * 来自 2026-10-05 真机事故：窗口矩形探针**认错窗口**（游戏全屏 2293×960，
 * 探针给出别的 1600×900 窗口）→ 换算出的搜索区切掉外侧卡边框 → **整局 0 命中**。
 * 修法不是"猜探针可不可信"（窗口化游戏时探针给出的正是这种小而不等比的矩形，
 * 猜错就把窗口化支持弄坏），而是**两个候选区都搜**。
 *
 * 这里用**假检测器**锁回退语义（顺序、短路、兜底）；
 * 检测器本身的结构判据在真机帧上标定，用 `scripts/diag-augment-frames.mts` /
 * `diag-augment-cards.mts` 的离线回放核对 —— 试过按真机比例合成三张等宽卡，
 * 检测器仍不认（它的判据比"等宽+暗+亮边"更细），
 * 所以**不用合成图充当检测器的测试**，只用它测流程。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectAugmentPanel, detectAugmentPanelInRegions, firstHit, type PanelDetection } from './augment-panel.ts';
import type { Bitmap } from './types.ts';

const miss = (reason: string): PanelDetection => ({ found: false, cards: [], bands: 0, reason });
const hit = (n: number): PanelDetection => ({
  found: true,
  bands: n * 2,
  reason: `${n} 张卡片`,
  cards: Array.from({ length: n }, () => ({ rect: { x: 0, y: 0, w: 0, h: 0 }, interiorLuma: 27, edgeLuma: 140 })),
});

test('第二个候选区命中时：报告 regionIndex=1，且只试了 2 次', () => {
  const calls: number[] = [];
  const r = firstHit([0, 1, 2], (i) => {
    calls.push(i);
    return i === 1 ? hit(3) : miss('没找到');
  });
  assert.equal(r.detection.found, true);
  assert.equal(r.regionIndex, 1);
  assert.equal(r.tried, 2);
  assert.deepEqual(calls, [0, 1], '命中后不应继续搜后面的区');
});

test('第一个就命中：tried=1（不发生额外开销）', () => {
  let calls = 0;
  const r = firstHit([0, 1], () => {
    calls++;
    return hit(2);
  });
  assert.equal(r.regionIndex, 0);
  assert.equal(r.tried, 1);
  assert.equal(calls, 1);
});

test('都不命中：返回**第一个**的结果（保留最有信息量的原因）', () => {
  const r = firstHit([0, 1], (i) => miss(`区${i}没找到`));
  assert.equal(r.detection.found, false);
  assert.equal(r.regionIndex, -1);
  assert.equal(r.tried, 2);
  assert.equal(r.detection.reason, '区0没找到');
});

test('候选区为空：返回"没有候选搜索区"，tried=0，不抛', () => {
  const r = firstHit([], () => hit(3));
  assert.equal(r.detection.found, false);
  assert.equal(r.regionIndex, -1);
  assert.equal(r.tried, 0);
  assert.match(r.detection.reason, /没有候选搜索区/);
});

test('detectAugmentPanelInRegions：空区列表也不抛（真机入口的兜底）', () => {
  const W = 64;
  const H = 64;
  const data = new Uint8ClampedArray(W * H * 4);
  const bmp: Bitmap = { width: W, height: H, data };
  const r = detectAugmentPanelInRegions(bmp, []);
  assert.equal(r.detection.found, false);
  assert.equal(r.tried, 0);
});

test('detectAugmentPanelInRegions：全黑整帧 + 两个候选区 → 不命中且试满', () => {
  const W = 400;
  const H = 200;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) data[i + 3] = 255;
  const r = detectAugmentPanelInRegions({ width: W, height: H, data }, [
    { x: 0, y: 0, w: 0.5, h: 0.6 },
    { x: 0.1, y: 0.1, w: 0.8, h: 0.7 },
  ]);
  assert.equal(r.detection.found, false);
  assert.equal(r.regionIndex, -1);
  assert.equal(r.tried, 2);
});

test('detectAugmentPanel 本身：越界搜索区返回"搜索区越界"（不是抛异常）', () => {
  const W = 100;
  const H = 100;
  const data = new Uint8ClampedArray(W * H * 4);
  const d = detectAugmentPanel({ width: W, height: H, data }, { x: 0.9, y: 0.9, w: 0.5, h: 0.5 });
  assert.equal(d.found, false);
  assert.match(d.reason, /越界/);
});
