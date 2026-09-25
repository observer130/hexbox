/**
 * 数据源接口 (Provider SPI)
 *
 * 设计目标：让"未来可能合规的统计类数据"有一个**预留位置**，
 * 而不必现在就实现或重构。
 *
 * 分层：
 *   - StaticProvider      静态定义类。v1 唯一启用的来源（CommunityDragon）。
 *   - PerformanceProvider 统计类。**接口已定义，实现默认不注册**。
 *                         启用前必须通过 compliance gate。
 *
 * 关键约定：任何 provider 在返回数据前都必须声明其 DataClass，
 * 由网关统一校验 —— 这样"合规"是架构的一部分，而非调用者的自觉。
 */

import type { DataClass } from './compliance.ts';
import type { Dataset, DatasetMeta } from './types.ts';

/** 所有 provider 的公共元信息。 */
export interface ProviderInfo {
  /** 稳定标识，用作缓存 key 与配置开关名。 */
  readonly id: string;
  /** 人类可读名称。 */
  readonly displayName: string;
  /** 该 provider 提供的数据类别。 */
  readonly dataClass: DataClass;
  /** 数据来源说明（供 UI 展示出处）。 */
  readonly attribution: string;
  /** 上游地址，便于审计。 */
  readonly upstream?: string;
}

/** 静态数据源：海克斯/英雄/装备的定义与静态数值。 */
export interface StaticProvider {
  readonly info: ProviderInfo;
  /** 拉取完整数据集。 */
  load(signal?: AbortSignal): Promise<Dataset>;
}

/**
 * 统计类数据源 —— **预留接口，v1 不注册任何实现**。
 *
 * 之所以现在就定义：一旦 Riot 对"某模式下英雄胜率"给出肯定答复，
 * 只需新增一个实现并在 registry 中注册，无需改动上层。
 *
 * ⚠️ 实现者注意：不要在此接口下返回海克斯级 (augment-performance) 数据。
 * 该类数据已被 DATA_POLICY 明确禁止。
 */
export interface PerformanceProvider {
  readonly info: ProviderInfo;
  /** 数据所对应的统计日期（如 `20260924`）。 */
  load(signal?: AbortSignal): Promise<PerformanceSnapshot>;
}

/**
 * 统计快照 —— 刻意保持**键为实体 ID** 而非内嵌实体，
 * 以便调用方自行决定如何 join 静态定义。
 */
export interface PerformanceSnapshot {
  readonly meta: DatasetMeta;
  /** 实体 ID -> 各项比率 (0..1)。 */
  readonly entries: readonly PerformanceEntry[];
}

export interface PerformanceEntry {
  /** 实体 ID：英雄 ID 或海克斯 ID，取决于 provider 的 dataClass。 */
  readonly entityId: number;
  readonly winRate: number;
  readonly pickRate: number;
  /** 可选：与之搭配最佳的实体 ID 列表。 */
  readonly bestWith?: readonly number[];
}
