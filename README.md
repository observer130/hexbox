# hexbox

英雄联盟 **海克斯乱斗** 助手：数据查询站 + 游戏内悬浮窗辅助。

> **硬性约束**：不读内存、不注入、不解析封包，也不打开游戏进程句柄。
> 只使用官方/公开数据面（CommunityDragon 静态数据、本地 LCU API）。
> 详细边界见 [COMPLIANCE.md](COMPLIANCE.md)。

## 快速开始

```bash
pnpm install
pnpm sync        # 拉取 CommunityDragon 静态数据 → ./data/dataset.json
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
- 英雄列表、装备数据
- 全部来自 CommunityDragon 公开静态数据

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
pnpm test        # 全量测试（合规 7 + lcu 8）
pnpm build       # 构建所有包
```

## 架构

```
packages/
  core/                       领域模型 + 合规闸门 + Provider 接口
  provider-communitydragon/   静态数据源（v1 唯一启用）
  provider-registry/          注册表（统计类插槽刻意留空）
  data-store/                 本地缓存（原子写，支持离线读取）
  data-cli/                   sync / status CLI
  lcu/                        LCU 探测 + REST 客户端
apps/
  web/                        数据查询站（Vue 3 + Vite）
  overlay/                    悬浮窗（Electron，详见 apps/overlay/README.md）
```

数据流：`CommunityDragon --pnpm sync--> data/dataset.json --读取--> 数据站/悬浮窗`

## 合规要点（详见 COMPLIANCE.md）

- **只展示官方公开静态数据**与赛前可见信息。
- **不做**海克斯胜率/选取率 —— Riot 将其列为不予批准的用例。
  注意：该数据技术上可得（腾讯一方接口公开），不做是**主动的政策选择**，
  代码闸门位于 `packages/core/src/compliance.ts`，由测试锁定。
- **不做**局内三选一识别 —— 官方 Live Client Data API 无此数据
  （swagger 24 端点/24 schema 中 augment/cherry/kiwi/hextech/brawl 零命中），
  只能靠截屏 OCR 或读内存，均已排除。

## 合规声明

本产品未获得 Riot Games 认可，不代表 Riot Games 或任何参与制作、管理 Riot Games
财产的人士的观点或意见。Riot Games 及所有相关财产均为 Riot Games, Inc. 的商标
或注册商标。
