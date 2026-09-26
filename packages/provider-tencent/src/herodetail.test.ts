/**
 * 单英雄海斗详情解析测试
 *
 * 夹具取自上游真实返回（亚索 157，20260925）。
 * 这一组测试针对三个**实际踩过的解析 bug**，每个都写明了错在哪：
 *
 *   1. `augment_json_irank` 是**带稀有度分组**的串，不是平铺列表。
 *      按 `#` 直接切会得到 249 条（含跨组重复），正确结果 126 条。
 *   2. `sk_s` / `sk_w` 是**原始计数**，不是 0..1 比率。
 *      直接当比率会算出 131200% 这种荒谬登场率。
 *   3. `itemout` 是**出门装组合**，`itemover_rec` 才是**成型六件套**。
 *      两者混用会让"完整出装"显示出出门装。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseChampionAugments,
  parseChampionBuild,
  parseChampionDetail,
  parseChampionPartners,
  parseItemOverRec,
  parseItemStatJson,
  parseItemStatList,
  parseSkillOrders,
  type RawHeroDetail,
} from './index.ts';

/* ------------------------------------------------------------------ */
/* 海克斯强度：分组解析                                                */
/* ------------------------------------------------------------------ */

/** 真实片段：255 组头 + 2 条，然后 kGold 组头 + 2 条。 */
const AUG_FIXTURE =
  '255:1|157|1077|255|0.2452|S' +
  '#2|157|1336|255|0.2105|S' +
  '&kGold:1|157|1077|kGold|0.2452|S' +
  '#2|157|1336|kGold|0.2105|S';

test('parseChampionAugments：默认取 255（全部品质）分组，不跨组重复', () => {
  const out = parseChampionAugments(AUG_FIXTURE);
  // 若按 # 直接切会得到 4 条（含 kGold 重复），正确是 2 条
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((a) => a.augmentId),
    [1077, 1336],
  );
  assert.ok(out.every((a) => a.level === '255'));
});

test('parseChampionAugments：可指定其它稀有度分组', () => {
  const gold = parseChampionAugments(AUG_FIXTURE, 'kGold');
  assert.equal(gold.length, 2);
  assert.ok(gold.every((a) => a.level === 'kGold'));
  // 不存在的分组应为空
  assert.equal(parseChampionAugments(AUG_FIXTURE, 'kSilver').length, 0);
});

test('parseChampionAugments：all-groups 去重合并', () => {
  // 1077/1336 在两个组都出现 → 去重后应为 2 条
  const all = parseChampionAugments(AUG_FIXTURE, 'all-groups');
  assert.equal(all.length, 2);
});

test('parseChampionAugments：字段解析正确（排名/登场率/强度）', () => {
  const [first] = parseChampionAugments(AUG_FIXTURE);
  assert.ok(first);
  assert.equal(first.rank, 1);
  assert.equal(first.augmentId, 1077);
  assert.equal(first.pickRate, 0.2452); // 登场率，不是胜率
  assert.equal(first.tier, 'S');
});

test('parseChampionAugments：按排名升序', () => {
  const raw = '255:5|1|105|255|0.01|C#1|1|106|255|0.5|S#3|1|107|255|0.1|B';
  const out = parseChampionAugments(raw);
  assert.deepEqual(
    out.map((a) => a.rank),
    [1, 3, 5],
  );
});

test('parseChampionAugments：跳过脏块与非法 ID，不抛错', () => {
  const raw = '255:1|157|1077|255|0.24|S#垃圾数据#2|157|-1|255|0.1|A#3|157|1080|255|0.08|B';
  const out = parseChampionAugments(raw);
  // 非法 augmentId 与字段不足者被丢弃，保留 2 条
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((a) => a.augmentId),
    [1077, 1080],
  );
});

test('parseChampionAugments：空输入返回空数组', () => {
  assert.deepEqual(parseChampionAugments(undefined), []);
  assert.deepEqual(parseChampionAugments(''), []);
});

/* ------------------------------------------------------------------ */
/* 出装：三种不同的上游格式                                             */
/* ------------------------------------------------------------------ */

test('parseItemStatList：解析 `itemIds$登场率$胜率`（登场率在前）', () => {
  // 直接写正确的上游格式，不要用 replace 去"拼"分隔符——
  // 那样容易把 fixture 里其它的下划线一起换掉（本用例最初就踩了这个坑）。
  const out = parseItemStatList('6672,6673,3031$0.1$0.5523#6333$0.1$0.5');
  assert.equal(out.length, 2);
  assert.deepEqual(out[0]!.itemIds, [6672, 6673, 3031]);
  assert.equal(out[0]!.pickRate, 0.1);
  assert.equal(out[0]!.winRate, 0.5523);
  assert.deepEqual(out[1]!.itemIds, [6333]);
});

test('parseItemStatJson：万分数值必须换算为比率（6033 → 0.6033）', () => {
  const out = parseItemStatJson(
    '{"1":{"itemone":"123430","winrate":6033,"showrate":6758}}',
    'itemone',
  );
  assert.equal(out.length, 1);
  // 若不换算会得到 6033（603300%）
  assert.equal(out[0]!.winRate, 0.6033);
  assert.equal(out[0]!.pickRate, 0.6758);
  assert.deepEqual(out[0]!.itemIds, [123430]);
});

test('parseItemStatJson：itemcore 用 & 分隔的多件', () => {
  const out = parseItemStatJson(
    '{"1":{"itemcore":"123430&3153&6333","winrate":6172,"showrate":699}}',
    'itemcore',
  );
  assert.deepEqual(out[0]!.itemIds, [123430, 3153, 6333]);
  assert.equal(out[0]!.winRate, 0.6172);
});

test('parseItemStatJson：按登场率降序（最常采用的方案在前）', () => {
  const out = parseItemStatJson(
    '{"1":{"itemone":"1","winrate":10,"showrate":100},' +
      '"2":{"itemone":"2","winrate":20,"showrate":900}}',
    'itemone',
  );
  assert.equal(out[0]!.itemIds[0], 2); // 登场率 900 > 100
});

test('parseItemStatJson：脏 JSON 返回空数组而非抛错', () => {
  assert.deepEqual(parseItemStatJson('{不是JSON', 'itemone'), []);
  assert.deepEqual(parseItemStatJson(undefined, 'itemone'), []);
});

test('parseItemOverRec：解析成型六件套（`;` 分隔）', () => {
  const out = parseItemOverRec(
    '1_123430,3006,3031,3032,3153,6333_0.0177_0.5622;2_1,2,3_0.01_0.5',
  );
  assert.equal(out.length, 2);
  assert.equal(out[0]!.itemIds.length, 6); // 六件
  assert.equal(out[0]!.pickRate, 0.0177);
  assert.equal(out[0]!.winRate, 0.5622);
});

test('parseChampionBuild：五个槽位取自各自正确的字段（不可混用）', () => {
  const raw: RawHeroDetail = {
    itemone_json: '{"1":{"itemone":"1055","winrate":5000,"showrate":8000}}',
    itemout: '1018,1052$0.0371$0.6347',
    itemshoes: '3006$0.5618$0.5787',
    itemcore_json: '{"1":{"itemcore":"1&2&3","winrate":6000,"showrate":700}}',
    itemover_rec: '1_1,2,3,4,5,6_0.0177_0.5622',
  };
  const b = parseChampionBuild(raw);
  assert.deepEqual(b.start[0]!.itemIds, [1055]); // 单件
  assert.deepEqual(b.startCombo[0]!.itemIds, [1018, 1052]); // 出门装组合
  assert.deepEqual(b.shoes[0]!.itemIds, [3006]);
  assert.deepEqual(b.core[0]!.itemIds, [1, 2, 3]); // 三件套
  assert.equal(b.full[0]!.itemIds.length, 6); // 六件套，不是出门装
});

/* ------------------------------------------------------------------ */
/* 技能加点：原始计数 → 比率                                            */
/* ------------------------------------------------------------------ */

test('parseSkillOrders：sk_s/sk_w 是计数，须换算为登场率', () => {
  const raw =
    '{"1":{"qwe":"1&3&2","sks":{"1":{"sk":"1&2&3&1","sk_s":"1312","sk_w":"5578"}}}}';
  const out = parseSkillOrders(raw);
  assert.equal(out.length, 1);
  // 1312/5578 ≈ 0.2352，而不是 1312（131200%）
  assert.ok(Math.abs(out[0]!.pickRate - 1312 / 5578) < 1e-9);
  assert.ok(out[0]!.pickRate < 1);
  assert.deepEqual(out[0]!.priority, [1, 3, 2]);
  assert.deepEqual(out[0]!.order, [1, 2, 3, 1]);
});

test('parseSkillOrders：同一方案下取登场率最高的加点序列', () => {
  const raw =
    '{"1":{"qwe":"1&2&3","sks":{' +
    '"1":{"sk":"1&1&1","sk_s":"100","sk_w":"1000"},' +
    '"2":{"sk":"2&2&2","sk_s":"500","sk_w":"1000"}}}}';
  const out = parseSkillOrders(raw);
  // 500/1000 > 100/1000 → 应取第 2 套
  assert.deepEqual(out[0]!.order, [2, 2, 2]);
  assert.equal(out[0]!.pickRate, 0.5);
});

test('parseSkillOrders：按登场率降序且遵守 limit', () => {
  const raw =
    '{"1":{"qwe":"1&2&3","sks":{"1":{"sk":"1","sk_s":"100","sk_w":"1000"}}},' +
    '"2":{"qwe":"1&2&3","sks":{"1":{"sk":"2","sk_s":"900","sk_w":"1000"}}},' +
    '"3":{"qwe":"1&2&3","sks":{"1":{"sk":"3","sk_s":"500","sk_w":"1000"}}}}';
  const out = parseSkillOrders(raw, 2);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0]!.order, [2]); // 0.9 最高
  assert.deepEqual(out[1]!.order, [3]); // 0.5 次之
});

test('parseSkillOrders：sk_w 为 0 时登场率为 0（不产生 NaN/Infinity）', () => {
  const raw = '{"1":{"qwe":"1&2&3","sks":{"1":{"sk":"1","sk_s":"10","sk_w":"0"}}}}';
  const out = parseSkillOrders(raw);
  assert.equal(out[0]!.pickRate, 0);
});

test('parseSkillOrders：脏 JSON 返回空数组', () => {
  assert.deepEqual(parseSkillOrders('{坏'), []);
});

/* ------------------------------------------------------------------ */
/* 拍档与整体                                                          */
/* ------------------------------------------------------------------ */

test('parseChampionPartners：解析并按排名升序', () => {
  const out = parseChampionPartners('4|0.642|0.0303|1#25|0.6397|0.0281|2');
  assert.equal(out.length, 2);
  assert.equal(out[0]!.championId, 4);
  assert.equal(out[0]!.winRate, 0.642);
  assert.equal(out[0]!.pickRate, 0.0303);
  assert.equal(out[0]!.rank, 1);
});

test('parseChampionPartners：空输入与脏数据安全', () => {
  assert.deepEqual(parseChampionPartners(undefined), []);
  assert.deepEqual(parseChampionPartners('#垃圾#'), []);
});

test('parseChampionDetail：汇总所有字段并取 dtstatdate', () => {
  const raw: RawHeroDetail = {
    dtstatdate: '20260925',
    augment_json_irank: '255:1|157|1077|255|0.2452|S',
    itemone_json: '{"1":{"itemone":"1055","winrate":5000,"showrate":8000}}',
    itemshoes: '3006$0.5$0.5',
    itemcore_json: '{"1":{"itemcore":"1&2&3","winrate":6000,"showrate":700}}',
    itemout: '1,2$0.03$0.6',
    itemover_rec: '1_1,2,3,4,5,6_0.01_0.5',
    championid_json: '4|0.642|0.0303|1',
    skill_json: '{"1":{"qwe":"1&2&3","sks":{"1":{"sk":"1","sk_s":"1","sk_w":"2"}}}}',
  };
  const d = parseChampionDetail(157, raw);
  assert.equal(d.championId, 157);
  assert.equal(d.dataDate, '20260925');
  assert.equal(d.augments.length, 1);
  assert.equal(d.build.shoes.length, 1);
  assert.equal(d.build.full.length, 1);
  assert.equal(d.skills.length, 1);
  assert.equal(d.partners.length, 1);
});

test('parseChampionDetail：字段缺失时全部降级为空，不抛错', () => {
  const d = parseChampionDetail(1, {});
  assert.deepEqual(d.augments, []);
  assert.deepEqual(d.build.start, []);
  assert.deepEqual(d.build.core, []);
  assert.deepEqual(d.skills, []);
  assert.deepEqual(d.partners, []);
  assert.equal(d.dataDate, '');
});
