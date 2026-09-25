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
> 详见 [docs/lcu-probe-findings.md](../../docs/lcu-probe-findings.md)。

## 功能边界（合规）

| 显示 | 不显示（原因） |
|---|---|
| 当前游戏流阶段 | 海克斯胜率/选取率（Riot 明令禁止） |
| 模式识别（是否海克斯乱斗） | 局内被提供的 3 个海克斯（官方 API 无此数据） |
| 静态海克斯图鉴条数 | "该选哪个"的单一推荐（政策禁止替玩家决定） |
| 选人阶段我方已选英雄（赛前可见） | |

合规逻辑由 `packages/core/src/compliance.ts` 强制，改动会被测试拦截。

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
data/dataset.json ──启动时读取──→ 主进程
```

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
