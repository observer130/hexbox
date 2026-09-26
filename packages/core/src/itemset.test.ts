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

test('buildBlocks：槽位顺序为 出门装→鞋→优先成装→其余成装', () => {
  const blocks = buildBlocks(
    build({
      start: [
        { itemIds: [1055], pickRate: 0.68, winRate: 0.55 },
        { itemIds: [1054], pickRate: 0.28, winRate: 0.49 },
      ],
      shoes: [{ itemIds: [3006], pickRate: 0.5, winRate: 0.57 }],
      core: [{ itemIds: [6672, 6673, 3031], pickRate: 0.07, winRate: 0.61 }],
    }),
  );
  assert.match(blocks[0]!.type, /^出门装/);
  assert.match(blocks[1]!.type, /^鞋/);
  assert.match(blocks[2]!.type, /^优先成装/);
  assert.match(blocks[3]!.type, /^其余成装/);
});

test('buildBlocks：出门装只给排名第一的一套', () => {
  const blocks = buildBlocks(
    build({
      start: [
        { itemIds: [1054], pickRate: 0.28, winRate: 0.49 },
        { itemIds: [1055], pickRate: 0.68, winRate: 0.55 }, // 登场率最高
      ],
    }),
  );
  const startBlocks = blocks.filter((b) => b.type.startsWith('出门装'));
  assert.equal(startBlocks.length, 1);
  assert.deepEqual(startBlocks[0]!.items.map((i) => i.id), ['1055']);
});

test('buildBlocks：按登场率降序取（上游原始顺序不可靠）', () => {
  // 上游常见：第一套并不是登场率最高的
  const blocks = buildBlocks(
    build({
      core: [
        { itemIds: [1, 2, 3], pickRate: 0.02, winRate: 0.5 },
        { itemIds: [4, 5, 6], pickRate: 0.16, winRate: 0.47 }, // 应为第 1
      ],
    }),
  );
  assert.match(blocks[0]!.type, /优先成装 1/);
  assert.deepEqual(blocks[0]!.items.map((i) => i.id), ['4', '5', '6']);
});

test('buildBlocks：优先成装最多 3 套，鞋最多 2 套', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      itemIds: [100 + i, 200 + i, 300 + i],
      pickRate: 0.2 - i / 100,
      winRate: 0.5,
    }));
  const blocks = buildBlocks(
    build({
      core: many(10),
      shoes: [
        { itemIds: [1], pickRate: 0.5, winRate: 0.5 },
        { itemIds: [2], pickRate: 0.4, winRate: 0.5 },
        { itemIds: [3], pickRate: 0.3, winRate: 0.5 },
      ],
    }),
  );
  assert.equal(blocks.filter((b) => b.type.startsWith('优先成装')).length, 3);
  assert.equal(blocks.filter((b) => b.type.startsWith('鞋')).length, 2);
});

test('buildBlocks：其余成装把单件合并进**一个**栏位', () => {
  const start = Array.from({ length: 20 }, (_, i) => ({
    itemIds: [1000 + i],
    pickRate: 0.7 - i / 100,
    winRate: 0.5,
  }));
  const blocks = buildBlocks(build({ start }));
  const rest = blocks.filter((b) => b.type === '其余成装');
  assert.equal(rest.length, 1, '其余成装应只有一栏');
  assert.ok(rest[0]!.items.length > 1, '该栏应包含多个单件');
  // 不含第 1 名（那是「出门装」）
  assert.equal(rest[0]!.items.some((i) => i.id === '1000'), false);
});

test('buildBlocks：块标题带胜率（游戏内也能看到依据）', () => {
  const blocks = buildBlocks(
    build({ core: [{ itemIds: [1, 2, 3], pickRate: 0.07, winRate: 0.617 }] }),
  );
  assert.match(blocks[0]!.type, /61\.7%/);
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
