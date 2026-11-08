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

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ChampionDetailSet, Dataset, RankingSnapshot } from '@hexbox/core';
import type { TemplatePack } from '@hexbox/vision';

export interface StorePaths {
  readonly root: string;
  readonly dataset: string;
  readonly rankings: string;
  readonly builds: string;
  readonly templates: string;
}

export function resolveStorePaths(root: string): StorePaths {
  return {
    root,
    dataset: join(root, 'dataset.json'),
    rankings: join(root, 'rankings.json'),
    builds: join(root, 'builds.json'),
    templates: join(root, 'templates.json'),
  };
}

/**
 * 本次写入独占的临时文件名。
 *
 * ⚠️ 绝不能固定成 `${path}.tmp`（2026-11 审查）：托盘「更新数据」和命令行
 * `pnpm sync` 完全可能同时跑，两个进程写同一个 `.tmp` 会互相覆盖，
 * 先完成的那次 `rename` 就会把**另一个进程的半截文件**搬成正式数据。
 * 文件名里带 pid + 随机后缀，各写各的；`rename` 依旧保证读方看不到半截文件。
 */
function tempPathFor(path: string): string {
  const salt = Math.random().toString(36).slice(2, 10);
  return `${path}.${process.pid}.${salt}.tmp`;
}

const RENAME_RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * rename 到已存在的目标；Windows 上允许有界重试。
 *
 * ⚠️ 真机教训（由并发测试暴露）：两个进程同时写同一个文件时，第二个
 * `MoveFileEx(REPLACE_EXISTING)` 会**瞬时**失败（EPERM/EACCES/EBUSY）——
 * 目标文件正被另一个进程的 rename/读取句柄占着。这不是"写坏了"，等几毫秒
 * 再试就成功。不重试的表现是：托盘「更新数据」和 `pnpm sync` 撞在一起时，
 * 其中一个直接报错退出（数据是好的，但用户以为同步失败）。
 */
async function renameWithRetry(tmp: string, target: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await rename(tmp, target);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === undefined || !RENAME_RETRYABLE.has(code)) throw e;
      lastError = e;
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** 原子写：临时文件 → rename；失败时清掉自己的临时文件（不留垃圾）。 */
async function writeAtomic(path: string, text: string): Promise<string> {
  const tmp = tempPathFor(path);
  try {
    await writeFile(tmp, text, 'utf8');
    await renameWithRetry(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  return path;
}

/**
 * 原子写 JSON：先写临时文件再 rename。
 *
 * rename 在同分区上是原子操作，因此读取方**永远看不到半截文件**
 * —— 这是三个数据文件共用的唯一写入路径。
 */
async function writeJsonAtomic(path: string, value: unknown): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  return writeAtomic(path, JSON.stringify(value, null, 2));
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

/**
 * 写入头像模板包（原子写）。
 *
 * 模板包是**构建期产物**（`pnpm templates` 生成，gzip+base64 的单字符串），
 * 供悬浮窗截屏识别离线使用 —— 与数据同放 data/ 但更新节奏独立：
 * 头像资源只在补丁改动英雄时变化。
 */
export async function writeTemplates(root: string, packJson: string): Promise<string> {
  await mkdir(root, { recursive: true });
  return writeAtomic(resolveStorePaths(root).templates, packJson);
}

/** 读取头像模板包（gzip+base64 字符串）；不存在返回 null。 */
export async function readTemplates(root: string): Promise<string | null> {
  const path = resolveStorePaths(root).templates;
  if (!existsSync(path)) return null;
  return await readFile(path, 'utf8');
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
  const t = new Date(dataset.meta.fetchedAt).getTime();
  // ⚠️ 日期解析失败时 `NaN > maxAgeHours` 恒为 false → 会永远显示"新鲜"。
  //    一个写坏的 fetchedAt（或旧版本留下的怪值）就会让启动检查再也不更新数据。
  if (!Number.isFinite(t)) {
    return { exists: true, fetchedAt: dataset.meta.fetchedAt, stale: true };
  }
  const ageHours = (Date.now() - t) / 3_600_000;
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
  const t = new Date(snapshot.meta.fetchedAt).getTime();
  // 同 `checkFreshness`：NaN 时必须判过期，否则坏掉的 fetchedAt 永远不会再同步
  if (!Number.isFinite(t)) {
    return { exists: true, fetchedAt: snapshot.meta.fetchedAt, stale: true };
  }
  const ageHours = (Date.now() - t) / 3_600_000;
  return {
    exists: true,
    fetchedAt: snapshot.meta.fetchedAt,
    ageHours,
    stale: ageHours > maxAgeHours,
  };
}
