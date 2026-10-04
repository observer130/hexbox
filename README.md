# hexbox

英雄联盟 **海克斯乱斗**（Hextech Mayhem / Brawl）助手：数据查询站 + 游戏内辅助。

> **硬性约束**：不读内存、不注入、不解析封包，也不打开游戏进程句柄。
> 只使用官方/一方公开数据面（CommunityDragon、腾讯 101 官方站、本地 LCU REST）。
> 截屏 + OCR **不属于**侵入手段 —— 它只读取屏幕上玩家肉眼可见的像素。

> **数据来源**：静态图鉴来自 CommunityDragon 与腾讯一方公开 CDN；
> 榜单与单英雄详情来自腾讯官方数据站 101.qq.com 的一方公开接口。
> 展示时标注来源与统计日期。

## 快速开始

```bash
pnpm install
pnpm sync        # 拉取全部数据源 → ./data/*.json（图鉴 + 榜单 + 英雄详情）
pnpm dev:web     # 数据站 → http://localhost:5273
```

悬浮窗（需**管理员权限**与真实桌面会话）：

```bash
pnpm dev:overlay
```

### 环境说明

- 工具链：Node 20+ / pnpm 11.7.0（见 `packageManager` 字段）。
- 若 `pnpm` 不在 PATH 上，用系统 Node 直接跑脚本：
  `node --experimental-strip-types packages/data-cli/src/cli.ts sync`
- 本项目以 **TS 源码直接运行**（strip-only），因此 import 必须带 `.ts` 扩展名，
  且禁用 `enum` / 参数属性 / `namespace`（`erasableSyntaxOnly`）。

## 功能现状

### 数据站（apps/web）

单页应用，两个区块：

- **海克斯图鉴**：中文名、图标、稀有度、所属模式池（KIWI / KIWI_JADE / CHERRY）；
  双来源合并展示（CommunityDragon 国际服口径 + 腾讯国服官方口径）
- **排行榜**（来源 101.qq.com，随数据标注统计日期 `dtstatdate`）
  - 海克斯榜：胜率、选取率、排名变化、最适配英雄
  - 英雄榜：胜率、选取率、排名变化、平均死亡时间、参团率、伤害/承伤占比

> ⚠️ 尚无**英雄列表页**与**装备浏览页** —— 两者目前只在统计卡片里显示数量。
> （装备页见 docs/ROADMAP.md 的 P3 待办。）

### 悬浮窗（apps/overlay）

**按阶段显示不同内容** —— 玩家在各阶段做的决策不同，显示无关数据只会干扰：

| 阶段 | 显示内容 |
|---|---|
| 英雄选择 | 所选英雄的**海斗胜率** |
| 英雄选择（截屏覆盖层） | 每张英雄卡片下方 / 确认态顶栏每个备选头像下方显示胜率 |
| 对局中 | 该英雄口径的**海克斯强度 S/A/B/C + 登场率** |
| 对局中 | **出装建议**（出门装 / 优先成装 / 其余成装，含胜率） |

跨阶段通用：游戏流阶段、模式识别（`gameMode === 'BRAWL'` 或
`queueId === 2300`）、我方已选英雄、数据出处与统计日期。

全部数据由 `pnpm sync` 预抓到 `data/`，悬浮窗**只读本地、离线可用**。
截屏覆盖层另需一次 `pnpm templates` 生成头像/名字模板包（`data/templates.json`），
运行时同样只读本地。

详见 [apps/overlay/README.md](apps/overlay/README.md) 与
[docs/SCREENSHOT-DEV.md](docs/SCREENSHOT-DEV.md)。

### 配装方案写入（packages/lcu）

把推荐出装直接写进客户端的「配装方案」，游戏内即可查看：

```bash
# 需管理员权限
node --experimental-strip-types packages/lcu/src/itemset-cli.ts list
node --experimental-strip-types packages/lcu/src/itemset-cli.ts write 266
node --experimental-strip-types packages/lcu/src/itemset-cli.ts clean
```

只操作标题以 `hexbox` 开头的方案，**玩家手写的方案不会被覆盖或删除**。

### LCU 探测（packages/lcu）

```bash
node --experimental-strip-types packages/lcu/src/cli.ts --install-dir <安装目录>
```

- 凭证来源：进程命令行（需管理员）→ 显式安装目录的 lockfile → 自动发现的 lockfile
- 端口探测**只用于诊断**：它能定位 LCU 端口，但拿不到 token
  （token 只在命令行与 lockfile 里），因此不产出凭证
- 国服（WeGame）特有现象：`LeagueClient\lockfile` 为 **0 字节**
  （实测 `E:\Games\WeGameApps\英雄联盟\LeagueClient\lockfile`），不可依赖

> **三个已踩过的坑（不要重犯）** —— 详见 [AGENTS.md](AGENTS.md)
>
> 1. **LCU 请求必须豁免自签证书**。裸 `fetch` 会抛
>    `SELF_SIGNED_CERT_IN_CHAIN`（对外只表现为 `fetch failed`）。
>    一律走 `LcuClient`，它内部已用 `withInsecureTls()` 按请求豁免并保证还原。
> 2. **不要全局设置 `NODE_TLS_REJECT_UNAUTHORIZED`** ——
>    那会让所有其它 HTTPS 请求（含外部数据源）一并失去校验。
> 3. **「无会话」不等于「凭证失效」**。大厅里
>    `/lol-gameflow/v1/session` 返回 404 是正常的，
>    只有 401/403 才说明凭证有问题。

## 常用命令

```bash
pnpm typecheck   # 全量类型检查（11 个 workspace 项目）
pnpm test        # 全量测试（274 项）
pnpm build       # 构建所有包
```

## 架构

```
packages/
  core/                       领域模型 + Provider 接口 + 纯视图模型
                              （overlay-view 分阶段 / itemset 配装方案）
  vision/                     截屏识别（几何/定位/头像与名字匹配/PNG/模板包
                              /确认态顶栏逐格识别/标签记忆/可见性判定），纯函数
  provider-communitydragon/   国际服静态数据源
  provider-tencent/           国服一方数据源（图鉴 + 榜单 + 单英雄详情）
  provider-registry/          注册表（启用中的数据源集中登记）
  data-store/                 本地缓存（原子写，支持离线读取）
  data-cli/                   sync / status / templates CLI
  lcu/                        LCU 探测 + REST 客户端 + 配装方案写入
apps/
  web/                        数据查询站（Vue 3 + Vite）
  overlay/                    悬浮窗 + S2 截屏覆盖层（Electron）
data/                         sync / templates 产物（gitignored）
```

数据流：

```
CommunityDragon ─┐
腾讯一方图鉴     ─┼─ pnpm sync ─→ data/dataset.json    ─┐
腾讯 101 榜单    ─┤              data/rankings.json   ─┼─→ 数据站 / 悬浮窗
腾讯 101 英雄详情 ┘              data/builds.json     ─┘
CDragon 头像/名字 ── pnpm templates ─→ data/templates.json ─→ 截屏覆盖层识别
```

## 文档索引

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 给 AI agent 的开发约定与已踩过的坑 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 现状盘点与后续路线 |
| [docs/OVERLAY-STAGES.md](docs/OVERLAY-STAGES.md) | 悬浮窗分阶段设计的调研依据 |
| [docs/build-slots.md](docs/build-slots.md) | 出装槽位与上游字段的对照（已核实） |
| [docs/SCREENSHOT-DEV.md](docs/SCREENSHOT-DEV.md) | 截屏覆盖层的技术事实与实现状态 |
| [docs/SESSION-NOTES.md](docs/SESSION-NOTES.md) | 最近一轮会话的交接备忘（真机验收 bug 记录） |

## 法律声明

本产品未获得 Riot Games 认可，不代表 Riot Games 或任何参与制作、管理 Riot Games
财产的人士的观点或意见。Riot Games 及所有相关财产均为 Riot Games, Inc. 的商标
或注册商标。
