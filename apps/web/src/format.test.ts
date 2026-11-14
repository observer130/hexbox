/**
 * 展示格式化单测（`format.ts`）
 *
 * 锁定 2026-11 审查 P2 #4/#5 的用户可见口径：
 *   · 统计日期 `20261101` → `2026-11-01`（不再原样展示）；
 *   · 百分比默认 2 位小数（上游 4 位精度、官方 101 站 2 位；旧实现 1 位丢精度）；
 *   · 模式代号中文名统一走 `modeLabel()`（CHERRY 曾被硬编码漏成英文）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatStatDate, modeLabel, pct, sortByRate } from './format.ts';

test('formatStatDate：上游 YYYYMMDD 转成可读的 YYYY-MM-DD', () => {
  assert.equal(formatStatDate('20261101'), '2026-11-01');
  assert.equal(formatStatDate('20260924'), '2026-09-24');
});

test('formatStatDate：识别不了就原样返回（不丢数据，也不猜）', () => {
  assert.equal(formatStatDate(''), '');
  assert.equal(formatStatDate('2026-11-01'), '2026-11-01');
  assert.equal(formatStatDate('2026111'), '2026111');
  assert.equal(formatStatDate(' 20261101 '), '2026-11-01', '容忍上游带空白');
});

test('pct：默认保留 2 位小数（与官方站一致）', () => {
  // 真实 rankings.json 的字段精度是 4 位：0.4814 / 0.1701
  assert.equal(pct(0.4814), '48.14%');
  assert.equal(pct(0.1701), '17.01%');
  assert.equal(pct(0.622), '62.20%');
});

test('pct：可显式指定小数位，0/1 边界不丢语义', () => {
  assert.equal(pct(0.5, 0), '50%');
  assert.equal(pct(1 / 3, 4), '33.3333%');
  assert.equal(pct(0), '0.00%');
  assert.equal(pct(1), '100.00%');
});

test('modeLabel：三个已知模式给中文名（CHERRY 是斗魂竞技场，不许漏英文）', () => {
  assert.equal(modeLabel('KIWI'), '海克斯乱斗');
  assert.equal(modeLabel('KIWI_JADE'), '海克斯乱斗 · Jade');
  assert.equal(modeLabel('CHERRY'), '斗魂竞技场');
});

test('modeLabel：上游新增未知模式时原样返回代号（不 undefined、不空白）', () => {
  assert.equal(modeLabel('ARAM'), 'ARAM');
  assert.equal(modeLabel('toString'), 'toString', '不认原型链上的键');
});

test('sortByRate：按指定比率降序，且不改动入参', () => {
  const rows = [
    { id: 1, winRate: 0.4, pickRate: 0.9 },
    { id: 2, winRate: 0.6, pickRate: 0.2 },
    { id: 3, winRate: 0.5, pickRate: 0.5 },
  ];
  assert.deepEqual(
    sortByRate(rows, 'winRate').map((r) => r.id),
    [2, 3, 1],
  );
  assert.deepEqual(
    sortByRate(rows, 'pickRate').map((r) => r.id),
    [1, 3, 2],
  );
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3], '不修改入参数组');
});

test('sortByRate：相等值保持上游原顺序（稳定排序 = 官方排名优先）', () => {
  const rows = [
    { id: 'first', winRate: 0.5, pickRate: 0.1 },
    { id: 'second', winRate: 0.5, pickRate: 0.1 },
  ];
  assert.deepEqual(
    sortByRate(rows, 'winRate').map((r) => r.id),
    ['first', 'second'],
  );
});
