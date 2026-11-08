/**
 * 同步引擎测试（不联网、不碰磁盘）
 *
 * 覆盖的是"更新数据"最容易出事的几条语义：
 *   · 部分源失败 → 仍写成功的部分；
 *   · 全部失败/空数据 → **保留旧文件**（绝不用空数组覆盖）；
 *   · 详情/榜单失败不阻断已经写好的图鉴；
 *   · 头像模板只在英雄集合变化时重建，且旧包里的名字指纹要被带过去；
 *   · 取消（AbortSignal）不写任何新文件。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  ChampionDetail,
  ChampionDetailSet,
  Dataset,
  HextechStatic,
  RankingProvider,
  RankingSnapshot,
  StaticProvider,
} from '@hexbox/core';
import { decodePack, encodePack, type TemplatePack } from '@hexbox/vision';

import {
  championIdKey,
  datasetHasContent,
  decideTemplatesRebuild,
  detailSkipReason,
  detailsRequiredCount,
  mayOverwriteDetails,
  mergeRankingSnapshot,
  mergeStaticDatasets,
  runDataSync,
  syncExitCode,
  templatesRequiredCount,
  type SyncProgress,
  type SyncStore,
} from './sync.ts';

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

function hex(id: number, name: string): HextechStatic {
  return {
    id,
    augmentNameId: `ARAM_${name}`,
    name,
    tooltip: '',
    rarity: 'kSilver',
    modes: ['KIWI'],
    largeIcon: '',
    smallIcon: '',
    isNew: false,
  };
}

function ds(source: string, opts: Partial<Dataset> = {}): Dataset {
  return {
    meta: { source, patch: null, fetchedAt: '2026-10-05T00:00:00.000Z' },
    augments: [],
    champions: [],
    items: [],
    hextechs: [],
    ...opts,
  };
}

function champion(id: number): Dataset['champions'][number] {
  return { id, name: `英雄${id}`, alias: `C${id}`, roles: [], iconPath: '' };
}

function snapshot(dataDate: string, opts: Partial<RankingSnapshot> = {}): RankingSnapshot {
  return {
    meta: { source: 'tencent-rankings', dataDate, fetchedAt: '2026-10-05T00:00:00.000Z' },
    augments: [],
    heroes: [],
    ...opts,
  };
}

function detail(id: number, dataDate = '20261005'): ChampionDetail {
  return {
    championId: id,
    augments: [],
    build: { start: [], startCombo: [], shoes: [], core: [] },
    skills: [],
    partners: [],
    dataDate,
  };
}

function staticProvider(
  displayName: string,
  load: StaticProvider['load'],
): StaticProvider {
  return {
    info: {
      id: displayName,
      displayName,
      dataClass: 'official-static',
      attribution: '测试',
    },
    load,
  };
}

function rankingProvider(
  displayName: string,
  load: RankingProvider['load'],
): RankingProvider {
  return {
    info: {
      id: displayName,
      displayName,
      dataClass: 'official-aggregated',
      attribution: '测试',
    },
    load,
  };
}

/** 内存存储：记录写了哪些文件，不发散到磁盘。 */
function memoryStore(seed: Partial<Record<'dataset' | 'rankings' | 'builds' | 'templates', unknown>> = {}): {
  readonly store: SyncStore;
  readonly writes: string[];
  readonly files: Map<string, unknown>;
} {
  const files = new Map<string, unknown>();
  for (const [key, value] of Object.entries(seed)) {
    if (value !== undefined) files.set(key, value);
  }
  const writes: string[] = [];
  const store: SyncStore = {
    readDataset: async () => (files.get('dataset') as Dataset | undefined) ?? null,
    readRankings: async () => (files.get('rankings') as RankingSnapshot | undefined) ?? null,
    readBuilds: async () => (files.get('builds') as ChampionDetailSet | undefined) ?? null,
    readTemplates: async () => (files.get('templates') as string | undefined) ?? null,
    writeDataset: async (_root, value) => {
      writes.push('dataset');
      files.set('dataset', value);
      return 'dataset.json';
    },
    writeRankings: async (_root, value) => {
      writes.push('rankings');
      files.set('rankings', value);
      return 'rankings.json';
    },
    writeBuilds: async (_root, value) => {
      writes.push('builds');
      files.set('builds', value);
      return 'builds.json';
    },
    writeTemplates: async (_root, value) => {
      writes.push('templates');
      files.set('templates', value);
      return 'templates.json';
    },
  };
  return { store, writes, files };
}

const NOW = new Date('2026-10-06T12:00:00.000Z');

function packOf(ids: readonly number[], withNames = false): TemplatePack {
  return {
    version: 1,
    size: 2,
    createdAt: '2026-10-05T00:00:00.000Z',
    sourceUrl: 'test',
    count: ids.length,
    templates: ids.map((championId) => ({
      championId,
      name: `英雄${championId}`,
      alias: `C${championId}`,
      size: 2,
      norm: [0, 1, 1, 0],
    })),
    ...(withNames
      ? {
          names: ids.map((championId) => ({
            championId,
            name: `英雄${championId}`,
            width: 1,
            height: 1,
            bits: '1',
          })),
        }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 纯函数                                                              */
/* ------------------------------------------------------------------ */

test('datasetHasContent：空数据集一律不算"有内容"', () => {
  assert.equal(datasetHasContent(null), false);
  assert.equal(datasetHasContent(ds('x')), false);
  assert.equal(datasetHasContent(ds('x', { augments: [{} as never] })), true);
  assert.equal(datasetHasContent(ds('x', { champions: [champion(1)] })), true);
});

test('championIdKey：与顺序无关、去重', () => {
  assert.equal(championIdKey([3, 1, 2, 1]), '1,2,3');
  assert.equal(championIdKey([]), '');
});

test('decideTemplatesRebuild：缺包/强制/英雄集合变化才重建', () => {
  assert.equal(
    decideTemplatesRebuild({ hasExistingPack: false, previousChampionIds: [], nextChampionIds: [1] })
      .rebuild,
    true,
  );
  assert.equal(
    decideTemplatesRebuild({
      hasExistingPack: true,
      previousChampionIds: [1, 2],
      nextChampionIds: [2, 1],
    }).rebuild,
    false,
    '集合相同（顺序不同）不应重建',
  );
  assert.equal(
    decideTemplatesRebuild({
      hasExistingPack: true,
      previousChampionIds: [1, 2],
      nextChampionIds: [1, 2, 3],
    }).rebuild,
    true,
  );
  assert.equal(
    decideTemplatesRebuild({
      hasExistingPack: true,
      previousChampionIds: [1],
      nextChampionIds: [1],
      force: true,
    }).rebuild,
    true,
  );
  assert.equal(
    decideTemplatesRebuild({ hasExistingPack: true, previousChampionIds: [1], nextChampionIds: [] })
      .rebuild,
    false,
    '没有英雄列表时不重建（会白拉 0 个）',
  );
});

/* ------------------------------------------------------------------ */
/* runDataSync                                                        */
/* ------------------------------------------------------------------ */

test('runDataSync：三个文件都写、报告统计日期与计数', async () => {
  const { store, writes } = memoryStore();
  const progress: SyncProgress[] = [];
  const report = await runDataSync({
    storeRoot: 'memory',
    store,
    staticProviders: [
      staticProvider('cdragon', async () =>
        ds('cdragon', {
          champions: [champion(1), champion(2)],
          augments: [{} as never],
          items: [{} as never],
        }),
      ),
    ],
    rankingProviders: [
      rankingProvider('tencent', async () => snapshot('20261005', { heroes: [{} as never] })),
    ],
    fetchDetails: async (ids) => ids.map((id) => detail(id)),
    buildTemplates: async () => packOf([1, 2]),
    encodeTemplates: (pack) => encodePack(pack),
    now: () => NOW,
    onProgress: (p) => progress.push(p),
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.wrote, ['dataset', 'rankings', 'builds', 'templates']);
  assert.deepEqual(writes, ['dataset', 'rankings', 'builds', 'templates']);
  assert.equal(report.dataDate, '20261005');
  assert.equal(report.counts.champions, 2);
  assert.equal(report.counts.rankingHeroes, 1);
  assert.equal(report.counts.details, 2);
  assert.equal(report.counts.templates, 2);
  assert.equal(report.failures.length, 0);
  assert.ok(progress.some((p) => p.stage === 'details' && p.done === 2));
});

test('runDataSync：部分静态源失败 → 仍写合并后的图鉴，并记失败', async () => {
  // 旧文件里**已经有**国服图鉴（hextechs）。腾讯源这次挂了 → 合并结果里
  // hextechs 是空数组，旧实现会直接写回，把 248 条国服图鉴静默清零。
  const { store, files } = memoryStore({
    dataset: ds('old', {
      champions: [champion(1)],
      hextechs: [hex(1001, '旧国服海克斯')],
    }),
    templates: encodePack(packOf([1], true)),
  });
  const report = await runDataSync({
    storeRoot: 'memory',
    store,
    staticProviders: [
      staticProvider('cdragon', async () => ds('cdragon', { champions: [champion(1)] })),
      staticProvider('tencent', async () => {
        throw new Error('上游 503');
      }),
    ],
    rankingProviders: [],
    fetchDetails: async () => [],
    buildTemplates: async () => packOf([1]),
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.wrote, ['dataset']);
  assert.match(report.failures[0]!.message, /503/);
  const written = files.get('dataset') as Dataset;
  assert.equal(written.meta.source, 'cdragon');
  assert.equal(
    written.hextechs.length,
    1,
    '失败源的 hextechs 必须沿用旧文件，不能被空数组覆盖',
  );
  assert.equal(written.hextechs[0]!.id, 1001);
  assert.ok(
    report.failures.some((f) => f.label === '静态图鉴合并' && /hextechs/.test(f.message)),
    '回退这件事必须出现在报告里（否则用户以为数据是全新的）',
  );
});

test('runDataSync：CDragon 失败 → 英雄/装备/海克斯沿用旧文件，不被腾讯单源清空', async () => {
  const { store, files } = memoryStore({
    dataset: ds('old', {
      champions: [champion(1), champion(2)],
      augments: [{} as never],
      items: [{} as never],
      hextechs: [hex(1001, '旧国服海克斯')],
    }),
    templates: encodePack(packOf([1, 2], true)),
  });
  const report = await runDataSync({
    storeRoot: 'memory',
    store,
    staticProviders: [
      staticProvider('cdragon', async () => {
        throw new Error('CDragon 超时');
      }),
      // 腾讯一方只提供 hextechs（真实口径）
      staticProvider('tencent', async () => ds('tencent', { hextechs: [hex(1002, '新国服海克斯')] })),
    ],
    rankingProviders: [],
    fetchDetails: async (ids) => ids.map((id) => detail(id)),
    buildTemplates: async () => packOf([1, 2]),
    encodeTemplates: (pack) => encodePack(pack),
  });

  const written = files.get('dataset') as Dataset;
  assert.equal(written.champions.length, 2, '英雄表不许被单源清空');
  assert.equal(written.augments.length, 1, '海克斯(cd) 不许被清空');
  assert.equal(written.items.length, 1, '装备表不许被清空');
  // 成功的那一半照常更新
  assert.equal(written.hextechs.length, 1);
  assert.equal(written.hextechs[0]!.id, 1002, '成功源的新数据要优先于旧值');
  // 详情阶段还能继续（英雄列表没丢）
  assert.equal(report.counts.details, 2);
});

test('runDataSync：静态源全失败 → 不写 dataset（保留旧文件）', async () => {
  const previous = ds('old', { champions: [champion(1)] });
  const { store, writes } = memoryStore({ dataset: previous });
  const report = await runDataSync({
    storeRoot: 'memory',
    store,
    staticProviders: [
      staticProvider('cdragon', async () => {
        throw new Error('断网');
      }),
    ],
    rankingProviders: [rankingProvider('tencent', async () => snapshot('20261005', { heroes: [{} as never] }))],
    fetchDetails: async (ids) => ids.map((id) => detail(id)),
    buildTemplates: async () => packOf([1]),
  });

  assert.equal(report.wrote.includes('dataset'), false, '失败时不许覆盖图鉴');
  assert.equal(writes.includes('dataset'), false);
  assert.ok(report.skipped.some((s) => s.stage === 'static'));
  // 但榜单与详情仍然用旧图鉴的英雄列表写成功
  assert.ok(writes.includes('rankings'));
  assert.ok(writes.includes('builds'));
});

test('runDataSync：排行榜空快照 → 不写（不拿空数据冒充最新）', async () => {
  const previous = snapshot('20261001');
  const { store, writes } = memoryStore({ rankings: previous });
  const report = await runDataSync({
    storeRoot: 'memory',
    store,
    staticProviders: [],
    rankingProviders: [rankingProvider('tencent', async () => snapshot(''))],
    fetchDetails: async () => [],
  });

  assert.equal(writes.includes('rankings'), false);
  assert.ok(report.skipped.some((s) => s.stage === 'rankings'));
  assert.equal(report.dataDate, '20261001', '数据日期应退回旧值');
});

test('runDataSync：英雄详情全失败 → 不写 builds', async () => {
  const { store, writes } = memoryStore();
  const report = await runDataSync({
    storeRoot: 'memory',
    store,
    staticProviders: [
      staticProvider('cdragon', async () => ds('cdragon', { champions: [champion(1)] })),
    ],
    rankingProviders: [],
    fetchDetails: async () => [],
    buildTemplates: async () => packOf([1]),
  });

  assert.equal(writes.includes('builds'), false);
  assert.ok(report.skipped.some((s) => s.stage === 'details'));
});

test('runDataSync：没有英雄列表 → 跳过详情，不盲抓', async () => {
  const { store, writes } = memoryStore();
  const report = await runDataSync({
    storeRoot: 'memory',
    store,
    staticProviders: [],
    rankingProviders: [],
    fetchDetails: async () => {
      throw new Error('不应该被调用');
    },
  });

  assert.equal(writes.length, 0);
  assert.ok(report.skipped.some((s) => s.stage === 'details'));
});

test('runDataSync：英雄集合未变 → 不重建模板', async () => {
  let built = 0;
  const { store, writes } = memoryStore({
    dataset: ds('old', { champions: [champion(1)] }),
    templates: encodePack(packOf([1], true)),
  });
  const report = await runDataSync({
    storeRoot: 'memory',
    store,
    staticProviders: [
      staticProvider('cdragon', async () => ds('cdragon', { champions: [champion(1)] })),
    ],
    rankingProviders: [],
    fetchDetails: async (ids) => ids.map((id) => detail(id)),
    buildTemplates: async () => {
      built++;
      return packOf([1]);
    },
  });

  assert.equal(built, 0);
  assert.equal(writes.includes('templates'), false);
  assert.equal(report.templatesRebuilt, false);
  assert.ok(report.skipped.some((s) => s.stage === 'templates'));
});

test('runDataSync：英雄集合变化 → 重建模板，并把旧包的名字指纹带过去', async () => {
  const previousPack = packOf([1], true);
  const { store, files } = memoryStore({
    dataset: ds('old', { champions: [champion(1)] }),
    templates: encodePack(previousPack),
  });
  const report = await runDataSync({
    storeRoot: 'memory',
    store,
    staticProviders: [
      staticProvider('cdragon', async () => ds('cdragon', { champions: [champion(1), champion(2)] })),
    ],
    rankingProviders: [],
    fetchDetails: async (ids) => ids.map((id) => detail(id)),
    // 应用内更新跑不了名字指纹脚本，所以新包默认**没有** names
    buildTemplates: async (champions) => packOf(champions.map((c) => c.id)),
    encodeTemplates: (pack) => encodePack(pack),
  });

  assert.equal(report.templatesRebuilt, true);
  const written = decodePack(files.get('templates') as string);
  assert.equal(written.count, 2);
  assert.equal(written.names?.length, 1, '旧包的名字指纹不许丢');
});

test('runDataSync：取消 → 一个文件都不写，报告 aborted', async () => {
  const { store, writes } = memoryStore();
  const report = await runDataSync({
    storeRoot: 'memory',
    store,
    staticProviders: [
      staticProvider('cdragon', async () => ds('cdragon', { champions: [champion(1)] })),
    ],
    rankingProviders: [rankingProvider('tencent', async () => snapshot('20261005'))],
    fetchDetails: async () => [],
    signal: AbortSignal.abort(),
  });

  assert.equal(report.ok, false);
  assert.equal(report.aborted, true);
  assert.deepEqual(writes, []);
});

test('runDataSync：写盘抛错会冒泡（调用方必须知道"没写进去"）', async () => {
  const store: SyncStore = {
    readDataset: async () => null,
    readRankings: async () => null,
    readBuilds: async () => null,
    readTemplates: async () => null,
    writeDataset: async () => {
      throw new Error('磁盘满了');
    },
    writeRankings: async () => 'x',
    writeBuilds: async () => 'x',
    writeTemplates: async () => 'x',
  };
  await assert.rejects(
    () =>
      runDataSync({
        storeRoot: 'memory',
        store,
        staticProviders: [
          staticProvider('cdragon', async () => ds('cdragon', { champions: [champion(1)] })),
        ],
        rankingProviders: [],
        fetchDetails: async () => [],
      }),
    /磁盘满了/,
  );
});

test('runDataSync：详情途中取消 → 不写 builds（不许用局部结果覆盖完整的旧文件）', async () => {
  const { store, writes } = memoryStore();
  const controller = new AbortController();
  const report = await runDataSync({
    storeRoot: 'memory',
    store,
    staticProviders: [
      staticProvider('cdragon', async () =>
        ds('cdragon', { champions: [champion(1), champion(2)] }),
      ),
    ],
    rankingProviders: [],
    signal: controller.signal,
    fetchDetails: async (ids) => {
      // 模拟"拉到一半用户点了取消"：返回部分结果，但信号已中止
      controller.abort();
      return ids.slice(0, 1).map((id) => detail(id));
    },
    buildTemplates: async () => packOf([1, 2]),
  });

  assert.equal(writes.includes('builds'), false, '局部详情不许覆盖旧 builds');
  assert.ok(report.skipped.some((s) => s.stage === 'details'));
  assert.equal(report.aborted, true);
  // 图鉴是原子写，已经成功写入的那份保留
  assert.ok(writes.includes('dataset'));
});

/* ------------------------------------------------------------------ */
/* S1/S3：按集合回退（纯函数）                                          */
/* ------------------------------------------------------------------ */

test('mergeStaticDatasets：无旧文件时不做任何回退', () => {
  const merged = mergeStaticDatasets([ds('cdragon', { champions: [champion(1)] })], null);
  assert.deepEqual(merged.backfilled, []);
  assert.equal(merged.dataset.champions.length, 1);
  assert.equal(merged.dataset.hextechs.length, 0);
});

test('mergeStaticDatasets：空集合按字段回退到旧文件（成功源的新数据优先）', () => {
  const previous = ds('old', {
    champions: [champion(9)],
    augments: [{} as never],
    items: [{} as never],
    hextechs: [hex(1001, '旧')],
  });
  const merged = mergeStaticDatasets(
    [
      ds('cdragon', { champions: [champion(1)] }),
      ds('tencent', { hextechs: [hex(1002, '新')] }),
    ],
    previous,
  );

  assert.deepEqual(merged.backfilled, ['augments', 'items'], '只有真正为空的集合才回退');
  assert.equal(merged.dataset.champions.length, 1);
  assert.equal(merged.dataset.champions[0]!.id, 1, '新数据不许被旧值盖掉');
  assert.equal(merged.dataset.hextechs[0]!.id, 1002, '新数据不许被旧值盖掉');
  assert.equal(merged.dataset.augments.length, 1, '空集合取旧值');
  assert.equal(merged.dataset.items.length, 1, '空集合取旧值');
});

test('mergeStaticDatasets：旧文件也为空 → 不回退（保持"没有就是没有"）', () => {
  const merged = mergeStaticDatasets(
    [ds('cdragon', { champions: [champion(1)] })],
    ds('old'),
  );
  assert.deepEqual(merged.backfilled, []);
  assert.equal(merged.dataset.hextechs.length, 0);
});

test('mergeRankingSnapshot：单边为空时逐列表回退', () => {
  const previous = snapshot('20261001', { heroes: [{} as never] });
  const merged = mergeRankingSnapshot(snapshot('20261005', { augments: [{} as never] }), previous);

  assert.deepEqual(merged.backfilled, ['heroes']);
  assert.equal(merged.snapshot.augments.length, 1, '新榜保留');
  assert.equal(merged.snapshot.heroes.length, 1, '空的那张榜取旧值');
  assert.equal(merged.snapshot.meta.dataDate, '20261005', '统计日期仍用新快照的');
});

test('mergeRankingSnapshot：两张榜都为空且无旧数据 → 不回退', () => {
  const merged = mergeRankingSnapshot(snapshot('20261005'), null);
  assert.deepEqual(merged.backfilled, []);
  assert.equal(merged.snapshot.augments.length, 0);
  assert.equal(merged.snapshot.heroes.length, 0);
});

/* ------------------------------------------------------------------ */
/* S2/S4：覆盖率下限（纯函数）                                          */
/* ------------------------------------------------------------------ */

test('detailsRequiredCount：90% 向上取整，边界不允许漏', () => {
  assert.equal(detailsRequiredCount(173), 156);
  assert.equal(detailsRequiredCount(2), 2);
  assert.equal(detailsRequiredCount(1), 1);
  assert.equal(detailsRequiredCount(0), 0);
  assert.equal(detailsRequiredCount(Number.NaN), 0);
});

test('mayOverwriteDetails：60/173 必须被拒，156/173 允许', () => {
  assert.equal(mayOverwriteDetails(60, 173), false, '大面积失败不许覆盖完整文件');
  assert.equal(mayOverwriteDetails(0, 173), false);
  assert.equal(mayOverwriteDetails(155, 173), false);
  assert.equal(mayOverwriteDetails(156, 173), true, '恰好到下限要允许（容忍个别抖动）');
  assert.equal(mayOverwriteDetails(173, 173), true);
});

test('detailSkipReason：取消 / 全失败 / 覆盖率不足三种文案可区分', () => {
  assert.match(detailSkipReason({ fetched: 3, expected: 10, aborted: true }), /已取消/);
  assert.match(detailSkipReason({ fetched: 0, expected: 10, aborted: false }), /全部失败/);
  const short = detailSkipReason({ fetched: 3, expected: 10, aborted: false });
  assert.match(short, /3\/10/);
  assert.match(short, /低于 9 个的下限/);
});

test('templatesRequiredCount：与详情同一套下限口径', () => {
  assert.equal(templatesRequiredCount(245), 221);
  assert.equal(templatesRequiredCount(2), 2);
  assert.equal(templatesRequiredCount(0), 0);
});

/* ------------------------------------------------------------------ */
/* S5：退出码                                                          */
/* ------------------------------------------------------------------ */

test('syncExitCode：一个文件都没写成 → 非零（CI 要能判出来）', () => {
  assert.equal(syncExitCode({ ok: false }), 1);
  assert.equal(syncExitCode({ ok: true }), 0);
});

/* ------------------------------------------------------------------ */
/* 集成：部分成功不许覆盖（S1–S4）                                      */
/* ------------------------------------------------------------------ */

test('runDataSync：详情只有 3/10 → 不写 builds，并记一条覆盖率失败', async () => {
  const { store, writes } = memoryStore();
  const report = await runDataSync({
    storeRoot: 'memory',
    store,
    staticProviders: [
      staticProvider('cdragon', async () =>
        ds('cdragon', { champions: Array.from({ length: 10 }, (_, i) => champion(i + 1)) }),
      ),
    ],
    rankingProviders: [],
    // 只成功 3 个英雄
    fetchDetails: async () => [1, 2, 3].map((id) => detail(id)),
    buildTemplates: async () => packOf([1]),
  });

  assert.equal(writes.includes('builds'), false, '30% 覆盖率不许覆盖');
  assert.ok(report.skipped.some((s) => s.stage === 'details'));
  assert.ok(
    report.failures.some((f) => f.stage === 'details' && /3\/10/.test(f.message)),
    '覆盖率不足要进报告',
  );
});

test('runDataSync：详情 10/10 → 照常写入（下限不误杀正常情况）', async () => {
  const { store, writes } = memoryStore();
  await runDataSync({
    storeRoot: 'memory',
    store,
    staticProviders: [
      staticProvider('cdragon', async () =>
        ds('cdragon', { champions: Array.from({ length: 10 }, (_, i) => champion(i + 1)) }),
      ),
    ],
    rankingProviders: [],
    fetchDetails: async (ids) => ids.map((id) => detail(id)),
    buildTemplates: async () => packOf([1]),
  });

  assert.ok(writes.includes('builds'));
});

test('runDataSync：英雄榜为空但海克斯榜有数据 → 旧英雄榜被保留，不被删掉', async () => {
  const previous = snapshot('20261001', {
    augments: [{} as never],
    heroes: [{ championId: 63, rank: 1 } as never],
  });
  const { store, files } = memoryStore({ rankings: previous });
  const report = await runDataSync({
    storeRoot: 'memory',
    store,
    staticProviders: [],
    rankingProviders: [
      // 海克斯榜有新数据，英雄榜这次是空的（真实故障形态）
      rankingProvider('tencent', async () => snapshot('20261005', { augments: [{} as never] })),
    ],
    fetchDetails: async () => [],
  });

  const written = files.get('rankings') as RankingSnapshot;
  assert.equal(written.augments.length, 1);
  assert.equal(written.heroes.length, 1, '旧英雄榜不许被"半边成功"删除');
  assert.ok(report.failures.some((f) => f.label === '排行榜合并' && /heroes/.test(f.message)));
});

test('runDataSync：取消后模板构建才返回 → 不写 templates', async () => {
  const previousPack = packOf([1], true);
  const { store, writes } = memoryStore({
    dataset: ds('old', { champions: [champion(1)] }),
    templates: encodePack(previousPack),
  });
  const controller = new AbortController();
  const report = await runDataSync({
    storeRoot: 'memory',
    store,
    staticProviders: [
      staticProvider('cdragon', async () => ds('cdragon', { champions: [champion(1), champion(2)] })),
    ],
    rankingProviders: [],
    signal: controller.signal,
    fetchDetails: async (ids) => ids.map((id) => detail(id)),
    buildTemplates: async () => {
      controller.abort(); // 构建期间用户点了取消
      return packOf([1, 2]);
    },
  });

  assert.equal(writes.includes('templates'), false, '取消后不许写残缺模板包');
  assert.ok(report.skipped.some((s) => s.stage === 'templates' && /已取消/.test(s.reason)));
});

test('runDataSync：模板只拿到 1/10 → 不写，并记覆盖率失败', async () => {
  const { store, writes } = memoryStore({
    dataset: ds('old', { champions: [champion(1)] }),
    templates: encodePack(packOf([1], true)),
  });
  const report = await runDataSync({
    storeRoot: 'memory',
    store,
    // 英雄集合变化 → 触发重建
    staticProviders: [
      staticProvider('cdragon', async () =>
        ds('cdragon', { champions: Array.from({ length: 10 }, (_, i) => champion(i + 1)) }),
      ),
    ],
    rankingProviders: [],
    fetchDetails: async (ids) => ids.map((id) => detail(id)),
    buildTemplates: async () => packOf([1]), // 1/10
  });

  assert.equal(writes.includes('templates'), false, '10% 的包不许覆盖好的包');
  assert.equal(report.templatesRebuilt, false);
  assert.ok(report.failures.some((f) => f.stage === 'templates' && /1\/10/.test(f.message)));
});
