/**
 * 数据源接口 (Provider SPI)
 *
 * v2 分层（按来源类别）：
 *   - StaticProvider       官方静态定义（official-static）。
 *   - RankingProvider      官方聚合统计（official-aggregated）。
 *
 * 关键约定：任何 provider 在返回数据前都必须声明其 DataClass，
 * 由注册表统一校验 —— 「合规」是架构的一部分，而非调用者的自觉。
 */

import type { DataClass } from './compliance.ts';
import type { Dataset, RankingSnapshot } from './types.ts';

/** 所有 provider 的公共元信息。 */
export interface ProviderInfo {
  /** 稳定标识，用作缓存 key 与配置开关名。 */
  readonly id: string;
  /** 人类可读名称。 */
  readonly displayName: string;
  /** 该 provider 提供的数据类别（注册时经 compliance gate 校验）。 */
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
 * 实现要求（与 compliance.ts 中 `official-aggregated` 的策略一致）：
 *   - meta.dataDate 必须携带上游统计日期（dtstatdate）；
 *   - 上游无数据时应返回空快照而非旧数据冒充；
 *   - UI 展示时必须标注来源与数据日期。
 */
export interface RankingProvider {
  readonly info: ProviderInfo;
  load(signal?: AbortSignal): Promise<RankingSnapshot>;
}
