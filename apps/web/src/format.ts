/**
 * 展示格式化（**纯函数 / 纯数据**，不依赖 vue/DOM，可 Node 直测）
 *
 * 这一层只做「数据 → 用户看到的文字」：模式中文名、百分比、统计日期、
 * 排名变化徽标。与数据加载（`useDataset.ts`）分开，是为了让格式化规则
 * 能在 `format.test.ts` 里直接测 —— 排行榜的显示精度/日期格式都属于
 * 用户可见口径，靠人眼在页面上验证太容易漂。
 */

import type { AugmentMode, HextechStatic } from '@hexbox/core';

/**
 * 模式代号的展示配置。
 *
 * ⚠️ 只收 `AugmentMode` 三个已知代号：上游新增代号时 `modeLabel()` 会**原样
 * 显示代号**而不是 `undefined`（`RankView` 曾硬编码三目表达式，CHERRY 就漏成
 * 英文 `CHERRY`）。`hint` 字段无人使用，已删除（审查 P2 #5）。
 */
export const MODE_META: Record<AugmentMode, { label: string }> = {
  KIWI: { label: '海克斯乱斗' },
  KIWI_JADE: { label: '海克斯乱斗 · Jade' },
  CHERRY: { label: '斗魂竞技场' },
};

/**
 * 模式代号 → 中文标签；未知代号原样返回（**永远不返回 undefined**）。
 *
 * 入参故意收 `string`：运行时模式来自 JSON，类型断言挡不住上游新增代号。
 */
export function modeLabel(mode: string): string {
  return Object.prototype.hasOwnProperty.call(MODE_META, mode)
    ? MODE_META[mode as AugmentMode].label
    : mode;
}

/** 国服官方图标（kiwi_augments 自带绝对直链）。 */
export function cnIconUrl(h: HextechStatic): string {
  return h.smallIcon || h.largeIcon;
}

/**
 * 把 0..1 比率格式化为百分数字符串。
 *
 * 默认 **2 位小数**：上游是 4 位精度（如 `0.4814`），官方 101 站展示 2 位；
 * 旧实现默认 1 位（`48.1%`）会丢精度且与官方站不一致（审查 P2 #4）。
 */
export function pct(rate: number, digits = 2): string {
  return (rate * 100).toFixed(digits) + '%';
}

/**
 * 上游统计日期 `YYYYMMDD` → 展示用的 `YYYY-MM-DD`。
 *
 * 上游 `meta.dataDate` 是 `20261101` 这种紧凑格式（审查 P2 #4：直接展示
 * 用户看不懂日期分隔）。识别不了的值原样返回 —— 宁可显示原始值，也**不**
 * 丢掉数据（例如上游将来改成 `2026-11-01` 时展示不受影响）。
 */
export function formatStatDate(raw: string): string {
  const matched = /^(\d{4})(\d{2})(\d{2})$/.exec(raw.trim());
  if (matched === null) return raw;
  const year = matched[1] ?? '';
  const month = matched[2] ?? '';
  const day = matched[3] ?? '';
  return `${year}-${month}-${day}`;
}

/** 排名变化徽标样式。 */
export function rankChangeClass(n: number): string {
  return n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
}

/** 排行榜排序键（与 `RankView` 的下拉选项一致）。 */
export type RankSortKey = 'winRate' | 'pickRate';

/**
 * 排行榜按指定比率**降序**排序（纯函数，供海克斯榜/英雄榜共用）。
 *
 * 返回新数组（不改入参）；相同值保持上游原顺序（`Array.prototype.sort` 自 ES2019
 * 起稳定，等于"官方排名优先"）。旧实现两处 computed 各写一份 sort 表达式，
 * 审计 P3 收敛到这里以便单测。
 */
export function sortByRate<T extends { readonly winRate: number; readonly pickRate: number }>(
  rows: readonly T[],
  key: RankSortKey,
): T[] {
  const field: 'winRate' | 'pickRate' = key === 'winRate' ? 'winRate' : 'pickRate';
  return [...rows].sort((a, b) => b[field] - a[field]);
}

/** 排名变化文字（↑上升 / ↓下降 / —不变）。 */
export function rankChangeText(n: number): string {
  if (n > 0) return `↑${n}`;
  if (n < 0) return `↓${-n}`;
  return '—';
}
