/**
 * 前端数据加载
 *
 * v1 直接从 `/data/dataset.json` 读取（由 `pnpm sync` 生成）。
 * 不在此处打包数据 —— 763KB JSON 会让构建产物无谓膨胀。
 *
 * 将来若接入统计 provider，只需在此文件增加一个加载函数，
 * 并在 UI 中标注数据来源 —— 合规边界见 packages/core/src/compliance.ts。
 */

import { ref, shallowRef, type Ref } from 'vue';
import type { Augment, Champion, Dataset, Item } from '@hexbox/core';

export interface DataState {
  readonly dataset: Ref<Dataset | null>;
  readonly loading: Ref<boolean>;
  readonly error: Ref<string | null>;
  readonly load: () => Promise<void>;
}

export function useDataset(): DataState {
  const dataset = shallowRef<Dataset | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const load = async (): Promise<void> => {
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch('/data/dataset.json');
      if (!res.ok) {
        throw new Error(
          res.status === 404
            ? '未找到数据集。请先在项目根目录运行 `pnpm sync` 生成数据。'
            : `加载数据集失败: HTTP ${res.status}`,
        );
      }
      dataset.value = (await res.json()) as Dataset;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  };

  return { dataset, loading, error, load };
}

/** 稀有度显示配置。 */
export const RARITY_META: Record<
  Augment['rarity'],
  { label: string; color: string; order: number }
> = {
  kPrismatic: { label: '棱彩', color: 'var(--prismatic)', order: 0 },
  kGold: { label: '黄金', color: 'var(--gold)', order: 1 },
  kSilver: { label: '白银', color: 'var(--silver)', order: 2 },
  kEventChoice: { label: '事件抉择', color: 'var(--event)', order: 3 },
};

export const MODE_META: Record<string, { label: string; hint: string }> = {
  KIWI: { label: '海克斯乱斗', hint: '主模式海克斯池' },
  KIWI_JADE: { label: '海克斯乱斗 · Jade', hint: 'Jade 变体池（更大）' },
  CHERRY: { label: '斗魂竞技场', hint: 'Arena（2v2v2v2）' },
};

export function iconUrl(iconPath: string): string {
  // CDragon 资源路径形如 /lol-game-data/assets/...
  return iconPath ? `https://raw.communitydragon.org/latest/plugins${iconPath}` : '';
}

export type { Augment, Champion, Item, Dataset };
