/**
 * 前端数据加载（**运行时校验 + 两份数据独立容错**）
 *
 * 两个数据文件（均由 `pnpm sync` 生成）：
 *   - data/dataset.json  静态图鉴（CDragon + 腾讯一方，合并落盘）
 *   - data/rankings.json 官方排行榜（腾讯 101 数据站，official-aggregated）
 *
 * 用**相对路径**而不是 `/data/...`：Vite `base: './'`，构建产物可部署到任意
 * 子路径（`vite.config.ts` 的 `serveDataFiles`/`copyDataToDist` 分别负责
 * dev 挂载与 build 拷贝）。
 *
 * 不在源码中打包数据 —— 800KB+ JSON 会让构建产物无谓膨胀（构建期拷入 dist/data）。
 *
 * 容错约定（2026-11 审查 P2 #1/#2）：
 *   - 拿到 JSON 后必须过 `validate.ts` 的 `parseDataset`/`parseRankings`，
 *     形状不对 → 报「数据不兼容，请重新 pnpm sync」，不再让 computed 抛 TypeError 白屏；
 *   - 排行榜失败写进独立的 `rankingsError`，只影响榜单区，**不阻塞图鉴**；
 *   - 图鉴失败仍是整页 `error`（没有图鉴就没有可展示的主体）；
 *   - 错误文案区分 404（缺数据文件 → 提示 `pnpm sync` / 构建前生成 data/）、
 *     其它 HTTP 错误、JSON 解析失败与格式不兼容。
 *
 * 排行榜展示应标注来源与统计日期（meta.dataDate），便于用户甄别出处。
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
import { parseDataset, parseRankings } from './validate.ts';

export interface DataState {
  readonly dataset: Ref<Dataset | null>;
  readonly rankings: Ref<RankingSnapshot | null>;
  readonly loading: Ref<boolean>;
  /** 图鉴整体错误（dataset 加载/校验失败）——页面显示错误态。 */
  readonly error: Ref<string | null>;
  /** 排行榜独立错误（rankings 加载/校验失败）——只在榜单区显示，不阻塞图鉴。 */
  readonly rankingsError: Ref<string | null>;
  readonly load: () => Promise<void>;
}

/** dataset 404 的提示（dev 未 sync / 部署产物缺 data）。 */
const DATASET_NOT_FOUND_HINT =
  '未找到数据文件 data/dataset.json。开发环境请在项目根目录运行 `pnpm sync`；已部署站点请确认构建前已生成 data/（构建时会拷入 dist/data）。';

/** rankings 404 的提示（同上，但只说排行榜文件）。 */
const RANKINGS_NOT_FOUND_HINT =
  '未找到排行榜数据文件 data/rankings.json。开发环境请在项目根目录运行 `pnpm sync`；已部署站点请确认构建前已生成 data/（构建时会拷入 dist/data）。';

/** 取回并解析 JSON；非 404 的 HTTP 错误与「文件不是 JSON」单独报错。 */
async function fetchJson(url: string, notFoundHint: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(res.status === 404 ? notFoundHint : `加载 ${url} 失败：HTTP ${res.status}`);
  }
  try {
    return (await res.json()) as unknown;
  } catch {
    throw new Error(`${url} 不是合法 JSON（文件可能损坏或只写了一半），请重新 \`pnpm sync\``);
  }
}

/** 异常 → 页面可读文案（fetch 的 TypeError 等非 Error 值也兜底）。 */
function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useDataset(): DataState {
  const dataset = shallowRef<Dataset | null>(null);
  const rankings = shallowRef<RankingSnapshot | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const rankingsError = ref<string | null>(null);

  const load = async (): Promise<void> => {
    loading.value = true;
    error.value = null;
    rankingsError.value = null;

    // 两份数据并发、各管各的失败：排行榜挂了不影响图鉴展示。
    const [datasetResult, rankingsResult] = await Promise.allSettled([
      fetchJson('data/dataset.json', DATASET_NOT_FOUND_HINT).then(parseDataset),
      fetchJson('data/rankings.json', RANKINGS_NOT_FOUND_HINT).then(parseRankings),
    ]);

    if (datasetResult.status === 'fulfilled') dataset.value = datasetResult.value;
    else error.value = describeError(datasetResult.reason);

    if (rankingsResult.status === 'fulfilled') rankings.value = rankingsResult.value;
    else rankingsError.value = describeError(rankingsResult.reason);

    loading.value = false;
  };

  return { dataset, rankings, loading, error, rankingsError, load };
}

export type { Augment, Champion, Dataset, HextechStatic, Item, RankingSnapshot };
