/**
 * 图鉴里「英雄」的**口径**：真实英雄 vs 同一英雄的**变体条目**
 *
 * ── 为什么必须有这个纯函数（数字描述错误，2026-10-06）────────────────────
 *
 * 用户指出："抓到的 173 个英雄就是 lol 全部的英雄数据，不存在 245 个英雄。"
 * 实测 `data/dataset.json`（`pnpm sync` 产物）：
 *
 * | 口径 | 条数 | 说明 |
 * |---|---|---|
 * | `dataset.champions.length` | **245** | CommunityDragon `champion-summary.json` 的**行数** |
 * | 真实英雄（基础 ID，1~999） | **173** | 与 `data/builds.json` 的 `details` **逐个 ID 相等**（173/173） |
 * | 变体条目（`Jade_*`，ID 60001~60267） | **72** | **同一英雄**的另一套 ID：59 条与真实英雄**同名**，13 条用的是**改名前的旧中文名**（`60003 哨兵之殇` = 现在的 `3 正义巨像`…） |
 *
 * 也就是说 245 = 173 + 72，是**展开后的行数**，不是英雄数。把 245 当英雄数展示给
 * 用户是错的（真机也踩过同一件事：按数字 join 排行榜时，72 个变体 ID 全部
 * "暂无数据"，见 `overlay-view.ts` 的 `canonicalChampionId()`）。
 *
 * ⚠️ 所以：**界面上"英雄"永远显示 `champions`（173）**；变体条目要显示就
 * **单独说明它是什么**（`variants`），绝不混进英雄数里。数据文件本身不许改
 * （它是 `pnpm sync` 产物，上游给什么就是什么）。
 */

import type { Champion } from './types.ts';

/**
 * 变体条目 ID 的下界（CommunityDragon 的「同一英雄的另一套 ID」）。
 *
 * 实测图鉴：基础 ID 最大 950（真实英雄），变体 ID 从 60001 起。
 * 与 `overlay-view.ts` 的 `canonicalChampionId()` 共用同一个界 —— 一处定义，
 * 免得"过滤展示"与"ID 归一化"两处各写一个 60000 然后漂移。
 */
export const CHAMPION_VARIANT_ID_MIN = 60000;

/** 这个 ID 是否是变体条目（同一英雄的另一套 ID）。 */
export function isChampionVariant(championId: number): boolean {
  return championId >= CHAMPION_VARIANT_ID_MIN;
}

/** 图鉴英雄条目的口径拆分。 */
export interface ChampionSetCounts {
  /** **真实英雄**条数（基础 ID）—— 界面上「英雄」显示的就是这个数。 */
  readonly champions: number;
  /** **变体条目**数（同一英雄的另一套 ID，`Jade_*`）。 */
  readonly variants: number;
  /** 图鉴总条数（`champions + variants`）—— 只有核对数据文件行数时才用它。 */
  readonly entries: number;
}

/**
 * 数一遍图鉴里的英雄条目（**纯函数**；界面与文档都用它，不许各写一遍 `length`）。
 *
 * 边界：`id` 非有限数（脏数据）时按真实英雄计（宁可多算一个，也不要静默吞掉）。
 */
export function countChampionSet(champions: readonly Champion[]): ChampionSetCounts {
  let variants = 0;
  for (const c of champions) {
    if (Number.isFinite(c.id) && isChampionVariant(c.id)) variants++;
  }
  return { champions: champions.length - variants, variants, entries: champions.length };
}
