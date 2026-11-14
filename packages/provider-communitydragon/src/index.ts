/**
 * CommunityDragon 静态数据源
 *
 * 上游：https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/
 * CommunityDragon 声明其数据基于 Riot 的 "Legal Jibber Jabber" 政策使用，
 * 属官方公开静态数据。
 *
 * ⚠️ 路径陷阱：
 *   locale 目录真实布局是 `global/<locale>/{content,v1}`。
 *   写成 `global/zh_cn/default/v1/...` 会 404 —— 不要照搬 `global/default/v1/`。
 */

import {
  fetchJsonWithRetry,
  type Augment,
  type AugmentMode,
  type AugmentRarity,
  type Champion,
  type Dataset,
  type HttpCache,
  type Item,
  type StaticProvider,
} from '@hexbox/core';

const DEFAULT_BASE =
  'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global';

/** CDragon 原始记录形状（仅声明我们实际使用的字段）。 */
interface RawAugment {
  id: number;
  augmentNameId: string;
  nameTRA?: string;
  simpleNameTRA?: string;
  augmentSmallIconPath?: string;
  rarity?: string;
}

interface RawAugmentList {
  augmentList: string[];
  modeName: string;
}

interface RawChampion {
  id: number;
  name: string;
  alias: string;
  roles?: string[];
  squarePortraitPath?: string;
}

interface RawItem {
  id: number;
  name: string;
  description?: string;
  price?: number;
  priceTotal?: number;
  iconPath?: string;
  categories?: string[];
}

export interface CommunityDragonOptions {
  /** 语言，默认 `zh_cn`。 */
  locale?: string;
  /** 覆盖基础地址（测试/镜像用）。 */
  baseUrl?: string;
  /** 自定义 fetch（测试注入用）。 */
  fetchImpl?: typeof fetch;
  /** 是否加载装备（items.json 约 666KB，可按需跳过）。 */
  includeItems?: boolean;
  /** 单次请求超时（ms，默认 15000；审查 P1：原实现没有超时）。 */
  timeoutMs?: number;
  /** 总尝试次数（默认 2 = 首次 + 1 次重试；5xx/429/网络错误才重试）。 */
  retryAttempts?: number;
  /** 重试等待（ms，默认 250；测试可调小）。 */
  retryDelayMs?: number;
  /** 条件请求缓存（可选；data-cli 传文件缓存时同 URL 不变则走 304）。 */
  httpCache?: HttpCache;
}

/** 单次请求超时（上游半开连接不能把整条同步挂死）。 */
const FETCH_TIMEOUT_MS = 15_000;
/** 总尝试次数（首次 + 1 次重试）。 */
const FETCH_ATTEMPTS = 2;
/** 重试等待。 */
const RETRY_DELAY_MS = 250;

const ALLOWED_RARITIES: readonly AugmentRarity[] = [
  'kSilver',
  'kGold',
  'kPrismatic',
  'kEventChoice',
];

const KNOWN_MODES: readonly AugmentMode[] = ['CHERRY', 'KIWI', 'KIWI_JADE'];

function parseRarity(raw: string | undefined): AugmentRarity {
  const found = ALLOWED_RARITIES.find((r) => r === raw);
  return found ?? 'kSilver';
}

/**
 * 从 `augment-lists.json` 建立 `augmentNameId -> modes[]` 索引。
 *
 * 注意：list 中的条目标识形如 `Maps/ModeSpecificData/Augments/ARAM_ADAPt`，
 * 需要取末段并与 `cherry-augments.json` 的 `augmentNameId` 匹配。
 * 但两侧命名并非总是严格相等（存在 ARAM_ 前缀有无的差异），
 * 因此做**归一化匹配**：去掉 `ARAM_` 前缀后比较。
 */
export function buildModeIndex(lists: readonly RawAugmentList[]): Map<string, AugmentMode[]> {
  const index = new Map<string, AugmentMode[]>();

  const normalize = (s: string): string =>
    s
      .replace(/^Maps\/ModeSpecificData\/Augments\//, '')
      .replace(/^ARAM_/i, '')
      .toLowerCase();

  for (const list of lists) {
    const mode = KNOWN_MODES.find((m) => m === list.modeName);
    if (!mode) continue; // 未知模式静默跳过，避免未来新增模式导致崩溃
    for (const entry of list.augmentList) {
      const key = normalize(entry);
      const bucket = index.get(key);
      if (bucket) {
        if (!bucket.includes(mode)) bucket.push(mode);
      } else {
        index.set(key, [mode]);
      }
    }
  }
  return index;
}

/** 把 CDragon 海克斯记录规范化为领域模型。 */
export function normalizeAugments(
  raws: readonly RawAugment[],
  modeIndex: Map<string, AugmentMode[]>,
): Augment[] {
  const normalize = (s: string): string => s.replace(/^ARAM_/i, '').toLowerCase();

  return raws.map((r) => ({
    id: r.id,
    augmentNameId: r.augmentNameId,
    name: r.nameTRA?.trim() || r.augmentNameId,
    simpleName: r.simpleNameTRA?.trim() ?? '',
    iconPath: r.augmentSmallIconPath ?? '',
    rarity: parseRarity(r.rarity),
    modes: modeIndex.get(normalize(r.augmentNameId)) ?? [],
  }));
}

export function normalizeChampions(raws: readonly RawChampion[]): Champion[] {
  return raws
    .filter((c) => c.id > 0) // id -1 是占位符「无」
    .map((c) => ({
      id: c.id,
      name: c.name,
      alias: c.alias,
      roles: c.roles ?? [],
      iconPath: c.squarePortraitPath ?? '',
    }));
}

export function normalizeItems(raws: readonly RawItem[]): Item[] {
  return raws.map((i) => ({
    id: i.id,
    name: i.name,
    description: i.description ?? '',
    price: i.price ?? 0,
    priceTotal: i.priceTotal ?? 0,
    iconPath: i.iconPath ?? '',
    categories: i.categories ?? [],
  }));
}

export function createCommunityDragonProvider(
  options: CommunityDragonOptions = {},
): StaticProvider {
  const locale = options.locale ?? 'zh_cn';
  const base = options.baseUrl ?? DEFAULT_BASE;
  const doFetch = options.fetchImpl ?? fetch;
  const includeItems = options.includeItems ?? true;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const attempts = Math.max(1, Math.floor(options.retryAttempts ?? FETCH_ATTEMPTS));
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;

  const url = (file: string): string => `${base}/${locale}/v1/${file}`;

  /**
   * 拉一个 JSON：共用 core 的 `fetchJsonWithRetry`（超时 + 有限重试 + 条件缓存）。
   *
   * 超时/重试语义见 `packages/core/src/json-fetch.ts`；这里只提供 URL、UA 与文案。
   */
  const getJson = async <T>(file: string, signal?: AbortSignal): Promise<T> =>
    await fetchJsonWithRetry<T>({
      url: url(file),
      label: `CommunityDragon ${file}`,
      fetchImpl: doFetch,
      headers: { 'user-agent': 'hexbox/0.1 (+https://github.com/)' },
      timeoutMs,
      retryAttempts: attempts,
      retryDelayMs,
      ...(signal !== undefined ? { signal } : {}),
      ...(options.httpCache !== undefined ? { cache: options.httpCache } : {}),
    });

  return {
    info: {
      id: 'communitydragon',
      displayName: 'CommunityDragon',
      dataClass: 'official-static',
      attribution: 'CommunityDragon（基于 Riot "Legal Jibber Jabber" 政策的官方公开静态数据）',
      upstream: `${base}/${locale}/v1/`,
    },

    async load(signal?: AbortSignal): Promise<Dataset> {
      const [rawAugments, rawLists, rawChampions, rawItems] = await Promise.all([
        getJson<RawAugment[]>('cherry-augments.json', signal),
        getJson<RawAugmentList[]>('augment-lists.json', signal),
        getJson<RawChampion[]>('champion-summary.json', signal),
        includeItems ? getJson<RawItem[]>('items.json', signal) : Promise.resolve([]),
      ]);

      return {
        meta: {
          source: 'communitydragon',
          patch: null, // CDragon 的 latest 路径不含补丁号；如需精确版本另取 version.json
          fetchedAt: new Date().toISOString(),
        },
        augments: normalizeAugments(rawAugments, buildModeIndex(rawLists)),
        champions: normalizeChampions(rawChampions),
        items: normalizeItems(rawItems),
        hextechs: [], // 国服口径图鉴由 provider-tencent 提供（见 mergeDatasets）
      };
    },
  };
}
