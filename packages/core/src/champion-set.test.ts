/**
 * 图鉴英雄口径测试（173 真实英雄 + 72 变体条目 = 245 行）
 *
 * 锁住的是**数字描述**：245 是 CommunityDragon `champion-summary.json` 的
 * **行数**（同一英雄有第二套 ID），英雄数只有 173（与 `builds.json` 的
 * `details` 逐个 ID 相等）。夹具用的是真机 `data/dataset.json` 的形状与真实数字。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHAMPION_VARIANT_ID_MIN,
  countChampionSet,
  isChampionVariant,
} from './champion-set.ts';
import type { Champion } from './types.ts';

/** 一条图鉴英雄（只要 id，其它字段与判定无关）。 */
function champ(id: number, name = `英雄#${id}`): Champion {
  return { id, name, alias: `A${id}`, roles: [], iconPath: '' };
}

test('变体条目的界：60000（与 overlay-view 的 canonicalChampionId 同一个界）', () => {
  assert.equal(CHAMPION_VARIANT_ID_MIN, 60000);
  assert.equal(isChampionVariant(1), false);
  assert.equal(isChampionVariant(950), false); // 真机图鉴里最大的基础 ID
  assert.equal(isChampionVariant(59999), false);
  assert.equal(isChampionVariant(60000), true);
  assert.equal(isChampionVariant(60001), true); // 真机 60001 = Jade_Annie（黑暗之女）
  assert.equal(isChampionVariant(60267), true); // 真机最大的变体 ID
});

test('真机形状：173 基础 ID + 72 变体条目 → 英雄 173（不是 245）', () => {
  // 真机数字：dataset.champions 245 条 = 173 基础 ID + 72 个 60001~60267 的 Jade_* 条目
  const champions: Champion[] = [
    ...Array.from({ length: 173 }, (_, i) => champ(i + 1)),
    ...Array.from({ length: 72 }, (_, i) => champ(60001 + i, '黑暗之女')),
  ];
  const counts = countChampionSet(champions);
  assert.deepEqual(counts, { champions: 173, variants: 72, entries: 245 });
  // ⚠️ 展示层不许再把 entries 当英雄数
  assert.notEqual(counts.champions, champions.length);
});

test('只有真实英雄时：变体 0、英雄数 = 行数', () => {
  assert.deepEqual(countChampionSet([champ(1), champ(63), champ(950)]), {
    champions: 3,
    variants: 0,
    entries: 3,
  });
});

test('边界：空数组 / 脏 id（NaN、非有限）不炸，也不被静默算成变体', () => {
  assert.deepEqual(countChampionSet([]), { champions: 0, variants: 0, entries: 0 });
  const dirty: Champion[] = [champ(Number.NaN), champ(Number.POSITIVE_INFINITY), champ(60001)];
  const counts = countChampionSet(dirty);
  assert.equal(counts.entries, 3);
  assert.equal(counts.variants, 1, '只有 60001 是变体');
  assert.equal(counts.champions, 2);
});
