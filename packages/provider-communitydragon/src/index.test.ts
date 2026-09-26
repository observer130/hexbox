/**
 * provider-communitydragon 解析测试
 *
 * 重点覆盖 `buildModeIndex` 的归一化匹配 —— 这是本包最易错的逻辑：
 * `augment-lists.json` 的条目形如 `Maps/ModeSpecificData/Augments/ARAM_ADAPt`，
 * 而 `cherry-augments.json` 的 `augmentNameId` 可能是 `ARAM_ADAPt` 或 `ADAPt`，
 * 两侧大小写/前缀并不严格一致，必须归一化后比较。
 *
 * 夹具按上游真实形状构造，provider 测试注入 fetchImpl，全程不触网。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildModeIndex,
  createCommunityDragonProvider,
  normalizeAugments,
  normalizeChampions,
  normalizeItems,
} from './index.ts';

/* ------------------------------------------------------------------ */
/* buildModeIndex：归一化匹配                                          */
/* ------------------------------------------------------------------ */

test('buildModeIndex：剥离路径前缀与 ARAM_ 前缀后小写匹配', () => {
  const index = buildModeIndex([
    { modeName: 'KIWI', augmentList: ['Maps/ModeSpecificData/Augments/ARAM_ADAPt'] },
  ]);
  // 入库 key 应为归一化后的 `adapt`
  assert.ok(index.has('adapt'));
  assert.deepEqual(index.get('adapt'), ['KIWI']);
  // 原始形式不应作为 key 存在
  assert.equal(index.has('Maps/ModeSpecificData/Augments/ARAM_ADAPt'), false);
  assert.equal(index.has('ARAM_ADAPt'), false);
});

test('buildModeIndex：同一海克斯跨模式池时合并 modes 且不重复', () => {
  const index = buildModeIndex([
    { modeName: 'KIWI', augmentList: ['Maps/ModeSpecificData/Augments/ARAM_Shared'] },
    { modeName: 'KIWI_JADE', augmentList: ['Maps/ModeSpecificData/Augments/ARAM_Shared'] },
    // 同一模式重复出现不应产生重复项
    { modeName: 'KIWI', augmentList: ['Maps/ModeSpecificData/Augments/ARAM_Shared'] },
  ]);
  assert.deepEqual(index.get('shared'), ['KIWI', 'KIWI_JADE']);
});

test('buildModeIndex：未知模式静默跳过，不影响已知模式', () => {
  const index = buildModeIndex([
    { modeName: 'SOMETHING_NEW', augmentList: ['Maps/ModeSpecificData/Augments/ARAM_Future'] },
    { modeName: 'CHERRY', augmentList: ['Maps/ModeSpecificData/Augments/ARAM_Arena'] },
  ]);
  // 未来新增模式不应导致崩溃，也不应污染索引
  assert.equal(index.has('future'), false);
  assert.deepEqual(index.get('arena'), ['CHERRY']);
});

test('buildModeIndex：空输入返回空索引', () => {
  assert.equal(buildModeIndex([]).size, 0);
});

/* ------------------------------------------------------------------ */
/* normalizeAugments                                                   */
/* ------------------------------------------------------------------ */

test('normalizeAugments：命中模式池，稀有度未知时降级为 kSilver', () => {
  const modeIndex = buildModeIndex([
    { modeName: 'KIWI', augmentList: ['Maps/ModeSpecificData/Augments/ARAM_ADAPt'] },
  ]);

  const out = normalizeAugments(
    [
      {
        id: 1205,
        augmentNameId: 'ARAM_ADAPt', // 大小写与 list 侧不一致，靠归一化命中
        nameTRA: '  自适应  ',
        simpleNameTRA: 'ADAPt',
        augmentSmallIconPath: '/lol-game-data/assets/x/ADAPt_small.png',
        rarity: 'kPrismatic',
      },
      {
        id: 1206,
        augmentNameId: 'ARAM_NotInAnyList',
        rarity: '不存在的稀有度', // 未知值应降级，不应崩溃
      },
    ],
    modeIndex,
  );

  assert.equal(out.length, 2);
  const [first, second] = out as [typeof out[0], typeof out[0]];

  assert.equal(first.id, 1205);
  assert.equal(first.name, '自适应'); // nameTRA 应被 trim
  assert.equal(first.simpleName, 'ADAPt');
  assert.equal(first.rarity, 'kPrismatic');
  assert.deepEqual(first.modes, ['KIWI']); // 归一化命中

  // 未命中模式池 → 空数组（不是崩溃、不是 null）
  assert.deepEqual(second.modes, []);
  // 未知稀有度 → 安全降级为 kSilver
  assert.equal(second.rarity, 'kSilver');
  // nameTRA 缺失 → 回落为 augmentNameId；可选字段给默认值
  assert.equal(second.name, 'ARAM_NotInAnyList');
  assert.equal(second.simpleName, '');
  assert.equal(second.iconPath, '');
});

/* ------------------------------------------------------------------ */
/* normalizeChampions / normalizeItems                                 */
/* ------------------------------------------------------------------ */

test('normalizeChampions：过滤 id <= 0 的占位符', () => {
  const out = normalizeChampions([
    { id: -1, name: '无', alias: 'None' }, // 官方占位符，必须过滤
    { id: 0, name: '零', alias: 'Zero' },
    { id: 1, name: '黑暗之女', alias: 'Annie', roles: ['MAGE'], squarePortraitPath: '/x.png' },
  ]);
  assert.equal(out.length, 1);
  const annie = out[0]!;
  assert.equal(annie.id, 1);
  assert.deepEqual(annie.roles, ['MAGE']);
  assert.equal(annie.iconPath, '/x.png');
});

test('normalizeChampions：roles/图标缺失时给安全默认值', () => {
  const out = normalizeChampions([{ id: 2, name: 'x', alias: 'X' }]);
  assert.deepEqual(out[0]!.roles, []);
  assert.equal(out[0]!.iconPath, '');
});

test('normalizeItems：可选字段缺失时给默认值', () => {
  const out = normalizeItems([
    { id: 1001, name: '装备' },
    {
      id: 1002,
      name: '完整装备',
      description: '描述',
      price: 100,
      priceTotal: 3000,
      iconPath: '/i.png',
      categories: ['Damage'],
    },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.description, '');
  assert.equal(out[0]!.price, 0);
  assert.deepEqual(out[0]!.categories, []);
  assert.equal(out[1]!.priceTotal, 3000);
});

/* ------------------------------------------------------------------ */
/* Provider 工厂（注入 fetchImpl，不触网）                              */
/* ------------------------------------------------------------------ */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** 按文件名分派的假 fetch，覆盖 provider 的 4 个并发请求。 */
function fakeFetch(
  routes: Record<string, unknown>,
  onCall?: (url: string) => void,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    onCall?.(url);
    for (const [file, body] of Object.entries(routes)) {
      if (url.includes(file)) return jsonResponse(body);
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

test('provider：加载并合并四个数据端点', async () => {
  const provider = createCommunityDragonProvider({
    fetchImpl: fakeFetch({
      'cherry-augments.json': [
        {
          id: 1205,
          augmentNameId: 'ARAM_ADAPt',
          nameTRA: '自适应',
          augmentSmallIconPath: '/x.png',
          rarity: 'kGold',
        },
      ],
      'augment-lists.json': [
        { modeName: 'KIWI', augmentList: ['Maps/ModeSpecificData/Augments/ARAM_ADAPt'] },
      ],
      'champion-summary.json': [{ id: 1, name: '安妮', alias: 'Annie' }],
      'items.json': [{ id: 1001, name: '长剑' }],
    }),
  });

  const ds = await provider.load();
  assert.equal(ds.meta.source, 'communitydragon');
  assert.equal(ds.augments.length, 1);
  assert.equal(ds.augments[0]!.name, '自适应');
  assert.deepEqual(ds.augments[0]!.modes, ['KIWI']); // 端到端打通了模式索引
  assert.equal(ds.champions.length, 1);
  assert.equal(ds.items.length, 1);
  // 国服口径图鉴由 provider-tencent 提供，本 provider 必须留空
  assert.deepEqual(ds.hextechs, []);
});

test('provider：includeItems=false 时跳过 items.json 且不请求它', async () => {
  const requested: string[] = [];
  const provider = createCommunityDragonProvider({
    includeItems: false,
    fetchImpl: fakeFetch(
      {
        'cherry-augments.json': [],
        'augment-lists.json': [],
        'champion-summary.json': [],
        'items.json': [{ id: 1, name: '不应被请求' }],
      },
      (u) => requested.push(u),
    ),
  });

  const ds = await provider.load();
  assert.deepEqual(ds.items, []);
  assert.equal(
    requested.some((u) => u.includes('items.json')),
    false,
    'includeItems=false 时不应请求 items.json',
  );
});

test('provider：请求 URL 使用 locale 目录布局（global/<locale>/v1）', async () => {
  const requested: string[] = [];
  const provider = createCommunityDragonProvider({
    locale: 'zh_cn',
    includeItems: false,
    fetchImpl: fakeFetch(
      { 'cherry-augments.json': [], 'augment-lists.json': [], 'champion-summary.json': [] },
      (u) => requested.push(u),
    ),
  });

  await provider.load();
  assert.ok(requested.length > 0);
  for (const u of requested) {
    // 已知陷阱：写成 global/zh_cn/default/v1/... 会 404
    assert.match(u, /\/global\/zh_cn\/v1\//);
    assert.equal(u.includes('/default/'), false);
  }
});

test('provider：上游非 2xx 时抛出且带状态码', async () => {
  const provider = createCommunityDragonProvider({
    fetchImpl: (async () => new Response('nope', { status: 500 })) as typeof fetch,
  });
  await assert.rejects(() => provider.load(), /HTTP 500/);
});
