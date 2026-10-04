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
  BuildItemStat,
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
 * 由出装统计构造分块（口径与 101 站「出装」页签一致）。
 *
 * 分块与条数（依据 docs/build-slots.md 的核实结果）：
 *   - **出门装**：只取第 1 套（官方按登场率降序的第 1 名）
 *   - **优先成装**：取前 3 套三件套
 *   - **其余成装**：单件列表，合并成一栏
 *   - **鞋**：不单独成栏（一栏只有一件装备，游戏内既不好看也无信息量）
 *
 * ⚠️ 两处易错点：
 *   1. 上游**不是**按登场率排序的，必须自己降序排（否则第一套是随机的）；
 *   2. 不要用 `itemover_rec` —— 官方页面不展示该字段，
 *      此前误当作「成型六件套」，属擅自扩大数据用途。
 *
 * ⚠️ 每个块是一套**连贯出装**，不能把互斥候选全塞进同一块
 * （实测：20 多件出门装堆在一起，游戏内完全没法参考）。
 */
export function buildBlocks(build: ChampionBuild): ItemSetBlock[] {
  const mk = (type: string, items: ItemSetEntry[]): ItemSetBlock => ({
    type,
    items,
    hideIfSummonerSpell: '',
    showIfSummonerSpell: '',
  });

  const blocks: ItemSetBlock[] = [];
  /** 按登场率降序（上游顺序不可靠），并去掉空方案。 */
  const byPick = (xs: readonly BuildItemStat[]): BuildItemStat[] =>
    xs.filter((x) => x.itemIds.length > 0).sort((a, b) => b.pickRate - a.pickRate);

  // 出门装：只给排名第一的一套
  const start = byPick(build.start)[0];
  if (start) {
    blocks.push(mk(`出门装（${(start.winRate * 100).toFixed(1)}%）`, toEntries(start.itemIds)));
  } else {
    // 回退：没有单件数据时用组合
    const combo = byPick(build.startCombo)[0];
    if (combo) {
      blocks.push(mk(`出门装（${(combo.winRate * 100).toFixed(1)}%）`, toEntries(combo.itemIds)));
    }
  }

  // 鞋：**不单独成栏**。
  // 每栏只有一件装备，在游戏内既不好看也没信息量
  // （鞋的选择通常已包含在核心三件套/其余成装里）。
  // 保留 shoes 数据本身，只是不展示。

  // 优先成装（三件套）：前 3
  for (const [i, s] of byPick(build.core).slice(0, 3).entries()) {
    blocks.push(
      mk(`优先成装 ${i + 1}（${(s.winRate * 100).toFixed(1)}%）`, toEntries(s.itemIds)),
    );
  }

  // 其余成装：单件合并成一栏。
  //
  // ⚠️ 必须取**全部** `itemone_json`（实测每英雄 20 条）**并排除第 1 名**。
  // 官方页面把同一份 itemone_json 展示了两次：按登场率前 5 作「出门装」，
  // **其余全部**作「其余成装」—— 所以两栏的数字本来就会重叠。
  // 此前写成 `slice(1, 11)` 是错的（真实 bug）：
  //   - 多出了第 1 名（如 266 的 71.19% 多兰盾，它是「出门装」）；
  //   - 丢掉了第 11~20 名（登场率 2.5%~7.5%），而它们才是官方
  //     「其余成装」里登场率最高的几件（7.51 / 5.95 / 5.68 …）。
  // 排序已由 parseItemStatJson 按登场率降序保证，这里不重复排。
  //
  // 再去一次重：上游偶尔为两件相同装备给出两个条目，而配装方案里
  // 同栏出现同一件装备纯属噪声（官方页面按件展示，不会重复）。
  const restIds: number[] = [];
  const restSeen = new Set<number>();
  for (const s of byPick(build.start).slice(1)) {
    for (const id of s.itemIds) {
      if (restSeen.has(id)) continue;
      restSeen.add(id);
      restIds.push(id);
    }
  }
  if (restIds.length > 0) {
    blocks.push(mk('其余成装', toEntries(restIds)));
  }

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
