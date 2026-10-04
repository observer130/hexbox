/**
 * overlay-view 测试（悬浮窗分阶段视图模型）
 *
 * 悬浮窗本身在 CI 中跑不起来（需管理员 + 真实桌面），
 * 因此纯函数层面的覆盖尤其重要。
 *
 * 重点验证各阶段的**语义正确性**：
 *   - 选人阶段给的是**英雄胜率**，不是海克斯胜率
 *   - 海克斯阶段给的是**该英雄口径**的强度与登场率（不是全局榜）
 *   - 出装槽位各取自正确的上游字段（出门装 ≠ 成型六件套）
 *   - 数据缺失时诚实降级，不伪造 0% 或空名
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  Champion,
  ChampionAugmentStat,
  ChampionDetail,
  ChampionDetailSet,
  HeroRankEntry,
  HextechStatic,
} from './types.ts';

import {
  augmentStrength,
  champSelectInfo,
  championBuild,
  findDetail,
  hasBuildData,
} from './overlay-view.ts';

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

function hex(id: number, name: string, rarity: HextechStatic['rarity']): HextechStatic {
  return {
    id,
    augmentNameId: `ARAM_${id}`,
    name,
    tooltip: '',
    rarity,
    modes: ['KIWI'],
    largeIcon: `https://cdn/large/${id}.png`,
    smallIcon: `https://cdn/small/${id}.png`,
    isNew: false,
  };
}

function aug(
  augmentId: number,
  rank: number,
  tier: string,
  pickRate: number,
  level = '255',
): ChampionAugmentStat {
  return { augmentId, rank, level, pickRate, tier };
}

const HEXTECHS: HextechStatic[] = [
  hex(1077, '灵魂虹吸', 'kGold'),
  hex(1336, '升级：无尽之刃', 'kGold'),
  hex(1058, '秘术冲拳', 'kPrismatic'),
];

const ITEMS = [
  { id: 1055, name: '多兰之刃' },
  { id: 3006, name: '狂战士胫甲' },
  { id: 6672, name: '海妖杀手' },
  { id: 6673, name: '不朽盾弓' },
  { id: 3031, name: '无尽之刃' },
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

/* ------------------------------------------------------------------ */
/* 选人阶段：英雄胜率                                                  */
/* ------------------------------------------------------------------ */

const HEROES: HeroRankEntry[] = [
  {
    championId: 157,
    rank: 1,
    rankChangeDesc: '未变化',
    rankChange: 0,
    winRate: 0.5723,
    pickRate: 0.1073,
    bestPartners: [],
    avgDeathTime: 298,
    avgParticipationRate: 0.6,
    avgDamageRatio: 0.2,
    avgTankRatio: 0.18,
  },
];

const CHAMPS: Champion[] = [
  { id: 157, name: '疾风剑豪', alias: 'Yasuo', roles: ['FIGHTER'], iconPath: '' },
];

test('champSelectInfo：返回该英雄的胜率', () => {
  const info = champSelectInfo(157, { heroes: HEROES, champions: CHAMPS });
  assert.equal(info.name, '疾风剑豪');
  assert.equal(info.winRate, 0.5723);
  assert.equal(info.hasData, true);
});

test('champSelectInfo：无统计的英雄标记 hasData=false，不伪造 0%', () => {
  const info = champSelectInfo(999, { heroes: HEROES, champions: CHAMPS });
  assert.equal(info.hasData, false);
  assert.equal(info.name, '英雄#999');
});

test('champSelectInfo：championId 为 0（未选人）时不报错', () => {
  const info = champSelectInfo(0, { heroes: HEROES, champions: CHAMPS });
  assert.equal(info.hasData, false);
  assert.equal(info.name, '');
});

test('champSelectInfo：不提供胜率变化（上游无此数据，避免假装有箭头）', () => {
  const info = champSelectInfo(157, { heroes: HEROES, champions: CHAMPS });
  assert.equal(info.winRateChange, 0);
});

/* ------------------------------------------------------------------ */
/* 海克斯阶段：该英雄口径的强度                                        */
/* ------------------------------------------------------------------ */

test('augmentStrength：按官方排名升序，并 join 图鉴取中文名', () => {
  const d = detail({
    augments: [
      aug(1058, 3, 'S', 0.1569),
      aug(1077, 1, 'S', 0.2452),
      aug(1336, 2, 'S', 0.2105),
    ],
  });
  const rows = augmentStrength({ detail: d, hextechs: HEXTECHS });
  assert.deepEqual(
    rows.map((r) => r.name),
    ['灵魂虹吸', '升级：无尽之刃', '秘术冲拳'],
  );
  assert.deepEqual(
    rows.map((r) => r.rank),
    [1, 2, 3],
  );
});

test('augmentStrength：pickRate 是登场率，原样透传不换算', () => {
  const d = detail({ augments: [aug(1077, 1, 'S', 0.2452)] });
  const rows = augmentStrength({ detail: d, hextechs: HEXTECHS });
  assert.equal(rows[0]!.pickRate, 0.2452);
  assert.equal(rows[0]!.tier, 'S');
});

test('augmentStrength：图鉴缺失时降级为占位名，不丢行', () => {
  const d = detail({ augments: [aug(9999, 1, 'A', 0.01)] });
  const rows = augmentStrength({ detail: d, hextechs: HEXTECHS });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.name, '海克斯#9999');
  assert.equal(rows[0]!.hasDef, false);
  assert.equal(rows[0]!.icon, '');
});

test('augmentStrength：遵守 limit（一屏放不下全部）', () => {
  const d = detail({
    augments: Array.from({ length: 126 }, (_, i) => aug(1000 + i, i + 1, 'S', 0.1)),
  });
  assert.equal(augmentStrength({ detail: d, hextechs: HEXTECHS, limit: 10 }).length, 10);
  assert.equal(augmentStrength({ detail: d, hextechs: HEXTECHS }).length, 10); // 默认 10
});

test('augmentStrength：可按稀有度筛选（官方页有品质页签）', () => {
  const d = detail({ augments: [aug(1077, 1, 'S', 0.2), aug(1058, 2, 'S', 0.15)] });
  const prismatic = augmentStrength({
    detail: d,
    hextechs: HEXTECHS,
    rarity: 'kPrismatic',
  });
  assert.equal(prismatic.length, 1);
  assert.equal(prismatic[0]!.name, '秘术冲拳');
});

test('augmentStrength：detail 为 null 时返回空数组', () => {
  assert.deepEqual(augmentStrength({ detail: null, hextechs: HEXTECHS }), []);
});

/* ------------------------------------------------------------------ */
/* 对局中：出装                                                        */
/* ------------------------------------------------------------------ */

test('championBuild：各槽位取自正确的上游字段', () => {
  const d = detail({
    build: {
      start: [{ itemIds: [1055], pickRate: 0.67, winRate: 0.6 }],
      startCombo: [],
      shoes: [{ itemIds: [3006], pickRate: 0.56, winRate: 0.57 }],
      core: [{ itemIds: [6672, 6673, 3031], pickRate: 0.07, winRate: 0.61 }],
    },
  });
  const v = championBuild({ detail: d, items: ITEMS });

  assert.deepEqual(v.start[0]!.names, ['多兰之刃']); // 单件
  assert.deepEqual(v.shoes[0]!.names, ['狂战士胫甲']);
  assert.deepEqual(v.core[0]!.names, ['海妖杀手', '不朽盾弓', '无尽之刃']); // 三件
  assert.equal(v.core[0]!.winRate, 0.61);
  // 官方页面不展示的 itemover_rec 不采集 —— 视图里也不该有「六件套」槽位
  assert.deepEqual(Object.keys(v).sort(), ['core', 'shoes', 'start']);
});

test('championBuild：装备表查不到时回落为「装备#id」，不丢项', () => {
  const d = detail({
    build: {
      start: [],
      startCombo: [],
      shoes: [],
      core: [{ itemIds: [99999], pickRate: 0.1, winRate: 0.5 }],
    },
  });
  const v = championBuild({ detail: d, items: ITEMS });
  assert.deepEqual(v.core[0]!.names, ['装备#99999']);
  assert.deepEqual(v.core[0]!.iconIds, [99999]);
});

test('championBuild：遵守 limit', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    itemIds: [3031],
    pickRate: 0.1 - i / 100,
    winRate: 0.5,
  }));
  const d = detail({
    build: { start: [], startCombo: [], shoes: [], core: many },
  });
  assert.equal(championBuild({ detail: d, items: ITEMS, limit: 3 }).core.length, 3);
});

test('championBuild：detail 为 null 时返回空结构（不抛错）', () => {
  const v = championBuild({ detail: null, items: ITEMS });
  assert.deepEqual(v, { start: [], shoes: [], core: [] });
});

/* ------------------------------------------------------------------ */
/* 集合查找与可用性                                                    */
/* ------------------------------------------------------------------ */

function set(details: ChampionDetail[]): ChampionDetailSet {
  return {
    meta: { source: 'test', dataDate: '20260925', fetchedAt: 'x', count: details.length },
    details,
  };
}

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

test('hasBuildData：空集合为 false（悬浮窗据此隐藏出装面板）', () => {
  assert.equal(hasBuildData(null), false);
  assert.equal(hasBuildData(set([])), false);
  assert.equal(hasBuildData(set([detail()])), true);
});
