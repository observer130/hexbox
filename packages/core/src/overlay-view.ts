/**
 * 英雄 ID 归一化 + 详情查找（原「悬浮窗分阶段视图模型」）
 *
 * ⚠️ 2026-11：侧边悬浮窗已**整体移除**（`apps/overlay` 的窗口/渲染端/preload 全删）。
 * 本模块里原先的选人胜率视图、海克斯强度视图、出装视图一并删除；只剩两件仍被
 * 生产代码使用的纯函数：
 *
 *   - `canonicalChampionId()` / `championKey()`：识别可能给出 60000+ 高 ID，
 *     而排行榜/图鉴用基础 ID —— 这是「顶栏全是暂无数据」真机 bug 的修法；
 *     覆盖层视觉循环（`vision-loop.ts`）与 lcu itemset CLI 都用它。
 *   - `findDetail()`：从 `builds.json` 取某英雄详情（局内标签、itemset CLI 用）。
 *
 * 纯函数、不碰 fs / Electron / DOM，因此能在 CI 里被单测覆盖。
 */

import type { Champion, ChampionDetail, ChampionDetailSet } from './types.ts';
// 「变体 ID」的界与图鉴口径计数**一处定义**（见 champion-set.ts：245 = 173 + 72）
import { isChampionVariant } from './champion-set.ts';

/* ------------------------------------------------------------------ */
/* 英雄两套 ID 的归一化                                                */
/* ------------------------------------------------------------------ */

/**
 * 英雄名归一化：去首尾空白 + 忽略大小写（中英文名都适用）。
 *
 * 实测：图鉴 173 个基础 ID + 72 个高 ID；英雄榜对基础 ID 覆盖 173/173，
 * 对高 ID 覆盖 **0/72**。因此只按数字 join 会让全部高 ID 英雄「暂无数据」。
 *
 * 用**名称**做键对齐两套编号：72 个高 ID 里 59 个与基础 ID 同名，
 * 可靠命中。剩余 13 个连名称都不同（`60003 哨兵之殇` vs `3 正义巨像`
 * —— 英雄在从高 ID 迁到基础 ID 的过程中改了名），**名称法无法对齐**，
 * 只能诚实显示「暂无数据」，不要用 `-60000` 偏移去猜（实测会错配）。
 */
export function championKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 把识别到的英雄 ID 归一化到「排行榜口径」的基础 ID。
 *
 * 识别（OCR / 头像模板）可能给出高 ID，而排行榜只有基础 ID；
 * 先按数字直查，未命中再按**名称**找基础 ID，最后回退原 ID
 * （宁可显示「暂无数据」，也不要错配成别的英雄）。
 *
 * 已知边界：13 个「改名英雄」无法对齐（见 `championKey` 说明），
 * 它们的胜率会缺失 —— 这是数据层面的限制，不是 bug。
 */
export function canonicalChampionId(
  championId: number,
  champions: readonly Champion[],
): number {
  if (championId <= 0) return championId;
  if (!isChampionVariant(championId)) return championId;
  const self = champions.find((c) => c.id === championId);
  if (!self) return championId;
  const key = championKey(self.name);
  const base = champions.find((c) => !isChampionVariant(c.id) && championKey(c.name) === key);
  return base?.id ?? championId;
}

/* ------------------------------------------------------------------ */
/* 详情查找                                                            */
/* ------------------------------------------------------------------ */

/** 从详情集合里取出某英雄（无则返回 null）。 */
export function findDetail(
  set: ChampionDetailSet | null,
  championId: number,
): ChampionDetail | null {
  if (!set || championId <= 0) return null;
  return set.details.find((d) => d.championId === championId) ?? null;
}
