# 悬浮窗（Overlay）

游戏内悬浮窗辅助。**不注入 / 不读内存 / 不打开游戏进程句柄 / 不解析封包**。

## 快速开始

```powershell
# 1. 先同步静态数据（仓库根执行）
pnpm sync

# 2. 启动悬浮窗
cd apps/overlay
pnpm dev
```

> ⚠️ **必须以管理员身份运行**，否则读不到 LCU 凭证（进程命令行被 Windows 屏蔽）。

## 功能

**设计原则：不同阶段显示不同内容。** 玩家在各阶段做的决策不同，
显示与该阶段无关的数据只会干扰（详见 [docs/OVERLAY-STAGES.md](../../docs/OVERLAY-STAGES.md)）。

| 阶段 | 显示内容 | 状态 |
|---|---|---|
| **英雄选择** | **所选英雄的海斗胜率**（选人时玩家在选英雄，此时海克斯尚未出现） | 已实现 |
| **对局中** | 该英雄口径的**海克斯强度 S/A/B/C + 登场率** | 已实现 |
| **对局中** | **出装建议**：出门装 / 鞋 / 核心三件套 / 成型六件套（含胜率） | 已实现 |
| 通用 | 游戏流阶段、模式识别、我方已选英雄、数据出处与统计日期 | 已实现 |
| 局内被提供的 3 个海克斯（**截屏 + OCR**） | | 待实现 |

数据来自 `data/`（`dataset.json` 图鉴 + `rankings.json` 榜单 + `builds.json`
单英雄详情），全部由 `pnpm sync` 预抓，悬浮窗**只读本地、离线可用**。

> **措辞约束**：海克斯面板回答的是「**这个英雄**官方统计上哪些海克斯强度高」，
> **不是**「你被提供了什么」。局内三选一的识别需要截屏 + OCR，属后续计划。
> UI 已写明这一点，避免误导。
>
> **列名不可写错**：海克斯表的数字是**登场率**，不是胜率。

> **ID 桥**：海克斯与装备都是**国服数字 ID**，必须经 `dataset.hextechs`
> 与 `dataset.items` join，不能用 CDragon 的 `Augment.id` 硬匹配 ——
> 两套官方 ID 不可换算。

**不采用的手段**：读内存、注入、打开游戏进程句柄、解析封包。
截屏 + OCR **不属于**此类 —— 它只读取玩家肉眼可见的屏幕像素，是正常做法。

## 架构

```
src/main/index.cjs      主进程：LCU 轮询、数据集读取、窗口定位/穿透
src/preload/index.cjs   桥接：只暴露白名单 IPC（contextIsolation=true）
src/renderer/           渲染端：纯浏览器，只接收主进程推送的状态
```

**为什么渲染端不做 IO**：渲染端是浏览器环境，`@hexbox/lcu`（child_process）、
`@hexbox/data-store`（fs）无法在浏览器 bundle 中解析。
所有 Node 工作集中在主进程，渲染端通过 `overlay:state` 单向接收状态。

## 关键实现点

### 窗口
- `transparent: true` + `frame: false` + `alwaysOnTop: 'screen-saver'`
- `focusable: false` —— **不抢焦点**，否则游戏丢输入
- `showInactive()` 显示，不用 `show()`
- `setIgnoreMouseEvents(true, { forward: true })` 鼠标穿透（右上角按钮可切换）

### 定位
- 每秒轮询游戏窗口矩形（`user32!GetWindowRect`，**只读几何信息**）
- 贴游戏窗口右侧，多显示器 / DPI 自动适配
- 查不到游戏窗口时降级到主显示器右侧

### 数据流
```
LCU (127.0.0.1:port) ──poll 2s──→ 主进程 ──overlay:state──→ 渲染端
data/dataset.json  ─┐
                    ├─启动时读取一次→ 主进程 join 好榜单 → 随状态推送
data/rankings.json ─┘
```

榜单在**启动时算一次**（`buildRankBoard`），而不是每次轮询重算 ——
榜单是日更的静态数据，每 2s 重算 211 条纯属浪费。

join + 分组 + 排序逻辑放在 `@hexbox/core/rankboard.ts`（纯函数）。
放 core 而非主进程的原因：悬浮窗需要管理员权限 + 真实桌面会话，
**CI 根本跑不起来**，只有把逻辑抽成纯函数才能被单元测试覆盖。

## 构建

```powershell
node build.mjs     # 产物: dist/main/index.cjs, dist/preload/index.cjs, dist/renderer/*
```

为什么用 esbuild 而非纯 tsc：
主进程/preload 需要打包 workspace 依赖（`@hexbox/lcu` 等），
Electron 渲染端也需单文件 IIFE。

### 两个踩过的坑

1. **`"type": "module"` 与 `.js` 产物冲突**
   项目根是 ESM，Electron 会把 `.js` 当 ESM 加载，报 `require is not defined`。
   → 产物用 `.cjs` 扩展名。

2. **`ELECTRON_RUN_AS_NODE=1`（DSH harness 环境）**
   该变量会让 electron.exe 以纯 Node 运行，`require('electron')` 返回路径字符串而非 API。
   → 桌面环境正常；在 harness 内启动会失败（exit 0x80000003），需真实桌面运行。
