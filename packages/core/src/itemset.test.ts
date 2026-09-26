/**
 * itemset 测试（配装方案构造与合并）
 *
 * 这是本项目**第一个写操作**的纯逻辑层，且会写入玩家的真实客户端数据，
 * 因此测试重点在**安全**而非功能：
 *   - 绝不覆盖/删除玩家手写的方案
 *   - 反复生成不产生重复
 *   - 地图 ID 用对了（海斗 = 12），填错会静默失效
 *   - 装备 id 必须是字符串（客户端自己的格式）
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChampionBuild, ItemSet } from './types.ts';
import { BRAWL_MAP_ID } from './types.ts';

import {
  buildBlocks,
  isOwnItemSet,
  ITEM_SET_TITLE_PREFIX,
  makeItemSet,
  mergeItemSets,
  newUid,
  toEntries,
} from './itemset.ts';

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

const EMPTY: ChampionBuild = { start: [], startCombo: [], shoes: [], core: [], full: [] };

function build(partial: Partial<ChampionBuild>): ChampionBuild {
  return { ...EMPTY, ...partial };
}

/** 玩家手写的方案（标题不以 hexbox 开头）。 */
function handwritten(title = '我的出装'): ItemSet {
  return {
    title,
    type: 'custom',
    map: 'any',
    mode: 'any',
    sortrank: 0,
    startedFrom: 'blank',
    associatedChampions: [266],
    associatedMaps: [12],
    blocks: [
      {
        type: '出门装',
        items: [{ id: '3177', count: 1 }],
        hideIfSummonerSpell: '',
        showIfSummonerSpell: '',
      },
    ],
    uid: 'handwritten-uid',
    preferredItemSlots: [],
  };
}

/* ------------------------------------------------------------------ */
/* 基础构造                                                            */
/* ------------------------------------------------------------------ */

test('newUid：生成非空且互不相同的 id', () => {
  const a = newUid();
  const b = newUid();
  assert.ok(a.length > 0);
  assert.notEqual(a, b);
});

test('toEntries：装备 id 必须是字符串（客户端自己的格式）', () => {
  const out = toEntries([3177, 6697]);
  assert.deepEqual(out, [
    { id: '3177', count: 1 },
    { id: '6697', count: 1 },
  ]);
  // 明确断言类型：写成数字可能被客户端静默忽略
  assert.equal(typeof out[0]!.id, 'string');
  assert.equal(out[0]!.count, 1);
});

test('buildBlocks：按 出门装→鞋→核心→六件套 顺序出块', () => {
  const blocks = buildBlocks(
    build({
      start: [{ itemIds: [1055], pickRate: 0.6, winRate: 0.55 }],
      shoes: [{ itemIds: [3006], pickRate: 0.5, winRate: 0.57 }],
      core: [{ itemIds: [6672, 6673, 3031], pickRate: 0.07, winRate: 0.61 }],
      full: [{ itemIds: [1, 2, 3, 4, 5, 6], pickRate: 0.01, winRate: 0.56 }],
    }),
  );
  assert.equal(blocks.length, 4);
  assert.match(blocks[0]!.type, /^出门装/);
  assert.match(blocks[1]!.type, /^鞋子/);
  assert.match(blocks[2]!.type, /核心三件套/);
  assert.match(blocks[3]!.type, /成型六件套/);
});

test('buildBlocks：每个块只装**一套**出装，不把候选全倒进同一块', () => {
  // 上游 start 常有 20+ 个候选；全塞进一个块会让游戏内完全没法看。
  const many = Array.from({ length: 20 }, (_, i) => ({
    itemIds: [1000 + i],
    pickRate: 0.5 - i / 100,
    winRate: 0.5,
  }));
  const blocks = buildBlocks(build({ start: many }), 2);
  // 默认每槽位最多 2 套 → 2 个块，每块 1 件
  assert.equal(blocks.length, 2);
  for (const b of blocks) assert.equal(b.items.length, 1);
});

test('buildBlocks：出门装单件与组合分属不同的块（语义不同）', () => {
  const blocks = buildBlocks(
    build({
      start: [{ itemIds: [1055], pickRate: 0.6, winRate: 0.55 }],
      startCombo: [{ itemIds: [1018, 1052], pickRate: 0.03, winRate: 0.63 }],
    }),
  );
  assert.equal(blocks.length, 2);
  assert.match(blocks[0]!.type, /^出门装/);
  assert.deepEqual(blocks[0]!.items.map((i) => i.id), ['1055']);
  assert.match(blocks[1]!.type, /^出门组合/);
  assert.deepEqual(blocks[1]!.items.map((i) => i.id), ['1018', '1052']);
});

test('buildBlocks：块标题带胜率（游戏内也能看到依据）', () => {
  const blocks = buildBlocks(
    build({ core: [{ itemIds: [1, 2, 3], pickRate: 0.07, winRate: 0.617 }] }),
  );
  assert.match(blocks[0]!.type, /61\.7%/);
});

test('buildBlocks：多个方案时编号区分', () => {
  const blocks = buildBlocks(
    build({
      core: [
        { itemIds: [1, 2, 3], pickRate: 0.07, winRate: 0.6 },
        { itemIds: [4, 5, 6], pickRate: 0.05, winRate: 0.58 },
      ],
    }),
  );
  assert.equal(blocks.length, 2);
  assert.match(blocks[0]!.type, /核心三件套 1/);
  assert.match(blocks[1]!.type, /核心三件套 2/);
});

test('buildBlocks：空出装返回空数组（不产生空块）', () => {
  assert.deepEqual(buildBlocks(EMPTY), []);
});

/* ------------------------------------------------------------------ */
/* makeItemSet                                                         */
/* ------------------------------------------------------------------ */

const FULL_BUILD = build({
  start: [{ itemIds: [3177], pickRate: 0.5, winRate: 0.55 }],
  shoes: [{ itemIds: [3008], pickRate: 0.4, winRate: 0.56 }],
  core: [{ itemIds: [6697, 6333, 2517], pickRate: 0.06, winRate: 0.6 }],
  full: [{ itemIds: [6697, 3008, 6333, 2517, 3033, 3143], pickRate: 0.01, winRate: 0.58 }],
});

test('makeItemSet：关联地图 ID 是海斗的 12（填错会静默失效）', () => {
  const s = makeItemSet({ championId: 266, championName: '暗裔剑魔', build: FULL_BUILD });
  assert.ok(s);
  assert.deepEqual(s.associatedMaps, [BRAWL_MAP_ID]);
  assert.equal(BRAWL_MAP_ID, 12);
});

test('makeItemSet：只关联该英雄', () => {
  const s = makeItemSet({ championId: 266, championName: '暗裔剑魔', build: FULL_BUILD });
  assert.deepEqual(s?.associatedChampions, [266]);
});

test('makeItemSet：固定字段取值正确（type/map/mode/startedFrom）', () => {
  const s = makeItemSet({ championId: 266, championName: '暗裔剑魔', build: FULL_BUILD });
  assert.equal(s?.type, 'custom');
  assert.equal(s?.map, 'any');
  assert.equal(s?.mode, 'any');
  assert.equal(s?.startedFrom, 'blank');
  assert.deepEqual(s?.preferredItemSlots, []);
});

test('makeItemSet：标题带 hexbox 前缀与数据日期（便于识别与清理）', () => {
  const s = makeItemSet({
    championId: 266,
    championName: '暗裔剑魔',
    build: FULL_BUILD,
    dataDate: '20260925',
  });
  assert.match(s!.title, new RegExp(`^${ITEM_SET_TITLE_PREFIX}`));
  assert.match(s!.title, /09\/25/);
});

test('makeItemSet：空出装返回 null（不写空方案）', () => {
  assert.equal(makeItemSet({ championId: 1, championName: 'X', build: EMPTY }), null);
});

test('makeItemSet：可复用既有 uid（更新而非新增）', () => {
  const s = makeItemSet({
    championId: 266,
    championName: '暗裔剑魔',
    build: FULL_BUILD,
    uid: 'fixed-uid',
  });
  assert.equal(s?.uid, 'fixed-uid');
});

/* ------------------------------------------------------------------ */
/* 安全性：合并与识别                                                  */
/* ------------------------------------------------------------------ */

test('isOwnItemSet：据标题前缀识别，不误判玩家手写的', () => {
  assert.equal(isOwnItemSet(handwritten()), false);
  assert.equal(isOwnItemSet(handwritten('hexbox 暗裔剑魔')), true);
});

test('mergeItemSets：**玩家手写的方案必须原样保留**', () => {
  const mine = handwritten('我最爱的出装');
  const gen = makeItemSet({ championId: 1, championName: '安妮', build: FULL_BUILD })!;
  const merged = mergeItemSets([mine], [gen]);

  assert.equal(merged.length, 2);
  assert.ok(merged.some((s) => s.uid === 'handwritten-uid'));
  assert.ok(merged.some((s) => s.uid === gen.uid));
});

test('mergeItemSets：同一英雄重复生成不产生重复方案', () => {
  const gen1 = makeItemSet({ championId: 266, championName: '暗裔剑魔', build: FULL_BUILD })!;
  const gen2 = makeItemSet({ championId: 266, championName: '暗裔剑魔', build: FULL_BUILD })!;

  // 第一次写入
  const after1 = mergeItemSets([], [gen1]);
  assert.equal(after1.length, 1);
  // 第二次写入：应替换而非追加
  const after2 = mergeItemSets(after1, [gen2]);
  assert.equal(after2.length, 1);
  assert.equal(after2[0]!.uid, gen2.uid);
});

test('mergeItemSets：不同英雄的方案各自保留', () => {
  const a = makeItemSet({ championId: 266, championName: '暗裔剑魔', build: FULL_BUILD })!;
  const b = makeItemSet({ championId: 1, championName: '安妮', build: FULL_BUILD })!;
  const merged = mergeItemSets([a], [b]);
  assert.equal(merged.length, 2);
});

test('mergeItemSets：不修改输入数组（无副作用）', () => {
  const existing = [handwritten()];
  const gen = makeItemSet({ championId: 1, championName: '安妮', build: FULL_BUILD })!;
  const before = existing.length;
  mergeItemSets(existing, [gen]);
  assert.equal(existing.length, before);
});

test('mergeItemSets：空生成列表时既有方案全保留', () => {
  const existing = [handwritten(), handwritten('另一个')];
  assert.equal(mergeItemSets(existing, []).length, 2);
});
