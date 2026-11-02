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
  runDataSync,
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
  const { store, files } = memoryStore({
    dataset: ds('old', { champions: [champion(1)] }),
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
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0]!.message, /503/);
  assert.equal((files.get('dataset') as Dataset).meta.source, 'cdragon');
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
