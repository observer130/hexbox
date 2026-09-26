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
import { pathToFileURL } from 'node:url';

import {
  checkFreshness,
  checkRankingsFreshness,
  readBuilds,
  readDataset,
  readRankings,
  writeBuilds,
  writeDataset,
  writeRankings,
  writeTemplates,
} from '@hexbox/data-store';
import { createRankingProviders, createStaticProviders } from '@hexbox/provider-registry';
import { fetchHeroDetails } from '@hexbox/provider-tencent';
import { buildEntry, encodePack, type TemplateEntry, type TemplatePack } from '@hexbox/vision';
import type { ChampionDetailSet, Dataset, RankingSnapshot } from '@hexbox/core';

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

  // ---- 单英雄海斗详情（出装 / 海克斯强度 / 加点）----
  // 依赖图鉴里的英雄列表；图鉴失败则跳过（不阻断整体）
  const championIds = (await readDataset(storeRoot))?.champions.map((c) => c.id) ?? [];
  if (championIds.length === 0) {
    console.log('\n  · 单英雄详情 … △ 跳过（无英雄列表，请先确保图鉴同步成功）');
  } else {
    await cmdSyncBuilds(storeRoot, championIds);
  }

  if (failures > 0) console.log(`\n⚠ ${failures} 个数据源失败，数据可能不完整`);
  return 0;
}

/**
 * 预抓全部英雄的海斗详情并落盘。
 *
 * 为什么预抓而不是运行时拉：悬浮窗需保持「只读本地、离线可用」。
 * 245 个英雄、并发 6，只打一次上游。
 */
async function cmdSyncBuilds(storeRoot: string, championIds: readonly number[]): Promise<void> {
  const total = championIds.length;
  process.stdout.write(`\n  · 单英雄海斗详情 (${total} 个英雄) … `);
  const t0 = Date.now();

  let lastPrint = 0;
  const details = await fetchHeroDetails(championIds, {
    concurrency: 6,
    onProgress: (done, all) => {
      // 每 ~10% 打一次进度，避免 245 行刷屏
      if (done - lastPrint >= Math.ceil(all / 10) || done === all) {
        lastPrint = done;
        process.stdout.write(`\r  · 单英雄海斗详情 … ${done}/${all}   `);
      }
    },
  }).catch((err: unknown) => {
    console.error(`\n      ${err instanceof Error ? err.message : String(err)}`);
    return [];
  });

  if (details.length === 0) {
    console.log(`\r  · 单英雄海斗详情 … ✗ 全部失败（未写入）`);
    return;
  }

  const set: ChampionDetailSet = {
    meta: {
      source: 'tencent-hero-detail',
      dataDate: details[0]?.dataDate ?? '',
      fetchedAt: new Date().toISOString(),
      count: details.length,
    },
    details,
  };

  const path = await writeBuilds(storeRoot, set);
  const { size } = await stat(path);
  const miss = total - details.length;
  console.log(
    `\r  · 单英雄海斗详情 … ✓ ${Date.now() - t0}ms  ` +
      `[${details.length}/${total} 个英雄${miss > 0 ? `，${miss} 个无数据` : ''}] ` +
      `统计日期 ${set.meta.dataDate || '未知'}`,
  );
  console.log(`✓ 已写入 ${path}  (${formatBytes(size)})`);
}

/**
 * 构建英雄头像模板包（截屏识别的构建期产物）。
 *
 * 为什么构建期做：运行时（悬浮窗）必须离线、且不应为识别
 * 单独引图像解码依赖 —— 见 packages/vision/src/templates.ts 头注。
 *
 * 图标 URL 映射（实测确认，勿改回）：
 *   dataset.json 的 iconPath 是 **LCU 内部资产路径**
 *   （`/lol-game-data/assets/v1/champion-icons/<id>.png`），
 *   该前缀在 CDragon 上**不存在**（404）。CDragon 的真实布局是
 *   `<plugins>/rcp-be-lol-game-data/global/default/v1/champion-icons/<id>.png`，
 *   因此这里按英雄 ID 直接构造，而不是拼接 iconPath。
 *
 * 单个头像失败只跳过该英雄（缺失模板 = 该英雄可能识别不出，可接受），
 * 全部失败才整体报错。
 */
export function championIconUrl(
  championId: number,
  baseUrl = 'https://raw.communitydragon.org/latest/plugins',
): string {
  return `${baseUrl}/rcp-be-lol-game-data/global/default/v1/champion-icons/${championId}.png`;
}

export async function fetchTemplates(
  champions: readonly { readonly id: number; readonly name: string; readonly alias: string; readonly iconPath?: string }[],
  options: {
    readonly size?: number;
    readonly baseUrl?: string;
    readonly concurrency?: number;
    readonly timeoutMs?: number;
  } = {},
): Promise<TemplatePack> {
  const { decodePng, extractGray } = await import('@hexbox/vision');
  const size = options.size ?? 24;
  const baseUrl = options.baseUrl ?? 'https://raw.communitydragon.org/latest/plugins';
  const concurrency = options.concurrency ?? 8;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const entries: TemplateEntry[] = [];
  let failed = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor++;
      if (idx >= champions.length) return;
      const c = champions[idx]!;
      const url = championIconUrl(c.id, baseUrl);
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const png = decodePng(new Uint8Array(await res.arrayBuffer()));
        // 头像整图缩放为模板（PNG 自带方形画布，无需再抠内框）
        const gray = extractGray(
          { width: png.width, height: png.height, data: png.data },
          { x: 0, y: 0, w: 1, h: 1 },
          size,
        );
        if (!gray) throw new Error('extractGray 返回空');
        entries.push(buildEntry({ id: c.id, name: c.name, alias: c.alias }, gray, size));
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  entries.sort((a, b) => a.championId - b.championId);
  if (entries.length === 0) {
    throw new Error(`全部 ${champions.length} 个头像拉取失败（网络异常？）`);
  }

  return {
    version: 1,
    size,
    createdAt: new Date().toISOString(),
    sourceUrl: baseUrl,
    count: entries.length,
    templates: entries,
    // failed 不入包：包内容只与「成功模板」有关，失败数仅打日志
  } as TemplatePack & { __failed?: number };
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

async function cmdStatus(storeRoot: string): Promise<number> {  const ds = await readDataset(storeRoot);
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

