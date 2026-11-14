/**
 * 本地数据存储
 *
 * 设计取舍：
 *   - 用**文件系统**而非数据库：数据量小（594 海克斯 + 254 英雄行 + 装备 + 排行榜），
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

import type { CachedHttpEntry, ChampionDetailSet, Dataset, RankingSnapshot } from '@hexbox/core';
import { DATA_SCHEMA_VERSION } from '@hexbox/core';

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

/* ------------------------------------------------------------------ */
/* schema 版本：写入时补齐、读取时校验/迁移（审查 P2）                    */
/* ------------------------------------------------------------------ */

/**
 * 校验数据文件版本；返回实际版本（缺省按 1 = 0.2 及以前）。
 *
 * 大于当前支持的版本 → **明确拒绝**：未知格式"尽力解析"只会更难排查；
 * 提示升级程序（或删掉旧数据重新同步）。
 */
function readSchemaVersion(label: string, raw: unknown): number {
  const meta = (raw as { meta?: { schemaVersion?: unknown } } | null)?.meta;
  const version = meta?.schemaVersion;
  if (typeof version === 'number' && !Number.isInteger(version)) {
    throw new Error(`${label}的 schema 版本非法（${String(version)}），请重新同步`);
  }
  if (typeof version === 'number' && version > DATA_SCHEMA_VERSION) {
    throw new Error(
      `${label}由更新版本的 hexbox 生成（schema ${version}，当前支持 ${DATA_SCHEMA_VERSION}）：` +
        '请升级程序，或删除旧数据后重新同步',
    );
  }
  return typeof version === 'number' ? version : 1;
}

/** 写盘前统一盖上当前 schema 版本（所有写入路径唯一入口）。 */
function stampSchema<T extends { readonly meta: object }>(value: T): T {
  return { ...value, meta: { ...value.meta, schemaVersion: DATA_SCHEMA_VERSION } };
}

/**
 * 迁移数据集：v1（0.2 及以前）没有 `hextechs` → 补空数组（图鉴仍可用 CDragon 口径）。
 *
 * 数据不会少（旧文件本来就没有这个字段），也不会凭空造国服数据；
 * 提示信息由调用方（悬浮窗/CLI）按 `hextechs.length === 0` 给出。
 */
function migrateDataset(raw: Dataset): Dataset {
  const hextechs = (raw as { hextechs?: unknown }).hextechs;
  return {
    ...raw,
    hextechs: Array.isArray(hextechs) ? raw.hextechs : [],
    meta: { ...raw.meta, schemaVersion: DATA_SCHEMA_VERSION },
  };
}

/** 写入数据集（原子写；自动补齐 schema 版本）。 */
export async function writeDataset(root: string, dataset: Dataset): Promise<string> {
  return await writeJsonAtomic(resolveStorePaths(root).dataset, stampSchema(dataset));
}

/** 读取数据集；不存在时返回 null（而非抛错，便于调用方决定降级策略）。 */
export async function readDataset(root: string): Promise<Dataset | null> {
  const raw = await readJson<Dataset>(resolveStorePaths(root).dataset, '数据集');
  if (raw === null) return null;
  readSchemaVersion('数据集', raw);
  return migrateDataset(raw);
}

/** 写入排行榜快照（原子写，与 dataset 独立；自动补齐 schema 版本）。 */
export async function writeRankings(root: string, snapshot: RankingSnapshot): Promise<string> {
  return await writeJsonAtomic(resolveStorePaths(root).rankings, stampSchema(snapshot));
}

/** 读取排行榜快照；不存在时返回 null。 */
export async function readRankings(root: string): Promise<RankingSnapshot | null> {
  const raw = await readJson<RankingSnapshot>(resolveStorePaths(root).rankings, '排行榜');
  if (raw === null) return null;
  readSchemaVersion('排行榜', raw);
  return stampSchema(raw);
}

/**
 * 写入单英雄详情集合（原子写，与 dataset/rankings 独立）。
 *
 * 独立落盘的理由：它是**最大**的一份数据（173 个真实英雄 × 各含 100+ 海克斯条目；
 * 图鉴里另有 81 条变体行，没有独立统计），
 * 且与图鉴/榜单的更新节奏不同；分开才能独立失效、独立排查。
 */
export async function writeBuilds(root: string, set: ChampionDetailSet): Promise<string> {
  return await writeJsonAtomic(resolveStorePaths(root).builds, stampSchema(set));
}

/** 读取单英雄详情集合；不存在时返回 null（悬浮窗据此降级）。 */
export async function readBuilds(root: string): Promise<ChampionDetailSet | null> {
  const raw = await readJson<ChampionDetailSet>(resolveStorePaths(root).builds, '英雄详情');
  if (raw === null) return null;
  readSchemaVersion('英雄详情', raw);
  return stampSchema(raw);
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

/* ------------------------------------------------------------------ */
/* HTTP 条件缓存（ETag / Last-Modified）—— 文件持久化                   */
/* ------------------------------------------------------------------ */

/**
 * 文件持久化的 HTTP 条件缓存（审查 P2：Provider ETag）。
 *
 * 放在 data-store：它是唯一负责 fs/原子写的包；core 只有纯内存实现。
 * 文件是 `data/.http-cache.json`（gitignored 的 data/ 内），内容就是
 * `{ [url]: { etag?, lastModified?, body } }` —— 304 时用 body 复用。
 *
 * 并发（托盘自动同步 + `pnpm sync`）只写这一份："最后写入者赢"，
 * 缓存失效的代价只是**下一次重新下载**，不会污染数据文件；写入走原子写，
 * 读方不会看到半截 JSON。
 */
export interface FileHttpCache {
  /** 缓存文件位置（诊断用）。 */
  readonly path: string;
  get(url: string): CachedHttpEntry | undefined;
  set(url: string, entry: CachedHttpEntry): void;
  /** 落盘（原子写）；失败不抛（缓存只是优化，不该让同步失败）。 */
  flush(): Promise<void>;
}

/** 打开（或创建）`<root>/.http-cache.json`；损坏/不存在按空缓存处理。 */
export async function openHttpCache(root: string): Promise<FileHttpCache> {
  const path = join(root, '.http-cache.json');
  const entries = new Map<string, CachedHttpEntry>();
  if (existsSync(path)) {
    try {
      const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        for (const [url, value] of Object.entries(raw as Record<string, unknown>)) {
          const e = value as Partial<CachedHttpEntry> | null;
          if (
            typeof e === 'object' &&
            e !== null &&
            typeof e.body === 'string' &&
            (e.etag === undefined || typeof e.etag === 'string') &&
            (e.lastModified === undefined || typeof e.lastModified === 'string')
          ) {
            entries.set(url, {
              body: e.body,
              ...(e.etag !== undefined ? { etag: e.etag } : {}),
              ...(e.lastModified !== undefined ? { lastModified: e.lastModified } : {}),
            });
          }
        }
      }
    } catch {
      // 损坏的缓存直接丢弃（下次重新下载即可，不能阻断同步）
    }
  }
  return {
    path,
    get: (url) => entries.get(url),
    set: (url, entry) => {
      entries.set(url, entry);
    },
    flush: async () => {
      try {
        await writeJsonAtomic(path, Object.fromEntries(entries));
      } catch {
        // 缓存落盘失败不影响同步结果
      }
    },
  };
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
