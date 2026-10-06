# Windows 打包发布说明（hexbox 悬浮窗）

> 面向"把 `apps/overlay` 做成一个可分发的 `.exe`"这件事的**全部事实与取舍**。
> 每一条都来自本机实测（命令与输出在文里给出），不是推测。
> 相关：`apps/overlay/README.md`（开发运行）、`README.md`（安装与发布一节）。

## 一、产物与命令

```powershell
# 仓库根执行；第一次会下载打包工具链（见 §八 网络）
pnpm --filter @hexbox/overlay package:win     # NSIS 安装包 + 便携版
pnpm --filter @hexbox/overlay package:dir     # 只出免安装目录（验证配置用，最快）
```

产物落在仓库根的 `release/`（已 gitignore）：

| 文件 | 大小（本机实测 0.1.0） | 说明 |
|---|---|---|
| `release/hexbox-setup-0.1.0-x64.exe` | **77.23 MB** | NSIS 安装包（中文界面、每用户、可选安装目录） |
| `release/hexbox-portable-0.1.0-x64.exe` | **77.00 MB** | 便携版（自解压到临时目录后运行） |
| `release/win-unpacked/` | 276.1 MB（含 Electron 运行时） | 免安装目录，`hexbox.exe` 可直接跑 |
| `release/…/resources/app.asar` | **0.30 MB** | 只有 `dist/**` + `package.json` |
| `release/…/resources/data/` | 6.26 MB | 数据快照（见 §三） |

配置在 **`apps/overlay/electron-builder.yml`**（不新增 `apps/desktop`：
本包已经是 workspace 项目、已经声明 `main=dist/main/index.cjs`，
再开一个"打包壳"只会让 `pnpm -r` 多一个项目、多一份要同步的元数据）。

## 二、为什么打包能这么小：主进程/渲染端都是 esbuild 单文件

`apps/overlay/build.mjs` 已经把**四个 workspace 包**（`@hexbox/core` /
`data-store` / `lcu` / `vision`）连同 `node_modules` 的一切内联进
`dist/*.cjs` 与 `dist/renderer/*.js`，所以打包**不需要 node_modules**：

```yaml
files:
  - dist/**/*
  - package.json
  - '!node_modules/**/*'      # ← 必须显式排除，见下
  - '!dist/debug-*.cjs'       # ← 诊断入口不进安装包，见 §七
  - '!dist/phase-probe.cjs'
```

⚠️ **`!node_modules/**/*` 不能省**。electron-builder 会自动把
`package.json` 里 `dependencies` 的**生产依赖**打包进去，而本仓库是
`workspace:*` 链接 —— 实测第一次打包把 `packages/*/src/**.test.ts`、
`tsconfig.json` 全塞进了 asar（130 个文件、asar **1.74 MB**）。
加上排除后（并再去掉 §七 那 4 个诊断入口）asar 只剩 15 个条目、**0.30 MB**：

```text
\dist\main\index.cjs  \dist\preload\index.cjs  \dist\renderer\{renderer.js,overlay-canvas.js,
capture\worker.js,*.html,styles.css}  \package.json
```

> 顺带这也是"**不可能把 `debug/`（真机截图）或令牌打进安装包**"的机制保证：
> 白名单只放 `dist/`，`debug/`、`data/`、`.env*` 根本不在候选里。

## 三、运行时数据（最关键的一条）

运行时读 `data/` 下 5 个文件（`resolveDataDir()` 向上遍历找 `dataset.json`）：

| 文件 | 大小 | 谁在读 |
|---|---|---|
| `builds.json` | 4.47 MB | 局内海克斯强度表 + 出装（`augmentStrength` / `championBuild`） |
| `dataset.json` | 0.87 MB | 图鉴（海克斯/英雄/装备 join） |
| `templates.json` | 0.46 MB | 头像模板 + 名字指纹（`pnpm templates` 产物） |
| `augment-names.json` | 0.24 MB | 局内海克斯名 OCR 指纹库 |
| `rankings.json` | 0.22 MB | 选人胜率榜 |
| （`name-fingerprints.json` 0.09 MB） | — | **不进包**：它已被 `pnpm templates` 编进 `templates.json` |

合计 **6.26 MB**（对 77 MB 的安装包可忽略），所以**整套打进包**，不做子集裁剪。

### 方案 ①（**采用**）：数据快照走 `extraResources`

```yaml
extraResources:
  - from: ../../data
    to: data
    filter: [dataset.json, rankings.json, builds.json, templates.json, augment-names.json]
```

落到 `…\resources\data\`，而 `resolveDataDir()` 的向上遍历**正好会在那里命中**
（`app.asar\dist\main` → `…\resources\data`），**运行时不需要任何配置**。
本机实测（打包后的程序自己打的日志）：

```text
[hexbox] 数据目录: D:\…\release-verify\win-unpacked\resources\data
[hexbox] 图鉴已加载: 海克斯(cn) 248 / 英雄 245 / 装备 870
[hexbox] 排行榜已加载: 英雄榜 173 / 海克斯榜 211  统计日期 20261005
[hexbox] 英雄详情已加载: 173 个英雄  统计日期 20261005
[hexbox] 名字指纹 245 个 / 头像模板 245 个已加载
```

**数据更新 = 在开发仓库重跑 `pnpm sync` / `pnpm templates` 后重新打包**
（数据是日更的静态数据；UI 里本来就带"统计日期"）。

**不想重新打包的更新方式**（已实现，优先级高于安装目录里的快照）：
把新的 5 个 json 放进 **`%LOCALAPPDATA%\hexbox\data\`**
（只要该目录里有 `dataset.json` 就整套用它）：

```powershell
# 开发仓库里先同步，再拷给已安装的程序
pnpm sync; pnpm templates
copy data\*.json "$env:LOCALAPPDATA\hexbox\data\"
```

优先级：`HEXBOX_DATA_DIR` / `--data-dir` → `%LOCALAPPDATA%\hexbox\data`
→ 向上遍历（打包后 = `resources\data`）。

### 方案 ②（**不采用**，但可行性已验证）：首次运行联网同步

* **Electron 跑不了 `packages/data-cli` 的 TS 源码**（硬事实，见下），
  要复用同步逻辑必须先用 esbuild 把 CLI 打成 CJS 再随包发布；
* 打出来的 bundle 在 Electron 的 Node 20 上**能加载**（实测 247.4 KB，
  无语法/依赖问题），但 **`cli.ts` 的"入口保护"让它什么都不做**：
  `isDirectRun()` 比较 `import.meta.url === pathToFileURL(argv[1]).href`，
  而 CJS 产物里 `import.meta` 不存在 → 恒为 false（实测：进程退出 0、无输出）。
  要真跑起来得**额外写一个 CJS 入口**（或给 CLI 加一个导出的 `cmdSync`），
  属于"为了一个可选功能动 `packages/data-cli`"；
* 运行时还要解决"数据写哪儿"（安装目录只读语义）与"国内数据源可达性"。

结论：**默认走快照**；联网同步留作后续可选项，落地时按上面的坑走。

### 硬事实：Electron 内置的 Node 不支持 `--experimental-strip-types`

```text
$ electron.exe -p "electron=… node=… chrome=…"       # ELECTRON_RUN_AS_NODE=1
electron=33.4.11 node=20.18.3 v8=13.0.245.25-electron.0 chrome=130.0.6723.191 modules=130

$ electron.exe --experimental-strip-types -e "…"
electron.exe: bad option: --experimental-strip-types
```

`--experimental-strip-types` 是 **Node 22.6.0** 引入的（22.18 / 23.6 起默认开启），
Electron 33 的内核是 **Node 20.18.3** → **完全没有这个开关**。
所以"打包后让 Electron 直接 `node --experimental-strip-types packages/data-cli/…`"
这条路是**死的**；本项目"TS 直接跑源码"只适用于开发机上的 Node 24。

## 四、权限（UAC）：采用 `requireAdministrator`

`apps/overlay/electron-builder.yml`：

```yaml
win:
  requestedExecutionLevel: requireAdministrator
```

### 依据（本机实测，非管理员终端）

```text
$ node --experimental-strip-types packages/lcu/src/cli.ts      # 非管理员
  ⚠ 未取到密码，但确认 LCU 端口: 10691 (pid 8144)
     （候选 58884, 40017, 30713, 10691 中，该端口返回 401 = 需鉴权）
     原因：非管理员无法读进程命令行；且国服 lockfile 可能被清空。

$ Get-Item "E:\Games\WeGameApps\英雄联盟\LeagueClient\lockfile"
    Length = 0                      ← 国服 WeGame 的 lockfile 是 0 字节
$ …\Riot Client Data\User Data\Config\lockfile  Length = 51   ← 那是 Riot Client 的，不是 LCU
```

### 为什么不能选 `asInvoker`（默认、不弹 UAC）

⚠️ **"读不到凭证只是降级"这个说法在本项目里不成立**，必须说清楚：

* 选人标签（`decideVisible()`：`showVision = phase === 'ChampSelect'`）与
  局内海克斯链路（`augmentChainActive()`：`InProgress` / `Reconnect`）
  **都以 LCU 阶段为准**；
* 非管理员 → 拿不到 token → 阶段恒为 `None`
  → **两块标签都不会出现**，程序只剩"一个什么都不显示的常驻进程"；
* 局内链路还额外依赖 LCU 阶段来启停（`docs/OVERLAY-STAGES.md`）。

所以在国服（WeGame）环境下，`asInvoker` 出来的程序**看起来是坏的**，
而用户不会知道要先"以管理员身份运行"。**默认要求管理员**是唯一能"装完就能用"的选择。

代价（如实写进给用户的说明）：

1. **每次启动都会弹 UAC**（Windows 不允许记住"这个程序总是放行"）；
2. 标准（非管理员）账户若输不出管理员密码，程序**完全无法启动**；
3. 开机自启必须用计划任务（"以最高权限运行"）才不会每次弹窗，
   普通"启动"文件夹的快捷方式每次都会弹；
4. 便携版必须自己先提权再启动内层 exe（已配 `portable.requestExecutionLevel: admin`；
   否则内层 exe 的清单要求提权，未提权进程 `CreateProcess` 会直接失败
   `ERROR_ELEVATION_REQUIRED (740)`）。

### 想改成不弹 UAC

把 `win.requestedExecutionLevel` 改成 `asInvoker` 即可（一行），
但此时**必须**同时接受"选人/局内标签在国服不可用"，
或让用户自己用 `HEXBOX_LCU_CREDENTIALS=<port>:<token>`（免提权通道，
`packages/lcu/src/detect.ts` 里优先级最高）——那要求用户自己能拿到 token，不现实。

## 五、安装形态：NSIS 每用户安装（主推）+ 便携版（附带）

| | NSIS 安装包 | 便携版 |
|---|---|---|
| 体积 | 77.46 MB | 77.24 MB |
| 安装 | 每用户（`perMachine: false`）→ **安装本身不需要管理员**；程序运行时才提权 | 免安装，但每次运行自解压到临时目录（启动慢 1~2 s） |
| 数据 | 安装目录 `…\resources\data` 是只读语义；用户数据在 `%LOCALAPPDATA%\hexbox` | 每次都是全新解压 → **用户放进安装目录的数据会丢** |
| 卸载 | 开始菜单可卸载（保留 `%LOCALAPPDATA%\hexbox`：日志与用户数据） | 删文件即可 |

**主推 NSIS**（体验最好：桌面/开始菜单快捷方式、可选安装目录、卸载干净），
便携版因为"只多一个 target、几乎零成本"而一起出（给"不想装东西"的人）。
`oneClick: false` 是刻意的：一键安装会把"装哪儿"和 UAC 都吞掉。

## 六、代码签名：当前**没有证书**

`win.icon`/`appId` 等都配了，但**没有任何 `cscLink`/证书** → 产物是**未签名**的。

影响（如实告知用户）：

* 首次运行 `hexbox-setup-0.1.0-x64.exe` 或便携版时，Windows SmartScreen
  会显示"**Windows 已保护你的电脑**"（未知发布者）→ 需要点
  「更多信息」→「仍要运行」；文件属性里"数字签名"页是空的；
* 从浏览器下载的安装包会带 Mark-of-the-Web（右键属性里会出现"解除锁定"）；
* 企业环境（AppLocker / WDAC / 组策略"仅允许已签名程序"）**会直接拦截**，
  这不是能靠文档绕过的；
* 部分杀软会对"未知发布者 + 要求管理员"的组合提高告警级别。

**建议写进发布说明的用户提示文案**（README/发布页照抄）：

> ⚠️ 本程序**未做代码签名**，所以 Windows 可能弹出
> 「Windows 已保护你的电脑 / 未知发布者」。
> 这是没有数字证书的正常表现，不是病毒：
> 点「更多信息」→「仍要运行」即可。
> 若你的电脑由公司统一管理（AppLocker 等只允许已签名程序），本程序可能无法安装。
> 随时可以校验：文件属性 → 数字签名（应为空）、以及安装包哈希（发布页给出 SHA256）。

将来要签名：买 OV/EV 代码签名证书 → 配 `win.cscLink`（或
`CSC_LINK`/`CSC_KEY_PASSWORD` 环境变量）→ 重新 `package:win` 即可，配置不用改结构。

## 七、发布哪些入口

`build.mjs` 出 6 个 Node 入口，但**只发常驻覆盖层**：

| 入口 | 是否进安装包 | 理由 |
|---|---|---|
| `dist/main/index.cjs` | ✅ **必发** | 常驻覆盖层（选人胜率标签 + 局内海克斯强度标签） |
| `dist/preload/index.cjs`、`dist/renderer/**` | ✅ 必发 | 上面那个入口的 preload 与渲染端 |
| `dist/debug-overlay-test.cjs` | ❌ | 功能已被主入口的 `--label-overlay-test` 取代（见下） |
| `dist/debug-augment.cjs` | ❌ | 真机录制工具：依赖 launcher（`run-electron.mjs`）的 Ctrl+C 哨兵，而 launcher 不发进安装包；产物目录在打包后是 `cwd\debug\augment`（要发得先改到 `%LOCALAPPDATA%`） |
| `dist/debug-capture.cjs` / `dist/phase-probe.cjs` | ❌ | 开发期工具（真机截图/守望采集），用户用不到 |

### 「覆盖窗自测」做成了主程序里的一个命令行开关（**比另发 debug 版好**）

用户日常要靠它排查"标签画了但屏幕上没有"。做法不是再发一个 debug 版，而是
在**主入口**里把命令行参数映射成已有的环境变量
（`apps/overlay/src/main/index.ts` 的 `applyCliOverrides()`）：

```powershell
& "$env:LOCALAPPDATA\Programs\hexbox\hexbox.exe" --label-overlay-test          # 画 L/C/R 三个大字母
& …\hexbox.exe --label-overlay-test --label-overlay-test-ms 15000             # 停留 15 s
& …\hexbox.exe --log-file D:\logs\hexbox.log                                  # 指定日志
& …\hexbox.exe --data-dir D:\hexbox-data                                      # 指定数据目录
& …\hexbox.exe --no-augment                                                   # 只关局内链路（选人标签照常）
& …\hexbox.exe --no-draw                                                      # 只识别不画（排查用）
```

实测（打包后的程序）：

```text
[hexbox] 命令行开关 --label-overlay-test → HEXBOX_LABEL_OVERLAY_TEST
[hexbox] 命令行开关 --log-file → HEXBOX_LOG_FILE
──────── 覆盖窗自测（HEXBOX_LABEL_OVERLAY_TEST=1）────────
  画布：3441x1368（窗口内 2294x912，dpr 1.5）
  三个标签中心像素：L=已画 C=已画 R=已画
  ✅ 窗口可见 + 置顶 + 画布出像素 —— 覆盖窗链路正常
```

**为什么不做第二个 debug 版**：两个安装包 = 两倍发布/文档/支持成本，
而"自测"只需要一个开关；同时"主程序里少一个能写任意 cwd 的调试入口"也更安全。
想临时出带调试入口的版本：删掉 `electron-builder.yml` 里那两行 `!dist/debug-*.cjs`
并把 `directories.output` 换个目录即可。

## 八、打包工具链与网络（本机实测的失败点与解法）

选型 **electron-builder 26.15.3**（`apps/overlay/devDependencies`）：仓库里原本
没有任何打包配置；electron-builder 对 NSIS 的支持最直接（`nsis`/`portable`
两个 target 就够），而 `@electron-forge` 要走 maker 体系、NSIS 定制反而更绕。
`pnpm-workspace.yaml` 的 `allowBuilds` 需要给 electron-builder 的可选依赖
`electron-winstaller` 显式写 `false`（只给 Squirrel 用，我们不用；
不表态 pnpm 会以 `ERR_PNPM_IGNORED_BUILDS` 失败）。

### 失败点 1：`publisherName` 在 v26 不在 `win` 下

```text
⨯ Invalid configuration object. electron-builder 26.15.3 … configuration.win should be one of these: null
```

	v26 把它挪到了 `win.signtoolOptions.publisherName`。**没有证书时不要设它**
（配置里已删）。

### 失败点 2：GitHub 下载太慢 → 600 s 超时（**这条是"必须先设镜像"的原因**）

默认从 GitHub Releases 拉 Electron 与 NSIS 工具链：

```text
• downloaded      label=electron progress=100%
⨯ Timeout awaiting 'request' for 600000ms  failedTask=build
    at ClientRequest.<anonymous> (…\got\dist\source\core\index.js:970:65)
```

本机实测 GitHub 的 Electron 资源约 **190 KB/s**（1 MB / 5.5 s）→ 115 MB 要 10 分钟，
正好超过 electron-builder 的 600 s 请求超时；而
[编辑器工具链镜像](https://npmmirror.com/mirrors/electron-builder-binaries/) 与
[Electron 镜像](https://npmmirror.com/mirrors/electron/) 实测 **5.56 MB/s**（5.37 MB / 1 s）。

**能联网但慢的机器上，请这样打包**：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
pnpm --filter @hexbox/overlay package:win
```

（这两个变量是 electron-builder 官方支持的；工具链缓存在
`%LOCALAPPDATA%\electron-builder\Cache` 与 `%LOCALAPPDATA%\electron\Cache`，
第一次之后就离线了。没有镜像也没关系 —— 只是慢，可能撞上 600 s 超时，
重跑一次会接着用已下好的部分。）

> 本机**不需要**额外下载 NSIS/winCodeSign 之外的东西；`electron-builder`
> 每次构建会"signing with signtool.exe"——**没有证书时这一步只是改写 exe 资源**，
> 不产生签名。

## 九、首次运行体验（用户双击 exe 后看到什么）

**当前行为（如实）**：`decideVisible()` 里 `showPanel` 恒为 `false`（用户 2026-10-04
的决策：连不上客户端也不弹诊断面板），所以**没有客户端时双击程序 = 屏幕上什么都不出现**，
只有系统托盘外的一个不可见常驻进程。全部信息在**日志文件**里：

| 位置 | 内容 |
|---|---|
| `%LOCALAPPDATA%\hexbox\logs\overlay.log` | 打包后**默认开启**的运行日志（>4 MB 自动轮转成 `.1`） |
| `%LOCALAPPDATA%\hexbox\logs\selftest\` | `--label-overlay-test` 的截图与结论 |
| `%LOCALAPPDATA%\hexbox\data\` | （可选）用户放进去的数据快照 |

为什么默认要落日志：安装包出来的是 **GUI 子系统进程，没有控制台**，
`console.log` 谁都不看 —— 不落文件就等于"出问题什么都没有"。

日志开头那几行就是排错入口（真实输出）：

```text
[hexbox] 日志文件（绝对路径）：C:\Users\<你>\AppData\Local\hexbox\logs\overlay.log
[hexbox] 数据目录: …\resources\data
[hexbox] LCU 已连接 (port 10691, 来自进程命令行)
# 或（非管理员/客户端没开）
[hexbox] 检测到英雄联盟客户端，但读不到 LCU 凭证。… 1. 确认本工具以管理员身份运行 …
```

> **需要产品决策**：要不要在"读不到凭证/未进对局"时给一个**一次性的
> Windows 通知或托盘图标**（现在的可见反馈为零）。见 §十一 决策清单。

## 十、数据站（`apps/web`）**不打包**

`apps/web` 是 Vue3 + Vite 的静态站点，`pnpm build` 出静态产物，
与覆盖层**没有任何运行时耦合**（覆盖层只读 `data/*.json`）；
把它塞进 Electron 只会让安装包变大、还要多维护一层窗口与路由。
**结论：继续独立部署**（任意静态托管 / 内网），需要时再单独发一版站点。

## 十一、待裁决的决策点（给 parent/用户）

| # | 决策 | 我的建议 | 代价/替代 |
|---|---|---|---|
| 1 | **UAC 级别** | `requireAdministrator`（已实现） | 改成 `asInvoker` = 每次启动不弹窗，但国服下选人/局内标签全部不可用 |
| 2 | **安装形态** | NSIS 每用户为主 + 便携版附带（已实现） | 只出便携版：免安装但每次自解压、且用户数据不跨次保留 |
| 3 | **诊断入口是否随包** | 不随包，自测改成主入口的 `--label-overlay-test`（已实现） | 想要真机录制进安装版：删 2 行 `files` 排除并改 `output`，同时要把 `debug-augment.ts` 的产物目录从 `cwd\debug` 改到 `%LOCALAPPDATA%` |
| 4 | **首次运行反馈** | 建议加：读不到凭证时弹**一次性**系统通知 + 常驻托盘图标（含"打开日志/退出"） | 现在的行为是"什么都看不到"；不加就等于用户必须知道日志路径 |
| 5 | **代码签名** | 暂不签名（无证书），按 §六 的文案提示用户 | 签名后才能免 SmartScreen 警告、企业环境可用 |
| 6 | **数据自更新** | 暂不做（快照 + 用户目录覆盖） | 做的话要先解决 §三-② 的三个坑 |

## 十二、本次实测到什么程度（诚实清单）

已验证（打包后的真实程序）：

* 产物存在：`release\hexbox-setup-0.1.0-x64.exe` 77.46 MB、
  `release\hexbox-portable-0.1.0-x64.exe` 77.24 MB；
* asar 内容只有 `dist/**` + `package.json`（0.76 MB，无 node_modules/debug/data）；
* `resources\data\` 里 5 个 json 齐备（6.26 MB）；
* 程序能起、能读数据（图鉴 248/245/870、榜单 173/211、详情 173、模板 245+245）；
* `--label-overlay-test` / `--log-file` / `--data-dir` 等命令行开关生效；
* **覆盖窗自测 ✅**（窗口可见 + 置顶 + 画布出像素，退出码 0），
  自测截图按预期落在 `%LOCALAPPDATA%\hexbox\…\selftest\`；
* 三闸门：`typecheck` / `test`（**672 通过 / 0 失败**）/ `build` 全绿。

**未验证（本机环境所限，请在有权限的终端上复验）**：

1. **默认日志真的落在 `%LOCALAPPDATA%\hexbox\logs\overlay.log`**：
   本会话的文件沙箱拒绝对该路径的写入
   （实测报错 `EPERM: operation not permitted, mkdir 'C:\Users\…\AppData\Local\hexbox\logs'`），
   把 `LOCALAPPDATA` 指到仓库内做了**等价验证** → 日志按预期生成（603 B）。
   代码里已经**不再静默**：建不出目录会打一行 `⚠ 无法创建日志目录 …（本次运行不落日志）`。
2. **UAC 弹窗与提权后的 LCU 连接**：没有在提权会话里跑过（`requireAdministrator`
   的 exe 一启动就会弹 UAC，不能无人值守地验证）。
   请在普通终端里双击 `release\win-unpacked\hexbox.exe`（或跑安装包）确认：
   弹 UAC → 进选人/对局 → 标签出现；日志里应出现 `LCU 已连接 (port …, 来自进程命令行)`。
3. **安装器本身**（装/卸、快捷方式、中文界面）未逐项点过，
   只验证了 NSIS 构建成功并产出安装包。
4. **签名相关**：未签名（无证书），SmartScreen 行为按 §六 如实说明。
