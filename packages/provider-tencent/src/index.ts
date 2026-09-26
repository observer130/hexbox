/**
 * 腾讯国服一方数据源 (provider-tencent)
 *
 * 来源（均为运营方官方公开渠道）：
 *   1. 海克斯图鉴（official-static）：
 *      https://game.gtimg.cn/images/lol/act/img/js/kiwi/kiwi_augments.json
 *      101.qq.com 官方数据站自身使用的图鉴数据：官方数字 ID（1001+）、
 *      中文名、官方 tooltip、官方图标直链、模式池、稀有度。
 *   2. 排行榜（official-aggregated）：
 *      https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_aram_rune_rank_v2
 *      https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_aram_hero_rank_v2
 *      101.qq.com「海克斯乱斗排行」页面的后端接口（其前端 ZMSERVICE 即
 *      mlol.qt.qq.com）。解析规格照抄官方站 bundle 中的 parseRuneRank /
 *      parseHeroRank，不猜测、不逆向其他内容。
 *
 * 解析失败策略：排行榜数据是「脏字符串」——始终 try/catch 返回
 * 已解析的部分，绝不让单条脏数据拖垮整个快照。
 */

import {
  type AugmentMode,
  type AugmentRarity,
  type AugmentRankEntry,
  type Dataset,
  type HeroPartner,
  type HeroRankEntry,
  type HextechStatic,
  type RankingProvider,
  type RankingSnapshot,
  type StaticProvider,
} from '@hexbox/core';

/* ------------------------------------------------------------------ */
/* 上游地址                                                            */
/* ------------------------------------------------------------------ */

export const KIWI_AUGMENTS_URL =
  'https://game.gtimg.cn/images/lol/act/img/js/kiwi/kiwi_augments.json';

export const RUNE_RANK_URL =
  'https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_aram_rune_rank_v2';

export const HERO_RANK_URL =
  'https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_aram_hero_rank_v2';

/* ------------------------------------------------------------------ */
/* 原始数据形状                                                        */
/* ------------------------------------------------------------------ */

/** `kiwi_augments.json` 原始条目。 */
export interface RawKiwiAugment {
  augmentID: number;
  name_en: string;
  name_cn: string;
  /** 如 `KIWI, KIWI_JADE`；空串视为不属于已知模式池。 */
  mode?: string;
  level?: string;
  isPBE?: number;
  isNew?: number;
  tooltip?: string;
  large_Icon?: string;
  small_Icon?: string;
}

/** `fuwen_aram_rune_rank_v2` 外层（qq 常见封装）。 */
export interface RawFieldValues {
  data?: { _fieldValues?: Record<string, string> };
}

/* ------------------------------------------------------------------ */
/* 共用工具                                                            */
/* ------------------------------------------------------------------ */

const KNOWN_MODES: readonly AugmentMode[] = ['CHERRY', 'KIWI', 'KIWI_JADE'];

const ALLOWED_RARITIES: readonly AugmentRarity[] = [
  'kSilver',
  'kGold',
  'kPrismatic',
  'kEventChoice',
];

function parseRarity(raw: string | undefined): AugmentRarity {
  const found = ALLOWED_RARITIES.find((r) => r === raw);
  return found ?? 'kSilver';
}

function parseModes(raw: string | undefined): AugmentMode[] {
  if (!raw) return [];
  const out: AugmentMode[] = [];
  for (const part of raw.split(',')) {
    const m = part.trim() as AugmentMode;
    if (KNOWN_MODES.includes(m) && !out.includes(m)) out.push(m);
  }
  return out;
}

function toNum(raw: string | undefined, fallback = 0): number {
  const n = Number.parseFloat(raw ?? '');
  return Number.isFinite(n) ? n : fallback;
}

function toInt(raw: string | undefined, fallback = 0): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 官方站 rank_change_desc 解析：「上升3位」→ +3，「下降2位」→ -2，「未变化」→ 0。 */
export function parseRankChange(desc: string | undefined): number {
  const s = (desc ?? '').trim();
  if (!s || s === '未变化') return 0;
  const m = s.match(/(上升|下降)(\d+)位/);
  if (!m) return 0;
  const n = Number.parseInt(m[2] ?? '0', 10);
  return m[1] === '上升' ? n : -n;
}

/**
 * 从 `data._fieldValues` 中取出「有内容的值」。
 *
 * 该接口的返回形如 `{ code:0, data:{ _fieldValues:{ R15381:"..." } } }`，
 * key（如 R15381）是服务端字段代号且会变化，因此按「值最长者」取，
 * 与官方站 `et()` 取值逻辑等价。
 */
export function extractFieldValue(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const data = (payload as RawFieldValues).data;
  const values = data?._fieldValues;
  if (typeof values !== 'object' || values === null) return null;
  let best: string | null = null;
  for (const v of Object.values(values)) {
    if (typeof v === 'string' && v.length > 0 && (best === null || v.length > best.length)) {
      best = v;
    }
  }
  return best;
}

/**
 * 字段值本身可能是「双重 JSON 字符串」（值为一段 JSON 文本），
 * 解出其中的统计字段；失败则把原值当作统计字段本身。
 */
function unwrapValue(fieldValue: string): unknown {
  const trimmed = fieldValue.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      /* fallthrough */
    }
  }
  return fieldValue;
}

/* ------------------------------------------------------------------ */
/* 海克斯图鉴（official-static）                                       */
/* ------------------------------------------------------------------ */

/** 把 kiwi_augments.json 条目规范化为 HextechStatic。 */
export function normalizeKiwiAugments(raws: readonly RawKiwiAugment[]): HextechStatic[] {
  return raws
    .filter((r) => Number.isFinite(r.augmentID) && r.augmentID > 0 && !r.isPBE)
    .map((r) => ({
      id: r.augmentID,
      augmentNameId: r.name_en,
      name: r.name_cn?.trim() || r.name_en,
      tooltip: r.tooltip?.trim() ?? '',
      rarity: parseRarity(r.level),
      modes: parseModes(r.mode),
      largeIcon: r.large_Icon ?? '',
      smallIcon: r.small_Icon ?? '',
      isNew: r.isNew === 1,
    }));
}

/**
 * ID 桥：国服数字 ID ↔ CDragon augmentNameId。
 *
 * 两套官方 ID 不能直接换算（106/248 数字冲突），只能按归一化名称对齐
 * （去 `ARAM_` 前缀、小写）。排行榜条目经此桥取得 CDragon 口径信息。
 */
export function buildIdBridge(
  hextechs: readonly HextechStatic[],
): Map<number, string> {
  const bridge = new Map<number, string>();
  for (const h of hextechs) bridge.set(h.id, h.augmentNameId);
  return bridge;
}

/** 归一化 augmentNameId（与 provider-communitydragon 的对齐规则一致）。 */
export function normalizeAugmentNameId(nameId: string): string {
  return nameId.replace(/^ARAM_/i, '').toLowerCase();
}

/* ------------------------------------------------------------------ */
/* 排行榜解析（official-aggregated）                                    */
/* ------------------------------------------------------------------ */

/**
 * 解析海克斯榜 augmentlist。
 *
 * 官方规格（照抄 101 站 parseRuneRank）：
 *   条目以 `#` 分隔，字段以 `_` 分隔：
 *   [0]augment_id [1]augment_level [2]pick_rate [3]pick_rank
 *   [4]pick_rank_change [5]win_rate [6]win_rank [7]win_rank_change
 *   [8]bestHeroes（逗号分隔 championId）
 */
export function parseAugmentRankList(raw: string | null): AugmentRankEntry[] {
  if (!raw) return [];
  const value = unwrapValue(raw);
  let listStr: string;
  if (typeof value === 'object' && value !== null && 'augmentlist' in value) {
    listStr = String((value as { augmentlist?: unknown }).augmentlist ?? '');
  } else {
    listStr = raw;
  }
  if (!listStr) return [];

  const entries: AugmentRankEntry[] = [];
  for (const block of listStr.split('#')) {
    if (!block) continue;
    try {
      const s = block.split('_');
      if (s.length < 8) continue;
      const id = toInt(s[0], -1);
      if (id <= 0) continue;
      const bestHeroes =
        s[8]
          ?.split(',')
          .map((x) => toInt(x, -1))
          .filter((x) => x > 0) ?? [];
      entries.push({
        id,
        level: toInt(s[1]),
        pickRate: toNum(s[2]),
        pickRank: toInt(s[3]),
        pickRankChange: toInt(s[4]),
        winRate: toNum(s[5]),
        winRank: toInt(s[6]),
        winRankChange: toInt(s[7]),
        bestHeroes,
      });
    } catch {
      // 单条脏数据不影响整体
    }
  }
  return entries;
}

/**
 * 解析英雄榜 listcollect。
 *
 * 官方规格（照抄 101 站 parseHeroRank）：
 *   条目以 `#` 分隔，字段以 `_` 分隔：
 *   [0]heroId [1]rank [2]rank_change_desc [3]win_rate [4]pick_rate
 *   [5]best_partner_top50（`&` 分隔，每组 `id,pickRate,winRate,rank`）
 *   [6]avg_death_time [7]avg_participation_rate [8]avg_damage_ratio
 *   [9]avg_tank_ratio [10]lowest_rank_runes（海克斯统计，本侧**不采集**）
 */
export function parseHeroRankList(raw: string | null): HeroRankEntry[] {
  if (!raw) return [];
  const value = unwrapValue(raw);
  let listStr: string;
  if (typeof value === 'object' && value !== null && 'listcollect' in value) {
    listStr = String((value as { listcollect?: unknown }).listcollect ?? '');
  } else {
    listStr = raw;
  }
  if (!listStr) return [];

  const entries: HeroRankEntry[] = [];
  for (const block of listStr.split(/[#|]/)) {
    if (!block) continue;
    try {
      const s = block.split('_');
      if (s.length < 5) continue;
      const championId = toInt(s[0], -1);
      if (championId <= 0) continue;
      const partners: HeroPartner[] = [];
      const partnerRaw = s[5];
      if (partnerRaw) {
        for (const p of partnerRaw.split('&')) {
          const f = p.split(',');
          if (f.length < 4) continue;
          const pid = toInt(f[0], -1);
          if (pid <= 0) continue;
          partners.push({
            championId: pid,
            pickRate: toNum(f[1]),
            winRate: toNum(f[2]),
            rank: toInt(f[3]),
          });
          if (partners.length >= 5) break; // 官方站取前 50；本侧只存前 5
        }
      }
      entries.push({
        championId,
        rank: toInt(s[1]),
        rankChangeDesc: (s[2] ?? '').trim(),
        rankChange: parseRankChange(s[2]),
        winRate: toNum(s[3]),
        pickRate: toNum(s[4]),
        bestPartners: partners,
        avgDeathTime: toNum(s[6]),
        avgParticipationRate: toNum(s[7]),
        avgDamageRatio: toNum(s[8]),
        avgTankRatio: toNum(s[9]),
      });
    } catch {
      // 单条脏数据不影响整体
    }
  }
  return entries;
}

/** 解析上游 dtstatdate（形如 `20260924`）。 */
export function parseDataDate(raw: string | null): string {
  if (!raw) return '';
  const value = unwrapValue(raw);
  if (typeof value === 'object' && value !== null && 'dtstatdate' in value) {
    return String((value as { dtstatdate?: unknown }).dtstatdate ?? '');
  }
  const m = raw.match(/(\d{8})/);
  return m?.[1] ?? '';
}

/* ------------------------------------------------------------------ */
/* Provider 工厂                                                      */
/* ------------------------------------------------------------------ */

export interface TencentOptions {
  /** 覆盖图鉴地址（测试用）。 */
  augmentsUrl?: string;
  /** 覆盖海克斯榜地址（测试用）。 */
  runeRankUrl?: string;
  /** 覆盖英雄榜地址（测试用）。 */
  heroRankUrl?: string;
  /** 自定义 fetch（测试注入用）。 */
  fetchImpl?: typeof fetch;
  /** 排行榜统计日期（YYYYMMDD）；默认自动回退最近 5 天找有数据的一天。 */
  statDate?: string;
}

const DEFAULT_UA = 'hexbox/0.2 (+https://github.com/)';

/** 构造腾讯一方静态图鉴 provider（并入 Dataset.hextechs）。 */
export function createTencentStaticProvider(options: TencentOptions = {}): StaticProvider {
  const url = options.augmentsUrl ?? KIWI_AUGMENTS_URL;
  const doFetch = options.fetchImpl ?? fetch;

  const getJson = async <T>(u: string, signal?: AbortSignal): Promise<T> => {
    const res = await doFetch(u, { signal, headers: { 'user-agent': DEFAULT_UA } });
    if (!res.ok) throw new Error(`腾讯图鉴请求失败: HTTP ${res.status}`);
    return (await res.json()) as T;
  };

  return {
    info: {
      id: 'tencent-static',
      displayName: '腾讯一方图鉴',
      dataClass: 'official-static',
      attribution: '腾讯官方 CDN（game.gtimg.cn，101.qq.com 数据站在用）',
      upstream: url,
    },

    async load(signal?: AbortSignal): Promise<Dataset> {
      const raws = await getJson<RawKiwiAugment[]>(url, signal);
      const hextechs = normalizeKiwiAugments(raws);
      return {
        meta: {
          source: 'tencent-static',
          patch: null,
          fetchedAt: new Date().toISOString(),
        },
        augments: [],
        champions: [],
        items: [],
        hextechs,
      };
    },
  };
}

/**
 * 构造腾讯一方排行榜 provider（official-aggregated）。
 *
 * 数据日期策略：默认 T-1 起向前尝试 5 天，取第一个「有数据」的日期 ——
 * 与官方站「统计滞后一天、节假日可能缺天」的行为一致。
 */
export function createTencentRankingProvider(options: TencentOptions = {}): RankingProvider {
  const runeUrl = options.runeRankUrl ?? RUNE_RANK_URL;
  const heroUrl = options.heroRankUrl ?? HERO_RANK_URL;
  const doFetch = options.fetchImpl ?? fetch;
  const statDates = options.statDate ? [options.statDate] : fallbackStatDates();

  const getFieldValue = async (u: string, signal?: AbortSignal): Promise<string | null> => {
    const res = await doFetch(u, { signal, headers: { 'user-agent': DEFAULT_UA } });
    if (!res.ok) throw new Error(`腾讯排行榜请求失败: HTTP ${res.status}`);
    return extractFieldValue(await res.json());
  };

  return {
    info: {
      id: 'tencent-rankings',
      displayName: '腾讯 101 数据站',
      dataClass: 'official-aggregated',
      attribution: '腾讯 101 官方数据站（101.qq.com，运营方一方公开数据）',
      upstream: runeUrl,
    },

    async load(signal?: AbortSignal): Promise<RankingSnapshot> {
      let lastErr: unknown = null;
      for (const date of statDates) {
        try {
          const [runeRaw, heroRaw] = await Promise.all([
            getFieldValue(`${runeUrl}?augmentid_level=255&dtstatdate=${date}`, signal),
            getFieldValue(`${heroUrl}?dtstatdate=${date}`, signal),
          ]);
          const augments = parseAugmentRankList(runeRaw);
          const heroes = parseHeroRankList(heroRaw);
          if (augments.length === 0 && heroes.length === 0) {
            lastErr = new Error(`暂无数据 (dtstatdate=${date})`);
            continue; // 该日期无数据（维护/滞后），尝试更早一天
          }
          return {
            meta: {
              source: 'tencent-rankings',
              dataDate: parseDataDate(runeRaw) || date,
              fetchedAt: new Date().toISOString(),
            },
            augments,
            heroes,
          };
        } catch (err) {
          lastErr = err;
        }
      }
      // 所有日期均失败：返回空快照（诚实降级），不冒充数据。
      if (lastErr !== null) {
        console.warn(`[provider-tencent] 排行榜拉取失败: ${String(lastErr)}`);
      }
      return {
        meta: {
          source: 'tencent-rankings',
          dataDate: '',
          fetchedAt: new Date().toISOString(),
        },
        augments: [],
        heroes: [],
      };
    },
  };
}

/** 近 5 天（T-1 起）的候选统计日期，格式 YYYYMMDD。 */
function fallbackStatDates(): string[] {
  return Array.from({ length: 5 }, (_, i) => {
    const d = new Date(Date.now() - (i + 1) * 86_400_000);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  });
}
