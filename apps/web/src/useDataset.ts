/**
 * 前端数据加载
 *
 * 两个数据文件（均由 `pnpm sync` 生成）：
 *   - /data/dataset.json  静态图鉴（CDragon + 腾讯一方，合并落盘）
 *   - /data/rankings.json 官方排行榜（腾讯 101 数据站，official-aggregated）
 *
 * 不在源码中打包数据 —— 800KB+ JSON 会让构建产物无谓膨胀。
 * 排行榜加载失败不应影响图鉴展示（两份状态独立）。
 *
 * 合规边界见 packages/core/src/compliance.ts：
 * 排行榜展示必须标注来源与统计日期（meta.dataDate）。
 */

import { ref, shallowRef, type Ref } from 'vue';
import type {
  Augment,
  Champion,
  Dataset,
  HextechStatic,
  Item,
  RankingSnapshot,
} from '@hexbox/core';

export interface DataState {
  readonly dataset: Ref<Dataset | null>;
  readonly rankings: Ref<RankingSnapshot | null>;
  readonly loading: Ref<boolean>;
  readonly error: Ref<string | null>;
  readonly load: () => Promise<void>;
}

async function fetchJson<T>(url: string, notFoundHint: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(res.status === 404 ? notFoundHint : `加载 ${url} 失败: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function useDataset(): DataState {
  const dataset = shallowRef<Dataset | null>(null);
  const rankings = shallowRef<RankingSnapshot | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const load = async (): Promise<void> => {
    loading.value = true;
    error.value = null;
    try {
      // 排行榜独立容错：失败不阻塞图鉴
      const [ds, rk] = await Promise.all([
        fetchJson<Dataset>(
          '/data/dataset.json',
          '未找到数据集。请先在项目根目录运行 `pnpm sync` 生成数据。',
        ),
        fetchJson<RankingSnapshot>(
          '/data/rankings.json',
          '未找到排行榜数据。请先在项目根目录运行 `pnpm sync`。',
        ).catch(() => null),
      ]);
      dataset.value = ds;
      rankings.value = rk;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  };

  return { dataset, rankings, loading, error, load };
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

/** 国服官方图标（kiwi_augments 自带绝对直链）。 */
export function cnIconUrl(h: HextechStatic): string {
  return h.smallIcon || h.largeIcon;
}

/** 把 0..1 比率格式化为百分数字符串（保留上游精度）。 */
export function pct(rate: number, digits = 1): string {
  return (rate * 100).toFixed(digits) + '%';
}

/** 排名变化徽标样式。 */
export function rankChangeClass(n: number): string {
  return n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
}

export function rankChangeText(n: number): string {
  if (n > 0) return `↑${n}`;
  if (n < 0) return `↓${-n}`;
  return '—';
}

export type { Augment, Champion, Dataset, HextechStatic, Item, RankingSnapshot };
