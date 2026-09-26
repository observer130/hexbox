/**
 * Provider 注册表
 *
 * 所有启用中的数据源在此集中登记。`dataClass` 只是描述性标签，
 * 用于在 UI 上标注数据出处 —— 没有闸门，接哪个源由开发者判断。
 *
 * 现役来源（均为运营方官方公开渠道）：
 *   - CommunityDragon        official-static    国际服图鉴
 *   - 腾讯一方图鉴            official-static    国服官方数字 ID / 描述 / 图标
 *   - 腾讯 101 数据站         official-aggregated 模式胜率 / 选取率 / 排行
 *
 * 新增来源时建议：
 *   1. 填写 info.dataClass（描述性标签）与 info.attribution（出处）
 *   2. 实现 provider 并在此注册
 *   3. 跑 pnpm test && pnpm typecheck
 */

import type { RankingProvider, StaticProvider } from '@hexbox/core';

import { createCommunityDragonProvider } from '@hexbox/provider-communitydragon';
import {
  createTencentRankingProvider,
  createTencentStaticProvider,
} from '@hexbox/provider-tencent';

/** 启用的静态图鉴数据源（合并进 dataset.json）。 */
export function createStaticProviders(): StaticProvider[] {
  return [createCommunityDragonProvider(), createTencentStaticProvider()];
}

/** 启用的官方统计数据源（写入 rankings.json）。 */
export function createRankingProviders(): RankingProvider[] {
  return [createTencentRankingProvider()];
}
