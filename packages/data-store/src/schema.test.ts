/**
 * schema 版本迁移 + HTTP 条件缓存文件测试
 *
 * 审查 P2 的两项契约：
 *   1. 旧数据（v1：没有 `hextechs`/没有 `schemaVersion`）**能读**（迁移补默认值）；
 *      未来版本明确拒绝并提示升级；所有写入自动盖上当前版本；
 *   2. `.http-cache.json` 可持久化/重开、损坏文件按空缓存处理、flush 原子落盘。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DATA_SCHEMA_VERSION, type Dataset, type RankingSnapshot } from '@hexbox/core';

import {
  openHttpCache,
  readBuilds,
  readDataset,
  readRankings,
  writeBuilds,
  writeDataset,
  writeRankings,
} from './index.ts';

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'hexbox-store-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** 造一份最小 dataset（只关心 meta/hextechs 这些 schema 相关字段）。 */
function dataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    meta: { source: 'test', patch: null, fetchedAt: new Date().toISOString() },
    augments: [],
    champions: [],
    items: [],
    hextechs: [],
    ...overrides,
  };
}

test('readDataset：v1 旧文件（缺 hextechs/schemaVersion）迁移为 v2 + 空图鉴', async () => {
  await withTempDir(async (dir) => {
    const legacy = { meta: { source: 'x', patch: null, fetchedAt: '2026-01-01T00:00:00.000Z' }, augments: [], champions: [], items: [] };
    writeFileSync(join(dir, 'dataset.json'), JSON.stringify(legacy));
    const ds = await readDataset(dir);
    assert.ok(ds !== null);
    assert.deepEqual(ds.hextechs, [], '缺 hextechs → 补空数组（CDragon 口径仍可用）');
    assert.equal(ds.meta.schemaVersion, DATA_SCHEMA_VERSION);
  });
});

test('readDataset：未来版本明确拒绝（不许静默降级解析）', async () => {
  await withTempDir(async (dir) => {
    writeFileSync(
      join(dir, 'dataset.json'),
      JSON.stringify({ ...dataset(), meta: { ...dataset().meta, schemaVersion: DATA_SCHEMA_VERSION + 1 } }),
    );
    await assert.rejects(() => readDataset(dir), /更新版本的 hexbox/);
  });
});

test('writeDataset / writeRankings / writeBuilds：写盘自动盖上当前 schema 版本', async () => {
  await withTempDir(async (dir) => {
    await writeDataset(dir, dataset());
    const rawDataset = JSON.parse(readFileSync(join(dir, 'dataset.json'), 'utf8')) as Dataset;
    assert.equal(rawDataset.meta.schemaVersion, DATA_SCHEMA_VERSION);

    const rankings: RankingSnapshot = {
      meta: { source: 'tencent', dataDate: '20261101', fetchedAt: new Date().toISOString() },
      augments: [],
      heroes: [],
    };
    await writeRankings(dir, rankings);
    assert.equal(
      (JSON.parse(readFileSync(join(dir, 'rankings.json'), 'utf8')) as RankingSnapshot).meta
        .schemaVersion,
      DATA_SCHEMA_VERSION,
    );

    await writeBuilds(dir, {
      meta: { source: 'tencent', dataDate: '20261101', fetchedAt: new Date().toISOString(), count: 0 },
      details: [],
    });
    assert.equal(
      (JSON.parse(readFileSync(join(dir, 'builds.json'), 'utf8')) as { meta: { schemaVersion: number } })
        .meta.schemaVersion,
      DATA_SCHEMA_VERSION,
    );
  });
});

test('readRankings / readBuilds：旧文件（无版本）按 v2 读回并补齐版本', async () => {
  await withTempDir(async (dir) => {
    writeFileSync(
      join(dir, 'rankings.json'),
      JSON.stringify({ meta: { source: 't', dataDate: '20261101', fetchedAt: '2026-11-01T00:00:00.000Z' }, augments: [], heroes: [] }),
    );
    writeFileSync(
      join(dir, 'builds.json'),
      JSON.stringify({ meta: { source: 't', dataDate: '20261101', fetchedAt: '2026-11-01T00:00:00.000Z', count: 0 }, details: [] }),
    );
    assert.equal((await readRankings(dir))?.meta.schemaVersion, DATA_SCHEMA_VERSION);
    assert.equal((await readBuilds(dir))?.meta.schemaVersion, DATA_SCHEMA_VERSION);
  });
});

test('openHttpCache：写入 → flush → 重开仍能读到 ETag 与正文', async () => {
  await withTempDir(async (dir) => {
    const cache = await openHttpCache(dir);
    cache.set('https://x.test/a.json', { body: '{"a":1}', etag: '"v1"' });
    await cache.flush();
    const reopened = await openHttpCache(dir);
    assert.deepEqual(reopened.get('https://x.test/a.json'), { body: '{"a":1}', etag: '"v1"' });
    assert.equal(reopened.path, join(dir, '.http-cache.json'));
  });
});

test('openHttpCache：损坏文件按空缓存处理（不能阻断同步）', async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, '.http-cache.json'), '{ not json');
    const cache = await openHttpCache(dir);
    assert.equal(cache.get('https://x.test/a.json'), undefined);
  });
});
