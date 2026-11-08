/**
 * 配装方案 CLI 的**写盘安全判据**（纯函数单测）
 *
 * ── 为什么专门测这两个函数（2026-11 审查，真机数据风险）──────────────
 *
 * 写配装方案走的是 `PUT /lol-item-sets/v1/item-sets/{id}/sets`，语义是
 * **整体替换**。而旧实现把"读不到"和"一套都没有"混成了同一件事：
 *
 *   const v = await client.getOrNull<RemoteSets>(url);   // 404/500 → null
 *   return v ?? { accountId: sid, itemSets: [], timestamp: 0 };
 *   ...
 *   const merged = mergeItemSets(existing.itemSets, generated);  // = 只有本工具的方案
 *   await client.sendJson('PUT', url, { itemSets: merged });     // ← 玩家方案被整体删除
 *
 * 于是"读失败"会静默删掉玩家手写的所有方案，而且**没有任何报错**。
 * 现在 `readSets` 返回 `RemoteSets | null`，`writeGuard` 在 null 时拒绝写入；
 * 两个函数都是纯函数，所以这条安全约束可以在 CI 里锁住（不需要真机）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ItemSet } from '@hexbox/core';

import { parseRemoteSets, writeGuard } from './itemset-cli.ts';

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

/** 一套**合法**方案（字段与客户端自己写出的形状一致）。 */
function itemSet(title: string): ItemSet {
  return {
    title,
    type: 'custom',
    map: 'any',
    mode: 'any',
    sortrank: 0,
    startedFrom: 'blank',
    associatedChampions: [63],
    associatedMaps: [12],
    blocks: [{ type: '出门装', items: [{ id: '1056', count: 1 }], hideIfSummonerSpell: '', showIfSummonerSpell: '' }],
    uid: 'uid-1',
    preferredItemSlots: [],
  };
}

function remote(itemSets: unknown[]): unknown {
  return { accountId: 42, itemSets, timestamp: 123 };
}

/* ------------------------------------------------------------------ */
/* parseRemoteSets：区分「读不懂」与「确实是空的」                        */
/* ------------------------------------------------------------------ */

test('parseRemoteSets：合法的空列表是**可读**的（玩家一套都没有）', () => {
  assert.deepEqual(parseRemoteSets(remote([])), {
    accountId: 42,
    itemSets: [],
    timestamp: 123,
  });
});

test('parseRemoteSets：合法方案原样解析，字段不丢', () => {
  const parsed = parseRemoteSets(remote([itemSet('玩家手写')]));
  assert.ok(parsed);
  assert.equal(parsed.itemSets.length, 1);
  assert.equal(parsed.itemSets[0]!.title, '玩家手写');
  assert.deepEqual(parsed.itemSets[0]!.associatedChampions, [63]);
});

test('parseRemoteSets：null / 非对象 / 数组 → 不可读', () => {
  assert.equal(parseRemoteSets(null), null, '404 走的就是这条');
  assert.equal(parseRemoteSets(undefined), null);
  assert.equal(parseRemoteSets('ok'), null);
  assert.equal(parseRemoteSets(42), null);
  assert.equal(parseRemoteSets([]), null);
});

test('parseRemoteSets：缺 itemSets 或不是数组 → 不可读（不能当成空列表）', () => {
  assert.equal(parseRemoteSets({}), null);
  assert.equal(parseRemoteSets({ accountId: 42 }), null);
  assert.equal(parseRemoteSets({ itemSets: null }), null);
  assert.equal(parseRemoteSets({ itemSets: {} }), null);
});

test('parseRemoteSets：条目形状异常 → 整份不可读（丢畸形条目=静默删除）', () => {
  // 缺 title
  assert.equal(parseRemoteSets(remote([{ associatedChampions: [1], associatedMaps: [12], blocks: [] }])), null);
  // 缺 associatedChampions（mergeItemSets 直接读它）
  assert.equal(parseRemoteSets(remote([{ title: 'x', associatedMaps: [12], blocks: [] }])), null);
  // blocks 不是数组
  assert.equal(parseRemoteSets(remote([{ title: 'x', associatedChampions: [1], associatedMaps: [12], blocks: {} }])), null);
  // 条目本身不是对象
  assert.equal(parseRemoteSets(remote([null])), null);
  assert.equal(parseRemoteSets(remote(['x'])), null);
});

test('parseRemoteSets：accountId / timestamp 缺失时按 0 处理（不阻断）', () => {
  const parsed = parseRemoteSets({ itemSets: [] });
  assert.deepEqual(parsed, { accountId: 0, itemSets: [], timestamp: 0 });
});

/* ------------------------------------------------------------------ */
/* writeGuard：读不到就绝不写                                          */
/* ------------------------------------------------------------------ */

test('writeGuard：不可读 → 拒绝写入，并给出可操作的说明', () => {
  const guard = writeGuard(null);
  assert.equal(guard.ok, false);
  if (guard.ok) return;
  assert.match(guard.reason, /拒绝写入/, '原因要明确说"没有写"');
  assert.match(guard.reason, /玩家手写/, '要说明这么做的理由');
  assert.match(guard.reason, /list/, '要给出可操作建议');
});

test('writeGuard：可读且为空 → 允许写入（空是合法状态，不是故障）', () => {
  const guard = writeGuard({ accountId: 42, itemSets: [], timestamp: 0 });
  assert.equal(guard.ok, true);
  if (!guard.ok) return;
  assert.equal(guard.sets.itemSets.length, 0);
});

test('writeGuard：可读且非空 → 原样交给调用方（玩家方案必须能被合并）', () => {
  const sets = { accountId: 42, itemSets: [itemSet('玩家手写')], timestamp: 0 };
  const guard = writeGuard(sets);
  assert.equal(guard.ok, true);
  if (!guard.ok) return;
  assert.equal(guard.sets.itemSets.length, 1);
});
