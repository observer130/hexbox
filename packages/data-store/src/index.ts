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

import type { ChampionDetailSet, Dataset, RankingSnapshot } from '@hexbox/core';

export interface StorePaths {
  readonly root: string;
  readonly dataset: string;
  readonly rankings: string;
  readonly builds: string;
}

export function resolveStorePaths(root: string): StorePaths {
  return {
    root,
    dataset: join(root, 'dataset.json'),
    rankings: join(root, 'rankings.json'),
    builds: join(root, 'builds.json'),
  };
}

/**
 * 原子写：先写 `.tmp` 再 rename。
 *
 * rename 在同分区上是原子操作，因此读取方**永远看不到半截文件**
 * —— 这是三个数据文件共用的唯一写入路径。
 */
async function writeJsonAtomic(path: string, value: unknown): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, path);
  return path;
}

/** 读取 JSON；不存在返回 null，内容损坏则抛带路径的可诊断错误。 */
async function readJson<T>(path: string, label: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (err) {
    throw new Error(`缓存${label}损坏，请重新同步: ${path}\n${String(err)}`);
  }
}

/** 写入数据集（原子写）。 */
export async function writeDataset(root: string, dataset: Dataset): Promise<string> {
  return await writeJsonAtomic(resolveStorePaths(root).dataset, dataset);
}

/** 读取数据集；不存在时返回 null（而非抛错，便于调用方决定降级策略）。 */
export async function readDataset(root: string): Promise<Dataset | null> {
  return await readJson<Dataset>(resolveStorePaths(root).dataset, '数据集');
}

/** 写入排行榜快照（原子写，与 dataset 独立）。 */
export async function writeRankings(root: string, snapshot: RankingSnapshot): Promise<string> {
  return await writeJsonAtomic(resolveStorePaths(root).rankings, snapshot);
}

/** 读取排行榜快照；不存在时返回 null。 */
export async function readRankings(root: string): Promise<RankingSnapshot | null> {
  return await readJson<RankingSnapshot>(resolveStorePaths(root).rankings, '排行榜');
}

/**
 * 写入单英雄详情集合（原子写，与 dataset/rankings 独立）。
 *
 * 独立落盘的理由：它是**最大**的一份数据（245 英雄 × 各含 100+ 海克斯条目），
 * 且与图鉴/榜单的更新节奏不同；分开才能独立失效、独立排查。
 */
export async function writeBuilds(root: string, set: ChampionDetailSet): Promise<string> {
  return await writeJsonAtomic(resolveStorePaths(root).builds, set);
}

/** 读取单英雄详情集合；不存在时返回 null（悬浮窗据此降级）。 */
export async function readBuilds(root: string): Promise<ChampionDetailSet | null> {
  return await readJson<ChampionDetailSet>(resolveStorePaths(root).builds, '英雄详情');
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
