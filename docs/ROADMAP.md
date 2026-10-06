# 现状与开发路线

> 本文描述**当前**状态与**接下来**要做什么。
> 历史决策过程见 [OVERLAY-STAGES.md](OVERLAY-STAGES.md) 与 git log。
> 核对时间：2026-10-04（选人阶段那一轮的验收清单见 [SESSION-NOTES.md](SESSION-NOTES.md)，
> 局内海克斯识别见 [AUGMENT-PANEL.md](AUGMENT-PANEL.md)）。

## 一、现状

| 层 | 状态 | 说明 |
|---|---|---|
| 数据管线 | ✅ 可用 | 双源图鉴 + 官方榜单 + 单英雄详情，全部预抓、可离线 |
| 数据站 | ✅ 可用 | 图鉴 + 排行榜双 Tab |
| 悬浮窗 | ⚠️ 已停用 | 2026-10-04 决策：**局内也不要侧边窗**，局内信息改由海克斯卡上的标签承担（S4 会删掉侧边窗代码）|
| 截屏覆盖层 | ⚠️ 可用待复验 | S2 已实现（卡片下方 / 确认态顶栏逐格胜率），离线全绿，**待真机复验** |
| 局内海克斯 | 🚧 进行中 | S5：门控**已用真机帧标定并验证**（3 正样本全中 / 8 负样本全拒，1/4 分辨率成立）；截屏已从"每次 0.9s 的一次性截屏"改为**常驻截屏流**（本地自测 ~18ms/帧）；名字 OCR（渲染端全分辨率）与**强度标签绘制**均已实现（S5.4c，录制工具能真机画）。⚠️ 真机复盘发现两个缺陷并已修（见 S5.4c-1/c-2）：**英雄身份取成了队友**（剑圣→154 Zac、酒桶→43 Karma）、**标签画了但屏幕上没有**（窗口可见性）。**S5.4d 已接线**：常驻 overlay（`pnpm dev:overlay`）与录制工具跑**同一份控制器**，选人/局内两个生产者的画布归属是纯函数（+19 项单测），并有降级开关 `HEXBOX_OVERLAY_AUGMENT=0`；**真机复验（S5.5）待做** |
| 配装方案 | ✅ 可用 | 出装写入客户端「配装方案」，游戏内查看 |
| LCU | ✅ 可用 | 探测 + REST + 模式识别 + 配装方案写入 |
| 工程基线 | ✅ 全绿 | **672 项测试** + typecheck（10 个项目）+ build，CI 已接入 |

### 数据集实测规模（`data/*.json`）

| 文件 | 内容 | 大小 |
|---|---|---|
| `dataset.json` | 海克斯 554（CDragon）+ 248（国服）/ **英雄 173**（+ 72 条同一英雄的变体条目 = 245 行）/ 装备 870 | ~0.87 MB |
| `rankings.json` | 海克斯榜 211 / 英雄榜 173 | ~0.22 MB |
| `builds.json` | 单英雄详情 **173** 个（= 全部真实英雄；图鉴里另 72 条是**同一英雄的变体条目**，没有独立统计）| ~4.5 MB |
| `templates.json` | 245 条英雄头像模板（173 英雄 + 72 变体条目）+ 245 个名字指纹（gzip+base64）| ~0.46 MB |

`builds.json` 每个英雄平均 **125 条**海克斯强度；出装字段实测
`itemone_json` **20 条**、`itemcore_json` **10 条**（173/173 英雄一致）。

### 关联完整性（实测）

| 关联 | 命中 |
|---|---|
| 海克斯榜 ID → 国服图鉴 | 210 / 211 |
| 英雄榜 ID → 英雄表 | 173 / 173 |
| `bestHeroes` → 英雄表 | 1266 / 1266 |

## 二、已完成（摘要）

| 阶段 | 内容 |
|---|---|
| P0 收口 | 补测试、CI 化、`cli.ts` 入口保护 |
| P1 分阶段 | 选人显示英雄胜率；局内显示该英雄的海克斯强度 |
| P2-S1/S2 | 截屏覆盖层：`vision` 包 + 卡片定位/名字 OCR + 确认态顶栏逐格胜率 |
| S5.1/S5.2 | 局内海克斯面板门控（真机帧标定为"卡片行结构 + 明暗对比"）+ 录制/基准工具 + 离线回放脚本 |
| 配装方案 | 出装写入客户端（本项目第一个写操作）|
| 若干真实 bug | 见下「已修复的坑」 |

### 已修复的坑（都值得记住）

| 缺陷 | 根因 |
|---|---|
| 测试随日历变红 | 用例把 T-1 写死成某一天，而候选日期按真实当天生成 |
| 局内显示「未识别到英雄」 | 离开选人阶段时把 `myChampionId` 清零了 |
| 未进对局时误报「读不到凭证」 | 把 404（无会话，正常）当成凭证失效 |
| 配装方案 CLI 报 `fetch failed` | 未豁免 LCU 自签证书（同一个坑第三次出现）|
| 「六神装」用户找不到出处 | 擅自使用了官方页面不展示的 `itemover_rec` 字段 |
| 「其余成装」少一半且混入出门装 | 取了 `slice(1, 11)` 而不是「全部 20 条去掉第 1 名」——多出 71.19% 的出门装、丢掉第 11~20 名（真实 bug）|
| 连不上客户端的诊断面板不再出现 | 窗口可见性只比较 `phase`，掉线时 phase 没变（真实 bug）；判定已抽成 `vision/visibility.ts` 纯函数 + 单测 |
| 确认态暗色头像不出标签 | 占用阈值 0.18 把 std=42 的暗头像判成空格（见 SESSION-NOTES）|
| 覆盖层文字发虚 / 标签闪失 | 未按 devicePixelRatio 放大画布；标签记忆 TTL 缺失 |

## 三、待办路线

### P2 — 截屏方案（S2 已实现，待真机复验）

用**截屏 + 覆盖绘制**在游戏画面内直接显示数据，替代侧边悬浮窗。

| 任务 | 说明 |
|---|---|
| S1 | ✅ 基础设施：`vision` 包（几何/定位/匹配/OCR/PNG/模板包）+ 调试 CLI |
| S2 | ✅ 选人阶段：卡片下方显示该英雄胜率；确认态顶栏**逐格**显示备选英雄胜率 |
| S2-余 | 真机复验清单见 [SESSION-NOTES.md](SESSION-NOTES.md)（3 个验收 bug 已修，待复验）|
| S3 | 召唤师技能推荐（**需先调研数据源**）|
| S4 | 移除侧边悬浮窗面板（**已决定**：2026-10-04 起局内也不显示侧边窗，代码留到本步整体删除）|

验证方法（需管理员 + 真实桌面，进入选人阶段后）：

```bash
pnpm templates                                # 构建期生成头像模板包（一次即可）
pnpm --filter @hexbox/overlay debug:capture   # 产出 debug/annotated.png
pnpm --filter @hexbox/overlay debug:overlay-test   # 覆盖层渲染自测（不需要游戏）
```

把标注图发回即可迭代定位/识别算法 —— 详见 [SCREENSHOT-DEV.md](SCREENSHOT-DEV.md)。

> **风险最高的两处**：卡片定位（分辨率/UI 缩放变化即失效）
> 与英雄识别（中文英雄名是美术字体，OCR 不可靠 → 用头像模板匹配）。
> 两处的抗噪都已做成可测纯函数：定位靠「等宽聚桶 + 间隙/等距校验」，
> 识别靠构建期灰度模板 + 名字指纹（宁漏勿错）。
> ⚠️ 卡片**立绘**不能用头像模板匹配（实测假阳性系统性存在），
> 立绘只走名字 OCR；头像模板只用于确认态顶栏的方头像。

### S5 — 局内海克斯识别（🚧 进行中，详见 [AUGMENT-PANEL.md](AUGMENT-PANEL.md)）

对局中「三选一海克斯」面板一出现，就在每张卡下方显示「该英雄 × 该海克斯」的强度。

**为什么不能按时间猜**：刷新时刻不固定（回合节奏、可重随、可关了再开），
且接口侧没有任何信号 —— 真机 swagger 全量核对（24 端点 / 24 schema）里
`augment`/`cherry`/`kiwi`/`hextech`/`brawl` **零命中**。
所以只能从屏幕识别**面板的开/关边沿**：面板出现 = 刷新事件。

判据（已用真机帧标定）：卡片行**结构**（3 张等宽卡、间隙 0.020、高度 48.7%）
+ **明暗对比**（卡片内部 < 40 且「边框 − 内部」≥ 70）。
⚠️ 第一版用"相对基线压暗"，因录制恰好从面板打开时开始而**整局 0 命中**，已废弃。

| 任务 | 说明 | 状态 |
|---|---|---|
| S5.1 | 录制工具 `debug:augment`（时间线 + 边沿帧 + 耗时 + 截屏基准）| ✅ |
| S5.1b | 真机帧离线标定（判据/阈值/分辨率下限 1/4）| ✅ |
| S5.2 | 门控纯函数 `vision/augment-panel.ts` + 去抖状态机 | ✅ 16 项单测 |
| S5.2b | 截屏基准 → **一次性截屏不可用**（16px 缩略图仍要 707ms）| ✅ 真机已跑 |
| S5.2c | 常驻截屏流（`augment-stream` + `capture/worker` + `/browser` 子入口）| ✅ 本地自测通过（~18ms/帧） |
| S5.2d | 真机验证流 + 节流 + 判据（一局真实对局）| ✅ 通过：14.1ms/帧、高频占比 13.6%、认出 1 次面板、零假阳性 |
| S5.2f | 修边沿取证（抓成客户端窗口 / 阻塞造出假边沿）| ✅ 已修 |
| S5.2e | 节流（常态 1s / 命中 250ms）：一局只出现 4 次，没必要一直高频 | ✅ 10 项单测 + 自测通过 |
| S5.3 | 海克斯识别 → **名字 OCR**（218 字库，真机两帧全对 0.64~0.71 / 分差 0.08~0.17）| ✅ `vision/augment-ocr.ts` + 10 项单测 |
| S5.3b | 图标通道（只作同名消歧钩子）| ⏸ dataset **0 重名**，且专属型卡面用英雄专属图标 → 暂不投入 |
| S5.6 | **常态不截屏**：API 触发（死亡 + 等级达标 + 该次未选 → 开；连选保持）| ✅ 14 项单测 + 本地冒烟（常态一帧不取 / API 挂了退回像素节流）|
| S5.6b | 真机验证 API 触发（含连选）| ⏳ HEXBOX_AUGMENT_TRIGGER=api |
| S5.4a | 标签位置纯函数 `vision/augment-label.ts`（卡内底部空白区）| ✅ 6 项单测 |
| S5.4b | 全分辨率识别搬进渲染端（从屏幕流取原生帧）| ✅ worker `recognize` + `onRecognized` 回传小 JSON |
| S5.4c | **局内强度标签**：纯函数 `vision/augment-tier-label.ts` + 接线（打印/落盘/画到 S2 那块画布）+ 关闭边沿清空 | ✅ 15 项单测；录制工具 `debug:augment` 能画（AUGMENT-PANEL §十二）|
| S5.4c-1 | **英雄身份只认"我自己"**（真机事故：拿到队友 → 显示别人的强度表）：`lcu/champion-identity.ts`（纯函数）+ `my-champion.ts`，`report.json` 记 `championIdSource` | ✅ 37 项单测；`none` 时**一张都不画** |
| S5.4c-2 | **覆盖窗可见性**：推送后重申置顶 + 1s 心跳重推 + `backgroundThrottling:false`；新增**不需要游戏**的自测 `HEXBOX_LABEL_OVERLAY_TEST=1`（左/中/右三个大字母，5 秒退出）| ✅ 自测逻辑纯函数 6 项单测；**待真机自测 + 对局复验** |
| S5.4d | 同一条链路接进常驻 overlay（`pnpm dev:overlay`，局内 `InProgress`/`Reconnect` 时）| ✅ 抽出公共控制器 `main/augment-controller.ts`（录制工具与常驻覆盖层**共用**）；画布归属 `labelProducerFor()` + 启停 `augmentChainTransition()`（+19 项单测）；降级开关 `HEXBOX_OVERLAY_AUGMENT=0`；常态零取帧、退出干净（AUGMENT-PANEL §十六）|
| S5.5 | 真机复验（延迟 / 不误画 / 性能）| ⏳ |

```bash
pnpm --filter @hexbox/overlay debug:augment           # 在一局真实对局中录制
$env:HEXBOX_AUGMENT_BENCH='1'; pnpm --filter @hexbox/overlay debug:augment   # 30 秒截屏基准
$env:HEXBOX_LABEL_OVERLAY_TEST='1'; pnpm --filter @hexbox/overlay debug:augment  # 覆盖窗自测（不需要游戏）
node --experimental-strip-types scripts/diag-augment-frames.mts <帧.png...>   # 离线回放真机帧
```

### P3 — 数据站增强（低风险，可并行）

| 任务 | 说明 |
|---|---|
| 装备浏览页 | `items` 已抓 870 条，但前端只显示数量、无浏览页 |
| 英雄详情页 | 跳转英雄的适配海克斯 |
| 图鉴筛选 | 按「新海克斯」（`isNew`）筛选；展示国服 `tooltip` |
| 补丁版本追踪 | `Dataset.meta.patch` 恒为 `null`，可接 CDragon `version.json` |

### 不做（数据不支持，避免臆想）

| 项 | 原因 |
|---|---|
| Tier 强度分级（T0/T1…）| 官方页的 T0 是**前端计算**，任何接口都不返回；不自行编公式 |
| 「以英雄为准」的完整海克斯强度排序 | 上游无 per-(英雄×海克斯) 全量统计 |
| 海克斯联动/冲突提醒 | 需人工维护规则表，上游无字段 |
| 「成型六件套」槽位 | `itemover_rec` 官方页面不展示；类型与渲染已整体删除 |

## 四、常用验证命令

```bash
pnpm test        # 672 项，应全绿
pnpm typecheck   # 10 个 workspace 项目
pnpm build       # web + overlay
pnpm sync        # 重新拉取数据（联网）
pnpm templates   # 重建头像/名字模板包（联网）

pnpm --filter @hexbox/web dev      # 数据站 :5273
pnpm --filter @hexbox/overlay dev  # 悬浮窗（需管理员 + 真实桌面）

# 局内海克斯：门控 + 识别 + 强度标签（需管理员 + 真实对局；产物在 debug/augment/）
$env:HEXBOX_AUGMENT_TRIGGER='api'; pnpm --filter @hexbox/overlay debug:augment

# 标签外观预览：**不需要游戏**，三档尺寸画在真机帧上 → debug/label-preview.png
node --experimental-strip-types scripts/preview-augment-labels.mts

# 配装方案（需管理员）
node --experimental-strip-types packages/lcu/src/itemset-cli.ts list
```
