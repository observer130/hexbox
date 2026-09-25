# COMPLIANCE.md — 合规边界（工程约束）

> 这份文件是**可执行的行为准则**，不是免责声明。
> 对应的代码位于 `packages/core/src/compliance.ts`，由测试强制校验。

## 一句话

本项目**只展示官方公开的静态数据**，并且**刻意不使用某些技术上完全可得的统计数据**。

## 我们做什么

| 类别 | 示例 | 状态 |
|---|---|---|
| `static-definition` | 海克斯名称、图标、稀有度、所属模式池 | ✅ 允许 |
| `static-numeric` | 装备价格、合成树、属性数值 | ✅ 允许 |
| `pregame-visible` | 选人阶段阵容、玩家自选英雄 | ✅ 允许 |

数据来源：CommunityDragon（基于 Riot "Legal Jibber Jabber" 政策公开静态数据）。

## 我们刻意不做

| 类别 | 为什么不做 | 性质 |
|---|---|---|
| `augment-performance` | Riot 明文列为**不予批准的用例**：「Products cannot display win rates for Augments or Arena Mode items. This applies to all websites, applications and overlays.」 | 政策红线 |
| `live-session` | 官方 Live Client Data API **不提供**；合法途径拿不到 | **技术限制** + 政策 |
| `mode-performance` | 属**解释空间**（禁令措辞只提 Augments / Arena Mode items，未明确覆盖"某模式下英雄胜率"）。默认关闭，保守处理 | 保守选择 |

### ⚠️ 重要澄清：不是"做不到"，是"选择不做"

```
mlol.qt.qq.com/go/battle_info/odp_proxy/fuwen_aram_rune_rank_v2?augmentid_level=255
```

腾讯**一方**接口公开、免鉴权、纯 GET 即返回 219 个海克斯的胜率与选取率——
**本项目不使用它**。详见 `docs/101qq-api-findings.md`。

因此"不做胜率"是**纯粹的政策选择**，没有任何技术借口。
代码里保留了这个判断的痕迹（`DATA_POLICY.augment-performance.reason`）。

### 两点必须区分清楚

1. **违规 ≠ 违法**。Riot 的开发者政策是**合同/ToS 层面**的约束，
   违反后果是**拿不到认可 / 可能被要求下架**，不是法律责任。
2. **腾讯能做 ≠ 我们能做**。腾讯是国服**运营方（一方）**，
   我们作为**第三方开发者**受 Riot 开发者政策约束。二者适用主体不同。

## 代码如何强制执行

- `packages/core/src/compliance.ts` 定义 `DATA_POLICY` 表与 `assertDataClassAllowed()`
- Provider 在返回数据前调用该断言 → 越界在**开发期**即失败
- `packages/core/src/compliance.test.ts` 有 7 项测试锁定这些行为
- `packages/provider-registry` 的 `createPerformanceProviders()` **刻意返回空数组**

> 若有人把 `augment-performance` 改为 `allowed`，**测试会失败**。
> 这是有意为之：让合规边界在类型与测试层面可见，而非依赖记忆。

## 上线前待办

- [ ] 在 Riot 开发者门户注册本产品（政策要求：面向玩家的产品**必须**注册，
      与使用何种 API 无关）
- [ ] 产品显著位置展示 Riot 标准声明（已在 `apps/web` 页脚实现）
- [ ] 若未来要启用统计类数据，**先取得 Riot 明确书面答复**，再改 `DATA_POLICY`

## 数据来源出处标注

- 静态数据：CommunityDragon <https://raw.communitydragon.org/latest/>
- Riot 政策原文：<https://developer.riotgames.com/docs/lol>
- 本产品未获 Riot Games 认可，不代表其观点或意见。
