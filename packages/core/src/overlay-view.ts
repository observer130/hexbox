/**
 * 悬浮窗分阶段视图模型
 *
 * 设计依据（见 docs/OVERLAY-STAGES.md）：调研同类工具后确认，
 * **不同阶段关注的完全是不同的问题**：
 *
 *   - 英雄选择阶段：玩家在**选英雄** → 只该显示该英雄的**胜率**。
 *     （此前错误地显示了海克斯胜率 —— 此时还没有海克斯，属臆想需求。）
 *   - 海克斯选择阶段：玩家在**选海克斯** → 显示该英雄口径的
 *     海克斯强度（S/A/B/C）与登场率。
 *   - 对局中：显示**出装建议**（出门装/鞋/核心/六件套 + 胜率）。
 *
 * 本模块**纯函数**，不碰 fs / Electron / DOM —— 悬浮窗在 CI 里跑不起来
 * （需管理员 + 真实桌面），只有抽成纯函数才能被单元测试覆盖。
 */

import type {
  AugmentRarity,
  Champion,
  ChampionBuild,
  ChampionDetail,
  ChampionDetailSet,
  HeroRankEntry,
  HextechStatic,
} from './types.ts';

/* ------------------------------------------------------------------ */
/* 英雄选择阶段：只显示胜率                                            */
/* ------------------------------------------------------------------ */

/** 选人阶段该英雄的展示模型。 */
export interface ChampSelectInfo {
  readonly championId: number;
  /** 英雄中文名。 */
  readonly name: string;
  /** 海斗模式胜率（0..1）。 */
  readonly winRate: number;
  /** 胜率相对变化（上游 rank_change 同类口径），可能为 0。 */
  readonly winRateChange: number;
  /** 是否有官方统计（无统计时 UI 应显示「暂无数据」而非 0%）。 */
  readonly hasData: boolean;
}

/** 从英雄榜取出某英雄的选人阶段信息（无数据时 hasData=false）。 */
export function champSelectInfo(
  championId: number,
  options: {
    readonly heroes: readonly HeroRankEntry[];
    readonly champions: readonly Champion[];
  },
): ChampSelectInfo {
  const { heroes, champions } = options;
  const name =
    champions.find((c) => c.id === championId)?.name ??
    (championId > 0 ? `英雄#${championId}` : '');
  const row = heroes.find((h) => h.championId === championId);
  if (!row) {
    return { championId, name, winRate: 0, winRateChange: 0, hasData: false };
  }
  return {
    championId,
    name,
    winRate: row.winRate,
    // 上游只给排名的变化描述；胜率变化不在数据里，
    // 因此这里恒为 0，UI 不应凭它显示箭头。
    winRateChange: 0,
    hasData: true,
  };
}

/* ------------------------------------------------------------------ */
/* 海克斯选择阶段：该英雄口径的海克斯强度                              */
/* ------------------------------------------------------------------ */

/** 单条海克斯强度（已 join 图鉴）。 */
export interface AugmentStrengthRow {
  readonly augmentId: number;
  /** 中文名（图鉴缺失时回落为 `海克斯#<id>`）。 */
  readonly name: string;
  readonly icon: string;
  readonly rarity: AugmentRarity;
  /** 强度评级 S/A/B/C（官方直出）。 */
  readonly tier: string;
  /** **登场率**（0..1）。注意不是胜率。 */
  readonly pickRate: number;
  /** 该英雄口径下的排名。 */
  readonly rank: number;
  /** 是否命中图鉴。 */
  readonly hasDef: boolean;
}

export interface AugmentStrengthOptions {
  readonly detail: ChampionDetail | null;
  readonly hextechs: readonly HextechStatic[];
  /** 只取某个稀有度；不传则取「全部品质」（上游 255 组）。 */
  readonly rarity?: AugmentRarity;
  /** 最多返回多少条（默认 10，一屏可读）。 */
  readonly limit?: number;
}

/**
 * 该英雄的海克斯强度榜（按官方排名升序）。
 *
 * 注意与全局海克斯榜的区别：这里的强度与登场率都是**以该英雄为准**的，
 * 同一个海克斯在不同英雄身上完全不同。这正是同类工具的核心功能。
 */
export function augmentStrength(
  options: AugmentStrengthOptions,
): AugmentStrengthRow[] {
  const { detail, hextechs, rarity, limit = 10 } = options;
  if (!detail) return [];

  const byId = new Map<number, HextechStatic>();
  for (const h of hextechs) byId.set(h.id, h);

  const rows = detail.augments
    .filter((a) => (rarity ? byId.get(a.augmentId)?.rarity === rarity : true))
    .map((a): AugmentStrengthRow => {
      const def = byId.get(a.augmentId);
      return {
        augmentId: a.augmentId,
        name: def?.name ?? `海克斯#${a.augmentId}`,
        icon: def ? def.smallIcon || def.largeIcon : '',
        rarity: def?.rarity ?? 'kSilver',
        tier: a.tier,
        pickRate: a.pickRate,
        rank: a.rank,
        hasDef: def !== undefined,
      };
    });

  return rows.sort((a, b) => a.rank - b.rank).slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* 对局中：出装建议                                                    */
/* ------------------------------------------------------------------ */

/** 一个出装槽位的展示模型（装备名已 join）。 */
export interface BuildSlotRow {
  /** 装备中文名（缺失时回落为 `装备#<id>`）。 */
  readonly names: readonly string[];
  readonly iconIds: readonly number[];
  /** 登场率（0..1）。 */
  readonly pickRate: number;
  /** 胜率（0..1）。 */
  readonly winRate: number;
}

export interface ChampionBuildView {
  /** 出门装（单件或组合）。 */
  readonly start: BuildSlotRow[];
  readonly shoes: BuildSlotRow[];
  /** 核心三件套。 */
  readonly core: BuildSlotRow[];
}

export interface BuildViewOptions {
  readonly detail: ChampionDetail | null;
  readonly items: readonly { readonly id: number; readonly name: string }[];
  /** 每个槽位最多几条方案（默认 3）。 */
  readonly limit?: number;
}

/**
 * 出装建议视图。
 *
 * 槽位语义（上游字段口径，不可混用）：
 *   - `start`     出门装单件（`itemone_json`）
 *   - `startCombo` 出门装组合（`itemout`）
 *   - `shoes`     鞋（`itemshoes`）
 *   - `core`      核心三件套（`itemcore_json`）
 *
 * ⚠️ 上游的 `itemover_rec`（成型六件套）**官方页面不展示**，
 * 本项目不采集、视图里也没有该槽位 —— 曾把它当「六神装」展示，
 * 用户找不到出处（见 docs/build-slots.md）。
 *
 * 出门装两路数据合并展示：单件与组合对玩家是同一件事的不同粒度。
 */
export function championBuild(options: BuildViewOptions): ChampionBuildView {
  const { detail, items, limit = 3 } = options;
  const empty: ChampionBuildView = { start: [], shoes: [], core: [] };
  if (!detail) return empty;

  const nameById = new Map<number, string>();
  for (const it of items) nameById.set(it.id, it.name);

  const toRows = (stats: ChampionBuild['start']): BuildSlotRow[] =>
    stats.slice(0, limit).map((s) => ({
      names: s.itemIds.map((id) => nameById.get(id) ?? `装备#${id}`),
      iconIds: s.itemIds,
      pickRate: s.pickRate,
      winRate: s.winRate,
    }));

  return {
    start: toRows(detail.build.start),
    shoes: toRows(detail.build.shoes),
    core: toRows(detail.build.core),
  };
}

/** 从详情集合里取出某英雄（无则返回 null）。 */
export function findDetail(
  set: ChampionDetailSet | null,
  championId: number,
): ChampionDetail | null {
  if (!set || championId <= 0) return null;
  return set.details.find((d) => d.championId === championId) ?? null;
}

/** 详情集合是否可用（悬浮窗据此决定是否显示出装面板）。 */
export function hasBuildData(set: ChampionDetailSet | null): boolean {
  return set !== null && set.details.length > 0;
}
