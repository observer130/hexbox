/**
 * 数据同步引擎（`pnpm sync` 与悬浮窗「更新数据」**共用同一份**）
 *
 * 为什么要抽出来：
 *   内置快照会随发版时间变旧（docs/RELEASE-WINDOWS.md 决策 #6 已改为"要做"），
 *   而悬浮窗必须能在**不重装**的前提下刷新数据。如果应用里另写一条拉取链路，
 *   它迟早会和 CLI 的口径漂移（合并策略、失败降级、模板重建条件……）。
 *   所以：CLI 只负责打印，应用只负责交互，**流水线只有这里一份**。
 *
 * 写盘策略（每一条都对应一次真实取舍）：
 *   · 每个文件**独立提交**：图鉴/榜单/英雄详情/模板互相不牵连，某个源失败
 *     不阻断其它文件（`pnpm sync` 一直如此）；
 *   · **空的绝不写**：拿不到数据时保留旧文件，而不是用空数组覆盖 ——
 *     否则一次网络抖动就会把用户本地的可用数据清空；
 *   · 原子写由 `@hexbox/data-store` 保证（`.tmp` → rename），读方永远看不到半截文件。
 *
 * 可测性：所有网络/写盘都通过注入点进来（provider 数组、store、fetch），
 *   单测里不需要真的联网；Electron 只负责把 `onProgress` 翻译成托盘文案。
 */

import {
  buildEntry,
  decodePack,
  decodePng,
  encodePack,
  extractGray,
  type TemplateEntry,
  type TemplatePack,
} from '@hexbox/vision';
import type {
  Champion,
  ChampionDetail,
  ChampionDetailSet,
  Dataset,
  RankingProvider,
  RankingSnapshot,
  StaticProvider,
} from '@hexbox/core';
import { fetchHeroDetails } from '@hexbox/provider-tencent';
import {
  readBuilds,
  readDataset,
  readRankings,
  readTemplates,
  writeBuilds,
  writeDataset,
  writeRankings,
  writeTemplates,
} from '@hexbox/data-store';
import { createRankingProviders, createStaticProviders } from '@hexbox/provider-registry';

/* ------------------------------------------------------------------ */
/* 多源合并（CLI 与应用的唯一口径）                                     */
/* ------------------------------------------------------------------ */

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

/** 数据集是否"有内容"（空数据集一律不落盘，保留旧文件）。 */
export function datasetHasContent(dataset: Dataset | null): dataset is Dataset {
  return (
    dataset !== null &&
    (dataset.augments.length > 0 ||
      dataset.hextechs.length > 0 ||
      dataset.champions.length > 0 ||
      dataset.items.length > 0)
  );
}

/* ------------------------------------------------------------------ */
/* 按集合回退（**只有存在旧文件时才生效**）                              */
/* ------------------------------------------------------------------ */

/** 数据集里可以独立回退的四类内容。 */
export type DatasetCollection = 'augments' | 'champions' | 'items' | 'hextechs';

const DATASET_COLLECTIONS: readonly DatasetCollection[] = [
  'augments',
  'champions',
  'items',
  'hextechs',
];

/** 去掉 `readonly` 的内存视图（回退时只改这一份浅拷贝，不动入参）。 */
type MutableDataset = { -readonly [K in keyof Dataset]: Dataset[K] };

/** 某一类内容为空时，用旧文件里的那一份补上（返回是否补了）。 */
function backfillDatasetCollection<K extends DatasetCollection>(
  key: K,
  merged: MutableDataset,
  previous: Dataset | null,
): boolean {
  if (merged[key].length > 0) return false;
  const old = previous?.[key];
  if (!old || old.length === 0) return false;
  merged[key] = old;
  return true;
}

/**
 * 多源合并 + **按集合回退**到上一份好数据。
 *
 * 为什么必须有（真机风险，2026-11 审查）：
 *   静态图鉴是**两个源分工**拼出来的 —— CDragon 出 `augments/champions/items`，
 *   腾讯一方出 `hextechs`（国服图鉴）。任一方失败时，`mergeDatasets` 得到的
 *   那一类是**空数组**，而 `datasetHasContent` 是"任一字段非空"的 OR 判据，
 *   于是"另一半"会被空数组**静默覆盖**：腾讯挂了 = 248 条国服图鉴清零；
 *   CDragon 挂了 = 英雄/装备/海克斯全清零（详情阶段随后还会因"没有英雄列表"
 *   而整体跳过）。这两条都发生在**启动静默自动同步**里，用户看不到任何提示。
 *
 * 判据：**失败源的那一类内容沿用旧文件**，其余照常写入；`backfilled` 交给
 *   调用方记成 failure，让"数据可能不完整"这件事在报告里看得见。
 *
 * @param fresh 本次**成功**的静态源（顺序有意义，见 `mergeDatasets`）
 * @param previous 上一份好数据（无则为 null → 不做任何回退）
 */
export function mergeStaticDatasets(
  fresh: readonly Dataset[],
  previous: Dataset | null,
): { readonly dataset: Dataset; readonly backfilled: readonly DatasetCollection[] } {
  const merged = mergeDatasets(fresh) as MutableDataset;
  const backfilled: DatasetCollection[] = [];
  for (const key of DATASET_COLLECTIONS) {
    if (backfillDatasetCollection(key, merged, previous)) backfilled.push(key);
  }
  return { dataset: merged, backfilled };
}

/** 排行榜里可以独立回退的两张榜。 */
export type RankingList = 'augments' | 'heroes';

/** 去掉 `readonly` 的内存视图。 */
type MutableRankingSnapshot = {
  -readonly [K in keyof RankingSnapshot]: RankingSnapshot[K];
};

/** 某一榜为空时用旧榜单补上（泛型保证两侧同一字段类型）。 */
function backfillRankingList<K extends RankingList>(
  merged: MutableRankingSnapshot,
  key: K,
  previous: RankingSnapshot | null,
): boolean {
  if (merged[key].length > 0) return false;
  const old = previous?.[key];
  if (!old || old.length === 0) return false;
  merged[key] = old;
  return true;
}

/**
 * 排行榜**逐列表**回退。
 *
 * 与 `mergeStaticDatasets` 同一个病：上游是两个独立接口（`fuwen_aram_rune_rank_v2`
 * 与 `fuwen_aram_hero_rank_v2`），其中一个报错时快照里那张榜是空数组，而写盘判据
 * 是"任一榜非空" —— 于是"半边成功"会删掉另一张完整的榜（245 条英雄榜）。
 */
export function mergeRankingSnapshot(
  fresh: RankingSnapshot,
  previous: RankingSnapshot | null,
): { readonly snapshot: RankingSnapshot; readonly backfilled: readonly RankingList[] } {
  const merged = { ...fresh } as MutableRankingSnapshot;
  const backfilled: RankingList[] = [];
  for (const key of ['augments', 'heroes'] as const) {
    if (backfillRankingList(merged, key, previous)) backfilled.push(key);
  }
  return { snapshot: merged, backfilled };
}

/* ------------------------------------------------------------------ */
/* 写入前的覆盖率下限（防"部分成功"覆盖完整文件）                        */
/* ------------------------------------------------------------------ */

/**
 * 单英雄详情的最低覆盖率。
 *
 * 为什么是 90% 而不是 100%：个别英雄偶发超时/无数据是常态，要求满覆盖会让
 * 一次抖动就把整次更新卡死；而 60/173 这种"大面积失败"必须挡住 —— 它会把
 * 113 个英雄的强度表**静默删掉**（详情逐条累计，`details` 就是最终文件）。
 */
export const DETAILS_MIN_COVERAGE = 0.9;

/** 头像模板包的最低覆盖率（同上：挡住大面积失败，容忍个别头像 404）。 */
export const TEMPLATES_MIN_COVERAGE = 0.9;

/** 覆盖率下限（向上取整，至少 1；`expected <= 0` 时为 0 = 无从判断）。 */
function coverageFloor(expected: number, ratio: number): number {
  const total = Number.isFinite(expected) && expected > 0 ? Math.floor(expected) : 0;
  if (total === 0) return 0;
  return Math.max(1, Math.ceil(total * ratio));
}

/** 这次至少要拿到多少个英雄详情才允许覆盖 `builds.json`。 */
export function detailsRequiredCount(expected: number): number {
  return coverageFloor(expected, DETAILS_MIN_COVERAGE);
}

/** 这次至少要拿到多少个头像模板才允许覆盖 `templates.json`。 */
export function templatesRequiredCount(expected: number): number {
  return coverageFloor(expected, TEMPLATES_MIN_COVERAGE);
}

/**
 * 这批详情够不够格覆盖旧文件（纯函数，写盘前的唯一判据）。
 *
 * 与 `aborted()` 分开判断：取消是"用户不要了"，覆盖率是"数据不完整"，
 * 两条都必须拒绝写入，但报告文案不同。
 */
export function mayOverwriteDetails(fetched: number, expected: number): boolean {
  if (!Number.isFinite(fetched) || fetched <= 0) return false;
  return fetched >= detailsRequiredCount(expected);
}

/** 详情未落盘时的**人话原因**（报告与 skipped 共用，纯函数便于单测）。 */
export function detailSkipReason(input: {
  readonly fetched: number;
  readonly expected: number;
  readonly aborted: boolean;
}): string {
  if (input.aborted) return '已取消（详情不完整，不覆盖旧文件）';
  if (input.fetched <= 0) return '全部失败，保留现有英雄详情';
  const required = detailsRequiredCount(input.expected);
  return (
    `只拿到 ${input.fetched}/${input.expected} 个英雄（低于 ${required} 个的下限，` +
    '保留现有英雄详情）'
  );
}

/* ------------------------------------------------------------------ */
/* 类型                                                               */
/* ------------------------------------------------------------------ */

/** 同步阶段（托盘文案 / 日志 / 测试断言都按它分组）。 */
export type SyncStage = 'static' | 'rankings' | 'details' | 'templates';

/** 落在 `data/` 下的四个文件。 */
export type SyncFile = 'dataset' | 'rankings' | 'builds' | 'templates';

/** 进度事件（`label` 已经是可以直接显示的阶段名）。 */
export interface SyncProgress {
  readonly stage: SyncStage;
  readonly label: string;
  readonly done?: number;
  readonly total?: number;
  /** 该阶段刚刚结束时的结果（成功/失败）；进行中为 undefined。 */
  readonly ok?: boolean;
  readonly message?: string;
}

export interface SyncFailure {
  readonly stage: SyncStage;
  readonly label: string;
  readonly message: string;
}

export interface SyncSkip {
  readonly stage: SyncStage;
  readonly reason: string;
}

export interface SyncCounts {
  readonly augments: number;
  readonly hextechs: number;
  readonly champions: number;
  readonly items: number;
  readonly rankingAugments: number;
  readonly rankingHeroes: number;
  readonly details: number;
  readonly templates: number;
}

export interface SyncReport {
  /** 至少写成了一个文件（用户可见的"更新成功"）。 */
  readonly ok: boolean;
  /** 被 `signal` 取消（已写下的文件仍然有效）。 */
  readonly aborted: boolean;
  readonly wrote: readonly SyncFile[];
  readonly failures: readonly SyncFailure[];
  readonly skipped: readonly SyncSkip[];
  /** 本次落盘的官方统计日期（`YYYYMMDD`；拿不到时退回旧值）。 */
  readonly dataDate: string;
  readonly counts: SyncCounts;
  readonly fetchedAt: string;
  readonly templatesRebuilt: boolean;
}

/**
 * `pnpm sync` 的退出码：**一个文件都没写成**才算失败。
 *
 * 为什么需要它（2026-11 审查）：`cmdSync` 以前无条件 `return 0`，
 * 于是"全部数据源失败"也返回 0 —— CI 与脚本据此完全看不出失败。
 * 部分阶段失败仍返回 0（已有文件被更新，CLI 会另行打印 ⚠ 警告）。
 */
export function syncExitCode(report: Pick<SyncReport, 'ok'>): number {
  return report.ok ? 0 : 1;
}

/** 写盘接口（默认实现 = `@hexbox/data-store`；测试注入内存版）。 */
export interface SyncStore {
  readDataset(root: string): Promise<Dataset | null>;
  readRankings(root: string): Promise<RankingSnapshot | null>;
  readBuilds(root: string): Promise<ChampionDetailSet | null>;
  readTemplates(root: string): Promise<string | null>;
  writeDataset(root: string, dataset: Dataset): Promise<string>;
  writeRankings(root: string, snapshot: RankingSnapshot): Promise<string>;
  writeBuilds(root: string, set: ChampionDetailSet): Promise<string>;
  writeTemplates(root: string, encoded: string): Promise<string>;
}

export interface DetailFetchOptions {
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (done: number, total: number) => void;
}

export interface TemplateBuildOptions {
  readonly size?: number;
  readonly baseUrl?: string;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface SyncOptions {
  readonly storeRoot: string;
  readonly store: SyncStore;
  readonly staticProviders: readonly StaticProvider[];
  readonly rankingProviders: readonly RankingProvider[];
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: SyncProgress) => void;
  readonly now?: () => Date;
  /** 英雄详情批量拉取（默认 = `@hexbox/provider-tencent` 的 `fetchHeroDetails`）。 */
  readonly fetchDetails?: (
    championIds: readonly number[],
    options: DetailFetchOptions,
  ) => Promise<readonly ChampionDetail[]>;
  /** 头像模板构建（默认 = 本模块的 `fetchTemplates`）。 */
  readonly buildTemplates?: (
    champions: readonly TemplateChampion[],
    options: TemplateBuildOptions,
  ) => Promise<TemplatePack>;
  readonly encodeTemplates?: (pack: TemplatePack) => string;
  /** 强制重建头像模板（默认只在英雄集合变化 / 缺包时重建）。 */
  readonly forceTemplates?: boolean;
}

/** 构建模板所需的最小英雄字段（`Dataset.champions` 的超集）。 */
export type TemplateChampion = Pick<Champion, 'id' | 'name' | 'alias'> & {
  readonly iconPath?: string;
};

/* ------------------------------------------------------------------ */
/* 头像模板：重建判据（纯函数）                                         */
/* ------------------------------------------------------------------ */

export interface TemplateDecisionInput {
  readonly hasExistingPack: boolean;
  readonly previousChampionIds: readonly number[];
  readonly nextChampionIds: readonly number[];
  readonly force?: boolean;
}

export interface TemplateDecision {
  readonly rebuild: boolean;
  readonly reason: string;
}

/** 英雄 ID 集合的稳定指纹（排序 + 去重，与顺序无关）。 */
export function championIdKey(ids: readonly number[]): string {
  return [...new Set(ids)].sort((a, b) => a - b).join(',');
}

/**
 * 要不要重建头像模板。
 *
 * 为什么不是每次同步都重建：245 个头像 = 245 次 CDragon 请求，
 * 而模板只在补丁新增/改名英雄时才变。用**英雄集合**变化作判据：
 * 日常的胜率/榜单更新不会白拉一遍头像，新增英雄时又会自动补上。
 */
export function decideTemplatesRebuild(input: TemplateDecisionInput): TemplateDecision {
  if (input.force) return { rebuild: true, reason: '强制重建' };
  if (!input.hasExistingPack) return { rebuild: true, reason: '本地没有模板包' };
  if (input.nextChampionIds.length === 0) return { rebuild: false, reason: '没有英雄列表' };
  if (
    championIdKey(input.previousChampionIds) !== championIdKey(input.nextChampionIds)
  ) {
    return {
      rebuild: true,
      reason:
        `英雄集合变化（${input.previousChampionIds.length} → ${input.nextChampionIds.length}）`,
    };
  }
  return { rebuild: false, reason: '英雄集合未变' };
}

/* ------------------------------------------------------------------ */
/* 头像模板：构建（联网；CLI 与应用的唯一实现）                          */
/* ------------------------------------------------------------------ */

/**
 * 图标 URL 映射（实测确认，勿改回）：
 *   dataset.json 的 iconPath 是 **LCU 内部资产路径**
 *   （`/lol-game-data/assets/v1/champion-icons/<id>.png`），
 *   该前缀在 CDragon 上**不存在**（404）。CDragon 的真实布局是
 *   `<plugins>/rcp-be-lol-game-data/global/default/v1/champion-icons/<id>.png`，
 *   因此这里按英雄 ID 直接构造，而不是拼接 iconPath。
 */
export function championIconUrl(
  championId: number,
  baseUrl = 'https://raw.communitydragon.org/latest/plugins',
): string {
  return `${baseUrl}/rcp-be-lol-game-data/global/default/v1/champion-icons/${championId}.png`;
}

/**
 * 拉取全部英雄头像并构建模板包。
 *
 * 单个头像失败只跳过该英雄（缺失模板 = 该英雄可能识别不出，可接受），
 * 全部失败才整体报错。
 */
export async function fetchTemplates(
  champions: readonly TemplateChampion[],
  options: TemplateBuildOptions = {},
): Promise<TemplatePack> {
  const size = options.size ?? 24;
  const baseUrl = options.baseUrl ?? 'https://raw.communitydragon.org/latest/plugins';
  const concurrency = options.concurrency ?? 8;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const signal = options.signal;

  const entries: TemplateEntry[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      const idx = cursor++;
      if (idx >= champions.length) return;
      const c = champions[idx]!;
      const url = championIconUrl(c.id, baseUrl);
      try {
        // 超时与外部取消合成一个信号（Node 20+ 的 AbortSignal.any）
        const attempt = AbortSignal.timeout(timeoutMs);
        const combined = signal ? AbortSignal.any([attempt, signal]) : attempt;
        const res = await fetch(url, { signal: combined });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const png = decodePng(new Uint8Array(await res.arrayBuffer()));
        // 头像整图缩放为模板（PNG 自带方形画布，无需再抠内框）
        const gray = extractGray(
          { width: png.width, height: png.height, data: png.data },
          { x: 0, y: 0, w: 1, h: 1 },
          size,
        );
        if (!gray) throw new Error('extractGray 返回空');
        entries.push(
          buildEntry({ id: c.id, name: c.name, alias: c.alias }, gray, size),
        );
      } catch {
        // 取消不算"这个头像失败"，直接收工
        if (signal?.aborted) return;
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
  };
}

/* ------------------------------------------------------------------ */
/* 同步引擎                                                           */
/* ------------------------------------------------------------------ */

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 把旧模板包里的名字指纹带进新包（应用内更新跑不了 `render-name-fingerprints.ps1`）。 */
function carryNames(pack: TemplatePack, previousEncoded: string | null): TemplatePack {
  if (pack.names && pack.names.length > 0) return pack;
  if (!previousEncoded) return pack;
  try {
    const previous = decodePack(previousEncoded);
    if (previous.names && previous.names.length > 0) {
      return { ...pack, names: previous.names };
    }
  } catch {
    // 旧包损坏 → 只能不带名字指纹（识别降级，但不阻断）
  }
  return pack;
}

/**
 * 跑一次完整同步：图鉴 → 榜单 → 单英雄详情 → 头像模板（按需）。
 *
 * 阶段之间**互不阻断**：任何一个阶段失败都只记录到 `failures`，
 * 已成功写入的文件保持有效；全部失败时 `ok === false`。
 */
export async function runDataSync(options: SyncOptions): Promise<SyncReport> {
  const now = options.now ?? (() => new Date());
  const store = options.store;
  const root = options.storeRoot;
  const signal = options.signal;
  const report = (
    extra: Omit<SyncReport, 'fetchedAt' | 'counts' | 'wrote' | 'failures' | 'skipped' | 'templatesRebuilt'> & {
      readonly counts: SyncCounts;
      readonly wrote: readonly SyncFile[];
      readonly failures: readonly SyncFailure[];
      readonly skipped: readonly SyncSkip[];
      readonly templatesRebuilt: boolean;
    },
  ): SyncReport => ({ fetchedAt: now().toISOString(), ...extra });

  const failures: SyncFailure[] = [];
  const skipped: SyncSkip[] = [];
  const wrote: SyncFile[] = [];
  const counts: {
    augments: number;
    hextechs: number;
    champions: number;
    items: number;
    rankingAugments: number;
    rankingHeroes: number;
    details: number;
    templates: number;
  } = {
    augments: 0,
    hextechs: 0,
    champions: 0,
    items: 0,
    rankingAugments: 0,
    rankingHeroes: 0,
    details: 0,
    templates: 0,
  };

  const aborted = (): boolean => signal?.aborted === true;
  const emit = (progress: SyncProgress): void => options.onProgress?.(progress);

  // 旧文件：用于"空不覆盖"与模板重建判据
  const previousDataset = await store.readDataset(root).catch(() => null);
  const previousRankings = await store.readRankings(root).catch(() => null);
  const previousBuilds = await store.readBuilds(root).catch(() => null);
  const previousTemplates = await store.readTemplates(root).catch(() => null);

  let dataDate =
    previousRankings?.meta.dataDate ??
    previousBuilds?.meta.dataDate ??
    previousDataset?.meta.dataDate ??
    '';

  /* ---- 1. 静态图鉴 ---- */
  const datasets: Dataset[] = [];
  const staticTotal = options.staticProviders.length;
  for (let i = 0; i < staticTotal; i++) {
    if (aborted()) break;
    const provider = options.staticProviders[i]!;
    const label = `${provider.info.displayName}`;
    emit({ stage: 'static', label, done: i, total: staticTotal });
    try {
      const ds = await provider.load(signal);
      datasets.push(ds);
      emit({
        stage: 'static',
        label,
        done: i + 1,
        total: staticTotal,
        ok: true,
        message: `海克斯(cd) ${ds.augments.length} / 海克斯(cn) ${ds.hextechs.length} / 英雄 ${ds.champions.length} / 装备 ${ds.items.length}`,
      });
    } catch (err) {
      failures.push({ stage: 'static', label, message: errorText(err) });
      emit({
        stage: 'static',
        label,
        done: i + 1,
        total: staticTotal,
        ok: false,
        message: errorText(err),
      });
    }
  }

  let dataset: Dataset | null = null;
  if (datasets.length > 0) {
    const mergedStatic = mergeStaticDatasets(datasets, previousDataset);
    dataset = mergedStatic.dataset;
    if (datasetHasContent(dataset)) {
      await store.writeDataset(root, dataset);
      wrote.push('dataset');
      counts.augments = dataset.augments.length;
      counts.hextechs = dataset.hextechs.length;
      counts.champions = dataset.champions.length;
      counts.items = dataset.items.length;
      if (mergedStatic.backfilled.length > 0) {
        // ⚠️ 这几类内容这次**一个源都没给出来**（对应静态源失败，或上游返回空），
        //    已回退成旧文件里的那一份 —— 记成 failure，让"数据可能不完整"看得见。
        //    不记的话，失败源的那一半会被静默沿用，报告却显示一切正常。
        failures.push({
          stage: 'static',
          label: '静态图鉴合并',
          message: `${mergedStatic.backfilled.join(' / ')} 本次没有数据，沿用旧文件（未清空）`,
        });
      }
    } else {
      skipped.push({ stage: 'static', reason: '合并结果为空，保留现有图鉴' });
      dataset = null;
    }
  } else {
    skipped.push({
      stage: 'static',
      reason: aborted() ? '已取消，保留现有图鉴' : '所有静态源均失败，保留现有图鉴',
    });
  }

  /* ---- 2. 排行榜 ---- */
  if (!aborted()) {
    let snapshot: RankingSnapshot | null = null;
    const rankingTotal = options.rankingProviders.length;
    for (let i = 0; i < rankingTotal; i++) {
      if (aborted()) break;
      const provider = options.rankingProviders[i]!;
      const label = provider.info.displayName;
      emit({ stage: 'rankings', label, done: i, total: rankingTotal });
      try {
        snapshot = await provider.load(signal);
        emit({
          stage: 'rankings',
          label,
          done: i + 1,
          total: rankingTotal,
          ok: true,
          message: `海克斯榜 ${snapshot.augments.length} / 英雄榜 ${snapshot.heroes.length} 统计日期 ${snapshot.meta.dataDate || '未知'}`,
        });
      } catch (err) {
        failures.push({ stage: 'rankings', label, message: errorText(err) });
        emit({
          stage: 'rankings',
          label,
          done: i + 1,
          total: rankingTotal,
          ok: false,
          message: errorText(err),
        });
        snapshot = null;
      }
    }
    if (snapshot) {
      // 逐列表回退：两张榜来自两个独立接口，一边失败不许删掉另一边。
      const mergedRanking = mergeRankingSnapshot(snapshot, previousRankings);
      const next = mergedRanking.snapshot;
      if (next.augments.length > 0 || next.heroes.length > 0) {
        await store.writeRankings(root, next);
        wrote.push('rankings');
        counts.rankingAugments = next.augments.length;
        counts.rankingHeroes = next.heroes.length;
        dataDate = next.meta.dataDate || dataDate;
        if (mergedRanking.backfilled.length > 0) {
          failures.push({
            stage: 'rankings',
            label: '排行榜合并',
            message: `${mergedRanking.backfilled.join(' / ')} 本次为空，沿用旧榜单（未清空）`,
          });
        }
      } else {
        skipped.push({
          stage: 'rankings',
          reason: aborted() ? '已取消' : '上游无数据（维护中或未更新），保留现有榜单',
        });
      }
    } else {
      skipped.push({
        stage: 'rankings',
        reason: aborted() ? '已取消' : '所有排行榜源均失败，保留现有榜单',
      });
    }
  }

  /* ---- 3. 单英雄详情 ---- */
  const effectiveDataset = dataset ?? previousDataset;
  const championIds = effectiveDataset?.champions.map((c) => c.id) ?? [];
  if (!aborted()) {
    if (championIds.length === 0) {
      skipped.push({ stage: 'details', reason: '没有英雄列表（先同步图鉴）' });
    } else {
      const total = championIds.length;
      emit({ stage: 'details', label: '单英雄详情', done: 0, total });
      const fetchDetails = options.fetchDetails ?? fetchHeroDetails;
      const details = await fetchDetails(championIds, {
        concurrency: 6,
        signal,
        onProgress: (done, all) =>
          emit({ stage: 'details', label: '单英雄详情', done, total: all }),
      }).catch((err: unknown) => {
        failures.push({ stage: 'details', label: '单英雄详情', message: errorText(err) });
        return [] as readonly ChampionDetail[];
      });

      // 两条拒绝条件，文案分开：
      //   · 取消 —— 详情是逐条累计的，局部结果会用 50 个英雄覆盖掉完整的 173 个；
      //   · 覆盖率不足 —— 个别超时无所谓，但 60/173 这种大面积失败必须挡住
      //     （以前只要 `details.length > 0` 就写，等于把 113 个英雄的表静默删掉）。
      if (!aborted() && mayOverwriteDetails(details.length, total)) {
        const set: ChampionDetailSet = {
          meta: {
            source: 'tencent-hero-detail',
            dataDate: details[0]?.dataDate ?? '',
            fetchedAt: now().toISOString(),
            count: details.length,
          },
          details,
        };
        await store.writeBuilds(root, set);
        wrote.push('builds');
        counts.details = details.length;
        dataDate = set.meta.dataDate || dataDate;
        emit({
          stage: 'details',
          label: '单英雄详情',
          done: details.length,
          total,
          ok: true,
          message: `${details.length}/${total} 个英雄`,
        });
      } else {
        const reason = detailSkipReason({
          fetched: details.length,
          expected: total,
          aborted: aborted(),
        });
        skipped.push({ stage: 'details', reason });
        // 覆盖率不足属于"数据不完整"，要出现在报告里；取消是用户意图，不算失败。
        if (!aborted() && details.length > 0) {
          failures.push({ stage: 'details', label: '单英雄详情', message: reason });
        }
      }
    }
  }

  /* ---- 4. 头像模板（默认只在英雄集合变化时重建）---- */
  let templatesRebuilt = false;
  if (!aborted()) {
    const decision = decideTemplatesRebuild({
      hasExistingPack: previousTemplates !== null,
      previousChampionIds: previousDataset?.champions.map((c) => c.id) ?? [],
      nextChampionIds: championIds,
      force: options.forceTemplates === true,
    });
    if (!decision.rebuild) {
      skipped.push({ stage: 'templates', reason: decision.reason });
    } else {
      emit({ stage: 'templates', label: '头像模板', done: 0, total: championIds.length });
      const champions: TemplateChampion[] = (effectiveDataset?.champions ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        alias: c.alias,
        iconPath: c.iconPath,
      }));
      const build = options.buildTemplates ?? fetchTemplates;
      try {
        const pack = await build(champions, { signal });
        // ⚠️ `await` 之后**必须**再查一次取消：以前这里直接写盘，用户点取消也照样
        //    落一个残缺包（`fetchTemplates` 只在"一个都没成功"时抛错）。
        const required = templatesRequiredCount(champions.length);
        if (aborted()) {
          skipped.push({ stage: 'templates', reason: '已取消（不写残缺模板包）' });
        } else if (pack.count <= 0 || pack.count < required) {
          const reason =
            `只拿到 ${pack.count}/${champions.length} 个模板（低于 ${required} 个的下限，` +
            '保留现有模板包）';
          failures.push({ stage: 'templates', label: '头像模板', message: reason });
          skipped.push({ stage: 'templates', reason });
        } else {
          const encoded = (options.encodeTemplates ?? encodePack)(
            carryNames(pack, previousTemplates),
          );
          await store.writeTemplates(root, encoded);
          wrote.push('templates');
          counts.templates = pack.count;
          templatesRebuilt = true;
          emit({
            stage: 'templates',
            label: '头像模板',
            done: pack.count,
            total: champions.length,
            ok: true,
            message: `${pack.count} 个模板`,
          });
        }
      } catch (err) {
        failures.push({ stage: 'templates', label: '头像模板', message: errorText(err) });
        skipped.push({ stage: 'templates', reason: `重建失败：${errorText(err)}` });
      }
    }
  }

  return report({
    ok: wrote.length > 0,
    aborted: aborted(),
    wrote,
    failures,
    skipped,
    dataDate,
    counts,
    templatesRebuilt,
  });
}

/* ------------------------------------------------------------------ */
/* 默认装配（CLI 与应用的唯一接线方式）                                   */
/* ------------------------------------------------------------------ */

/**
 * 文件系统存储（生产用）。
 *
 * 注意这里的顺序不是随便写的：`write*` 全部是**原子写**（`.tmp` → rename），
 * 所以同步过程中应用随时可以从同一个目录读，永远读不到半截 JSON。
 */
export const fileSyncStore: SyncStore = {
  readDataset,
  readRankings,
  readBuilds,
  readTemplates,
  writeDataset,
  writeRankings,
  writeBuilds,
  writeTemplates,
};

export interface DefaultSyncOptions {
  readonly storeRoot: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: SyncProgress) => void;
  readonly forceTemplates?: boolean;
  /** 覆盖存储（单测用内存版）。 */
  readonly store?: SyncStore;
}

/**
 * 用**生产装配**跑一次同步：官方数据源 + 文件系统存储。
 *
 * 悬浮窗只调这个函数，不再自己拼 provider 列表 ——
 * 「接了哪些源」必须只有一处（`provider-registry`），否则应用与 CLI 会漂移。
 */
export async function runDefaultSync(options: DefaultSyncOptions): Promise<SyncReport> {
  return await runDataSync({
    storeRoot: options.storeRoot,
    store: options.store ?? fileSyncStore,
    staticProviders: createStaticProviders(),
    rankingProviders: createRankingProviders(),
    signal: options.signal,
    onProgress: options.onProgress,
    forceTemplates: options.forceTemplates,
  });
}
