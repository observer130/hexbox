# hexbox

英雄联盟 **海克斯乱斗** 助手：数据查询站 + 游戏内悬浮窗辅助（**不读内存 / 不注入 / 不解析封包**）。

> 📋 开工前请先读 [COMPLIANCE.md](COMPLIANCE.md) 与 [docs/research.md](docs/research.md)。
> 其中两条结论决定了产品形态：
> 1. 官方 API **不提供**"局内被提供的 3 个海克斯" → 无法自动识别（除非读内存，已排除）
> 2. 第三方展示海克斯胜率是 Riot **不予批准的用例** → 不做
>    （注意：该数据技术上**完全可得**，所以这是**主动选择**，不是能力缺陷）

## 快速开始

```bash
pnpm install
pnpm sync        # 拉取 CommunityDragon 静态数据 → ./data/dataset.json
pnpm dev:web     # 启动数据站 → http://localhost:5273
```

启动悬浮窗（**需管理员权限 + 真实桌面环境**，详见 apps/overlay/README.md）：

```bash
pnpm dev:overlay
```

> ⚠️ **环境注意**：`pnpm` 不在系统 PATH 上（只存在于 DSH 内置运行时），
> 且 PATH 不含 `powershell.exe`。
> 在外部终端请用 `node` 直接跑脚本，例如：
> ```powershell
> node --experimental-strip-types "packages/lcu/src/cli.ts" --install-dir "E:\Games\WeGameApps\英雄联盟"
> ```
> 系统 Node：`C:\Program Files\nodejs\node.exe`（v24.19.0）。

其他命令：

```bash
pnpm typecheck   # 全量类型检查
pnpm test        # 全量测试（合规 7 项 + LCU 8 项）
pnpm build       # 构建所有包
```

## 架构

```
packages/
  core/                       领域模型 + 合规闸门 + Provider 接口
  provider-communitydragon/   静态数据源（v1 唯一启用）
  provider-registry/          注册表（含**预留**的统计类插槽）
  data-store/                 本地缓存（文件系统，支持离线降级）
  data-cli/                   同步 CLI（sync / status）
  lcu/                        LCU 探测与 REST 客户端
apps/
  web/                        数据查询站（Vue 3 + Vite）
  overlay/                    悬浮窗（Electron，见 apps/overlay/README.md）
```

### 关键设计：可插拔 Provider + 合规闸门

```
StaticProvider ──┐
                 ├─→ assertDataClassAllowed(dataClass) ─→ 数据
PerformanceProvider ─┘   （不通过则抛 ComplianceError）
```

- 统计类接口（`PerformanceProvider`）**已定义但默认不注册任何实现**
  —— 这就是"预留位置"的落点。
- 将来若 Riot 对"某模式下英雄胜率"给出肯定答复，
  只需新增实现并注册，**无需重构上层**。

## 当前数据（实测）

```
海克斯 554   KIWI 327 / KIWI_JADE 265 / CHERRY 58
英雄   245
装备   870
```

## 文档

| 文档 | 内容 |
|---|---|
| [COMPLIANCE.md](COMPLIANCE.md) | 合规边界（可执行准则） |
| [docs/research.md](docs/research.md) | 调研报告：数据源、政策分析、悬浮窗方案 |
| [docs/101qq-api-findings.md](docs/101qq-api-findings.md) | 腾讯 101 数据站接口取证 |
| [docs/lcu-probe-findings.md](docs/lcu-probe-findings.md) | 国服 LCU 探测实测结果 |

## 状态

✅ 已完成：
- 数据层（抓取 → 规范化 → 缓存）
- 合规闸门（政策写入代码 + 测试锁定）
- 查询站（Vue 3 + Vite）
- LCU 探测（国服实测通过：命令行含 token，可访问）
- 局内 swagger 验证（真实对局实测：24 端点/24 schema，无 augment 字段）
- **悬浮窗骨架（Electron，构建通过；需桌面环境实测）**

⏳ 待办：
- 悬浮窗在真实桌面 + 对局中实测（选人阶段显示、窗口定位、穿透）
- 确认国服"海克斯乱斗"对应 KIWI 还是 KIWI_JADE
- Riot 开发者门户注册

> ✅ **证据链已闭合**：局内三选一不可得 —— 官方样本 + 线上 swagger 实测（零命中）
> + 虎牙采用截屏+OCR（用户确认）三方一致。
> 原生 API（/Help）探测已降级为低优先级（可选做）：
> ```powershell
> node --experimental-strip-types packages/lcu/src/probe-help.ts
> ```
>
> 💡 探测需**管理员权限**（否则读不到进程命令行）：
> ```powershell
> node --experimental-strip-types "packages/lcu/src/cli.ts" --install-dir "E:\Games\WeGameApps\英雄联盟"
> ```
