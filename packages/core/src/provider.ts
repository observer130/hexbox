/**
 * 数据源接口 (Provider SPI)
 *
 * v2 分层（按来源类别）：
 *   - StaticProvider       官方静态定义（official-static）。
 *   - RankingProvider      官方聚合统计（official-aggregated）。
 *
 * `dataClass` 只是**描述性标签**，用于在 UI 上标明数据出处，
 * 不再有闸门/断言 —— 接哪个数据源由开发者判断，不由代码拦截。
 */

import type { Dataset, RankingSnapshot } from './types.ts';

/**
 * 数据来源标签（纯描述，无准入判定）。
 *
 * - `official-static`      官方静态定义，或官方运行时画面（截屏 + OCR）。
 * - `official-aggregated`  官方一方聚合统计（胜率/选取率/排名）。
 * - `third-party-scraped`  第三方站点数据 —— 展示时应注明出处以便甄别。
 * - `live-session`         局内实时信息（当前被提供的 3 个海克斯）。
 * - `process-invasive`     侵入性手段获取的数据 —— **不采用**。
 *                          不读内存、不注入、不打开游戏进程句柄、不解析封包。
 *                          （截屏 + OCR 不属于此列。）
 */
export type DataClass =
  | 'official-static'
  | 'official-aggregated'
  | 'third-party-scraped'
  | 'live-session'
  | 'process-invasive';

/** 所有 provider 的公共元信息。 */
export interface ProviderInfo {
  /** 稳定标识，用作缓存 key 与配置开关名。 */
  readonly id: string;
  /** 人类可读名称。 */
  readonly displayName: string;
  /** 该 provider 提供的数据类别（描述性标签，供 UI 标注出处）。 */
  readonly dataClass: DataClass;
  /** 数据来源说明（供 UI 展示出处）。 */
  readonly attribution: string;
  /** 上游地址，便于审计。 */
  readonly upstream?: string;
}

/** 官方静态数据源：海克斯/英雄/装备的定义与静态数值。 */
export interface StaticProvider {
  readonly info: ProviderInfo;
  /** 拉取完整数据集。 */
  load(signal?: AbortSignal): Promise<Dataset>;
}

/**
 * 官方聚合统计数据源（排行榜）。
 *
 * 约定：
 *   - meta.dataDate 应携带上游统计日期（dtstatdate）；
 *   - 上游无数据时应返回空快照而非旧数据冒充；
 *   - UI 展示时标注来源与数据日期。
 */
export interface RankingProvider {
  readonly info: ProviderInfo;
  load(signal?: AbortSignal): Promise<RankingSnapshot>;
}
