/**
 * label-memory 测试：跨轮保留缺失标签（检测闪烁下的显示连续性）
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLabelMemory } from './label-memory.ts';
import type { CardLabel } from './card-overlay.ts';

function label(x: number, text: string, y = 100): CardLabel {
  return { x, y, w: 60, h: 26, text, sub: '', hasData: true, championId: 1 };
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

/* ------------------------------------------------------------------ */
/* 容量上限：误检产生的"幽灵标签"绝不能进来（真机 bug，2026-10-11）        */
/* ------------------------------------------------------------------ */

test('容量上限：先误检 1 张（远离位置）→ 再正确 3 张 → 输出 3 且不含误检位置', () => {
  const mem = createLabelMemory();
  // 轮 1：detectCards 误检成 2 张、名字只低置信命中 1 张 →
  // 产出 1 个标签 @(1160,621)（真机打包版日志 L34 的原始读数，w=236.27）
  const ghost: CardLabel = { x: 1160, y: 621, w: 236.27307354233812, h: 34, text: '48.5%', sub: '旧英雄名', hasData: true, championId: 9 };
  const r1 = mem.update([ghost], 1, true);
  assert.equal(r1.length, 1);
  // 轮 2：正确检出 3 张 → 3 个标签与那个幽灵**两两都差 > 24 DIP（容差）**
  const real = [label(757, '54.8%', 614), label(1108, '51.2%', 614), label(1460, '49.9%', 614)];
  const r2 = mem.update(real, 2, true);
  assert.equal(r2.length, 3, '3 张卡就只能显示 3 个（改前这里是 4 个 = 幽灵残留）');
  assert.ok(
    !r2.some((l) => l.x === 1160 && l.y === 621),
    '误检位置 (1160,621) 的幽灵必须在容量上限下被丢掉',
  );
  assert.deepEqual(
    r2.map((l) => l.x),
    [757, 1108, 1460],
  );
  // 后续几轮（哪怕本轮一张都检不出）也不许把它放回来
  for (let round = 3; round <= 5; round++) {
    const r = mem.update([], round, false);
    assert.ok(!r.some((l) => l.x === 1160 && l.y === 621), `第 ${round} 轮也不许出现幽灵`);
  }
});

test('容量上限：3 张 → 某轮只检出 2 张且位置全变 → 仍补齐第 3 个（原设计目的不受影响）', () => {
  const mem = createLabelMemory();
  const r1 = mem.update([label(100, '57.2%'), label(300, '51.4%'), label(500, '48.9%')], 1, true);
  assert.equal(r1.length, 3);
  // 检测闪烁：本轮只认出 2 张，而且矩形整体位移（与旧位置都超出容差）
  const r2 = mem.update([label(900, '57.2%'), label(1100, '51.4%')], 2, true);
  assert.equal(r2.length, 3, '容量上限是 3 → 仍要补齐第 3 个（少掉一张卡的胜率是原始 bug）');
  // 补进来的那一个来自旧记忆（位置 100/300/500 之一），本轮的两个新标签原样保留
  const fresh = r2.filter((l) => l.x === 900 || l.x === 1100);
  const kept = r2.filter((l) => l.x !== 900 && l.x !== 1100);
  assert.equal(fresh.length, 2);
  assert.equal(kept.length, 1);
  assert.ok([100, 300, 500].includes(kept[0]!.x), `补进来的应是旧记忆里的元素，实际 x=${kept[0]!.x}`);
});

test('容量上限：容量只增不减，且 reset 后重新从 0 开始', () => {
  const mem = createLabelMemory();
  // 先见过 3 张 → 容量 3
  mem.update([label(100, 'a'), label(300, 'b'), label(500, 'c')], 1, true);
  // 下一轮只产出 2 张、位置全变 → 仍补到 3
  assert.equal(mem.update([label(900, 'd'), label(1100, 'e')], 2, true).length, 3);
  // reset 之后容量归零：这一轮只有 1 张 → 就只能有 1 个（不许拿旧容量补）
  mem.reset();
  assert.equal(mem.update([label(100, 'x')], 3, true).length, 1);
  // 而且这之后容量按新的一批重新长（1 → 3）
  assert.equal(mem.update([label(100, 'x'), label(300, 'y'), label(500, 'z')], 4, true).length, 3);
});
