/**
 * 配装方案（LCU item sets）构造
 *
 * 把我们的出装统计（`ChampionBuild`）转成官方客户端能识别的 `ItemSet`。
 *
 * 格式来源：**客户端自己保存的方案**（实测导出），不是社区记忆。
 * 其中两个易错点必须记住：
 *
 *   1. `items[].id` 是**字符串**（如 `"3177"`），不是数字；
 *   2. 海克斯乱斗的地图 ID 是 **12**（官方 `maps.json` 中 name = "Random Map"，
 *      该模式下每局随机地图，故官方复用此 ID）。
 *      填错会导致方案在游戏内**静默不出现**，不报错。
 *
 * 本模块是纯函数（不碰 LCU / 网络），便于单测覆盖。
 */

import type {
  ChampionBuild,
  ItemSet,
  ItemSetBlock,
  ItemSetEntry,
} from './types.ts';

/** 生成一个 UUID（优先用 crypto.randomUUID，回退到简易实现）。 */
export function newUid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // 回退：足够唯一即可（方案 uid 只在本机去重）
  const r = (): string => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `${r()}${r()}-${r()}-${r()}-${r()}-${r()}${r()}${r()}`;
}

/** 把装备 ID 列表转成 block 的 items（注意 id 必须是字符串）。 */
export function toEntries(itemIds: readonly number[]): ItemSetEntry[] {
  return itemIds.map((id) => ({ id: String(id), count: 1 }));
}

/**
 * 由出装统计构造分块。
 *
 * 分块顺序即游戏内的显示顺序，按「玩家实际会依次购买」排列：
 * 出门装 → 鞋 → 核心三件套 → 成型六件套。
 *
 * ⚠️ 每个块必须是**一套连贯的出装**，不能把上游所有候选方案倒进同一个块。
 * 实测教训：上游 `start` 有 20+ 个候选出门装，全部塞进去会让这个块
 * 变成一长串互斥装备，游戏内完全没法参考。
 * 因此这里对每个槽位只取**登场率最高的前 N 套**，且每套独立成块。
 *
 * 块标题带胜率与序号，便于玩家区分与取舍。
 */
export function buildBlocks(build: ChampionBuild, perSlot = 2): ItemSetBlock[] {
  const mk = (type: string, items: ItemSetEntry[]): ItemSetBlock => ({
    type,
    items,
    hideIfSummonerSpell: '',
    showIfSummonerSpell: '',
  });

  const blocks: ItemSetBlock[] = [];

  /** 给一组方案生成若干块（每套独立一块）。 */
  const pushGroup = (stats: ChampionBuild['start'], label: string): void => {
    const picked = stats.filter((s) => s.itemIds.length > 0).slice(0, perSlot);
    picked.forEach((s, i) => {
      const wr = `${(s.winRate * 100).toFixed(1)}%`;
      const suffix = picked.length > 1 ? ` ${i + 1}` : '';
      blocks.push(mk(`${label}${suffix}（${wr}）`, toEntries(s.itemIds)));
    });
  };

  // 出门装：单件与组合分开成块（语义不同：一件 vs 一套）
  pushGroup(build.start, '出门装');
  pushGroup(build.startCombo, '出门组合');
  pushGroup(build.shoes, '鞋子');
  pushGroup(build.core, '核心三件套');
  pushGroup(build.full, '成型六件套');

  return blocks;
}

export interface MakeItemSetOptions {
  readonly championId: number;
  readonly championName: string;
  readonly build: ChampionBuild;
  /** 统计日期（YYYYMMDD），写进标题便于玩家辨认数据新旧。 */
  readonly dataDate?: string;
  /** 复用既有方案的 uid（更新而非新增时必须传）。 */
  readonly uid?: string;
  /**
   * 关联地图 ID。
   * 默认 **12**（海克斯乱斗 = Random Map）；填错会静默不生效。
   */
  readonly mapId?: number;
  /** 标题前缀（用于识别哪些方案由本工具生成）。 */
  readonly titlePrefix?: string;
}

/** 本工具生成的方案标题前缀，便于识别与安全清理。 */
export const ITEM_SET_TITLE_PREFIX = 'hexbox';

/**
 * 由出装统计构造一套配装方案。
 *
 * 返回 null 表示该英雄没有可用出装（避免写入空方案）。
 */
export function makeItemSet(options: MakeItemSetOptions): ItemSet | null {
  const {
    championId,
    championName,
    build,
    dataDate,
    uid,
    mapId = 12,
    titlePrefix = ITEM_SET_TITLE_PREFIX,
  } = options;

  const blocks = buildBlocks(build);
  if (blocks.length === 0) return null;

  // 标题带上数据日期，玩家一眼能看出是不是最新数据。
  // 前缀用于后续安全识别「哪些方案是本工具写的」。
  const dateSuffix = dataDate
    ? ` ${dataDate.slice(4, 6)}/${dataDate.slice(6, 8)}`
    : '';
  const title = `${titlePrefix} ${championName}${dateSuffix}`.slice(0, 40);

  return {
    title,
    type: 'custom',
    map: 'any',
    mode: 'any',
    sortrank: 0,
    startedFrom: 'blank',
    associatedChampions: [championId],
    associatedMaps: [mapId],
    blocks,
    uid: uid ?? newUid(),
    preferredItemSlots: [],
  };
}

/**
 * 判断某方案是否由本工具生成（据标题前缀）。
 *
 * 用于**安全清理**：只动自己写的方案，绝不碰玩家手写的。
 */
export function isOwnItemSet(set: ItemSet, prefix = ITEM_SET_TITLE_PREFIX): boolean {
  return typeof set.title === 'string' && set.title.startsWith(prefix);
}

/**
 * 合并新的配装方案进既有列表。
 *
 * 规则（很重要，避免破坏玩家数据）：
 *   - **只替换同 (英雄) 且由本工具生成的**方案；
 *   - 玩家手写的方案一律原样保留；
 *   - 其它英雄的方案保留。
 *
 * 这样可以反复 sync 而不产生重复方案，也不会覆盖玩家自己的方案。
 */
export function mergeItemSets(
  existing: readonly ItemSet[],
  generated: readonly ItemSet[],
  options: { readonly prefix?: string } = {},
): ItemSet[] {
  const prefix = options.prefix ?? ITEM_SET_TITLE_PREFIX;
  const genChampions = new Set(
    generated.flatMap((g) => g.associatedChampions.map((c) => `${c}`)),
  );

  const kept = existing.filter((s) => {
    if (!isOwnItemSet(s, prefix)) return true; // 玩家手写的：保留
    // 本工具生成、且本次要重新生成同一英雄的：丢弃旧版
    return !s.associatedChampions.some((c) => genChampions.has(`${c}`));
  });

  return [...kept, ...generated];
}
