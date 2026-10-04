/**
 * 领域模型：英雄联盟「海克斯乱斗」助手
 *
 * 术语对照：
 *   CHERRY     = 斗魂竞技场 (Arena)
 *   KIWI       = 海克斯乱斗
 *   KIWI_JADE  = 海克斯乱斗 (Jade 变体)
 *
 * ID 体系说明（重要）：
 *   - 海克斯存在两套官方 ID：
 *     · CDragon 数字 ID（如 1205，来自 cherry-augments.json 的 id 字段）
 *     · 国服官方数字 ID（如 1001，来自腾讯一方 kiwi_augments.json 的 augmentID）
 *     两套 ID **不能互相换算**，按归一化 augmentNameId 对齐（见
 *     provider-tencent 的 buildIdBridge）。海克斯排行榜使用国服 ID。
 *   - 英雄 ID 全生态一致（championId），排行榜直接可用。
 */

/** 海克斯（强化符文）稀有度。kEventChoice 为事件抉择类，非三选一池。 */
export type AugmentRarity = 'kSilver' | 'kGold' | 'kPrismatic' | 'kEventChoice';

/** Riot 内部模式代号。 */
export type AugmentMode = 'CHERRY' | 'KIWI' | 'KIWI_JADE';

/**
 * 海克斯静态定义（来源：CommunityDragon `cherry-augments.json`）。
 *
 * 这是官方公开的静态数据，不含统计信息。
 */
export interface Augment {
  /** 官方数字 ID（CDragon 口径）。 */
  readonly id: number;
  /** 内部名称标识，如 `ARAM_ADAPt`。 */
  readonly augmentNameId: string;
  /** 本地化名称 key（中文取自 zh_cn 数据源）。 */
  readonly name: string;
  readonly simpleName: string;
  /** 图标路径，如 `/lol-game-data/assets/.../ADAPt_small.png`。 */
  readonly iconPath: string;
  readonly rarity: AugmentRarity;
  /** 该海克斯所属的模式池，来源于 `augment-lists.json`。 */
  readonly modes: readonly AugmentMode[];
}

/**
 * 海克斯静态定义（国服口径，来源：腾讯一方 CDN `kiwi_augments.json`）。
 *
 * 与 CDragon 口径的差异：带官方数字 ID、中文描述与官方图标直链。
 * 排行榜（fuwen_aram_rune_rank_v2）的 augment_id 即此处的 id。
 */
export interface HextechStatic {
  /** 国服官方数字 ID（1001+，排行榜使用此 ID）。 */
  readonly id: number;
  /** 内部名称标识，如 `ARAM_ImTheJuggernaut`。 */
  readonly augmentNameId: string;
  readonly name: string;
  readonly tooltip: string;
  readonly rarity: AugmentRarity;
  /** 模式池，如 `KIWI, KIWI_JADE`（上游为逗号分隔字符串）。 */
  readonly modes: readonly AugmentMode[];
  /** 大/小图标（官方 CDN 直链）。 */
  readonly largeIcon: string;
  readonly smallIcon: string;
  /** 上游标记是否新海克斯。 */
  readonly isNew: boolean;
}

/** 英雄摘要（来源：CommunityDragon `champion-summary.json`）。 */
export interface Champion {
  readonly id: number;
  readonly name: string;
  readonly alias: string;
  readonly roles: readonly string[];
  readonly iconPath: string;
}

/** 装备（来源：CommunityDragon `items.json`）。 */
export interface Item {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly price: number;
  readonly priceTotal: number;
  readonly iconPath: string;
  readonly categories: readonly string[];
}

/**
 * 数据集元信息 —— 用于版本追踪与缓存失效。
 */
export interface DatasetMeta {
  /** 数据源标识，如 `communitydragon`。 */
  readonly source: string;
  /** Riot 补丁版本，如 `16.19.1`；未知时为 null。 */
  readonly patch: string | null;
  /** 抓取时间 (ISO 8601)。 */
  readonly fetchedAt: string;
  /** 数据源的权威日期（若有），如统计数据的 dtstatdate。 */
  readonly dataDate?: string;
}

/** 一个完整的静态数据快照。 */
export interface Dataset {
  readonly meta: DatasetMeta;
  readonly augments: readonly Augment[];
  readonly champions: readonly Champion[];
  readonly items: readonly Item[];
  /**
   * 国服口径海克斯图鉴（腾讯一方 CDN）。
   * 若腾讯源同步失败则为空数组 —— 图鉴仍可用（CDragon 口径）。
   */
  readonly hextechs: readonly HextechStatic[];
}

/* ------------------------------------------------------------------ */
/* 排行榜（official-aggregated）                                        */
/* ------------------------------------------------------------------ */

/** 海克斯榜条目（上游 `fuwen_aram_rune_rank_v2`，官方解析规格）。 */
export interface AugmentRankEntry {
  /** 国服海克斯数字 ID（对应 HextechStatic.id）。 */
  readonly id: number;
  /** 上游等级掩码（255 = 全部等级聚合）。 */
  readonly level: number;
  /** 选取率 (0..1)。 */
  readonly pickRate: number;
  /** 选取排名。 */
  readonly pickRank: number;
  /** 选取排名变化（正=上升，负=下降，0=不变）。 */
  readonly pickRankChange: number;
  /** 胜率 (0..1)。 */
  readonly winRate: number;
  /** 胜率排名。 */
  readonly winRank: number;
  /** 胜率排名变化。 */
  readonly winRankChange: number;
  /** 最适配英雄（championId 列表，官方数据源直出）。 */
  readonly bestHeroes: readonly number[];
}

/** 英雄榜条目（上游 `fuwen_aram_hero_rank_v2`，官方解析规格）。 */
export interface HeroRankEntry {
  readonly championId: number;
  /** 综合排名。 */
  readonly rank: number;
  /** 排名变化描述原文（如 `上升1位` / `未变化`）。 */
  readonly rankChangeDesc: string;
  /** 排名变化（正=上升，负=下降，0=不变；由描述解析）。 */
  readonly rankChange: number;
  /** 胜率 (0..1)。 */
  readonly winRate: number;
  /** 选取率 (0..1)。 */
  readonly pickRate: number;
  /** 最佳搭档（官方数据源直出的前 50 组，此处只保留前 5）。 */
  readonly bestPartners: readonly HeroPartner[];
  readonly avgDeathTime: number;
  readonly avgParticipationRate: number;
  readonly avgDamageRatio: number;
  readonly avgTankRatio: number;
}

export interface HeroPartner {
  readonly championId: number;
  readonly pickRate: number;
  readonly winRate: number;
  readonly rank: number;
}

/** 排行榜快照 —— 海克斯榜 + 英雄榜。 */
export interface RankingSnapshot {
  readonly meta: RankingsMeta;
  readonly augments: readonly AugmentRankEntry[];
  readonly heroes: readonly HeroRankEntry[];
}

export interface RankingsMeta {
  readonly source: string;
  /** 上游统计日期，格式 `YYYYMMDD`（如 `20260924`）。 */
  readonly dataDate: string;
  /** 抓取时间 (ISO 8601)。 */
  readonly fetchedAt: string;
}

/* ------------------------------------------------------------------ */
/* 单英雄海斗详情（官方 101 站英雄页的海斗口径）                        */
/* ------------------------------------------------------------------ */

/**
 * 该英雄的单个海克斯强度（上游 `augment_json_irank`）。
 *
 * 这是**以该英雄为准**的口径，与全局海克斯榜（`AugmentRankEntry`）不同：
 * 同一个海克斯在不同英雄身上强度不同，官方对此按英雄单独统计。
 *
 * 上游格式：`排名|英雄ID|海克斯ID|等级|登场率|强度`，以 `#` 分隔。
 */
export interface ChampionAugmentStat {
  /** 该英雄口径下的强度排名。 */
  readonly rank: number;
  /** 国服海克斯数字 ID（对应 HextechStatic.id）。 */
  readonly augmentId: number;
  /** 稀有度等级掩码，如 `kGold` / `kPrismatic`。 */
  readonly level: string;
  /** **登场率**（0..1）。注意：不是胜率 —— UI 文案不可写错。 */
  readonly pickRate: number;
  /** 强度评级（S/A/B/C…），官方直出。 */
  readonly tier: string;
}

/** 一件装备及其统计（上游 `itemone_json` / `itemcore_json` 等）。 */
export interface BuildItemStat {
  /** 装备 ID 列表（核心组合为多件，用 `&` 分隔后拆开）。 */
  readonly itemIds: readonly number[];
  /** 登场率（0..1）。 */
  readonly pickRate: number;
  /** 胜率（0..1）。 */
  readonly winRate: number;
}

/**
 * 出装建议（上游多个字段汇总）。
 *
 * 上游各字段格式不一，统一归一化为 BuildItemStat：
 *   - `itemone_json`  : JSON，winrate/showrate 为**万分比**；单件（20 条）
 *   - `itemcore_json` : JSON，itemcore 用 `&` 分隔；核心三件套（10 条）
 *   - `itemshoes`     : `itemId$登场率$胜率`；鞋子
 *   - `itemout`       : `itemIds$登场率$胜率`；**出门装组合**
 *
 * ⚠️ 上游还有 `itemover_rec`（成型六件套），但**官方页面不展示它**，
 * 因此本项目不采集、类型里也没有对应字段 —— 此前误把它当「成型六件套」
 * 写进配装方案，属擅自扩大数据用途（见 docs/build-slots.md §已废弃）。
 */
export interface ChampionBuild {
  /** 出门装单件（按登场率降序，实测 20 条）。 */
  readonly start: readonly BuildItemStat[];
  /** 出门装组合（如「灵巧披风+增幅典籍」）。 */
  readonly startCombo: readonly BuildItemStat[];
  /** 鞋子。 */
  readonly shoes: readonly BuildItemStat[];
  /** 核心三件套组合（按登场率降序，实测 10 条）。 */
  readonly core: readonly BuildItemStat[];
}

/** 技能加点方案（上游 `skill_json`，暂只保留加点序列与统计）。 */
export interface SkillOrder {
  /** 主/副/一级技能（如 `1&3&2` → [1,3,2]）。 */
  readonly priority: readonly number[];
  /** 加点序列（如 `1&2&3&1&1&4&…`）。 */
  readonly order: readonly number[];
  /** 登场率（0..1）。 */
  readonly pickRate: number;
}

/** 单个英雄的海斗模式详情。 */
export interface ChampionDetail {
  readonly championId: number;
  /** 该英雄的海克斯强度（已按上游排名升序）。 */
  readonly augments: readonly ChampionAugmentStat[];
  readonly build: ChampionBuild;
  /** 技能加点方案（按登场率降序，最多保留前 3）。 */
  readonly skills: readonly SkillOrder[];
  /** 最佳拍档（championId + 胜率 + 登场率）。 */
  readonly partners: readonly HeroPartner[];
  /** 上游统计日期 `YYYYMMDD`。 */
  readonly dataDate: string;
}

/** 单英雄详情的集合（由 `pnpm sync` 预抓，供悬浮窗离线读取）。 */
export interface ChampionDetailSet {
  readonly meta: {
    readonly source: string;
    readonly dataDate: string;
    readonly fetchedAt: string;
    /** 成功抓取的英雄数，便于判断数据完整性。 */
    readonly count: number;
  };
  readonly details: readonly ChampionDetail[];
}

/* ------------------------------------------------------------------ */
/* 配装方案（LCU item sets）                                           */
/* ------------------------------------------------------------------ */

/**
 * 配装方案里的一个装备条目。
 *
 * 注意 `id` 是**字符串**——这是官方客户端自己写出的格式（实测），
 * 写成数字可能被静默忽略。
 */
export interface ItemSetEntry {
  readonly id: string;
  readonly count: number;
}

/** 配装方案里的一个分块（如「出门装」「三件套」）。 */
export interface ItemSetBlock {
  readonly type: string;
  readonly items: readonly ItemSetEntry[];
  readonly hideIfSummonerSpell: string;
  readonly showIfSummonerSpell: string;
}

/**
 * 一套配装方案（与 LCU `/lol-item-sets/v1/item-sets/{id}/sets` 的结构一致）。
 *
 * 字段来自**客户端自己保存的方案**（实测导出），不是社区记忆，
 * 因此大小写与取值都可靠。
 */
export interface ItemSet {
  readonly title: string;
  /** 固定 `custom`（自定义方案）。 */
  readonly type: string;
  /** `any` 或具体地图名。 */
  readonly map: string;
  /** `any` 或具体模式名。 */
  readonly mode: string;
  readonly sortrank: number;
  /** 固定 `blank`（从空白创建）。 */
  readonly startedFrom: string;
  /** 关联英雄（championId 列表）。 */
  readonly associatedChampions: readonly number[];
  /**
   * 关联地图 ID 列表。
   *
   * ⚠️ 海克斯乱斗用 **12**（官方 `maps.json` 中名为 "Random Map"）。
   * 注意它同样被嚎哭深渊使用 —— 该模式下每局随机地图，故官方复用此 ID。
   * 填错会导致方案在游戏内**静默不出现**。
   */
  readonly associatedMaps: readonly number[];
  readonly blocks: readonly ItemSetBlock[];
  /** 唯一标识（UUID）。更新既有方案时必须沿用原 uid。 */
  readonly uid: string;
  readonly preferredItemSlots: readonly unknown[];
}

/** 写入配装方案的请求体。 */
export interface ItemSetPayload {
  readonly accountId: number;
  readonly itemSets: readonly ItemSet[];
  readonly timestamp: number;
}

/** 海克斯乱斗的官方地图 ID（`maps.json` 中 name = "Random Map"）。 */
export const BRAWL_MAP_ID = 12;
