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
    dataset = mergeDatasets(datasets);
    if (datasetHasContent(dataset)) {
      await store.writeDataset(root, dataset);
      wrote.push('dataset');
      counts.augments = dataset.augments.length;
      counts.hextechs = dataset.hextechs.length;
      counts.champions = dataset.champions.length;
      counts.items = dataset.items.length;
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
    if (snapshot && (snapshot.augments.length > 0 || snapshot.heroes.length > 0)) {
      await store.writeRankings(root, snapshot);
      wrote.push('rankings');
      counts.rankingAugments = snapshot.augments.length;
      counts.rankingHeroes = snapshot.heroes.length;
      dataDate = snapshot.meta.dataDate || dataDate;
    } else {
      skipped.push({
        stage: 'rankings',
        reason: aborted() ? '已取消' : '上游无数据（维护中或未更新），保留现有榜单',
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

      // 取消时**不写**：详情是逐条累计的，局部结果会用 50 个英雄覆盖掉完整的 173 个
      if (details.length > 0 && !aborted()) {
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
        skipped.push({
          stage: 'details',
          reason: aborted() ? '已取消（详情不完整，不覆盖旧文件）' : '全部失败，保留现有英雄详情',
        });
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
