/**
 * 稀有度兜底的单测（`apps/web` 的第一个测试）
 *
 * 这条锁的是一个**整页白屏**级别的缺陷：数据是运行时 JSON，上游新增一个稀有度
 * 档位时 `RARITY_META[x]` 取不到 → 模板里读 `.color` 直接抛错 → Vue 渲染中断。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RARITY_META, UNKNOWN_RARITY, rarityMeta } from './rarity.ts';

test('rarityMeta：已知档位返回配置', () => {
  assert.equal(rarityMeta('kPrismatic').label, '棱彩');
  assert.equal(rarityMeta('kGold').order, 1);
  assert.equal(rarityMeta('kSilver').color, 'var(--silver)');
  assert.deepEqual(rarityMeta('kEventChoice'), RARITY_META.kEventChoice);
});

test('rarityMeta：上游新增档位时必须兜底，不许抛（否则整页白屏）', () => {
  const unknown = rarityMeta('kBronze'); // 目前不存在，将来可能出现
  assert.deepEqual(unknown, UNKNOWN_RARITY);
  assert.equal(typeof unknown.label, 'string');
  assert.equal(typeof unknown.color, 'string');
  assert.ok(unknown.order >= Math.max(...Object.values(RARITY_META).map((m) => m.order)));
});

test('rarityMeta：空值/脏数据也兜底（旧缓存里 rarity 可能是 null）', () => {
  assert.deepEqual(rarityMeta(null), UNKNOWN_RARITY);
  assert.deepEqual(rarityMeta(undefined), UNKNOWN_RARITY);
  assert.deepEqual(rarityMeta(''), UNKNOWN_RARITY);
});

test('rarityMeta：不认原型链上的键（toString 不是稀有度）', () => {
  assert.deepEqual(rarityMeta('toString'), UNKNOWN_RARITY);
  assert.deepEqual(rarityMeta('constructor'), UNKNOWN_RARITY);
});
