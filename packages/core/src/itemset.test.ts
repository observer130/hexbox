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

const EMPTY: ChampionBuild = { start: [], startCombo: [], shoes: [], core: [] };

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

test('buildBlocks：槽位顺序为 出门装→优先成装→其余成装（无鞋栏）', () => {
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
  assert.match(blocks[1]!.type, /^优先成装/);
  assert.match(blocks[2]!.type, /^其余成装/);
  assert.equal(
    blocks.some((b) => b.type.startsWith('鞋')),
    false,
    '鞋不应单独成栏（一栏一件装备，游戏内既不好看也无信息量）',
  );
});

test('buildBlocks：即使只有鞋数据也不产生鞋栏', () => {
  const blocks = buildBlocks(
    build({ shoes: [{ itemIds: [3006], pickRate: 0.5, winRate: 0.57 }] }),
  );
  assert.deepEqual(blocks, []);
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

test('buildBlocks：优先成装最多 3 套', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      itemIds: [100 + i, 200 + i, 300 + i],
      pickRate: 0.2 - i / 100,
      winRate: 0.5,
    }));
  const blocks = buildBlocks(build({ core: many(10) }));
  assert.equal(blocks.filter((b) => b.type.startsWith('优先成装')).length, 3);
});

test('buildBlocks：其余成装 = itemone 全部条目去掉第 1 名（真实回归）', () => {
  // 真实数据：parseItemStatJson 产出的 start 恰好 **20 条**（实测 173/173 英雄），
  // 官方页面把同一份 itemone_json 展示两次：前 5 作「出门装」、**其余全部**
  // 作「其余成装」（见 docs/build-slots.md 的核实表）：
  //   其余成装 = 7.51 / 5.95 / 5.68 / 71.19 / 59.84 / 58.02
  // 曾经的 bug：写成 slice(1, 11) → 多出第 1 名（71.19，属「出门装」）
  // 且丢掉第 11~20 名（2.5%~7.5%，正是官方该栏里最高的几件）。
  const start = Array.from({ length: 20 }, (_, i) => ({
    itemIds: [1000 + i],
    pickRate: 0.7 - i / 100,
    winRate: 0.5,
  }));
  const blocks = buildBlocks(build({ start }));
  const rest = blocks.filter((b) => b.type === '其余成装');
  assert.equal(rest.length, 1, '其余成装应只有一栏');

  const ids = rest[0]!.items.map((i) => i.id);
  // 第 1 名是「出门装」，不得重复出现在「其余成装」里
  assert.equal(ids.includes('1000'), false, '不得包含出门装第 1 名');
  // 其余 19 条一条都不能少（第 11~20 名曾被 slice 上界丢掉）
  assert.equal(ids.length, 19, '应包含除第 1 名外的全部 19 条');
  for (let i = 1; i < 20; i++) {
    assert.ok(ids.includes(String(1000 + i)), `缺少第 ${i + 1} 名 (${1000 + i})`);
  }
  // 上游可能给出重复单件，配装方案里不应出现重复条目
  assert.equal(new Set(ids).size, ids.length, '其余成装内不得有重复装备');
});

test('buildBlocks：其余成装对上游重复单件去重', () => {
  // 上游偶尔把同一件装备给成两个条目（不同登场率）：
  // 配装方案同一栏里出现两次同一件装备纯属噪声。
  const blocks = buildBlocks(
    build({
      start: [
        { itemIds: [1055], pickRate: 0.7, winRate: 0.5 }, // 出门装（第 1 名）
        { itemIds: [3031], pickRate: 0.2, winRate: 0.5 },
        { itemIds: [3031], pickRate: 0.1, winRate: 0.5 }, // 重复
        { itemIds: [6333], pickRate: 0.05, winRate: 0.5 },
      ],
    }),
  );
  const ids = blocks.find((b) => b.type === '其余成装')!.items.map((i) => i.id);
  assert.deepEqual(ids, ['3031', '6333']);
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
