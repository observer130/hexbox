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
 *             单英雄详情 → builds.json；头像模板 → templates.json（按需）
 *   - status: 显示当前缓存的新鲜度与统计
 *
 * 流水线本身在 `sync.ts`：**悬浮窗的「更新数据」跑的是同一份引擎**，
 * 这里只负责把进度打印成人看的文字（别在 CLI 里另写一套拉取顺序）。
 *
 * 失败策略：单个 provider 失败**不**导致整体失败 ——
 * 图鉴与排行榜互相独立，统计数据缺失不应影响图鉴可用性。
 */

import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  checkFreshness,
  checkRankingsFreshness,
  readBuilds,
  readDataset,
  readRankings,
  writeTemplates,
} from '@hexbox/data-store';
import { createRankingProviders, createStaticProviders } from '@hexbox/provider-registry';
import { encodePack, type TemplatePack } from '@hexbox/vision';
import type { Dataset } from '@hexbox/core';

import {
  computeJoinCoverage,
  fetchTemplates,
  runDefaultSync,
  syncExitCode,
  type SyncProgress,
} from './sync.ts';

// 历史入口：单测与本包其它调用方一直从 `cli.ts` 取这两个纯函数。
// 实现已搬到 `sync.ts`（CLI 与应用共用），这里保留 re-export 以免调用方/SDK 漂移。
export { championIconUrl, fetchTemplates, mergeDatasets } from './sync.ts';

const DEFAULT_STORE = resolve(process.cwd(), 'data');

function formatBytes(n: number): string {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
}

/** 进度事件 → 终端一行（`\r` 覆盖同一行，避免 173 行刷屏）。 */
function printProgress(p: SyncProgress): void {
  if (p.stage === 'details') {
    if (p.done !== undefined && p.total !== undefined) {
      process.stdout.write(`\r  · ${p.label} … ${p.done}/${p.total}   `);
    }
    return;
  }
  if (p.stage === 'static') {
    if (p.done === 0) process.stdout.write(`  · ${p.label} … `);
    else if (p.ok === true) console.log(`✓  [${p.message ?? ''}]`);
    else if (p.ok === false) {
      console.log('✗ 失败');
      console.error(`      ${p.message ?? ''}`);
    }
    return;
  }
  if (p.stage === 'rankings') {
    if (p.done === 0) process.stdout.write(`  · ${p.label} … `);
    else if (p.ok === true) console.log(`✓  [${p.message ?? ''}]`);
    else if (p.ok === false) {
      console.log('✗ 失败');
      console.error(`      ${p.message ?? ''}`);
    }
    return;
  }
  if (p.stage === 'templates' && p.done === 0) {
    process.stdout.write(`\n  · ${p.label} … `);
  }
}

async function cmdSync(storeRoot: string): Promise<number> {
  const staticProviders = createStaticProviders();
  const rankingProviders = createRankingProviders();
  console.log(
    `▶ 同步开始：静态源 ${staticProviders.length} 个，排行榜源 ${rankingProviders.length} 个\n`,
  );
  const t0 = Date.now();

  const report = await runDefaultSync({
    storeRoot,
    onProgress: printProgress,
  });

  // 详情/模板阶段的进度行是 `\r` 覆盖的，收尾补一个换行
  if (process.stdout.isTTY) process.stdout.write('\n');

  for (const w of report.wrote) {
    const path = resolve(storeRoot, `${w}.json`);
    try {
      const { size } = await stat(path);
      console.log(`✓ 已写入 ${path}  (${formatBytes(size)})`);
    } catch {
      console.log(`✓ 已写入 ${path}`);
    }
  }

  for (const s of report.skipped) {
    if (s.stage === 'templates') console.log(`  · 头像模板 … △ 跳过（${s.reason}）`);
  }

  console.log(
    report.ok
      ? `\n✓ 同步完成：${Date.now() - t0}ms，统计日期 ${report.dataDate || '未知'}`
      : '\n✗ 没有写入任何文件（全部数据源失败或已取消）',
  );
  if (report.failures.length > 0) {
    console.log(`⚠ ${report.failures.length} 个阶段失败，数据可能不完整`);
  }
  if (report.aborted) console.log('（已取消：已写下的文件仍然有效）');
  // ⚠️ 不能无条件 return 0：全失败时 CI/脚本要能看出来（判据在 sync.ts，有单测）。
  return syncExitCode(report);
}

async function cmdTemplates(storeRoot: string): Promise<number> {
  const ds = await readDataset(storeRoot);
  if (!ds || ds.champions.length === 0) {
    console.error('✗ 读不到图鉴英雄列表 —— 请先运行 pnpm sync');
    return 1;
  }

  process.stdout.write(`  · 英雄头像模板包 (${ds.champions.length} 个英雄) … `);
  const t0 = Date.now();
  let pack: TemplatePack;
  try {
    pack = await fetchTemplates(ds.champions);
  } catch (err) {
    console.log('✗');
    console.error(`      ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // 名字指纹（OCR 阶段 1）：读 scripts/render-name-fingerprints.ps1 的产物。
  // 缺失不阻断（识别降级为仅头像模板,已有真机数据表明其不可靠,但保留结构）。
  const { readFileSync } = await import('node:fs');
  const fpPath = resolve(storeRoot, '..', 'data', 'name-fingerprints.json');
  const fpAlt = resolve(process.cwd(), 'data', 'name-fingerprints.json');
  for (const p of [fpAlt, fpPath]) {
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as Array<{
        championId: number;
        name: string;
        width: number;
        height: number;
        bits: string;
      }>;
      (pack as TemplatePack & { names?: TemplatePack['names'] }).names = raw;
      console.log(`\n  · 名字指纹 ${raw.length} 个 ← ${p}`);
      break;
    } catch {
      /* 尝试下一个路径 */
    }
  }
  if (!pack.names) {
    console.log('\n  · 名字指纹缺失（运行 scripts/render-name-fingerprints.ps1 生成）');
  }

  const encoded = encodePack(pack);
  const path = await writeTemplates(storeRoot, encoded);
  const { size } = await stat(path);
  console.log(
    `✓ ${Date.now() - t0}ms  [${pack.count}/${ds.champions.length} 个模板，` +
      `${pack.size}×${pack.size} 灰度${pack.names ? ` + ${pack.names.length} 名字指纹` : ''}]` +
      ` → ${path} (${formatBytes(size)})`,
  );
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
    console.log(`  抓取时间  : ${f.fetchedAt}  (${f.ageHours === undefined ? '不可解析，按过期处理' : `${f.ageHours.toFixed(1)}h 前`})`);
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
    console.log(`  抓取时间  : ${rf.fetchedAt}  (${rf.ageHours === undefined ? '不可解析，按过期处理' : `${rf.ageHours.toFixed(1)}h 前`})`);
    console.log(`  统计日期  : ${rk.meta.dataDate || '未知'}`);
    console.log(`  新鲜度    : ${rf.stale ? '⚠ 已过期（建议重新同步）' : '✓ 新鲜'}`);
    console.log(`  海克斯榜  : ${rk.augments.length}`);
    console.log(`  英雄榜    : ${rk.heroes.length}`);
  }

  // 关联完整性：文件非空 ≠ 数据可用（见 `computeJoinCoverage` 的注释）。
  // 抓成"看着都有、一条也 join 不上"是本项目最容易悄悄发生的一种坏数据。
  const builds = await readBuilds(storeRoot);
  const coverage = ds ? computeJoinCoverage({ dataset: ds, rankings: rk, builds }) : [];
  console.log('\n关联完整性');
  if (coverage.length === 0) {
    console.log('  ○ 数据不全，无法核对（先跑 pnpm sync）');
  } else {
    for (const c of coverage) {
      const mark = c.total === 0 ? '○' : c.hit === c.total ? '✓' : '⚠';
      console.log(`  ${mark} ${c.label}: ${c.hit}/${c.total}`);
    }
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
    case 'templates':
      process.exitCode = await cmdTemplates(storeRoot);
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
          '  sync        拉取所有启用的数据源并落盘',
          '  templates   构建英雄头像模板包（截屏识别用，需联网）',
          '  status      查看本地数据集状态',
          '',
          '选项:',
          '  --store <dir>   数据目录（默认 ./data）',
        ].join('\n'),
      );
  }
}

/**
 * 仅在**直接运行本文件**时执行 CLI。
 *
 * 不能无条件调用 main()：那样任何 `import`（包括单元测试）
 * 都会立刻跑一遍 CLI、打印帮助并设置 process.exitCode，
 * 使得本文件里的纯函数（如 mergeDatasets）无法被测试。
 *
 * 用 `import.meta.url` 与 argv[1] 比对实现「入口保护」，
 * 等价于 Python 的 `if __name__ == '__main__'`。
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((err: unknown) => {
    console.error('未捕获错误:', err);
    process.exitCode = 1;
  });
}
