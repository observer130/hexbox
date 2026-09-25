#!/usr/bin/env node
/**
 * 数据同步 CLI
 *
 * 用法：
 *   node --experimental-strip-types packages/data-cli/src/cli.ts sync
 *   node --experimental-strip-types packages/data-cli/src/cli.ts status
 *
 * 行为：
 *   - sync  : 从所有启用的 provider 拉取，合并后落盘（原子写）
 *   - status: 显示当前缓存的新鲜度与统计
 *
 * 失败策略：单个 provider 失败**不**导致整体失败 ——
 * 静态数据优先，统计类数据缺失不应影响图鉴可用性。
 */

import { resolve } from 'node:path';

import { readDataset, writeDataset, checkFreshness } from '@hexbox/data-store';
import { createStaticProviders } from '@hexbox/provider-registry';
import type { Dataset } from '@hexbox/core';

const DEFAULT_STORE = resolve(process.cwd(), 'data');

function formatBytes(n: number): string {
  return n > 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${(n / 1024).toFixed(0)} KB`;
}

async function cmdSync(storeRoot: string): Promise<number> {
  const providers = createStaticProviders();
  console.log(`▶ 同步开始，启用 ${providers.length} 个数据源\n`);

  const datasets: Dataset[] = [];
  let failures = 0;

  for (const p of providers) {
    const label = `${p.info.displayName} (${p.info.id})`;
    process.stdout.write(`  · ${label} … `);
    const t0 = Date.now();
    try {
      const ds = await p.load();
      datasets.push(ds);
      console.log(
        `✓ ${Date.now() - t0}ms  ` +
          `[海克斯 ${ds.augments.length} / 英雄 ${ds.champions.length} / 装备 ${ds.items.length}]`,
      );
    } catch (err) {
      failures++;
      console.log(`✗ 失败`);
      console.error(`      ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (datasets.length === 0) {
    console.error('\n✗ 所有数据源均失败，未写入任何数据。');
    const cached = await readDataset(storeRoot);
    if (cached) {
      console.error(`  现有缓存仍可用（抓取于 ${cached.meta.fetchedAt}）。`);
    }
    return 1;
  }

  // v1 只有一个静态源；将来多源时在此做合并策略
  const merged = datasets[0]!;
  const path = await writeDataset(storeRoot, merged);
  const { size } = await import('node:fs/promises').then((m) => m.stat(path));

  console.log(`\n✓ 已写入 ${path}  (${formatBytes(size)})`);
  if (failures > 0) console.log(`⚠ ${failures} 个数据源失败，数据可能不完整`);
  return 0;
}

async function cmdStatus(storeRoot: string): Promise<number> {
  const ds = await readDataset(storeRoot);
  const f = checkFreshness(ds);

  if (!f.exists || !ds) {
    console.log('○ 尚无本地数据。请先运行: pnpm sync');
    return 0;
  }

  const byMode = new Map<string, number>();
  for (const a of ds.augments) {
    for (const m of a.modes) byMode.set(m, (byMode.get(m) ?? 0) + 1);
  }

  console.log('数据集状态');
  console.log(`  来源      : ${ds.meta.source}`);
  console.log(`  抓取时间  : ${f.fetchedAt}  (${f.ageHours?.toFixed(1)}h 前)`);
  console.log(`  新鲜度    : ${f.stale ? '⚠ 已过期（建议重新同步）' : '✓ 新鲜'}`);
  console.log(`  海克斯    : ${ds.augments.length}`);
  for (const [m, n] of byMode) console.log(`      ${m.padEnd(10)}: ${n}`);
  console.log(`  英雄      : ${ds.champions.length}`);
  console.log(`  装备      : ${ds.items.length}`);
  return 0;
}

async function main(): Promise<void> {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  const storeIdx = rest.indexOf('--store');
  const storeRoot = storeIdx >= 0 && rest[storeIdx + 1] ? resolve(rest[storeIdx + 1]!) : DEFAULT_STORE;

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
