# hexbox

英雄联盟 **海克斯乱斗**（Hextech Mayhem / Brawl 轮换模式）的辅助工具。

> **硬性边界**：只使用官方 / 一方数据面，外加**对官方界面的截图识别**（只读屏幕上玩家肉眼可见的像素）。
> **绝不**读游戏内存、不注入、不 hook 游戏进程、不解析封包、不打开游戏进程句柄。

## 这是什么

| 界面 | 是什么 | 技术 |
|---|---|---|
| **数据站** `apps/web` | 查海克斯（强化符文）：中文名、图标、品质、所属模式池；看国服官方榜单（海克斯榜 / 英雄榜：胜率、登场率、排名变化等） | Vue 3 + Vite |
| **覆盖层** `apps/overlay` | 在**游戏画面上直接贴标签**，在选人 / 三选一 / 出装时帮你做决定 | Electron |

数据站：`pnpm dev:web` → <http://localhost:5273>

> ⚠️ 数据站目前只有**海克斯图鉴 + 排行榜**两个区块。**英雄（173）**与装备（870）已经抓到本地，
> 但还没有浏览页 —— 它们只在统计卡片里显示数量（见 [docs/ROADMAP.md](docs/ROADMAP.md) 的 P3）。
>
> 「英雄」的口径要说清：`data/dataset.json` 的 `champions` 有 **245 条**，那是上游
> CommunityDragon `champion-summary.json` 的**行数** —— 其中 **173 条是真实英雄**
> （与 `data/builds.json` 的 `details` 逐个 ID 相等），另外 **72 条是同一英雄的变体条目**
> （`Jade_*`，第二套 ID `60001+`，59 条与真实英雄同名、13 条用的是改名前的旧中文名）。
> 界面与文档一律显示 **173**，变体条目单独说明，绝不把 245 当英雄数
> （口径判定是纯函数 `countChampionSet()`，见 `packages/core/src/champion-set.ts`）。

## 覆盖层能做什么

**设计原则：不同阶段显示不同内容**（玩家在各阶段的决策不同，见 [docs/OVERLAY-STAGES.md](docs/OVERLAY-STAGES.md)）。

1. **选人阶段：英雄胜率标签**
   在每张英雄卡下方显示该英雄的海斗胜率；锁定后，顶栏「可用」栏逐格显示备选英雄胜率。
   来源是屏幕截图 + 头像/名字识别，不碰游戏进程。

2. **局内三选一海克斯：强度评级 + 选取率**
   在三张卡**下方的空白区水平居中**显示该英雄这颗海克斯的**档位字母（S / A / B / C，按档配色）**与一行
   **「选取率 x%」**（就是官方表的登场率那一列）。数据来自国服官方的**「该英雄海克斯强度表」**：
   - **只画官方有的**：认不出是哪颗海克斯、或官方表里查不到这一颗 → **不画**（不猜档位、不补数字）；
   - 面板消失时标签**立刻清空**，不会残留到下一次三选一。

   > 这条链路目前在录制 / 验证工具 `debug:augment` 里走通（见下方命令）；
   > 常驻覆盖层（`pnpm dev:overlay`）的接线还没做完。
   > 选取率那一行取自**同一张官方表**：表里没有就不画那一行，字母照画。

3. **出装建议：写进客户端的「配装方案」**
   不在画面上弹出装面板，而是把推荐出装（出门装 / 优先成装 / 其余成装）直接写进客户端
   「收藏 → 配装方案」，游戏内自己查。命令见下文。

**已经去掉的**（别期待）：侧边悬浮窗（局内也不显示，局内信息由卡上的标签承担）、
Tier（T0/T1…）强度分级、最佳拍档 / 避坑提醒。原因见 [docs/ROADMAP.md](docs/ROADMAP.md) 的「不做」。

## 怎么用

### 一次性准备

```bash
pnpm install
pnpm sync        # 拉数据到 ./data（图鉴 + 榜单 + 单英雄详情）
pnpm dev:web     # 数据站 → http://localhost:5273
```

覆盖层做截图识别还需要一次模板包（头像模板 + 名字指纹）：

```bash
pnpm templates   # → data/templates.json，一次即可
```

### 日常使用覆盖层

```powershell
pnpm dev:overlay    # 需要：管理员权限 + 真实桌面会话
```

以**管理员**启动，否则读不到本地 LCU 凭证；它不能在没有真实桌面的环境里跑。
启动后进选人阶段就会自动出现胜率标签，不需要额外操作。

### 托盘菜单（它唯一的入口）

覆盖层**没有可见窗口**（全屏透明、点击穿透），所以托盘图标是它唯一能点的地方：
**关窗口只是最小化，只有托盘菜单的「退出」才是真退出**。右键（或左键）图标可见：

| 菜单项 | 能点 | 说明 |
|---|---|---|
| `状态：选人中 / 局内 / 等待客户端 …` | ❌ | 它现在在干什么（判断"为什么没有标签"的第一现场依据） |
| `数据更新时间：2026-10-05（统计日期）` | ❌ | 当前数据是哪天的**官方统计**；没有官方日期时退回 `dataset.json` 的文件时间并标成`（文件时间）` |
| `检查更新` | ✅ | **只有点了才会联网**：查 GitHub Release 最新版本；没更新会明确告诉你，有更新会问"是否下载更新？" |
| `退出` | ✅ | 唯一的真退出入口 |

> **日志与数据目录去哪找**：托盘菜单里**没有**「打开日志」和「打开数据目录」
> （按用户要求移除了）。日志位置写在下面 §安装与发布 的**日志**一条，
> 而且**每次启动的日志第一行就是它的绝对路径**（例：
> `[hexbox] 日志文件（绝对路径）：C:\Users\<你>\AppData\Local\hexbox\logs\overlay.log`）。

### 不用开游戏就能验证的两条命令

```powershell
# 1) 覆盖窗自测：屏幕中线上画左 L / 中 C / 右 R 三个大字母，5 秒后自动退出
$env:HEXBOX_LABEL_OVERLAY_TEST='1'; pnpm --filter @hexbox/overlay debug:augment
$env:HEXBOX_LABEL_OVERLAY_TEST='1'; pnpm dev:overlay        # 同一块画布、同一份窗口代码
$env:HEXBOX_LABEL_OVERLAY_TEST_MS='15000'                   # 想停留久一点

# 2) 标签外观离线预览：拿真机面板帧当底图，一笔画出小 / 中 / 大 三档
node --experimental-strip-types scripts/preview-augment-labels.mts
node --experimental-strip-types scripts/preview-augment-labels.mts <帧.png> --full --out debug/x.png
```

第一条验证「透明画布能不能显示」（终端会打印 `visible / alwaysOnTop / bounds`、
画布位图尺寸与三个标签中心是否真的画上了像素）；第二条产物是 `debug/label-preview.png`，
**框大小、字号、位置、配色与局内同源**（只有字母轮廓是内置单线字形）。

### 出装写进客户端配装方案

```powershell
# 需要管理员权限；在仓库根执行
node --experimental-strip-types packages/lcu/src/itemset-cli.ts list            # 只读，建议先跑
node --experimental-strip-types packages/lcu/src/itemset-cli.ts write 266       # 指定英雄
node --experimental-strip-types packages/lcu/src/itemset-cli.ts write           # 全部有出装数据的英雄
node --experimental-strip-types packages/lcu/src/itemset-cli.ts clean           # 只删本工具生成的
```

只操作**标题以 `hexbox` 开头**的方案，玩家手写的方案不会被覆盖或删除。

## 排查问题

```powershell
# 在一局真实对局里录制（产物 debug/augment/：timeline.csv / open-*.png / report.json）
pnpm --filter @hexbox/overlay debug:augment
$env:HEXBOX_AUGMENT_TRIGGER='api'; pnpm --filter @hexbox/overlay debug:augment  # 推荐：常态不截屏，由 API 触发
$env:HEXBOX_AUGMENT_DRAW='0';      pnpm --filter @hexbox/overlay debug:augment  # 只识别不画
$env:HEXBOX_AUGMENT_BENCH='1';     pnpm --filter @hexbox/overlay debug:augment  # 约 30 秒截屏基准
$env:HEXBOX_AUGMENT_CAPTURE='oneshot'; pnpm --filter @hexbox/overlay debug:augment  # 切回一次性截屏做对照

# 离线回放真机帧（跑的是线上同一份门控）
node --experimental-strip-types scripts/diag-augment-frames.mts <帧.png...>
```

其它：`pnpm --filter @hexbox/lcu probe`（LCU 探测详情）、
`pnpm --filter @hexbox/lcu probe:live`（对局中读游戏自带 Live Client Data API）、
`$env:HEXBOX_LOG_FILE='debug/overlay.log'; pnpm dev:overlay`（日志以 UTF-8 写文件）。

## 安装与发布

面向"给别人一个能装的 `.exe`"（**只是打包，不改任何识别/标签链路**）。
完整事实、失败点与取舍见 [docs/RELEASE-WINDOWS.md](docs/RELEASE-WINDOWS.md)。

```powershell
# 仓库根执行。第一次要下载打包工具链；国内网络建议先设镜像（否则可能 600s 超时）
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
pnpm --filter @hexbox/overlay package:win      # → release\hexbox-setup-0.1.0-x64.exe（NSIS 安装包）
pnpm --filter @hexbox/overlay package:dir      # 只出免安装目录，最快
```

- **产物**：`release\hexbox-setup-0.1.0-x64.exe`（NSIS，每用户安装）+
  `release\hexbox-portable-0.1.0-x64.exe`（便携版），各约 **77 MB**。
- **数据**：`data/` 下 5 个运行时 json（约 6.3 MB）作为快照打进去，
  运行时由 `resolveDataDir()` 自动命中 `resources\data`。
  **数据更新 = 重跑 `pnpm sync` / `pnpm templates` 后重新打包**；
  不想重装的话，把新的 json 放进 `%LOCALAPPDATA%\hexbox\data\` 即可覆盖。
- **权限**：安装包**不需要**管理员；程序本身要求管理员（`requireAdministrator`）——
  因为国服 WeGame 的 `LeagueClient\lockfile` 是 0 字节，非管理员拿不到 LCU 凭证，
  选人/局内标签就全都不会出现（每次启动会弹一次 UAC）。
- **未做代码签名**：首次运行会有 SmartScreen「未知发布者」提示，
  点「更多信息」→「仍要运行」即可；企业环境（AppLocker 等）可能直接拦截。
- **日志**（GUI 进程没有控制台，排查只能看这里）：
  `%LOCALAPPDATA%\hexbox\logs\overlay.log`（超过 4 MB 自动轮转成 `.log.1`）。
  开发时用 `HEXBOX_LOG_FILE=<绝对路径>` 指定；**启动日志第一行就是它的绝对路径**。
  （托盘菜单里的「打开日志」已按用户要求移除 —— 要看日志请按上面这个路径去找。）
- **更新**：托盘菜单 →「检查更新」查 GitHub Release 的最新 tag，有更新就下载
  `hexbox-setup-<版本>-x64.exe` 并启动安装程序。**不会自动检查、不会后台下载**。
  发布时要附带什么、便携版/安装版各自的行为、国内网络与无签名的代价：
  见 [docs/RELEASE-WINDOWS.md](docs/RELEASE-WINDOWS.md) §发布与更新。
- **打包版自带的诊断开关**（等价于开发期的环境变量）：

  ```powershell
  & "$env:LOCALAPPDATA\Programs\hexbox\hexbox.exe" --label-overlay-test          # 覆盖窗自测（L/C/R）
  & …\hexbox.exe --log-file D:\logs\hexbox.log                                  # 指定日志文件
  & …\hexbox.exe --data-dir D:\hexbox-data                                      # 指定数据目录
  & …\hexbox.exe --no-augment                                                   # 只关局内链路
  & …\hexbox.exe --tray-autotest 8000                                           # 托盘/退出路径自测（打印菜单逐项）
  & …\hexbox.exe --update-check-test offline                                    # 检查更新自测：offline/up-to-date/update/download
  ```

- **数据站 `apps/web` 不打包**：它是独立部署的静态站点，与覆盖层没有运行时耦合。

## 数据来源与边界

| 用途 | 来源 |
|---|---|
| 静态图鉴（海克斯 / 英雄 / 装备） | CommunityDragon（`raw.communitydragon.org`） |
| 国服海克斯图鉴 | 腾讯官方 CDN `game.gtimg.cn`（kiwi_augments） |
| 榜单 + 单英雄详情（强度表 / 出装） | 腾讯国服一方接口 `mlol.qt.qq.com`（口径与 `101.qq.com` 官方页一致） |
| 客户端阶段、我的英雄、写配装方案 | 本地 **LCU REST API**（`127.0.0.1`，需管理员读凭证） |
| 局内等级 / 死亡状态 | 游戏自带 **Live Client Data API**（`127.0.0.1:2999`，只在局内） |
| 选人标签、局内海克斯卡 | **对游戏画面截图做识别**（模板匹配 + 名字 OCR） |

**不做**：读游戏内存、注入、hook 游戏进程、解析封包、抓取第三方站点数据。
展示数据时同时标注来源与统计日期。

## 环境要求

- **Node ≥ 20**（见根 `package.json` 的 `engines`）。
- **pnpm 11.7.0**（见 `packageManager` 字段；`pnpm --version` 可确认）。
  若你的终端里没有 `pnpm`，可以直接用 Node 跑 TS 源码，等价命令：

  ```bash
  node --experimental-strip-types packages/data-cli/src/cli.ts sync
  node --experimental-strip-types packages/lcu/src/itemset-cli.ts list
  ```

- 项目**以 TypeScript 源码直接运行**（Node strip-only）：import 必须带 `.ts` 扩展名，
  且不能用 `enum` / 参数属性 / `namespace`（详见 [AGENTS.md](AGENTS.md)）。

## 常见问题 / 已知限制

1. **有些海克斯卡不会显示评级**：官方「该英雄强度表」每个英雄只有 95~162 条，
   248 颗海克斯里只有约 **211 颗**有官方强度 —— 查不到就**不画**，这是数据事实，不是 bug。
2. **分辨率与窗口模式**：换分辨率、窗口化、无边框窗口都能用；覆盖层是独立的透明置顶窗口，
   在**无边框窗口**下正常显示。
3. **出装推荐需要管理员权限**（否则读不到 LCU 凭证）。凭证缓存会随客户端重启失效，
   代码会先做端口探活、过期缓存自动忽略并回落实时探测。
4. **局内三选一标签目前只在录制 / 验证工具里走通**，常驻覆盖层接线待做。
5. **数据站暂无英雄 / 装备浏览页**（数据已抓，见 [docs/ROADMAP.md](docs/ROADMAP.md) P3）。
6. **`data/` 与 `debug/` 都不入库**：前者可用 `pnpm sync` 再生，后者含真机截屏与个人信息。

## 项目结构

```
packages/
  core/                       领域模型 + Provider 接口 + 纯视图模型（分阶段视图 / 配装方案）
  vision/                     截图识别（几何 / 卡片定位 / 模板匹配 / OCR / 局内海克斯门控与标签），纯函数
  provider-communitydragon/   国际服静态数据源
  provider-tencent/           国服一方数据源（图鉴 + 榜单 + 单英雄详情）
  provider-registry/          数据源注册表
  data-store/                 本地缓存（原子写 + 离线读取）
  data-cli/                   sync / status / templates CLI
  lcu/                        LCU 探测 + REST 客户端 + 配装方案写入 + 「我是谁」判定
apps/
  web/                        数据站（Vue 3 + Vite）
  overlay/                    覆盖层（Electron）：选人标签 / 局内海克斯标签 / 录制工具
scripts/                      离线诊断脚本 + 不用开游戏的标签预览
docs/                         设计文档（路线 / 阶段 / 局内识别 / 出装槽位）
data/                         sync 产物（gitignored）
```

开发者三闸门：`pnpm test`（当前 743 项，以实际输出为准）/ `pnpm typecheck` / `pnpm build`。

## 进一步阅读

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 给 AI agent 的开发约定、已踩过的坑、局内链路全貌与环境变量 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 现状盘点与后续路线 |
| [docs/OVERLAY-STAGES.md](docs/OVERLAY-STAGES.md) | 覆盖层分阶段设计的调研依据 |
| [docs/AUGMENT-PANEL.md](docs/AUGMENT-PANEL.md) | 局内海克斯识别：方案、真机标定与性能 |
| [apps/overlay/README.md](apps/overlay/README.md) | 覆盖层的功能清单、自测与排查步骤 |
| [docs/build-slots.md](docs/build-slots.md) | 出装槽位与上游字段的对照（已核实） |
| [docs/SCREENSHOT-DEV.md](docs/SCREENSHOT-DEV.md) | 选人截屏覆盖层的技术事实与实现状态 |
| [docs/SESSION-NOTES.md](docs/SESSION-NOTES.md) | 历史会话备忘（当时的真机验收 bug 记录） |

## 法律声明

本产品未获得 Riot Games 认可，不代表 Riot Games 或任何参与制作、管理 Riot Games
财产的人士的观点或意见。Riot Games 及所有相关财产均为 Riot Games, Inc. 的商标
或注册商标。
