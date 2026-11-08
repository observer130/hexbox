/**
 * 稀有度显示配置（**不依赖 vue**，因此可以在 Node 里单测）
 *
 * ⚠️ 为什么要有 `rarityMeta()` 这层（2026-11 审查）：模板里原本直接写
 * `RARITY_META[a.rarity].color`。数据是**运行时 JSON**，类型上的
 * `Record<Augment['rarity'], …>` 只在编译期成立；上游某天新增一个档位
 * （例如 `kBronze`）时键就取不到 → 读 `.color` 抛 TypeError → Vue 渲染中断
 * → **整页空白**，而控制台只有一行看不出所以然的报错。
 *
 * 现在就一遍：取不到就返回"未知"档，页面照常渲染。
 */

import type { Augment } from '@hexbox/core';

export interface RarityMeta {
  readonly label: string;
  readonly color: string;
  /** 排序权重（越小越稀有）。 */
  readonly order: number;
}

export const RARITY_META: Record<Augment['rarity'], RarityMeta> = {
  kPrismatic: { label: '棱彩', color: 'var(--prismatic)', order: 0 },
  kGold: { label: '黄金', color: 'var(--gold)', order: 1 },
  kSilver: { label: '白银', color: 'var(--silver)', order: 2 },
  kEventChoice: { label: '事件抉择', color: 'var(--event)', order: 3 },
};

/** 未知档位的显示值（排最后，不下结论说它稀有）。 */
export const UNKNOWN_RARITY: RarityMeta = {
  label: '未知档位',
  color: 'var(--text-dim, #888)',
  order: 99,
};

/** 稀有度 → 显示配置，**永远返回对象**（未知档位不抛错）。 */
export function rarityMeta(rarity: string | null | undefined): RarityMeta {
  if (typeof rarity !== 'string') return UNKNOWN_RARITY;
  return Object.prototype.hasOwnProperty.call(RARITY_META, rarity)
    ? RARITY_META[rarity as Augment['rarity']]
    : UNKNOWN_RARITY;
}
