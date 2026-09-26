/**
 * provider-tencent 解析测试
 *
 * 夹具取自上游真实返回（20260924），字段规格照抄 101 官方站
 * bundle 中的 parseRuneRank / parseHeroRank。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildIdBridge,
  createTencentRankingProvider,
  createTencentStaticProvider,
  extractFieldValue,
  normalizeAugmentNameId,
  normalizeKiwiAugments,
  parseAugmentRankList,
  parseDataDate,
  parseHeroRankList,
  parseRankChange,
  type RawKiwiAugment,
} from './index.ts';

/* ------------------------------------------------------------------ */
/* 图鉴                                                                */
/* ------------------------------------------------------------------ */

const KIWI_FIXTURE: RawKiwiAugment[] = [
  {
    augmentID: 1001,
    name_en: 'ARAM_ImTheJuggernaut',
    name_cn: '泰坦的坚决',
    mode: 'KIWI, KIWI_JADE',
    level: 'kPrismatic',
    isPBE: 0,
    isNew: 0,
    tooltip: '在承受或造成伤害时获得层数。',
    large_Icon: 'https://game.gtimg.cn/images/lol/act/img/rune/iamthejuggernaut_large.png',
    small_Icon: 'https://game.gtimg.cn/images/lol/act/img/rune/iamthejuggernaut_small.png',
  },
  {
    augmentID: 1002,
    name_en: 'ARAM_ApexInventor',
    name_cn: '尖端发明家',
    mode: 'KIWI',
    level: 'kGold',
    isNew: 1,
  },
  {
    // PBE 条目应被过滤
    augmentID: 1999,
    name_en: 'ARAM_NotLiveYet',
    name_cn: '尚未上线',
    mode: 'KIWI',
    level: 'kSilver',
    isPBE: 1,
  },
  {
    // 非法 ID 应被过滤
    augmentID: -1,
    name_en: 'ARAM_BadId',
    name_cn: '坏ID',
    level: 'kSilver',
  },
];

test('normalizeKiwiAugments：过滤 PBE/非法 ID，规范化字段', () => {
  const out = normalizeKiwiAugments(KIWI_FIXTURE);
  assert.equal(out.length, 2);
  const first = out[0]!;
  assert.equal(first.id, 1001);
  assert.equal(first.augmentNameId, 'ARAM_ImTheJuggernaut');
  assert.equal(first.name, '泰坦的坚决');
  assert.equal(first.rarity, 'kPrismatic');
  assert.deepEqual([...first.modes], ['KIWI', 'KIWI_JADE']);
  assert.equal(first.isNew, false);
  const second = out[1]!;
  assert.equal(second.isNew, true);
  assert.equal(second.rarity, 'kGold');
});

test('normalizeKiwiAugments：未知模式与稀有度安全降级', () => {
  const out = normalizeKiwiAugments([
    { augmentID: 3001, name_en: 'ARAM_X', name_cn: 'X', mode: 'FUTURE_MODE', level: 'kDiamond' },
  ]);
  const e = out[0]!;
  assert.deepEqual([...e.modes], []);
  assert.equal(e.rarity, 'kSilver');
});

test('buildIdBridge + normalizeAugmentNameId：与 CDragon 口径对齐规则一致', () => {
  const bridge = buildIdBridge(normalizeKiwiAugments(KIWI_FIXTURE));
  assert.equal(bridge.get(1001), 'ARAM_ImTheJuggernaut');
  assert.equal(normalizeAugmentNameId('ARAM_ImTheJuggernaut'), 'imthejuggernaut');
  assert.equal(normalizeAugmentNameId('ImTheJuggernaut'), 'imthejuggernaut');
});

/* ------------------------------------------------------------------ */
/* 排行榜                                                              */
/* ------------------------------------------------------------------ */

// 来自 fuwen_aram_rune_rank_v2 真实返回（20260924，首两条 + 一条脏数据）
const RUNE_RAW =
  '{"dtstatdate":"20260924","augmentlist":' +
  '"1001_255_0.147_110_0_0.4783_188_-1_223,36,50,14,31,875' +
  '#1002_255_0.1427_111_0_0.4981_151_-1_223,36,14,875,31,516' +
  '#badblock' +
  '#1004_255_0.2757_46_-1_0.5769_18_-2_13,41,4,901,223,25"}';

test('parseAugmentRankList：按官方规格解析字段', () => {
  const list = parseAugmentRankList(RUNE_RAW);
  assert.equal(list.length, 3);
  const first = list[0]!;
  assert.equal(first.id, 1001);
  assert.equal(first.level, 255);
  assert.equal(first.pickRate, 0.147);
  assert.equal(first.pickRank, 110);
  assert.equal(first.pickRankChange, 0);
  assert.equal(first.winRate, 0.4783);
  assert.equal(first.winRank, 188);
  assert.equal(first.winRankChange, -1);
  assert.deepEqual([...first.bestHeroes], [223, 36, 50, 14, 31, 875]);
});

test('parseAugmentRankList：跳过脏块，空输入返回空数组', () => {
  assert.equal(parseAugmentRankList('')[0], undefined);
  assert.equal(parseAugmentRankList(null)!.length, 0);
  assert.equal(parseAugmentRankList(RUNE_RAW)!.length, 3);
});

// 来自 fuwen_aram_hero_rank_v2 真实返回（20260924，首块）
const HERO_RAW =
  '{"dtstatdate":"20260924","listcollect":' +
  '"157_1_未变化_0.5721_0.1067_17,0.059,0.6137,1&63,0.0587,0.6129,2_298.1781_0.6097_0.205_0.1873_1077,1336,1058' +
  '#17_2_上升1位_0.5369_0.1374_157,0.0458,0.6138,1_254.7162_0.6247_0.1803_0.1323_2128,1373,1029' +
  '#136_3_下降3位_0.5476_0.1116_223,0.0606,0.5931,1_271.1115_0.7205_0.2073_0.1718_2128,2132,2131"}';

test('parseHeroRankList：按官方规格解析字段（含搭档列表）', () => {
  const list = parseHeroRankList(HERO_RAW);
  assert.equal(list.length, 3);
  const first = list[0]!;
  assert.equal(first.championId, 157);
  assert.equal(first.rank, 1);
  assert.equal(first.rankChangeDesc, '未变化');
  assert.equal(first.rankChange, 0);
  assert.equal(first.winRate, 0.5721);
  assert.equal(first.pickRate, 0.1067);
  assert.equal(first.avgDeathTime, 298.1781);
  assert.equal(first.avgParticipationRate, 0.6097);
  assert.equal(first.avgDamageRatio, 0.205);
  assert.equal(first.avgTankRatio, 0.1873);
  assert.deepEqual(
    [...first.bestPartners],
    [
      { championId: 17, pickRate: 0.059, winRate: 0.6137, rank: 1 },
      { championId: 63, pickRate: 0.0587, winRate: 0.6129, rank: 2 },
    ],
  );
});

test('parseHeroRankList：搭档只保留前 5', () => {
  const manyPartners = Array.from({ length: 8 }, (_, i) => `${100 + i},0.01,0.5,${i + 1}`).join('&');
  const raw = `42_1_未变化_0.5_0.1_${manyPartners}_300_0.6_0.2_0.2_x`;
  const list = parseHeroRankList(raw);
  assert.equal(list[0]!.bestPartners.length, 5);
});

test('parseRankChange：官方站同款文案解析', () => {
  assert.equal(parseRankChange('未变化'), 0);
  assert.equal(parseRankChange('上升1位'), 1);
  assert.equal(parseRankChange('下降3位'), -3);
  assert.equal(parseRankChange(''), 0);
  assert.equal(parseRankChange(undefined), 0);
  assert.equal(parseRankChange('乱写'), 0);
});

/* ------------------------------------------------------------------ */
/* 封装解包                                                            */
/* ------------------------------------------------------------------ */

test('extractFieldValue：取 _fieldValues 中最长值', () => {
  const payload = { code: 0, data: { _fieldValues: { R15381: 'short', R15380: 'x'.repeat(50) } } };
  assert.equal(extractFieldValue(payload)!.length, 50);
  assert.equal(extractFieldValue({}), null);
  assert.equal(extractFieldValue(null), null);
});

test('extractFieldValue：返回错误提示时为 null 或短串', () => {
  const errPayload = {
    code: 0,
    data: { _fieldValues: { R15381: '' } },
    message: 'arg dtstatdate is required',
  };
  assert.equal(extractFieldValue(errPayload), null);
});

test('parseDataDate：从字段值中提取统计日期', () => {
  assert.equal(parseDataDate(RUNE_RAW), '20260924');
  assert.equal(parseDataDate('no date here'), '');
});

/* ------------------------------------------------------------------ */
/* Provider 工厂（注入 fetch，不触网）                                 */
/* ------------------------------------------------------------------ */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('静态 provider：加载并规范化图鉴', async () => {
  const provider = createTencentStaticProvider({
    fetchImpl: (async () => jsonResponse(KIWI_FIXTURE)) as typeof fetch,
  });
  const ds = await provider.load();
  assert.equal(ds.hextechs.length, 2);
  assert.equal(ds.meta.source, 'tencent-static');
  assert.equal(ds.augments.length, 0); // 本 provider 只补国服口径图鉴
});

test('排行榜 provider：拉取 + 解析 + 数据日期', async () => {
  const calls: string[] = [];
  const provider = createTencentRankingProvider({
    statDate: '20260924',
    fetchImpl: (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse({
        code: 0,
        data: { _fieldValues: { R999: String(input).includes('rune') ? RUNE_RAW : HERO_RAW } },
      });
    }) as typeof fetch,
  });
  const snap = await provider.load();
  assert.equal(snap.meta.dataDate, '20260924');
  assert.equal(snap.augments.length, 3);
  assert.equal(snap.heroes.length, 3);
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.includes('augmentid_level=255'));
});

test('排行榜 provider：上游无数据时诚实返回空快照', async () => {
  const provider = createTencentRankingProvider({
    statDate: '20260924',
    fetchImpl: (async () => jsonResponse({ code: 0, data: { _fieldValues: { R1: '' } } })) as typeof fetch,
  });
  const snap = await provider.load();
  assert.equal(snap.augments.length, 0);
  assert.equal(snap.heroes.length, 0);
  assert.equal(snap.meta.dataDate, '');
});

test('排行榜 provider：上游报错时返回空快照而非抛出', async () => {
  const provider = createTencentRankingProvider({
    statDate: '20260924',
    fetchImpl: (async () => new Response('bad gateway', { status: 502 })) as typeof fetch,
  });
  const snap = await provider.load();
  assert.equal(snap.augments.length, 0);
  assert.equal(snap.heroes.length, 0);
});

test('排行榜 provider：HTTP 失败后回退到更早日期', async () => {
  // 不能写死「T-1 = 某天」：候选窗口由真实当前日期生成，写死会让测试
  // 随日历漂移而失效（日期一过，首个候选日就不再是被 mock 失败的那天）。
  // 这里改为让「首个候选日」动态失败，其余日期成功。
  const firstCandidate = Array.from({ length: 5 }, (_, i) =>
    new Date(Date.now() - (i + 1) * 86_400_000).toISOString().slice(0, 10).replace(/-/g, ''),
  )[0]!;

  let failures = 0;
  const tried: string[] = [];
  const provider = createTencentRankingProvider({
    fetchImpl: (async (input: RequestInfo | URL) => {
      const date = String(input).match(/dtstatdate=(\d{8})/)![1]!;
      tried.push(date);
      if (date === firstCandidate) {
        failures++;
        return new Response('err', { status: 502 });
      }
      return jsonResponse({ code: 0, data: { _fieldValues: { R1: RUNE_RAW } } });
    }) as typeof fetch,
  });
  const snap = await provider.load();
  assert.ok(failures >= 2, `首个候选日 ${firstCandidate} 失败后应重试更早日期`);
  assert.ok(new Set(tried).size >= 2, '应尝试过至少两个不同日期');
  assert.ok(snap.augments.length > 0);
});
