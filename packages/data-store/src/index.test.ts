/**
 * data-store 测试
 *
 * 这里刻意**用真实临时目录**而不是 mock fs：
 * 本包的核心承诺就是"原子写"（先写 .tmp 再 rename）与"离线可读"，
 * 这类性质只有打到真实文件系统上验证才有意义。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Dataset, RankingSnapshot } from '@hexbox/core';

import {
  checkFreshness,
  checkRankingsFreshness,
  readDataset,
  readRankings,
  readTemplates,
  resolveStorePaths,
  writeDataset,
  writeRankings,
  writeTemplates,
} from './index.ts';

/** 建一个用完即删的临时数据目录。 */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'hexbox-store-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeDataset(fetchedAt: string, hextechCount = 0): Dataset {
  return {
    meta: { source: 'test', patch: null, fetchedAt },
    augments: [],
    champions: [],
    items: [],
    hextechs: Array.from({ length: hextechCount }, (_, i) => ({
      id: 1001 + i,
      augmentNameId: `ARAM_T${i}`,
      name: `测试${i}`,
      tooltip: '',
      rarity: 'kSilver' as const,
      modes: ['KIWI' as const],
      largeIcon: '',
      smallIcon: '',
      isNew: false,
    })),
  };
}

function makeRankings(fetchedAt: string, dataDate: string): RankingSnapshot {
  return {
    meta: { source: 'test', dataDate, fetchedAt },
    augments: [],
    heroes: [],
  };
}

/* ------------------------------------------------------------------ */
/* 路径解析                                                            */
/* ------------------------------------------------------------------ */

test('resolveStorePaths：两个文件独立落盘', () => {
  const p = resolveStorePaths('C:\\data');
  assert.equal(p.root, 'C:\\data');
  assert.ok(p.dataset.endsWith('dataset.json'));
  assert.ok(p.rankings.endsWith('rankings.json'));
  // 图鉴与排行榜必须分开，才能独立失效
  assert.notEqual(p.dataset, p.rankings);
});

test('resolveStorePaths：模板包独立于其余数据文件', () => {
  const p = resolveStorePaths('C:\\data');
  assert.ok(p.templates.endsWith('templates.json'));
  const all = [p.dataset, p.rankings, p.builds, p.templates];
  assert.equal(new Set(all).size, all.length, '四个数据文件路径必须互不相同');
});

/* ------------------------------------------------------------------ */
/* 模板包：独立落盘（构建期产物）                                       */
/* ------------------------------------------------------------------ */

test('writeTemplates/readTemplates：往返一致且原子收尾', async () => {
  await withTempDir(async (dir) => {
    const payload = 'H4sIAAAAAAAA//Kt0lFRAAAA//8DALp+9ocKAAA=';
    const path = await writeTemplates(dir, payload);
    assert.equal(existsSync(path), true);
    assert.equal(await readTemplates(dir), payload);

    const entries = await readdir(dir);
    assert.equal(entries.some((e) => e.endsWith('.tmp')), false);
  });
});

test('readTemplates：文件不存在时返回 null', async () => {
  await withTempDir(async (dir) => {
    assert.equal(await readTemplates(dir), null);
  });
});

/* ------------------------------------------------------------------ */
/* 写入 / 读取往返                                                     */
/* ------------------------------------------------------------------ */

test('writeDataset/readDataset：往返一致，且目录不存在时自动创建', async () => {
  await withTempDir(async (dir) => {
    const nested = join(dir, 'a', 'b'); // 目录尚不存在
    const ds = makeDataset('2026-09-26T00:00:00.000Z', 2);

    const path = await writeDataset(nested, ds);
    assert.equal(existsSync(path), true);

    const back = await readDataset(nested);
    assert.deepEqual(back, ds);
  });
});

test('writeDataset：不残留 .tmp 文件（原子写收尾干净）', async () => {
  await withTempDir(async (dir) => {
    await writeDataset(dir, makeDataset('2026-09-26T00:00:00.000Z'));

    const entries = await readdir(dir);
    assert.deepEqual(entries, ['dataset.json']);
    assert.equal(
      entries.some((e) => e.endsWith('.tmp')),
      false,
    );
  });
});

test('writeDataset：覆盖写后读到的是新数据（不是新旧拼接）', async () => {
  await withTempDir(async (dir) => {
    await writeDataset(dir, makeDataset('2026-09-26T00:00:00.000Z', 1));
    const second = makeDataset('2026-09-27T00:00:00.000Z', 3);
    await writeDataset(dir, second);

    const back = await readDataset(dir);
    assert.equal(back?.meta.fetchedAt, '2026-09-27T00:00:00.000Z');
    assert.equal(back?.hextechs.length, 3);
  });
});

test('readDataset：文件不存在时返回 null 而非抛错', async () => {
  await withTempDir(async (dir) => {
    assert.equal(await readDataset(dir), null);
  });
});

test('readDataset：内容损坏时抛出带路径的可诊断错误', async () => {
  await withTempDir(async (dir) => {
    const { dataset } = resolveStorePaths(dir);
    await writeFile(dataset, '{ 这不是合法 JSON', 'utf8');

    await assert.rejects(
      () => readDataset(dir),
      (err: Error) => {
        assert.match(err.message, /缓存数据集损坏/);
        assert.match(err.message, /dataset\.json/); // 必须指出是哪个文件
        return true;
      },
    );
  });
});

/* ------------------------------------------------------------------ */
/* 排行榜：独立于图鉴                                                  */
/* ------------------------------------------------------------------ */

test('排行榜与图鉴互不影响：损坏排行榜不影响读取图鉴', async () => {
  await withTempDir(async (dir) => {
    await writeDataset(dir, makeDataset('2026-09-26T00:00:00.000Z', 1));
    const { rankings } = resolveStorePaths(dir);
    await writeFile(rankings, 'BROKEN', 'utf8');

    // 图鉴照常可读（这正是"独立落盘、独立失效"的意义）
    assert.equal((await readDataset(dir))?.hextechs.length, 1);
    // 排行榜则应报错
    await assert.rejects(() => readRankings(dir), /缓存排行榜损坏/);
  });
});

test('writeRankings/readRankings：往返一致且保留统计日期', async () => {
  await withTempDir(async (dir) => {
    const snap = makeRankings('2026-09-26T00:00:00.000Z', '20260925');
    await writeRankings(dir, snap);

    const back = await readRankings(dir);
    assert.deepEqual(back, snap);
    assert.equal(back?.meta.dataDate, '20260925');
  });
});

test('readRankings：文件不存在时返回 null', async () => {
  await withTempDir(async (dir) => {
    assert.equal(await readRankings(dir), null);
  });
});

/* ------------------------------------------------------------------ */
/* 新鲜度                                                              */
/* ------------------------------------------------------------------ */

test('checkFreshness：null 视为不存在且已过期', () => {
  const f = checkFreshness(null);
  assert.equal(f.exists, false);
  assert.equal(f.stale, true);
});

test('checkFreshness：按 24 小时阈值判定新鲜/过期', async () => {
  await withTempDir(async (dir) => {
    // 刚抓取 → 新鲜
    await writeDataset(dir, makeDataset(new Date().toISOString()));
    const fresh = checkFreshness(await readDataset(dir));
    assert.equal(fresh.exists, true);
    assert.equal(fresh.stale, false);
    assert.ok((fresh.ageHours ?? 0) < 1);
    assert.ok(typeof fresh.fetchedAt === 'string');

    // 2 天前 → 过期
    const old = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const stale = checkFreshness(makeDataset(old));
    assert.equal(stale.stale, true);
    assert.ok((stale.ageHours ?? 0) > 24);
  });
});

test('checkRankingsFreshness：阈值 12 小时，比图鉴更严格', () => {
  // 统计榜每日更新，8 小时前应仍新鲜（阈值 12）
  const eightHoursAgo = new Date(Date.now() - 8 * 3_600_000).toISOString();
  const f = checkRankingsFreshness(makeRankings(eightHoursAgo, '20260925'));
  assert.equal(f.stale, false);

  // 但同样 8 小时对图鉴（阈值 24）也是新鲜 —— 说明两者用的是不同阈值
  assert.equal(checkFreshness(makeDataset(eightHoursAgo)).stale, false);

  // 13 小时前：排行榜已过期
  const thirteenHoursAgo = new Date(Date.now() - 13 * 3_600_000).toISOString();
  assert.equal(checkRankingsFreshness(makeRankings(thirteenHoursAgo, '20260925')).stale, true);
});

test('checkFreshness：支持自定义阈值', () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
  assert.equal(checkFreshness(makeDataset(twoHoursAgo), 1).stale, true);
  assert.equal(checkFreshness(makeDataset(twoHoursAgo), 3).stale, false);
});

test('写入的是可读文本 JSON（便于人直接排查）', async () => {
  await withTempDir(async (dir) => {
    const path = await writeDataset(dir, makeDataset('2026-09-26T00:00:00.000Z'));
    const raw = await readFile(path, 'utf8');
    assert.ok(raw.includes('\n'), '应为格式化输出而非单行');
    assert.match(raw, /"source": "test"/);
  });
});
