/**
 * Provider 注册表
 *
 * 所有启用中的数据源在此集中登记。每个 provider 的 dataClass
 * 在注册时经 compliance gate 校验（见 register* 系列函数），
 * 使「越界来源」在开发期就失败。
 *
 * 现役来源（均为运营方官方公开渠道）：
 *   - CommunityDragon        official-static    国际服图鉴
 *   - 腾讯一方图鉴            official-static    国服官方数字 ID / 描述 / 图标
 *   - 腾讯 101 数据站         official-aggregated 模式胜率 / 选取率 / 排行
 *
 * 新增来源的步骤：
 *   1. 确认属于 official-static / official-aggregated（运营方官方公开）
 *   2. 在 DATA_POLICY（packages/core/src/compliance.ts）中登记来源与理由
 *   3. 实现 provider 并在此注册
 *   4. 补测试，跑 pnpm test && pnpm typecheck
 */

import {
  assertDataSourceAllowed,
  type RankingProvider,
  type StaticProvider,
} from '@hexbox/core';

import { createCommunityDragonProvider } from '@hexbox/provider-communitydragon';
import {
  createTencentRankingProvider,
  createTencentStaticProvider,
} from '@hexbox/provider-tencent';

/** 启用的静态图鉴数据源（合并进 dataset.json）。 */
export function createStaticProviders(): StaticProvider[] {
  return [
    registerStaticProvider(createCommunityDragonProvider()),
    registerStaticProvider(createTencentStaticProvider()),
  ];
}

/** 启用的官方统计数据源（写入 rankings.json）。 */
export function createRankingProviders(): RankingProvider[] {
  return [registerRankingProvider(createTencentRankingProvider())];
}

/** 注册静态 provider，附带合规校验（唯一的启用入口）。 */
export function registerStaticProvider(provider: StaticProvider): StaticProvider {
  assertDataSourceAllowed(provider.info.dataClass);
  return provider;
}

/** 注册排行榜 provider，附带合规校验（唯一的启用入口）。 */
export function registerRankingProvider(provider: RankingProvider): RankingProvider {
  assertDataSourceAllowed(provider.info.dataClass);
  return provider;
}
