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
