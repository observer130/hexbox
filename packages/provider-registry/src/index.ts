/**
 * Provider 注册表
 *
 * 这是"预留位置"的**具体落点**：
 *   - STATIC_PROVIDERS：v1 启用（CommunityDragon）
 *   - PERFORMANCE_PROVIDERS：**默认为空数组**
 *
 * 为什么不现在就塞一个统计 provider 进去：
 *   它不是"没写"，而是"刻意不启用"。注册表里留空数组 + 注释，
 *   比任何文档都更能阻止后来者顺手接上。
 *
 * 启用步骤（当 Riot 明确答复后）：
 *   1. 在 packages/provider-* 下实现 PerformanceProvider
 *   2. 确认其 dataClass 的 DATA_POLICY 已改为 allowed（见 compliance.ts）
 *   3. 在此处注册
 *   4. 跑 `pnpm test` —— compliance 测试会校验策略一致性
 */

import {
  assertDataClassAllowed,
  type PerformanceProvider,
  type StaticProvider,
} from '@hexbox/core';

import { createCommunityDragonProvider } from '@hexbox/provider-communitydragon';

/** v1 启用的静态数据源。 */
export function createStaticProviders(): StaticProvider[] {
  return [createCommunityDragonProvider()];
}

/**
 * 统计类数据源 —— **刻意留空**。
 *
 * 已知的候选（技术上可得，但**当前政策不允许**）：
 *
 *   - mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_aram_rune_rank_v2
 *     腾讯一方接口，海克斯级胜率/选取率。dataClass = 'augment-performance' ❌ 明令禁止
 *
 *   - mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_aram_hero_rank_v2
 *     同源，模式内英雄胜率。dataClass = 'mode-performance' ⚠️ 属解释空间，默认关闭
 *
 * 详见 docs/research.md §4.3 与 docs/101qq-api-findings.md。
 */
export function createPerformanceProviders(): PerformanceProvider[] {
  return [];
}

/**
 * 注册一个统计 provider，附带合规校验。
 *
 * 这是**唯一的**启用入口，且会强制走 compliance gate ——
 * 使得"越界"在开发期就失败，而不是上线后被审查发现。
 */
export function registerPerformanceProvider(provider: PerformanceProvider): PerformanceProvider {
  assertDataClassAllowed(provider.info.dataClass);
  return provider;
}
