/**
 * 英雄 ID 归一化 + 详情查找测试
 *
 * 重点锁住「顶栏全是暂无数据」这条真机 bug 的修法：
 *   - 高 ID（60000+）必须按名称对齐到基础 ID（英雄榜对高 ID 覆盖 0/72）；
 *   - 改名英雄无法对齐时**诚实回退**，绝不按 `-60000` 偏移乱猜；
 *   - 数据缺失时返回 null/空，不伪造。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Champion, ChampionDetail, ChampionDetailSet } from './types.ts';

import { canonicalChampionId, championKey, findDetail } from './overlay-view.ts';

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

/** 真实图鉴里的形态：同一英雄同时存在基础 ID 与 60000+ 的高 ID。 */
const TWO_ID_CHAMPS: Champion[] = [
  { id: 63, name: '黑暗之女', alias: 'Annie', roles: ['MAGE'], iconPath: '' },
  { id: 60001, name: '黑暗之女', alias: 'Annie', roles: ['MAGE'], iconPath: '' },
  // 改名英雄：高 ID 的名字与基础 ID **不同**（60003 哨兵之殇 → 3 正义巨像）
  { id: 3, name: '正义巨像', alias: 'Galio', roles: ['TANK'], iconPath: '' },
  { id: 60003, name: '哨兵之殇', alias: 'Galio', roles: ['TANK'], iconPath: '' },
  { id: 950, name: '远古恐惧', alias: 'FiddleSticks', roles: ['MAGE'], iconPath: '' },
];

function detail(partial: Partial<ChampionDetail> = {}): ChampionDetail {
  return {
    championId: 157,
    augments: [],
    build: { start: [], startCombo: [], shoes: [], core: [] },
    skills: [],
    partners: [],
    dataDate: '20260925',
    ...partial,
  };
}

function set(details: ChampionDetail[]): ChampionDetailSet {
  return {
    meta: { source: 'test', dataDate: '20260925', fetchedAt: 'x', count: details.length },
    details,
  };
}

/* ------------------------------------------------------------------ */
/* 归一化                                                              */
/* ------------------------------------------------------------------ */

test('canonicalChampionId：基础 ID 原样返回', () => {
  assert.equal(canonicalChampionId(63, TWO_ID_CHAMPS), 63);
  assert.equal(canonicalChampionId(0, TWO_ID_CHAMPS), 0);
  assert.equal(canonicalChampionId(-1, TWO_ID_CHAMPS), -1);
});

test('canonicalChampionId：高 ID 按名称映射到基础 ID（真实 60001 → 63）', () => {
  // 只按数字 join 会让全部高 ID 英雄「暂无数据」：英雄榜对高 ID 覆盖 0/72
  assert.equal(canonicalChampionId(60001, TWO_ID_CHAMPS), 63);
});

test('canonicalChampionId：改名英雄无法对齐 —— 诚实回退原 ID，不猜', () => {
  // 真实案例：60003「哨兵之殇」（加里奥旧名）对不上 3「正义巨像」。
  // 英雄在从高 ID 迁到基础 ID 时改了名，名称法失效；而 `-60000` 偏移
  // 实测会错配（60038 → 38 是另一个英雄）。因此只能回退、显示暂无数据。
  assert.equal(canonicalChampionId(60003, TWO_ID_CHAMPS), 60003);
});

test('canonicalChampionId：高 ID 减 60000 不等于基础 ID 时不得乱猜', () => {
  // 真实案例：60038（虚空行者 卡萨丁）− 60000 = 38，而 38 是另一个英雄
  const champs: Champion[] = [
    { id: 38, name: '虚空先知', alias: 'Malzahar', roles: ['MAGE'], iconPath: '' },
    { id: 141, name: '虚空行者', alias: 'Kassadin', roles: ['ASSASSIN'], iconPath: '' },
    { id: 60038, name: '虚空行者', alias: 'Kassadin', roles: ['ASSASSIN'], iconPath: '' },
  ];
  // 命中名称 → 141（它的基础 ID），绝不能返回 38
  assert.equal(canonicalChampionId(60038, champs), 141);
});

test('canonicalChampionId：找不到对应基础 ID 时回退原 ID（宁显示暂无数据也不错配）', () => {
  const champs: Champion[] = [
    { id: 60099, name: '某个只有高 ID 的英雄', alias: 'X', roles: [], iconPath: '' },
  ];
  assert.equal(canonicalChampionId(60099, champs), 60099);
});

test('canonicalChampionId：英雄表里没有该高 ID 时原样返回', () => {
  assert.equal(canonicalChampionId(60077, TWO_ID_CHAMPS), 60077);
});

test('canonicalChampionId：归一化后能直接命中基础 ID 的英雄数据', () => {
  // 高 ID 在英雄榜里不存在（实测 0/72），归一化后必须能对上基础 ID
  const cid = canonicalChampionId(60001, TWO_ID_CHAMPS);
  assert.equal(cid, 63);
  assert.equal(TWO_ID_CHAMPS.find((c) => c.id === cid)?.name, '黑暗之女');
});

test('championKey：名称归一化（去空白、忽略大小写）', () => {
  assert.equal(championKey(' 黑暗之女 '), championKey('黑暗之女'));
  assert.equal(championKey('Annie'), championKey('annie'));
});

/* ------------------------------------------------------------------ */
/* 详情查找                                                            */
/* ------------------------------------------------------------------ */

test('findDetail：按英雄 ID 取出详情', () => {
  const s = set([detail({ championId: 1 }), detail({ championId: 157 })]);
  assert.equal(findDetail(s, 157)?.championId, 157);
  assert.equal(findDetail(s, 999), null);
});

test('findDetail：collection 为 null 或 id 非法时返回 null', () => {
  assert.equal(findDetail(null, 157), null);
  assert.equal(findDetail(set([detail()]), 0), null);
  assert.equal(findDetail(set([detail()]), -1), null);
});
