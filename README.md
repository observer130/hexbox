# hexbox

英雄联盟 **海克斯乱斗** 助手：数据查询站 + 游戏内悬浮窗辅助。

> **硬性约束**：不读内存、不注入、不解析封包，也不打开游戏进程句柄。

> **数据来源声明**：静态图鉴来自 CommunityDragon 与腾讯一方公开 CDN；
> 排行榜来自腾讯官方数据站 101.qq.com 的一方公开接口（判定依据见
> `packages/core/src/compliance.ts` 中 `DATA_POLICY` 的说明注释）。

## 快速开始

```bash
pnpm install
pnpm sync        # 拉取全部数据源 → ./data/dataset.json + rankings.json
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

## 功能

### 数据站（apps/web）

- 海克斯图鉴：中文名、图标、稀有度、所属模式池（KIWI / KIWI_JADE / CHERRY）
  - 双来源：CommunityDragon（国际服口径）+ 腾讯一方 CDN（国服官方数字 ID、中文描述、官方图标直链）
- 英雄列表、装备数据
- **排行榜**（数据来源：腾讯 101 官方数据站 101.qq.com）
  - 英雄榜：胜率、选取率、排名变化、平均死亡时间、参团率、伤害/承伤占比
  - 海克斯榜：各稀有度胜率/选取率/排名变化、最适配英雄
  - 随数据标注上游统计日期（dtstatdate）
- 静态数据来自 CommunityDragon 与腾讯一方公开 CDN；统计榜来自腾讯官方一方公开接口

### 悬浮窗（apps/overlay）

- 跟随游戏流阶段自动显示/隐藏（选人中、对局中）
- 模式识别：`gameMode === 'BRAWL'` 或 `queueId === 2300`（官方常量）
- 选人阶段显示我方已选英雄（赛前可见信息）
- 透明置顶、鼠标穿透可切换、不抢焦点

### LCU 探测（packages/lcu）

`node --experimental-strip-types packages/lcu/src/cli.ts --install-dir <安装目录>`

- 凭证：进程命令行（需管理员）→ 递归查找有效 lockfile → 监听端口探测（返回 401 判定）
- 国服（WeGame）实测可用：`LeagueClientUx.exe` 命令行含 `--app-port` / `--remoting-auth-token`
- 国服特有现象：`LeagueClient\lockfile` 为 0 字节，lockfile 路径不可依赖

## 常用命令

```bash
pnpm typecheck   # 全量类型检查
pnpm test        # 全量测试（合规 + lcu + provider）
pnpm build       # 构建所有包
```

## 架构

```
packages/
  core/                       领域模型 + 合规闸门 + Provider 接口
  provider-communitydragon/   国际服静态数据源
  provider-tencent/           国服一方数据源（官方图鉴 + 模式排行榜）
  provider-registry/          注册表（启用中的数据源集中登记）
  data-store/                 本地缓存（原子写，支持离线读取）
  data-cli/                   sync / status CLI
  lcu/                        LCU 探测 + REST 客户端
apps/
  web/                        数据查询站（Vue 3 + Vite）
  overlay/                    悬浮窗（Electron，详见 apps/overlay/README.md）
```

数据流：`CommunityDragon + 腾讯一方 --pnpm sync--> data/*.json --读取--> 数据站/悬浮窗`

## 合规要点

- **判定维度是数据来源，而非数据内容**：只接运营方/官方一方公开数据。
  国服由腾讯运营，101.qq.com 为腾讯官方数据站，其公开发布的
  英雄/海克斯胜率属于一方官方公开数据（`official-aggregated`），可以使用。
- 展示统计数据时必须标注来源与上游统计日期（dtstatdate）。
- **不做**局内三选一识别 —— 官方 Live Client Data API 无此数据
  （swagger 24 端点/24 schema 中 augment/cherry/kiwi/hextech/brawl 零命中），
  只能靠截屏 OCR 或读内存，均已排除。
- **手段红线永不妥协**：不读内存、不注入、不打开游戏进程句柄、不解析封包。
- 不接第三方爬取/二次加工的数据（`third-party-scraped`）。

## 合规声明

本产品未获得 Riot Games 认可，不代表 Riot Games 或任何参与制作、管理 Riot Games
财产的人士的观点或意见。Riot Games 及所有相关财产均为 Riot Games, Inc. 的商标
或注册商标。
