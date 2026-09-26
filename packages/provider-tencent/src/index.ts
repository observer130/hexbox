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
  type BuildItemStat,
  type ChampionAugmentStat,
  type ChampionBuild,
  type ChampionDetail,
  type Dataset,
  type HeroPartner,
  type HeroRankEntry,
  type HextechStatic,
  type RankingProvider,
  type RankingSnapshot,
  type SkillOrder,
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
/* 单英雄海斗详情解析                                                  */
/* ------------------------------------------------------------------ */

/** `fuwen_hero_rank` 的返回形状（我们实际使用的字段）。 */
export interface RawHeroDetail {
  dtstatdate?: string;
  /** `排名|英雄ID|海克斯ID|等级|登场率|强度`，`#` 分隔。 */
  augment_json_irank?: string;
  /** JSON：`{"1":{"itemone":"123430","winrate":6033,"showrate":6758}}`（万分比）。 */
  itemone_json?: string;
  /** JSON：`{"1":{"itemcore":"a&b&c","winrate":6172,"showrate":699}}`。 */
  itemcore_json?: string;
  /** `itemIds$登场率$胜率`，`#` 分隔（出门装组合）。 */
  itemout?: string;
  /** `itemId$登场率$胜率`，`#` 分隔。 */
  itemshoes?: string;
  /** `排名_六件_登场率_胜率`，`;` 分隔（成型六件套）。 */
  itemover_rec?: string;
  /** `英雄ID|胜率|登场率|排名`，`#` 分隔。 */
  championid_json?: string;
  /** JSON：`{"1":{"qwe":"1&3&2","sk_s":"1312","sk_w":"5578","sks":{...}}}`。 */
  skill_json?: string;
}

/**
 * 解析该英雄的海克斯强度表（`augment_json_irank`）。
 *
 * ⚠️ 上游格式**带稀有度分组**，不是单一平铺列表：
 *
 *   `255:1|157|1077|255|0.2452|S#2|157|1336|255|0.2105|S#…`
 *    `└组头┘ └─────── 第 1 条 ───────┘└── 第 2 条（省略组头）──┘
 *    `…&kGold:1|157|1077|kGold|0.2452|S#2|…`
 *
 * 即：组头为 `<组名>:<排名>|…`，同组后续条目省略组名，仅 `<排名>|…`。
 * 组名 `255` 表示「全部品质」（页面默认页签，亚索 126 条）；
 * `kGold`/`kPrismatic`/`kSilver` 为各品质分组。
 *
 * 字段：`排名|英雄ID|海克斯ID|等级|登场率|强度`
 * 注意第 5 列是**登场率**，不是胜率。
 *
 * @param raw     上游原始串
 * @param groupBy 要取的分组；默认 `255`（全部品质）。
 *                传 'all-groups' 可拿到去重后的全部条目。
 */
export function parseChampionAugments(
  raw: string | undefined,
  groupBy: string = '255',
): ChampionAugmentStat[] {
  if (!raw) return [];

  interface Row extends ChampionAugmentStat {
    readonly group: string;
  }
  const rows: Row[] = [];

  for (const seg of raw.split('&')) {
    // 每个 & 分段是一个品质组；段内以 # 分隔条目
    for (const block of seg.split('#')) {
      if (!block) continue;
      const f = block.split('|');
      if (f.length < 6) continue;

      // 组头形如 `255:1`（第 0 列含冒号）；否则沿用上一个组名
      let group = rows.length > 0 ? rows[rows.length - 1]!.group : '255';
      let rankField = f[0] ?? '';
      const colon = rankField.indexOf(':');
      if (colon >= 0) {
        group = rankField.slice(0, colon);
        rankField = rankField.slice(colon + 1);
      }

      const rank = toInt(rankField, -1);
      const augmentId = toInt(f[2], -1);
      if (rank <= 0 || augmentId <= 0) continue;

      rows.push({
        group,
        rank,
        augmentId,
        level: (f[3] ?? '').trim(),
        pickRate: toNum(f[4]),
        tier: (f[5] ?? '').trim(),
      });
    }
  }

  const picked =
    groupBy === 'all-groups' ? rows : rows.filter((r) => r.group === groupBy);

  // 同一分组内按 augmentId 去重（上游偶有重复），保留排名靠前者
  const best = new Map<number, Row>();
  for (const r of picked) {
    const prev = best.get(r.augmentId);
    if (!prev || r.rank < prev.rank) best.set(r.augmentId, r);
  }

  return [...best.values()]
    .map(({ group: _group, ...rest }) => rest)
    .sort((a, b) => a.rank - b.rank);
}

/**
 * 解析 `itemshoes` / `itemout` 系列（`itemIds$登场率$胜率`，`#` 分隔）。
 *
 * 注意顺序是**登场率在前、胜率在后**（与 `itemone_json` 的字段名一致）。
 */
export function parseItemStatList(raw: string | undefined): BuildItemStat[] {
  if (!raw) return [];
  const out: BuildItemStat[] = [];
  for (const block of raw.split('#')) {
    if (!block) continue;
    const f = block.split('$');
    if (f.length < 3) continue;
    const itemIds = (f[0] ?? '')
      .split(',')
      .map((x) => toInt(x, -1))
      .filter((x) => x > 0);
    if (itemIds.length === 0) continue;
    out.push({ itemIds, pickRate: toNum(f[1]), winRate: toNum(f[2]) });
  }
  return out;
}

/**
 * 解析 `itemone_json` / `itemcore_json` 系列（JSON，比率为**万分比**）。
 *
 * 万分比换算：6033 → 0.6033。上游用整数规避浮点，我们必须还原。
 */
export function parseItemStatJson(
  raw: string | undefined,
  key: 'itemone' | 'itemcore',
): BuildItemStat[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // 脏数据不应拖垮整个详情
  }
  if (typeof parsed !== 'object' || parsed === null) return [];

  const out: BuildItemStat[] = [];
  for (const v of Object.values(parsed as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue;
    const rec = v as Record<string, unknown>;
    const idStr = String(rec[key] ?? '');
    if (!idStr) continue;
    const itemIds = idStr
      .split(/[&,]/)
      .map((x) => toInt(x, -1))
      .filter((x) => x > 0);
    if (itemIds.length === 0) continue;
    out.push({
      itemIds,
      winRate: toInt(String(rec['winrate'] ?? ''), 0) / 10_000,
      pickRate: toInt(String(rec['showrate'] ?? ''), 0) / 10_000,
    });
  }
  // 按登场率降序：玩家最该先看到最常被采用的方案
  return out.sort((a, b) => b.pickRate - a.pickRate);
}

/** 解析出装（汇总五个上游字段）。 */
export function parseChampionBuild(raw: RawHeroDetail): ChampionBuild {
  return {
    start: parseItemStatJson(raw.itemone_json, 'itemone'),
    shoes: parseItemStatList(raw.itemshoes),
    core: parseItemStatJson(raw.itemcore_json, 'itemcore'),
    // 出门装组合（如「灵巧披风+增幅典籍」），与 itemone 的单件不同
    startCombo: parseItemStatList(raw.itemout),
    // 完整六件套（上游 itemover_rec，`排名_6件_登场率_胜率`，`;` 分隔）
    full: parseItemOverRec(raw.itemover_rec),
  };
}

/**
 * 解析完整六件套（`itemover_rec`）。
 *
 * 格式：`排名_装备1,装备2,…,装备6_登场率_胜率`，条目以 `;` 分隔。
 * 与 `itemout` 的区别：`itemout` 是**出门装**组合，本字段是**成型六件套**。
 */
export function parseItemOverRec(raw: string | undefined): BuildItemStat[] {
  if (!raw) return [];
  const out: BuildItemStat[] = [];
  for (const block of raw.split(';')) {
    if (!block) continue;
    const f = block.split('_');
    if (f.length < 4) continue;
    const itemIds = (f[1] ?? '')
      .split(',')
      .map((x) => toInt(x, -1))
      .filter((x) => x > 0);
    if (itemIds.length === 0) continue;
    out.push({ itemIds, pickRate: toNum(f[2]), winRate: toNum(f[3]) });
  }
  return out.sort((a, b) => b.pickRate - a.pickRate);
}

/** 解析最佳拍档（`英雄ID|胜率|登场率|排名`，`#` 分隔）。 */
export function parseChampionPartners(raw: string | undefined): HeroPartner[] {
  if (!raw) return [];
  const out: HeroPartner[] = [];
  for (const block of raw.split('#')) {
    if (!block) continue;
    const f = block.split('|');
    if (f.length < 4) continue;
    const championId = toInt(f[0], -1);
    if (championId <= 0) continue;
    out.push({
      championId,
      winRate: toNum(f[1]),
      pickRate: toNum(f[2]),
      rank: toInt(f[3]),
    });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

/**
 * 解析技能加点（`skill_json`，最多保留前 3 套方案）。
 *
 * ⚠️ `sk_s` / `sk_w` 是**原始计数**（如 1312 / 5578），不是 0..1 比率。
 * 登场率需用 `sk_w`（该方案总场次）作为分母换算：`sk_s / sk_w`。
 * 直接当比率用会得到 131200% 这种荒谬数字。
 */
export function parseSkillOrders(raw: string | undefined, limit = 3): SkillOrder[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];

  const nums = (s: unknown): number[] =>
    String(s ?? '')
      .split('&')
      .map((x) => toInt(x, -1))
      .filter((x) => x > 0 && x <= 4);

  /** 由 sk_s / sk_w 两个原始计数算出登场率。 */
  const ratio = (s: unknown, w: unknown): number => {
    const pick = toInt(String(s ?? ''), 0);
    const total = toInt(String(w ?? ''), 0);
    if (total <= 0 || pick < 0) return 0;
    return pick / total;
  };

  const out: SkillOrder[] = [];
  for (const v of Object.values(parsed as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue;
    const rec = v as Record<string, unknown>;
    // 取该方案下登场率最高的加点序列
    const subs = rec['sks'];
    let bestOrder: number[] = [];
    let bestRatio = -1;
    if (typeof subs === 'object' && subs !== null) {
      for (const s of Object.values(subs as Record<string, unknown>)) {
        if (typeof s !== 'object' || s === null) continue;
        const sr = s as Record<string, unknown>;
        const r = ratio(sr['sk_s'], sr['sk_w']);
        if (r > bestRatio) {
          bestRatio = r;
          bestOrder = nums(sr['sk']);
        }
      }
    }
    out.push({
      priority: nums(rec['qwe']),
      order: bestOrder,
      pickRate: bestRatio > 0 ? bestRatio : 0,
    });
  }
  return out.sort((a, b) => b.pickRate - a.pickRate).slice(0, limit);
}

/** 把 `fuwen_hero_rank` 的返回解析为 ChampionDetail。 */
export function parseChampionDetail(
  championId: number,
  raw: RawHeroDetail,
): ChampionDetail {
  return {
    championId,
    augments: parseChampionAugments(raw.augment_json_irank),
    build: parseChampionBuild(raw),
    skills: parseSkillOrders(raw.skill_json),
    partners: parseChampionPartners(raw.championid_json),
    dataDate: raw.dtstatdate ?? '',
  };
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

/* ------------------------------------------------------------------ */
/* 单英雄海斗详情：拉取                                                */
/* ------------------------------------------------------------------ */

export const HERO_DETAIL_URL =
  'https://mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_hero_rank';

export interface HeroDetailOptions {
  /** 覆盖详情地址（测试用）。 */
  detailUrl?: string;
  /** 自定义 fetch（测试注入用）。 */
  fetchImpl?: typeof fetch;
  /** 并发度（预抓 245 个英雄时用，默认 6）。 */
  concurrency?: number;
  /** 进度回调（预抓时打印进度）。 */
  onProgress?: (done: number, total: number) => void;
}

/**
 * 拉取单个英雄的海斗详情。
 *
 * 上游地址：`fuwen_hero_rank?championid=<id>`
 * （注意与全局榜 `fuwen_aram_hero_rank_v2` 是两个不同接口）
 *
 * 失败时返回 null 而不是抛错 —— 预抓 245 个英雄时，
 * 个别英雄无数据/网络抖动不应让整批失败。
 */
export async function fetchHeroDetail(
  championId: number,
  options: HeroDetailOptions = {},
): Promise<ChampionDetail | null> {
  const url = options.detailUrl ?? HERO_DETAIL_URL;
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${url}?championid=${championId}`, {
      headers: { 'user-agent': DEFAULT_UA },
    });
    if (!res.ok) return null;
    const fieldValue = extractFieldValue(await res.json());
    if (!fieldValue) return null;
    const value = unwrapValue(fieldValue);
    if (typeof value !== 'object' || value === null) return null;
    const detail = parseChampionDetail(championId, value as RawHeroDetail);
    // 完全无内容的条目视为无数据
    if (
      detail.augments.length === 0 &&
      detail.build.start.length === 0 &&
      detail.build.core.length === 0
    ) {
      return null;
    }
    return detail;
  } catch {
    return null;
  }
}

/**
 * 批量预抓多个英雄的详情（供 `pnpm sync` 落盘）。
 *
 * 用**有上限的并发**而不是 Promise.all 全发：245 个请求同时打上游
 * 既容易被限流，也无谓占满连接。默认并发 6。
 */
export async function fetchHeroDetails(
  championIds: readonly number[],
  options: HeroDetailOptions = {},
): Promise<ChampionDetail[]> {
  const concurrency = Math.max(1, options.concurrency ?? 6);
  const out: ChampionDetail[] = [];
  let done = 0;
  let idx = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = idx++;
      if (i >= championIds.length) return;
      const id = championIds[i]!;
      const d = await fetchHeroDetail(id, options);
      if (d) out.push(d);
      done++;
      options.onProgress?.(done, championIds.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, championIds.length) }, worker));
  // 并发完成顺序不定，按英雄 ID 排序保证落盘稳定（便于 diff）
  return out.sort((a, b) => a.championId - b.championId);
}
