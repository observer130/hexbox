#!/usr/bin/env node
/**
 * 数据同步 CLI
 *
 * 用法：
 *   node --experimental-strip-types packages/data-cli/src/cli.ts sync
 *   node --experimental-strip-types packages/data-cli/src/cli.ts status
 *
 * 行为：
 *   - sync  : 静态图鉴源 → 合并落盘 dataset.json
 *             排行榜源 → 独立落盘 rankings.json
 *   - status: 显示当前缓存的新鲜度与统计
 *
 * 失败策略：单个 provider 失败**不**导致整体失败 ——
 * 图鉴与排行榜互相独立，统计数据缺失不应影响图鉴可用性。
 */

import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';

import {
  checkFreshness,
  checkRankingsFreshness,
  readDataset,
  readRankings,
  writeDataset,
  writeRankings,
} from '@hexbox/data-store';
import { createRankingProviders, createStaticProviders } from '@hexbox/provider-registry';
import type { Dataset, RankingSnapshot } from '@hexbox/core';

const DEFAULT_STORE = resolve(process.cwd(), 'data');

function formatBytes(n: number): string {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
}

/** 多源合并：后者只补前者没有的部分（当前 = CDragon 全量 + 腾讯补国服图鉴）。 */
export function mergeDatasets(datasets: readonly Dataset[]): Dataset {
  if (datasets.length === 0) throw new Error('没有可合并的数据集');
  const [primary, ...rest] = datasets;
  const merged: Dataset = { ...primary! };
  for (const extra of rest) {
    if (merged.hextechs.length === 0 && extra.hextechs.length > 0) {
      (merged as { hextechs: Dataset['hextechs'] }).hextechs = extra.hextechs;
    }
  }
  return merged;
}

async function cmdSync(storeRoot: string): Promise<number> {
  const staticProviders = createStaticProviders();
  const rankingProviders = createRankingProviders();
  console.log(
    `▶ 同步开始：静态源 ${staticProviders.length} 个，排行榜源 ${rankingProviders.length} 个\n`,
  );

  let failures = 0;

  // ---- 静态图鉴 ----
  const datasets: Dataset[] = [];
  for (const p of staticProviders) {
    const label = `${p.info.displayName} (${p.info.id})`;
    process.stdout.write(`  · ${label} … `);
    const t0 = Date.now();
    try {
      const ds = await p.load();
      datasets.push(ds);
      console.log(
        `✓ ${Date.now() - t0}ms  ` +
          `[海克斯(cd) ${ds.augments.length} / 海克斯(cn) ${ds.hextechs.length} / ` +
          `英雄 ${ds.champions.length} / 装备 ${ds.items.length}]`,
      );
    } catch (err) {
      failures++;
      console.log(`✗ 失败`);
      console.error(`      ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (datasets.length === 0) {
    console.error('\n✗ 所有静态数据源均失败，未写入 dataset.json。');
    const cached = await readDataset(storeRoot);
    if (cached) {
      console.error(`  现有缓存仍可用（抓取于 ${cached.meta.fetchedAt}）。`);
    }
  } else {
    const merged = mergeDatasets(datasets);
    const path = await writeDataset(storeRoot, merged);
    const { size } = await stat(path);
    console.log(`\n✓ 已写入 ${path}  (${formatBytes(size)})`);
  }

  // ---- 排行榜 ----
  let snapshot: RankingSnapshot | null = null;
  for (const p of rankingProviders) {
    const label = `${p.info.displayName} (${p.info.id})`;
    process.stdout.write(`\n  · ${label} … `);
    const t0 = Date.now();
    try {
      snapshot = await p.load();
      if (snapshot.augments.length === 0 && snapshot.heroes.length === 0) {
        console.log(`△ 无数据（上游统计未更新或维护中）`);
      } else {
        console.log(
          `✓ ${Date.now() - t0}ms  ` +
            `[海克斯榜 ${snapshot.augments.length} / 英雄榜 ${snapshot.heroes.length}] ` +
            `统计日期 ${snapshot.meta.dataDate || '未知'}`,
        );
      }
    } catch (err) {
      failures++;
      snapshot = null;
      console.log(`✗ 失败`);
      console.error(`      ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (snapshot && (snapshot.augments.length > 0 || snapshot.heroes.length > 0)) {
    const path = await writeRankings(storeRoot, snapshot);
    const { size } = await stat(path);
    console.log(`✓ 已写入 ${path}  (${formatBytes(size)})`);
  }

  if (failures > 0) console.log(`\n⚠ ${failures} 个数据源失败，数据可能不完整`);
  return 0;
}

async function cmdStatus(storeRoot: string): Promise<number> {
  const ds = await readDataset(storeRoot);
  const f = checkFreshness(ds);

  console.log('静态图鉴');
  if (!f.exists || !ds) {
    console.log('  ○ 尚无本地数据。请先运行: pnpm sync');
  } else {
    const byMode = new Map<string, number>();
    for (const a of ds.augments) {
      for (const m of a.modes) byMode.set(m, (byMode.get(m) ?? 0) + 1);
    }
    // 旧缓存可能没有 hextechs 字段（v2 前落盘），兼容读取
    const cnCount = (ds as { hextechs?: Dataset['hextechs'] }).hextechs?.length ?? 0;
    console.log(`  来源      : ${ds.meta.source}${cnCount > 0 ? ' + tencent-static' : ''}`);
    console.log(`  抓取时间  : ${f.fetchedAt}  (${f.ageHours?.toFixed(1)}h 前)`);
    console.log(`  新鲜度    : ${f.stale ? '⚠ 已过期（建议重新同步）' : '✓ 新鲜'}`);
    console.log(`  海克斯    : ${ds.augments.length} (cd) + ${cnCount} (cn)`);
    for (const [m, n] of byMode) console.log(`      ${m.padEnd(10)}: ${n}`);
    console.log(`  英雄      : ${ds.champions.length}`);
    console.log(`  装备      : ${ds.items.length}`);
  }

  const rk = await readRankings(storeRoot);
  const rf = checkRankingsFreshness(rk);
  console.log('\n排行榜（腾讯 101 数据站）');
  if (!rf.exists || !rk) {
    console.log('  ○ 尚无本地数据。请先运行: pnpm sync');
  } else {
    console.log(`  抓取时间  : ${rf.fetchedAt}  (${rf.ageHours?.toFixed(1)}h 前)`);
    console.log(`  统计日期  : ${rk.meta.dataDate || '未知'}`);
    console.log(`  新鲜度    : ${rf.stale ? '⚠ 已过期（建议重新同步）' : '✓ 新鲜'}`);
    console.log(`  海克斯榜  : ${rk.augments.length}`);
    console.log(`  英雄榜    : ${rk.heroes.length}`);
  }
  return 0;
}

async function main(): Promise<void> {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  const storeIdx = rest.indexOf('--store');
  const storeRoot =
    storeIdx >= 0 && rest[storeIdx + 1] ? resolve(rest[storeIdx + 1]!) : DEFAULT_STORE;

  switch (cmd) {
    case 'sync':
      process.exitCode = await cmdSync(storeRoot);
      break;
    case 'status':
      process.exitCode = await cmdStatus(storeRoot);
      break;
    default:
      console.log(
        [
          'hexbox 数据同步 CLI',
          '',
          '用法:',
          '  sync     拉取所有启用的数据源并落盘',
          '  status   查看本地数据集状态',
          '',
          '选项:',
          '  --store <dir>   数据目录（默认 ./data）',
        ].join('\n'),
      );
  }
}

main().catch((err: unknown) => {
  console.error('未捕获错误:', err);
  process.exitCode = 1;
});
