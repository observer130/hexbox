# hexbox

英雄联盟 **海克斯乱斗** 模式助手。装上它，你在两个关键时刻能直接看到官方数据：

| 场景 | 你会看到 |
|---|---|
| **选人界面** | 三张候选卡**下方**显示该英雄的**官方胜率** |
| **局内海克斯三选一** | 每张卡**下方**显示该英雄这颗海克斯的**评级（S / A / B / C）+ 选取率** |

它**常驻在系统托盘**，没有可见窗口，也不占屏幕。

> **硬性边界**：只用官方 / 一方公开数据（CommunityDragon、Data Dragon、腾讯官方公开数据、
> 本地 LCU REST、游戏自带 Live Client Data API `127.0.0.1:2999`），外加**对官方界面的截图识别**。
> **绝不**读游戏内存、不注入、不 hook 游戏进程、不解析封包。
> 只展示官方界面真实出现过的字段。

## 下载与安装

从 **GitHub Releases** 下载：<https://github.com/observer130/hexbox/releases/latest>

| 文件 | 说明 |
|---|---|
| `hexbox-setup-<版本>-x64.exe` | **安装版（推荐）**。中文向导、可选安装目录、带桌面/开始菜单快捷方式。**安装本身不需要管理员** |
| `hexbox-portable-<版本>-x64.exe` | **便携版（免安装）**。每次运行自解压到临时目录，启动慢 1~2 秒 |

安装包约 **77 MB**，已经内置数据快照（见下），**装完即用，不需要联网**。

### ⚠️ 程序运行时会请求管理员权限（UAC）

这是**必须**的，不是可选项，每次启动都会弹一次 UAC：

- 程序需要读**本地 LCU 凭证**才能判断当前对局阶段（选人 / 局内）。
- **非管理员运行时，选人标签与局内标签都不会出现** —— 等于一个看不见的常驻进程，
  屏幕上什么都不会有。

所以如果标签一直不出现，第一件事就是确认它是**以管理员身份运行**的。

### 首次运行：SmartScreen 提示

本程序**没有代码签名**（没有数字证书），所以 Windows 可能弹出
「Windows 已保护你的电脑 / 未知发布者」。这是正常现象，不是病毒：

**点「更多信息」→「仍要运行」** 即可。

> 企业环境（AppLocker / 只允许已签名程序的组策略）**可能直接拦截**，这不是文档能绕过的。
> 安装包哈希（SHA256）在 [发布说明](docs/RELEASE-NOTES-v0.1.0.md) 与 Release 页给出，
> 可用 `Get-FileHash .\hexbox-setup-0.1.0-x64.exe -Algorithm SHA256` 自行校验。

### 数据是内置快照

数据（英雄 / 海克斯 / 装备 / 官方榜单）已经**打包进安装包**（`resources/data`），
所以**装完即用、运行时不需要联网**。数据更新要等新版本发布。

不想重装也可以手动换数据：把新的 json 放进 **`%LOCALAPPDATA%\hexbox\data\`**
（该目录里只要有一份 `dataset.json`，程序就整套用它）。

## 怎么用

### 启动后没有窗口，只有托盘图标

双击 `hexbox.exe` 后**屏幕上不会出现任何窗口** —— 这是设计如此。它只在托盘里：

- Windows 11 默认把托盘图标收在任务栏的 **`^` 隐藏区**，可以拖出来固定到任务栏。
- 双击没反应时，先看 `^` 隐藏区。

### 玩法

1. 进**海克斯乱斗**（选人阶段）→ 每张候选英雄卡下方出现该英雄的**官方胜率**。
2. 局内出现**海克斯三选一** → 每张卡下方出现**评级（S / A / B / C，按档配色）**
   和一行 **「选取率 x%」**（官方表的登场率那一列）。

> **刷新（每张卡最多一次）之后请对照「选取率」那一行**：评级字母经常**同档不变**，
> 这是正常的 —— 刷新换了一颗海克斯，但两颗恰好同档时字母当然一样。
> 真正变化的是选取率那一行的数字。
>
> 认不出是哪颗海克斯、或官方表里查不到这一颗 → **不画**（不猜档位、不补数字）。

### 托盘菜单（它唯一的入口）

右键（或左键）托盘图标，菜单**就这四项**：

| 菜单项 | 能点 | 说明 |
|---|---|---|
| `状态：选人中 / 局内 / 等待客户端 …` | ❌ 灰色 | 它现在在干什么 —— 判断"为什么没有标签"的第一现场依据 |
| `数据更新时间：2026-10-05（统计日期）` | ❌ 灰色 | 当前数据是哪天的**官方统计**；没有官方日期时退回文件时间并标成`（文件时间）` |
| `检查更新` | ✅ | 只有点了才会联网 |
| `退出` | ✅ | **唯一的真退出入口** |

> **点窗口的 X 不会退出**（它只是隐藏到托盘）。**退出请右键托盘图标 →「退出」**。

### 检查更新

点托盘菜单的「检查更新」后：

1. 查 GitHub Release 的最新版本（**只在点击后联网**，启动不检查、不后台轮询）；
2. 有更新 → 弹窗「**检测到版本 vX.Y.Z，是否下载更新？**」；
3. 点「确认」→ 下载 `hexbox-setup-<版本>-x64.exe` → 启动**安装向导**（不是静默更新，要自己走一遍向导）；
4. 失败 → 弹窗给出**明确原因 + 手动下载页**。

> - **便携版不能自助更新**：更新流程认的只有 `hexbox-setup-*.exe`（会把你装成正式安装版）。
>   想继续用便携版，请手动下载新的 `hexbox-portable-*.exe` 换包。
> - **国内访问 GitHub 可能很慢甚至不通**，超时后会明确告诉你并给出下载页。

## 数据来源

| 用途 | 来源 |
|---|---|
| 静态图鉴（海克斯 / 英雄 / 装备） | CommunityDragon（`raw.communitydragon.org`） |
| 国服海克斯图鉴 | 腾讯官方 CDN `game.gtimg.cn` |
| 榜单 + 单英雄详情（强度表 / 出装） | 腾讯国服一方公开接口 `mlol.qt.qq.com`（口径与 `101.qq.com` 官方页一致） |
| 客户端阶段、我的英雄 | 本地 **LCU REST API**（`127.0.0.1`，需管理员读凭证） |
| 局内等级 / 死亡状态 | 游戏自带 **Live Client Data API**（`127.0.0.1:2999`，只在局内） |
| 选人英雄卡、局内海克斯卡 | **对游戏画面截图做识别**（模板匹配 + 名字 OCR） |

托盘「数据更新时间」显示的就是官方榜单的**统计日期**（形如 `2026-10-05（统计日期）`）。
当前快照规模：**英雄 173 / 海克斯 248 / 装备 870**（以程序日志里的加载行为准）。

## 排查问题

### 日志是唯一的排查入口

```
%LOCALAPPDATA%\hexbox\logs\overlay.log
```

启动时日志的**第一行就是它的绝对路径**（形如
`[hexbox] 日志文件（绝对路径）：C:\Users\<你>\AppData\Local\hexbox\logs\overlay.log`）。
超过 **4 MB** 会自动轮转成 `overlay.log.1`。

### 常见问题

| 现象 | 先查什么 |
|---|---|
| **标签不出现** | ① 是否**以管理员身份运行**？② 游戏客户端是否已启动？（托盘 tooltip 会显示「等待客户端」） |
| **双击没反应** | 看任务栏 `^` 隐藏区 —— 它没有窗口，只有托盘图标 |
| **启动即崩** | v0.1.0 已修（启动自动加 `--disable-gpu --in-process-gpu`，并有一次自动降级重启）。仍不行请看日志里的 `图形引导：…` 那一行 |
| **启动第二个实例没反应** | 正常行为：第二个实例会被拒绝（防止两套标签重叠） |

## 开发者

仓库是 **pnpm workspace**（10 个项目：8 个包 + 2 个应用），TypeScript **直接跑源码**
（`node --experimental-strip-types`）。环境要求 Node ≥ 20、pnpm 11.7.0。

```bash
pnpm install
pnpm sync        # 拉数据到 ./data（图鉴 + 榜单 + 单英雄详情）
pnpm templates   # → data/templates.json（头像模板 + 名字指纹）
pnpm dev:web     # 数据站 → http://localhost:5273
```

覆盖层的开发运行：

```powershell
pnpm dev:overlay    # 需要管理员权限 + 真实桌面会话；CI 里跑不了
```

三闸门（提交前保持全绿）：

```bash
pnpm typecheck
pnpm test        # 当前 796 项；以 pnpm test 的实际输出为准
pnpm build
```

打包 Windows 产物：

```powershell
# ⚠️ 必须先设镜像，否则从 GitHub 拉 Electron/NSIS 工具链会撞 600s 超时
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
pnpm --filter @hexbox/overlay package:win      # → release/hexbox-setup-<版本>-x64.exe + 便携版
```

目录结构（一句话级，细节见 [AGENTS.md](AGENTS.md)）：

```
packages/{core,vision,lcu,data-*}   领域模型 / 截图识别 / LCU 客户端 / 数据源与缓存
apps/{web,overlay}                  数据站（Vue 3 + Vite）/ 覆盖层（Electron）
scripts/                            离线诊断脚本 + 不用开游戏的标签预览
docs/                               设计文档
```

**不用开游戏的自测**（可选）：

```powershell
# 覆盖窗自测：屏幕中线上画左 L / 中 C / 右 R 三个大字母
& "$env:LOCALAPPDATA\Programs\hexbox\hexbox.exe" --label-overlay-test
# 标签外观离线预览 → debug/label-preview.png（框大小/字号/位置/配色与局内同源）
node --experimental-strip-types scripts/preview-augment-labels.mts
```

开发约定、已踩过的坑、局内识别链路全貌与**环境变量表**在 [AGENTS.md](AGENTS.md)；
打包与发布的全部事实在 [docs/RELEASE-WINDOWS.md](docs/RELEASE-WINDOWS.md)。

## 法律声明

本产品未获得 Riot Games 认可，不代表 Riot Games 或任何参与制作、管理 Riot Games
财产的人士的观点或意见。Riot Games 及所有相关财产均为 Riot Games, Inc. 的商标
或注册商标。
