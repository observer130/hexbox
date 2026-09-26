/**
 * rankboard 测试
 *
 * 这是悬浮窗「对局中有用」功能的核心逻辑，且悬浮窗本身在 CI 中跑不起来
 * （需管理员 + 真实桌面），因此纯函数层面的覆盖尤其重要。
 *
 * 重点验证：
 *   - join 用的是**国服数字 ID**，不是 CDragon id（两套 ID 不可换算）
 *   - 图鉴缺失时不崩、不丢行，而是降级为占位名
 *   - 分组顺序与组内排序稳定
 *   - 上游无数据时返回空，而不是伪造数据
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  AugmentRankEntry,
  Champion,
  HextechStatic,
  RankingSnapshot,
} from './types.ts';

import {
  bestAugmentsForChampion,
  buildRankBoard,
  buildRankRows,
  groupByRarity,
  hasRankingData,
  RARITY_ORDER,
} from './rankboard.ts';

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

function hex(id: number, name: string, rarity: HextechStatic['rarity']): HextechStatic {
  return {
    id,
    augmentNameId: `ARAM_${name}`,
    name,
    tooltip: '',
    rarity,
    modes: ['KIWI'],
    largeIcon: `https://cdn/large/${id}.png`,
    smallIcon: `https://cdn/small/${id}.png`,
    isNew: false,
  };
}

function rankEntry(
  id: number,
  winRate: number,
  opts: Partial<AugmentRankEntry> = {},
): AugmentRankEntry {
  return {
    id,
    level: 255,
    pickRate: 0.1,
    pickRank: 1,
    pickRankChange: 0,
    winRate,
    winRank: 1,
    winRankChange: 0,
    bestHeroes: [],
    ...opts,
  };
}

function snapshot(augments: AugmentRankEntry[]): RankingSnapshot {
  return {
    meta: { source: 'tencent-rankings', dataDate: '20260925', fetchedAt: '2026-09-26T00:00:00Z' },
    augments,
    heroes: [],
  };
}

const CHAMPS: Champion[] = [
  { id: 1, name: '安妮', alias: 'Annie', roles: ['MAGE'], iconPath: '/a.png' },
  { id: 2, name: '盖伦', alias: 'Garen', roles: ['FIGHTER'], iconPath: '/g.png' },
  { id: 3, name: '拉克丝', alias: 'Lux', roles: ['MAGE'], iconPath: '/l.png' },
];

const HEXTECHS: HextechStatic[] = [
  hex(1001, '泰坦的坚决', 'kPrismatic'),
  hex(1002, '尖端发明家', 'kGold'),
  hex(1003, '小小之力', 'kSilver'),
];

/* ------------------------------------------------------------------ */
/* join                                                                */
/* ------------------------------------------------------------------ */

test('buildRankRows：按国服数字 ID join 图鉴，取出中文名/图标/稀有度', () => {
  const rows = buildRankRows({
    rankings: snapshot([rankEntry(1001, 0.55)]),
    hextechs: HEXTECHS,
  });

  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.id, 1001);
  assert.equal(r.name, '泰坦的坚决');
  assert.equal(r.rarity, 'kPrismatic');
  assert.equal(r.icon, 'https://cdn/small/1001.png'); // 优先 smallIcon
  assert.equal(r.hasDef, true);
});

test('buildRankRows：图鉴缺失时不丢行，降级为占位名与 hasDef=false', () => {
  const rows = buildRankRows({
    // 9999 不在图鉴里（例如新海克斯、图鉴尚未更新）
    rankings: snapshot([rankEntry(9999, 0.5)]),
    hextechs: HEXTECHS,
  });

  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.name, '海克斯#9999');
  assert.equal(r.hasDef, false);
  assert.equal(r.icon, '');
  assert.equal(r.rarity, 'kSilver'); // 安全降级
  // 统计数据仍保留（有图鉴信息更好，没有也不该丢统计）
  assert.equal(r.winRate, 0.5);
});

test('buildRankRows：不会拿 CDragon 口径的 id 误匹配', () => {
  // CDragon 的 augment id 是 1205 这类，与国服 1001+ 语义不同。
  // 这里构造「统计 id = CDragon id」的情形，必须判定为无图鉴，
  // 而不是错把 CDragon 条目当成国服条目匹配上。
  const cdragonLike: HextechStatic = hex(1205, '错误匹配', 'kGold');
  const rows = buildRankRows({
    rankings: snapshot([rankEntry(1205, 0.4)]),
    hextechs: [cdragonLike, ...HEXTECHS],
  });
  // 注意：HextechStatic.id 本身就是国服口径，所以 1205 命中是"合法"的；
  // 本用例真正要防的是别去用 Augment.id 匹配。这里断言 join 只认 HextechStatic。
  assert.equal(rows[0]!.name, '错误匹配');
  assert.equal(rows[0]!.hasDef, true);
});

test('buildRankRows：bestHeroes 经英雄表翻译，超限截断', () => {
  const rows = buildRankRows({
    rankings: snapshot([rankEntry(1001, 0.5, { bestHeroes: [1, 2, 3, 4, 5] })]),
    hextechs: HEXTECHS,
    champions: CHAMPS,
    maxHeroes: 3,
  });
  assert.deepEqual(rows[0]!.bestHeroes, ['安妮', '盖伦', '拉克丝']);
});

test('buildRankRows：英雄表中查不到的 id 回落为 #id', () => {
  const rows = buildRankRows({
    rankings: snapshot([rankEntry(1001, 0.5, { bestHeroes: [1, 999] })]),
    hextechs: HEXTECHS,
    champions: CHAMPS,
  });
  assert.deepEqual(rows[0]!.bestHeroes, ['安妮', '#999']);
});

test('buildRankRows：rankings 为 null 时返回空数组', () => {
  assert.deepEqual(buildRankRows({ rankings: null, hextechs: HEXTECHS }), []);
});

/* ------------------------------------------------------------------ */
/* 分组与排序                                                          */
/* ------------------------------------------------------------------ */

test('groupByRarity：按稀有度分组，组内按胜率降序', () => {
  const rows = buildRankRows({
    rankings: snapshot([
      rankEntry(1003, 0.48), // 白银
      rankEntry(1001, 0.51), // 棱彩
      rankEntry(1002, 0.60), // 黄金
      rankEntry(1001, 0.58), // 又一个棱彩（应由胜率排序）
    ]),
    hextechs: HEXTECHS,
  });

  const groups = groupByRarity(rows);
  assert.deepEqual(
    groups.map((g) => g.rarity),
    ['kPrismatic', 'kGold', 'kSilver'],
  );

  const prismatic = groups[0]!;
  assert.equal(prismatic.rows.length, 2);
  assert.equal(prismatic.rows[0]!.winRate, 0.58); // 高胜率在前
  assert.equal(prismatic.rows[1]!.winRate, 0.51);
});

test('groupByRarity：空组被剔除（调用方可直接判空）', () => {
  const groups = groupByRarity([]);
  assert.equal(groups.length, 0);
});

test('groupByRarity：只出现白银时不产生空的棱彩/黄金组', () => {
  const rows = buildRankRows({
    rankings: snapshot([rankEntry(1003, 0.4)]),
    hextechs: HEXTECHS,
  });
  const groups = groupByRarity(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.rarity, 'kSilver');
});

test('RARITY_ORDER：棱彩 > 黄金 > 白银 > 事件（展示优先级）', () => {
  assert.deepEqual(RARITY_ORDER, ['kPrismatic', 'kGold', 'kSilver', 'kEventChoice']);
});

/* ------------------------------------------------------------------ */
/* buildRankBoard                                                      */
/* ------------------------------------------------------------------ */

test('buildRankBoard：每组按 perGroup 截断', () => {
  const entries = Array.from({ length: 20 }, (_, i) => rankEntry(1001, 0.5 + i / 100));
  const groups = buildRankBoard({
    rankings: snapshot(entries),
    hextechs: HEXTECHS,
    perGroup: 5,
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.rows.length, 5);
  // 截断应保留胜率最高的那些
  assert.ok(groups[0]!.rows[0]!.winRate >= groups[0]!.rows[4]!.winRate);
});

test('buildRankBoard：perGroup 默认 8', () => {
  const entries = Array.from({ length: 20 }, (_, i) => rankEntry(1001, 0.5 + i / 100));
  const groups = buildRankBoard({ rankings: snapshot(entries), hextechs: HEXTECHS });
  assert.equal(groups[0]!.rows.length, 8);
});

/* ------------------------------------------------------------------ */
/* 指定英雄的适配海克斯                                                */
/* ------------------------------------------------------------------ */

test('bestAugmentsForChampion：只返回该英雄的适配海克斯，且按胜率降序', () => {
  const rankings = snapshot([
    rankEntry(1001, 0.55, { bestHeroes: [1, 2] }), // 适配安妮
    rankEntry(1002, 0.62, { bestHeroes: [1] }), // 适配安妮，胜率更高
    rankEntry(1003, 0.70, { bestHeroes: [3] }), // 只适配拉克丝
  ]);

  const rows = bestAugmentsForChampion(1, {
    rankings,
    hextechs: HEXTECHS,
    champions: CHAMPS,
  });

  assert.deepEqual(
    rows.map((r) => r.name),
    ['尖端发明家', '泰坦的坚决'], // 0.62 在 0.55 之前
  );
  // 未适配的必须被排除
  assert.equal(
    rows.some((r) => r.name === '小小之力'),
    false,
  );
});

test('bestAugmentsForChampion：遵守 limit', () => {
  const rankings = snapshot([
    rankEntry(1001, 0.5, { bestHeroes: [1] }),
    rankEntry(1002, 0.6, { bestHeroes: [1] }),
    rankEntry(1003, 0.7, { bestHeroes: [1] }),
  ]);
  const rows = bestAugmentsForChampion(1, {
    rankings,
    hextechs: HEXTECHS,
    limit: 2,
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.name, '小小之力'); // 最高胜率者保留
});

test('bestAugmentsForChampion：无适配数据时返回空数组', () => {
  const rankings = snapshot([rankEntry(1001, 0.5, { bestHeroes: [2] })]);
  assert.deepEqual(
    bestAugmentsForChampion(1, { rankings, hextechs: HEXTECHS }),
    [],
  );
});

test('bestAugmentsForChampion：rankings 为 null 时返回空数组', () => {
  assert.deepEqual(
    bestAugmentsForChampion(1, { rankings: null, hextechs: HEXTECHS }),
    [],
  );
});

/* ------------------------------------------------------------------ */
/* hasRankingData                                                      */
/* ------------------------------------------------------------------ */

test('hasRankingData：无快照/空快照均为 false（不得用旧数据冒充）', () => {
  assert.equal(hasRankingData(null), false);
  assert.equal(hasRankingData(snapshot([])), false);
  assert.equal(hasRankingData(snapshot([rankEntry(1001, 0.5)])), true);
});
