/**
 * 本地数据存储
 *
 * 设计取舍：
 *   - 用**文件系统**而非数据库：数据量小（554 海克斯 + 245 英雄 + 装备），
 *     且需要人能直接打开查看/排查。JSON 足够，且零依赖。
 *   - 保持**按来源分文件**，而非合并成一个大文件：
 *     便于将来统计 provider 独立落盘、独立失效。
 *   - 记录 `fetchedAt` 供 UI 显示数据新鲜度。
 *
 * ⚠️ 风险提示（见 docs/research.md §8）：CommunityDragon 官方公告其服务器
 * 硬件老化、正在募资升级。因此**必须**支持离线读取已缓存数据，
 * 并准备 Data Dragon 作为降级来源。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Dataset } from '@hexbox/core';

export interface StorePaths {
  readonly root: string;
  readonly dataset: string;
}

export function resolveStorePaths(root: string): StorePaths {
  return { root, dataset: join(root, 'dataset.json') };
}

/** 写入数据集（原子性：先写临时文件再改名，避免半截文件）。 */
export async function writeDataset(root: string, dataset: Dataset): Promise<string> {
  const paths = resolveStorePaths(root);
  await mkdir(dirname(paths.dataset), { recursive: true });

  const tmp = `${paths.dataset}.tmp`;
  await writeFile(tmp, JSON.stringify(dataset, null, 2), 'utf8');
  // rename 在同分区上是原子的
  const { rename } = await import('node:fs/promises');
  await rename(tmp, paths.dataset);

  return paths.dataset;
}

/** 读取数据集；不存在时返回 null（而非抛错，便于调用方决定降级策略）。 */
export async function readDataset(root: string): Promise<Dataset | null> {
  const paths = resolveStorePaths(root);
  if (!existsSync(paths.dataset)) return null;
  try {
    return JSON.parse(await readFile(paths.dataset, 'utf8')) as Dataset;
  } catch (err) {
    throw new Error(`缓存数据集损坏，请重新同步: ${paths.dataset}\n${String(err)}`);
  }
}

export interface FreshnessInfo {
  readonly exists: boolean;
  readonly fetchedAt?: string;
  readonly ageHours?: number;
  readonly stale: boolean;
}

/**
 * 判断缓存新鲜度。
 * 默认 24 小时视为过期 —— 静态数据变化不频繁，无需更激进的刷新。
 */
export function checkFreshness(dataset: Dataset | null, maxAgeHours = 24): FreshnessInfo {
  if (!dataset) return { exists: false, stale: true };
  const ageMs = Date.now() - new Date(dataset.meta.fetchedAt).getTime();
  const ageHours = ageMs / 3_600_000;
  return {
    exists: true,
    fetchedAt: dataset.meta.fetchedAt,
    ageHours,
    stale: ageHours > maxAgeHours,
  };
}
