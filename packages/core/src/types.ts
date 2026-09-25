/**
 * 领域模型：英雄联盟「海克斯乱斗」助手
 *
 * 术语对照（见 docs/research.md §1）：
 *   CHERRY     = 斗魂竞技场 (Arena)
 *   KIWI       = 海克斯乱斗
 *   KIWI_JADE  = 海克斯乱斗 (Jade 变体)
 */

/** 海克斯（强化符文）稀有度。kEventChoice 为事件抉择类，非三选一池。 */
export type AugmentRarity = 'kSilver' | 'kGold' | 'kPrismatic' | 'kEventChoice';

/** Riot 内部模式代号。 */
export type AugmentMode = 'CHERRY' | 'KIWI' | 'KIWI_JADE';

/**
 * 海克斯静态定义（来源：CommunityDragon `cherry-augments.json`）。
 *
 * 这是**官方公开的静态数据**，不含任何统计信息 —— 见 COMPLIANCE.md。
 */
export interface Augment {
  /** 官方数字 ID。可与统计类数据源 join。 */
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

/** 一个完整的数据快照。 */
export interface Dataset {
  readonly meta: DatasetMeta;
  readonly augments: readonly Augment[];
  readonly champions: readonly Champion[];
  readonly items: readonly Item[];
}
