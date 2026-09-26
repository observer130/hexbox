/**
 * 排行榜视图模型（悬浮窗 / 数据站共用）
 *
 * 为什么放在 core：
 *   这段逻辑是**纯函数**——输入领域模型，输出可直接渲染的分组，
 *   不碰 fs、不碰 Electron、不碰 DOM。放在 core 里才能被单元测试覆盖，
 *   而悬浮窗（需管理员 + 真实桌面）在 CI 中根本跑不起来。
 *
 * 设计要点：
 *   1. 排行榜条目用的是**国服数字 ID**，图鉴有 CDragon / 国服两套口径，
 *      必须经国服图鉴（HextechStatic）做 join，不能拿 CDragon 的 id 硬匹配。
 *   2. 按稀有度分组——玩家在对局中关心的是「这次给的可能是棱彩/黄金/白银」，
 *      而不是一个 211 条的平铺长列表。
 *   3. 上游无数据时返回空分组，由调用方诚实展示「暂无数据」，不拿旧数据冒充。
 */

import type {
  AugmentRankEntry,
  AugmentRarity,
  Champion,
  HextechStatic,
  RankingSnapshot,
} from './types.ts';

/** 一个排行榜条目的展示模型（已 join 图鉴，字段够渲染即可）。 */
export interface RankRow {
  /** 国服数字 ID（= 上游 augment_id）。 */
  readonly id: number;
  /** 中文名；图鉴缺失时回落为 `海克斯#<id>`。 */
  readonly name: string;
  readonly rarity: AugmentRarity;
  /** 图标直链（国服官方 CDN）；缺失时为空串。 */
  readonly icon: string;
  /** 胜率 0..1。 */
  readonly winRate: number;
  /** 选取率 0..1。 */
  readonly pickRate: number;
  readonly winRank: number;
  readonly winRankChange: number;
  /** 最适配英雄的中文名（已 join 英雄表，最多 3 个）。 */
  readonly bestHeroes: readonly string[];
  /** 该条目是否在图鉴中找到了定义（false 表示仅统计无图鉴）。 */
  readonly hasDef: boolean;
}

/** 按稀有度分组后的榜单。 */
export interface RarityGroup {
  readonly rarity: AugmentRarity;
  readonly rows: readonly RankRow[];
}

/** 稀有度的展示顺序与中文名（与数据站 RARITY_META 保持一致口径）。 */
export const RARITY_ORDER: readonly AugmentRarity[] = [
  'kPrismatic',
  'kGold',
  'kSilver',
  'kEventChoice',
];

export const RARITY_LABEL: Record<AugmentRarity, string> = {
  kPrismatic: '棱彩',
  kGold: '黄金',
  kSilver: '白银',
  kEventChoice: '事件',
};

export interface BuildRankRowsOptions {
  readonly rankings: RankingSnapshot | null;
  /** 国服口径图鉴（提供 ID 桥与中文名/图标）。 */
  readonly hextechs: readonly HextechStatic[];
  readonly champions?: readonly Champion[];
  /** 每个条目最多带几个最适配英雄。 */
  readonly maxHeroes?: number;
}

/**
 * 把排行榜快照 join 图鉴，得到可渲染的行。
 *
 * join 依据：`AugmentRankEntry.id`（国服数字 ID）↔ `HextechStatic.id`。
 * 注意两套官方 ID 不能换算，因此**只**用国服图鉴做桥。
 */
export function buildRankRows(options: BuildRankRowsOptions): RankRow[] {
  const { rankings, hextechs, champions = [], maxHeroes = 3 } = options;
  if (!rankings) return [];

  const byId = new Map<number, HextechStatic>();
  for (const h of hextechs) byId.set(h.id, h);

  const nameById = new Map<number, string>();
  for (const c of champions) nameById.set(c.id, c.name);

  return rankings.augments.map((e: AugmentRankEntry): RankRow => {
    const def = byId.get(e.id);
    return {
      id: e.id,
      name: def?.name ?? `海克斯#${e.id}`,
      rarity: def?.rarity ?? 'kSilver',
      icon: def ? def.smallIcon || def.largeIcon : '',
      winRate: e.winRate,
      pickRate: e.pickRate,
      winRank: e.winRank,
      winRankChange: e.winRankChange,
      bestHeroes: e.bestHeroes
        .slice(0, maxHeroes)
        .map((id) => nameById.get(id) ?? `#${id}`),
      hasDef: def !== undefined,
    };
  });
}

/**
 * 按稀有度分组，组内按胜率降序。
 *
 * 空组会被剔除，因此调用方可以直接判断 `groups.length === 0`。
 */
export function groupByRarity(rows: readonly RankRow[]): RarityGroup[] {
  const buckets = new Map<AugmentRarity, RankRow[]>();
  for (const r of rows) {
    const bucket = buckets.get(r.rarity);
    if (bucket) bucket.push(r);
    else buckets.set(r.rarity, [r]);
  }

  const groups: RarityGroup[] = [];
  for (const rarity of RARITY_ORDER) {
    const bucket = buckets.get(rarity);
    if (!bucket || bucket.length === 0) continue;
    groups.push({
      rarity,
      rows: [...bucket].sort((a, b) => b.winRate - a.winRate),
    });
  }
  return groups;
}

/** 便捷组合：join + 分组 + 每组截断（悬浮窗一屏放不下全部）。 */
export function buildRankBoard(
  options: BuildRankRowsOptions & { readonly perGroup?: number },
): RarityGroup[] {
  const { perGroup = 8, ...rest } = options;
  const groups = groupByRarity(buildRankRows(rest));
  return groups.map((g) => ({ rarity: g.rarity, rows: g.rows.slice(0, perGroup) }));
}

/* ------------------------------------------------------------------ */
/* 指定英雄的适配海克斯（对局中「我玩这个英雄，该拿什么」）             */
/* ------------------------------------------------------------------ */

/**
 * 找出最适合某英雄的海克斯。
 *
 * 依据：上游 `AugmentRankEntry.bestHeroes`（官方数据源直出的「最适配英雄」字段）。
 * 这比按全局胜率排序更贴合玩家问题——它回答的是「对**我这个英雄**而言」。
 */
export function bestAugmentsForChampion(
  championId: number,
  options: BuildRankRowsOptions & { readonly limit?: number },
): RankRow[] {
  const { limit = 6, ...rest } = options;
  const { rankings, hextechs, champions = [] } = rest;
  if (!rankings) return [];

  // 复用 buildRankRows 的 join，再按「是否适配本英雄」过滤
  const rows = buildRankRows({ rankings, hextechs, champions, maxHeroes: rest.maxHeroes });
  const byId = new Map(rankings.augments.map((e) => [e.id, e]));

  return rows
    .filter((r) => byId.get(r.id)?.bestHeroes.includes(championId))
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, limit);
}

/** 排行榜数据是否可用（用于渲染端决定显示榜单还是「暂无数据」）。 */
export function hasRankingData(rankings: RankingSnapshot | null): boolean {
  if (!rankings) return false;
  return rankings.augments.length > 0 || rankings.heroes.length > 0;
}
