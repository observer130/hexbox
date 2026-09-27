/**
 * label-memory 测试：跨轮保留缺失标签（检测闪烁下的显示连续性）
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLabelMemory } from './label-memory.ts';
import type { CardLabel } from './card-overlay.ts';

function label(x: number, text: string): CardLabel {
  return { x, y: 100, w: 60, h: 26, text, sub: '', hasData: true, championId: 1 };
}

test('rememberLabels：部分失败时保留 TTL 内的旧标签', () => {
  const mem = createLabelMemory();
  // 第 1 轮:3 张卡片全部识别
  const r1 = mem.update([label(100, '57.2%'), label(300, '51.4%'), label(500, '48.9%')], 1, true);
  assert.equal(r1.length, 3);
  // 第 2 轮:第三张卡片检测失败（部分失败）—— 前两张覆盖,第三张从记忆补齐
  const r2 = mem.update([label(100, '57.2%'), label(300, '51.4%')], 2, true);
  assert.equal(r2.length, 3, '第三张标签应从记忆保留');
  assert.ok(r2.some((l) => l.x === 500 && l.text === '48.9%'));
});

test('rememberLabels：超过 TTL 后旧标签真正消失', () => {
  const mem = createLabelMemory();
  mem.update([label(100, '57.2%'), label(500, '48.9%')], 1, true);
  // 第 2 轮起,第二张持续缺失;默认 TTL=6 → 第 8 轮起消失
  let last: CardLabel[] = [];
  for (let round = 2; round <= 9; round++) {
    last = mem.update([label(100, '57.2%')], round, true);
    if (round <= 7) assert.equal(last.length, 2, `第 ${round} 轮应仍保留`);
  }
  assert.equal(last.length, 1, 'TTL 过后第二张应消失');
});

test('rememberLabels：新识别覆盖同位旧标签（数据更新）', () => {
  const mem = createLabelMemory();
  mem.update([label(100, '57.2%')], 1, true);
  // 同位置文本变化（新数据）→ 应以新的为准,不产生重复
  const r2 = mem.update([label(100, '58.1%')], 2, true);
  assert.equal(r2.length, 1);
  assert.equal(r2[0]!.text, '58.1%');
});

test('rememberLabels：整轮失败按 TTL 衰减而非立即清空', () => {
  const mem = createLabelMemory();
  mem.update([label(100, '57.2%')], 1, true);
  // 连续失败（< TTL=6）→ 保留
  assert.equal(mem.update([], 2, false).length, 1);
  assert.equal(mem.update([], 4, false).length, 1);
  assert.equal(mem.update([], 7, false).length, 1);
  // 超过 TTL → 清空
  assert.equal(mem.update([], 8, false).length, 0);
});

test('rememberLabels：位置容差内视为同一元素', () => {
  const mem = createLabelMemory();
  mem.update([label(100, '57.2%')], 1, true);
  // 下一轮卡片矩形抖动几像素 → 仍应覆盖而非并存
  const r2 = mem.update([label(108, '57.2%')], 2, true);
  assert.equal(r2.length, 1);
  assert.equal(r2[0]!.x, 108);
});

test('rememberLabels：reset 后记忆清空', () => {
  const mem = createLabelMemory();
  mem.update([label(100, '57.2%')], 1, true);
  mem.reset();
  assert.equal(mem.update([], 2, false).length, 0);
});
