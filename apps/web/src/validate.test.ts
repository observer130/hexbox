/**
 * 运行时数据校验单测（`validate.ts`）
 *
 * 锁定 2026-11 审查 P2 #1：`res.json() as T` 只在编译期成立，旧/坏数据会让
 * computed 抛 TypeError → **整页白屏**。现在的约定是：形状不兼容时抛带
 * 「重新 pnpm sync」提示和字段名的 Error，页面显示「数据不兼容」而不是白屏。
 *
 * 数据形状与 `pnpm sync` 产物一致（只保留校验关心的字段）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Dataset, RankingSnapshot } from '@hexbox/core';

import { INCOMPATIBLE_DATA_MESSAGE, parseDataset, parseRankings } from './validate.ts';

/** 最小可用 dataset（每条数组放 1 个形状合法的条目）。 */
function validDataset(): Record<string, unknown> {
  return {
    meta: { source: 'communitydragon', patch: null, fetchedAt: '2026-11-02T14:48:37.531Z' },
    augments: [{ id: 1205, augmentNameId: 'ARAM_X', name: 'X', modes: ['KIWI'] }],
    champions: [{ id: 1, name: 'A', alias: 'a' }],
    items: [{ id: 1001, name: 'I' }],
    hextechs: [{ id: 1001, augmentNameId: 'ARAM_X', name: 'X' }],
  };
}

/** 最小可用 rankings。 */
function validRankings(): Record<string, unknown> {
  return {
    meta: {
      source: 'tencent-rankings',
      dataDate: '20261101',
      fetchedAt: '2026-11-02T14:48:37.994Z',
    },
    augments: [{ id: 1001, winRate: 0.5, pickRate: 0.2 }],
    heroes: [{ championId: 1, winRate: 0.51, pickRate: 0.11 }],
  };
}

/** 断言抛出「数据不兼容」错误，且错误信息带字段名（方便定位脏数据）。 */
function assertIncompatible(fn: () => unknown, field: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error, '必须抛 Error');
    assert.ok(
      err.message.includes(INCOMPATIBLE_DATA_MESSAGE),
      `错误信息应包含统一提示「${INCOMPATIBLE_DATA_MESSAGE}」：${err.message}`,
    );
    assert.ok(err.message.includes(field), `错误信息应带字段名 ${field}：${err.message}`);
    return true;
  });
}

test('parseDataset：合法数据通过，且原样返回（不深拷贝/不重排）', () => {
  const raw = validDataset();
  const parsed: Dataset = parseDataset(raw);
  assert.equal(parsed, raw, '应返回同一对象引用，避免复制近 1MB 数据');
  assert.equal(parsed.augments.length, 1);
});

test('parseDataset：null/非对象直接拒绝（不能让模板拿到 null 去读字段）', () => {
  assertIncompatible(() => parseDataset(null), '根对象');
  assertIncompatible(() => parseDataset('dataset.json'), '根对象');
  assertIncompatible(() => parseDataset([]), '根对象');
});

test('parseDataset：缺 meta 或 meta 不是对象时拒绝', () => {
  const missing = validDataset();
  delete missing.meta;
  assertIncompatible(() => parseDataset(missing), 'meta');
  assertIncompatible(() => parseDataset({ ...validDataset(), meta: null }), 'meta');
});

test('parseDataset：meta.fetchedAt 不是字符串时拒绝', () => {
  const raw = validDataset();
  raw.meta = { source: 'communitydragon', patch: null, fetchedAt: 20261102 };
  assertIncompatible(() => parseDataset(raw), 'meta.fetchedAt');
  assertIncompatible(
    () => parseDataset({ ...validDataset(), meta: { fetchedAt: '' } }),
    'meta.fetchedAt',
  );
});

test('parseDataset：旧版本数据缺 hextechs → 拒绝并提示重新 sync（真实旧数据场景）', () => {
  const raw = validDataset();
  delete raw.hextechs;
  assertIncompatible(() => parseDataset(raw), 'hextechs');
});

test('parseDataset：顶层数组字段类型错（对象/字符串）时拒绝', () => {
  assertIncompatible(() => parseDataset({ ...validDataset(), augments: {} }), 'augments');
  assertIncompatible(() => parseDataset({ ...validDataset(), items: 'items' }), 'items');
});

test('parseDataset：数组里混入 null（写了一半的文件）→ 带下标拒绝', () => {
  const raw = validDataset();
  raw.champions = [{ id: 1 }, null];
  assertIncompatible(() => parseDataset(raw), 'champions[1]');
});

test('parseRankings：合法数据通过，且原样返回', () => {
  const raw = validRankings();
  const parsed: RankingSnapshot = parseRankings(raw);
  assert.equal(parsed, raw);
});

test('parseRankings：缺 meta.dataDate 或不是字符串时拒绝（统计日期是必展示字段）', () => {
  const missing = validRankings();
  missing.meta = { source: 'tencent-rankings', fetchedAt: '2026-11-02T14:48:37.994Z' };
  assertIncompatible(() => parseRankings(missing), 'meta.dataDate');
  assertIncompatible(
    () => parseRankings({ ...validRankings(), meta: { dataDate: 20261101 } }),
    'meta.dataDate',
  );
});

test('parseRankings：augments/heroes 必须是数组（排行榜两份子表）', () => {
  assertIncompatible(() => parseRankings({ ...validRankings(), augments: null }), 'augments');
  assertIncompatible(() => parseRankings({ ...validRankings(), heroes: {} }), 'heroes');
  assertIncompatible(() => parseRankings(null), '根对象');
});

/* ------------------------------------------------------------------ */
/* 条目级必填字段（审查 P2：数组元素缺字段同样会 TypeError 白屏）          */
/* ------------------------------------------------------------------ */

test('parseDataset：海克斯条目缺 name/augmentNameId/modes → 带下标拒绝', () => {
  const raw = validDataset();
  raw.augments = [{ id: 1205, augmentNameId: 'ARAM_X', modes: [] }];
  assertIncompatible(() => parseDataset(raw), 'augments[0].name');

  const raw2 = validDataset();
  raw2.augments = [{ id: 1205, augmentNameId: 'ARAM_X', name: 'X', modes: 'KIWI' }];
  assertIncompatible(() => parseDataset(raw2), 'augments[0].modes');
});

test('parseDataset：英雄/装备条目缺必填字段 → 拒绝', () => {
  const raw = validDataset();
  raw.champions = [{ id: 1, name: 'A' }];
  assertIncompatible(() => parseDataset(raw), 'champions[0].alias');

  const raw2 = validDataset();
  raw2.items = [{ id: '1001', name: 'I' }];
  assertIncompatible(() => parseDataset(raw2), 'items[0].id');
});

test('parseRankings：榜单条目缺数值字段 → 拒绝（排序会对 undefined 做减法）', () => {
  const raw = validRankings();
  raw.heroes = [{ championId: 1, pickRate: 0.1 }];
  assertIncompatible(() => parseRankings(raw), 'heroes[0].winRate');

  const raw2 = validRankings();
  raw2.augments = [{ id: 1001, winRate: '0.5', pickRate: 0.2 }];
  assertIncompatible(() => parseRankings(raw2), 'augments[0].winRate');
});

test('parseDataset/parseRankings：未来 schema 版本明确拒绝并提示升级', () => {
  const ds = validDataset();
  ds.meta = { ...(ds.meta as object), schemaVersion: 999 };
  assert.throws(() => parseDataset(ds), /更新版本的 hexbox/);

  const rk = validRankings();
  rk.meta = { ...(rk.meta as object), schemaVersion: 999 };
  assert.throws(() => parseRankings(rk), /更新版本的 hexbox/);
});
