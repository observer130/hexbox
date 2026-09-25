/**
 * 本地数据存储
 *
 * 设计取舍：
 *   - 用**文件系统**而非数据库：数据量小（554 海克斯 + 245 英雄 + 装备 + 排行榜），
 *     且需要人能直接打开查看/排查。JSON 足够，且零依赖。
 *   - 保持**按来源分文件**：dataset.json（静态图鉴，多源合并）与
 *     rankings.json（官方统计榜）独立落盘、独立失效。
 *   - 记录 `fetchedAt` 供 UI 显示数据新鲜度。
 *
 * ⚠️ 风险提示：CommunityDragon 官方公告其服务器硬件老化、正在募资升级。
 * 因此本存储**必须**支持离线读取已缓存数据。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Dataset, RankingSnapshot } from '@hexbox/core';

export interface StorePaths {
  readonly root: string;
  readonly dataset: string;
  readonly rankings: string;
}

export function resolveStorePaths(root: string): StorePaths {
  return { root, dataset: join(root, 'dataset.json'), rankings: join(root, 'rankings.json') };
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

/** 写入排行榜快照（原子写，同 dataset）。 */
export async function writeRankings(root: string, snapshot: RankingSnapshot): Promise<string> {
  const paths = resolveStorePaths(root);
  await mkdir(dirname(paths.rankings), { recursive: true });
  const tmp = `${paths.rankings}.tmp`;
  await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, paths.rankings);
  return paths.rankings;
}

/** 读取排行榜快照；不存在时返回 null。 */
export async function readRankings(root: string): Promise<RankingSnapshot | null> {
  const paths = resolveStorePaths(root);
  if (!existsSync(paths.rankings)) return null;
  try {
    return JSON.parse(await readFile(paths.rankings, 'utf8')) as RankingSnapshot;
  } catch (err) {
    throw new Error(`缓存排行榜损坏，请重新同步: ${paths.rankings}\n${String(err)}`);
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
 * 静态数据 24 小时视为过期；排行榜统计每日更新，12 小时即视为过期。
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

export function checkRankingsFreshness(
  snapshot: RankingSnapshot | null,
  maxAgeHours = 12,
): FreshnessInfo {
  if (!snapshot) return { exists: false, stale: true };
  const ageMs = Date.now() - new Date(snapshot.meta.fetchedAt).getTime();
  const ageHours = ageMs / 3_600_000;
  return {
    exists: true,
    fetchedAt: snapshot.meta.fetchedAt,
    ageHours,
    stale: ageHours > maxAgeHours,
  };
}
