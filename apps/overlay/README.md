# 悬浮窗（Overlay）

游戏内悬浮窗辅助。**不注入 / 不读内存 / 不打开游戏进程句柄 / 不解析封包**。

## 快速开始

```powershell
# 1. 先同步数据（仓库根执行）
pnpm sync

# 2. 启动悬浮窗（仓库根执行）
pnpm dev:overlay
```

> ⚠️ **必须以管理员身份运行**，否则读不到 LCU 凭证（进程命令行被 Windows 屏蔽）。

## 功能

**设计原则：不同阶段显示不同内容。** 玩家在各阶段做的决策不同，
显示与该阶段无关的数据只会干扰（调研依据见
[docs/OVERLAY-STAGES.md](../../docs/OVERLAY-STAGES.md)）。

| 阶段 | 显示内容 | 状态 |
|---|---|---|
| **英雄选择** | 所选英雄的**海斗胜率**（侧边面板） | 已实现 |
| **英雄选择** | **截屏覆盖层**：每张英雄卡片下方 → 该英雄胜率 | 已实现（待真机复验）|
| **英雄选择（已锁定）** | 顶栏「可用」栏**逐格**显示备选英雄胜率 | 已实现（待真机复验）|
| **对局中** | 该英雄口径的**海克斯强度 S/A/B/C + 登场率** | 已实现 |
| 通用 | 游戏流阶段、模式识别、我方已选英雄、数据出处与统计日期 | 已实现 |
| 局内被提供的 3 个海克斯 | 每张卡**底部正中间**显示该英雄口径的**强度评级** —— 大号彩色字母 + 两侧尖括号 `‹ S ›` + 一行「选取率 12.1%」（默认「小」档：字母 cap 高 ≈29 DIP ≈ 卡高 0.066、内容宽 ≈卡宽 21%，发光外廓与选取率行留 ≥4 DIP 正间隙；**同一排三个标签共用一个纵向基准 → 基线像素级相同**）；**面板保持打开时刷新某张卡 → 只更新那一张卡的标签**，刷新后认不出/查不到则**清掉那一张**的标签 | 已实现（**常驻 overlay 已接线**：`pnpm dev:overlay` 局内直接生效；整体关掉 `HEXBOX_OVERLAY_AUGMENT=0`。见 `docs/AUGMENT-PANEL.md` §十二/§十三/§十五/§十六）|

数据来自 `data/`（`dataset.json` 图鉴 + `rankings.json` 榜单 +
`builds.json` 单英雄详情），全部由 `pnpm sync` 预抓，**只读本地、离线可用**。
截屏覆盖层另需 `pnpm templates` 生成的 `data/templates.json`（头像模板 + 名字指纹）。

### 截屏覆盖层（S2）

技术事实、坐标换算与调参依据见 [docs/SCREENSHOT-DEV.md](../../docs/SCREENSHOT-DEV.md)；
最近一轮真机验收的 3 个 bug 与复验清单见
[docs/SESSION-NOTES.md](../../docs/SESSION-NOTES.md)。

```powershell
pnpm templates                                  # 一次即可，生成模板包
pnpm --filter @hexbox/overlay debug:capture     # 标注图（需在选人阶段）
pnpm --filter @hexbox/overlay debug:overlay-test   # 覆盖层渲染自测（旧版：自带一份窗口代码 + 截图上色）
```

> 验**共用的那块画布**（`src/main/label-overlay.ts`）请用下面的
> `HEXBOX_LABEL_OVERLAY_TEST=1` —— 它走的就是局内标签那条路。

### 透明覆盖窗自测（不需要游戏）

```powershell
# 覆盖窗自测：屏幕中线上画左 L / 中 C / 右 R 三个大字母，5 秒后自动退出
$env:HEXBOX_LABEL_OVERLAY_TEST='1'; pnpm --filter @hexbox/overlay debug:augment
# 同一块画布、同一份窗口代码（常驻 overlay 入口）：
$env:HEXBOX_LABEL_OVERLAY_TEST='1'; pnpm dev:overlay
# 想停留久一点：$env:HEXBOX_LABEL_OVERLAY_TEST_MS='15000'
```

> ⚠️ **`$env:` 赋值是会话级的，验完记得清掉**
> （`Remove-Item Env:\HEXBOX_LABEL_OVERLAY_TEST`）或开一个新终端，
> 否则之后跑 `pnpm dev:overlay` 仍会走自测并自动退出
> （那是**按设计**退出，不是覆盖层启动完就崩了）。
> 自测自己也会在退出前打印这一行提示与当前生效的自测变量值，便于分辨。

**用途**：把「局内标签画了但屏幕上什么都没有」里的**窗口可见性**单独隔离出来验证。
它复用正式的 `src/main/label-overlay.ts`（创建/定位/置顶/推送/心跳全走那条路），
所以窗口参数一旦有问题会被它一次暴露，**不必再靠一局真机去试**。

**应该看到**：启动后 1~3 秒内，屏幕上出现三个大方块（约 300×200），
分别是大写 **L / C / R**（屏幕上排成左 / 中 / 右），5 秒后窗口自动消失。

**终端会给出结论**（可判读，不用猜）：

| 打印项 | 含义 |
|---|---|
| `visible=true alwaysOnTop=true` | 画布窗口确实显示了且是置顶层 |
| `画布：3441x1368（窗口内 2294x912，dpr 1.5）` | 画布**位图**尺寸 = 窗口内尺寸 × DPR（这里是 1.5）。若显示 `300x150`（HTML 默认值）→ 画布脚本根本没跑起来，先看下面「构建」的第 3 个坑 |
| `三个标签中心像素：L=已画 C=已画 R=已画` | 渲染端**真的**在画布上画了像素（读 `getImageData`）|
| `✅ 窗口可见 + 置顶 + 画布出像素` | 覆盖窗链路正常；此时屏幕上若仍看不到 → 是显示器/游戏遮挡问题 |
| `❌ …` | 按 ❌ 的那一项定位（窗口没显示 / 被降级 / 画布尺寸不对 / 渲染端没画）|
| `debug/label-overlay-selftest.png` | 画布内容的截图（留证，可发回）|

> 注意：自测画在**主显示器**上（终端会列出所有显示器与各自分辨率）。
> 若你正在看副屏，会"看不到" —— 这本身不是 bug。

排查顺序（**先窗口、再对局**）：
`HEXBOX_LABEL_OVERLAY_TEST=1`（验窗口）→ 进对局跑 `debug:augment`（验标签）。
标签产物里看 `report.json` 的 `labels.championIdSource`（见下），
一眼就能分辨"没画"是**认错英雄**还是**窗口看不见**。

### 局内海克斯识别（S5）

方案、为什么不能按时间猜刷新、真机标定数据与性能结论，
见 [docs/AUGMENT-PANEL.md](../../docs/AUGMENT-PANEL.md)。

**常驻覆盖层（`pnpm dev:overlay`）现在自己就会在局内画强度标签**（S5.4d）——
它与录制工具跑**同一份控制器**（`src/main/augment-controller.ts`），
所以两边不可能漂移。日常使用只需要这一条：

```powershell
pnpm dev:overlay          # 选人胜率标签 + 局内海克斯强度标签（同一块透明画布）
# 整体关掉局内那一条链路（选人标签照常工作）：
$env:HEXBOX_OVERLAY_AUGMENT='0'; pnpm dev:overlay
# 只想看识别结果、不画到屏幕上（排查用）：
$env:HEXBOX_AUGMENT_DRAW='0'; pnpm dev:overlay
# 想把终端日志落成 UTF-8 文件（真机排查；不要用 PowerShell *> 重定向）：
# ⚠️ 用**绝对路径**！pnpm 会把 cwd 设成 apps/overlay，相对路径会落到
#    apps/overlay/debug/…（按仓库根的 debug/ 找不到文件 —— 真实踩过）。
#    启动第一行会打印「日志文件（绝对路径）」与当前 cwd，照它去找。
$env:HEXBOX_LOG_FILE='D:\Projects\hexbox\apps\overlay\debug\overlay-augment.log'; pnpm dev:overlay
```

**日志怎么看**（按顺序）：

> **日志文件在哪**：`HEXBOX_LOG_FILE` 写**相对路径**时，它是相对 **cwd** 解析的，
> 而 `pnpm dev:overlay` 的 cwd 是 `apps/overlay` → `debug/x.log` 落在
> `apps/overlay/debug/x.log`。启动第一行会打印
> `[hexbox] 日志文件（绝对路径）：…` 与 `当前工作目录 cwd=…`，**照那一行去读**；
> 或者干脆写绝对路径（推荐）。

| 日志 | 含义 |
|---|---|
| `[hexbox] 日志文件（绝对路径）：…` | 本次日志落在哪（第一行就会打；相对路径的坑见上）|
| `[hexbox] 进入对局（InProgress）→ 启动局内海克斯链路…` | 阶段判定为局内，开始起链路（探窗口 + 建流约几秒）|
| `[augment] · 门控已就绪（不取帧）：待触发后开始` | 渲染端亲口确认"现在没在取帧"——**常态零取帧**的第一手证据（本地实测 25 秒 `样本 0`）|
| `[hexbox] 局内海克斯链路已就绪` / `[augment] ⏱ 触发方式=API（常态不截屏…）` | 常驻屏幕流已建好，等「死亡 + 等级达标 + 该次未选」才开截屏 |
| `[augment] ⏱ 采样间隔 → 停（常态零取帧）` | 面板**关闭**后回到零取帧（启动那一刻本来就没在取，所以这条只在面板关过之后出现）|
| `[augment] ⏱ 采样间隔 → 250ms：关闭待确认 → 复检取帧…` | 门控说"面板关了"，正在**复检窗口**（3 秒）里继续取帧 —— 面板若还在，下一步就会自己回来 |
| `[augment] ▶ 面板出现 #1 …` → `[hexbox:augment] 推送 active=true labels=3 …` | 面板开边沿 + 三张标签已推到画布 |
| `[augment] 标签：卡1 → S（选取率 12.1%）（扇巴掌）` | 逐卡判定（认不准/查不到会写"不画（原因）"）|
| `[augment] 🔄 检测到卡2 刷新（结构距离 … ≥ 阈值 0.03）` | 面板停留期间某张卡被刷新 → 只重认那一张 |
| `[augment] 🛡 面板信号托底：…` | 卡片判据失效但「面板仍在」信号成立（**翻牌动画**的典型形状）→ **不判关闭** |
| `[augment] ◀ 面板消失 #1 @44.0s — 依据：卡片判据连续未命中 3/3 帧；面板信号 0/5 帧仍成立（阈值…）` | 关闭判定的**完整依据**（两条信号各连续几次 + 阈值 + 判据原文）|
| `[augment] 🔒 假关闭作废（第 N 次）：面板又出现…` | 复检窗口内面板回来了 → 上次是**误判**：不消耗待选、不关截屏，标签会自愈重画 |
| `[augment] 🧹 清空强度标签：原因=面板关闭边沿（第 1 次）` | 面板关闭边沿**立刻清空**（不复用选人的 6 轮 TTL）——**标签消失的正当理由之一** |
| `[hexbox] 🧹 清空强度标签：原因=阶段换手（augment → none…）` | 画布归属变了 = **确认离开对局**（这是另一条正当的清空路径）|
| `[hexbox] ⚠ 保持 疑似离开对局（读到 None，第 1/2 次）→ 保持 InProgress` → `[hexbox] ✔ 采纳（离开对局） 连续 2 次读到 None → 确认离开对局` | 阶段门的**两轮**结论（改前第二轮是静默的，日志看起来像自相矛盾）|
| `[augment] ⏹ 链路停止但不清标签（面板仍开）：原因=…` | 链路停了但标签**故意保留**（清空只由面板边沿/确认离开决定）——看到它**不代表**标签会消失 |
| `[hexbox] ⏹ 忽略已作废的启动结果（令牌 … ≠ 当前会话 …）` | 在途启动的回调过期 → **只忽略自己那一代**，不碰当前会话的流与标签 |
| `[augment] 本局英雄 …（来源 activePlayer-raw：…）` | 档位是"以该英雄为准"的；来源是 `none` = **一张都不画** |
| `[hexbox] 🧹 画布换手：champ-select → augment` | 画布归属切换（选人标签与局内标签不会互相踩）|
| `⚠ 局内海克斯链路未能启动（常驻屏幕流不可用…）` | 本局只显示选人标签，下一局重试；把这段日志发回 |

> **三条"标签消失"来源怎么区分**（grep 一次就够）：
> `grep '🧹 清空强度标签'` 的原因字段是唯一入口 ——
> `面板关闭边沿`（门控两个信号都认定面板不在，连续 3 帧）/`阶段换手`（确认离开对局）/
> `刷新后认不出`·`刷新后查不到强度`（那一张卡，已验收的底线行为）/`重识别失败`（整批无可画结果）。
> 若紧跟其后有 `🔒 假关闭作废`，说明是**误判后自愈**（面板回来了）；
> 若**一条清空行都没有**而标签没了，问题在渲染端/窗口层（先用
> `HEXBOX_LABEL_OVERLAY_TEST=1` 验窗口）。

> **标签生命周期规则（勿违）**：局内强度标签只由
> ① 面板**关闭边沿**、② **确认离开对局**（阶段换手）、
> ③ 本次识别没有可画结果 清空；**链路停止本身不清标签**
> （`vision/augment-clear.ts` 的 `augmentStopClearsLabels()`：默认不清，
> 只有"程序退出""录制收工"明确要求才清）。所以"面板开着、标签被清掉"时
> 先 grep `🧹 清空强度标签` 看原因，再 grep `⏹ 链路停止但不清标签` 排除链路停止
>（详见 [docs/AUGMENT-PANEL.md §十六 6](../../docs/AUGMENT-PANEL.md)，
> 含"宁可多留一个轮询周期，也不要闪一下就没了"的代价说明）。

> 局内链路的启停**依赖 LCU 阶段**（与选人标签同一个来源）：非管理员 → 读不到凭证
> → 阶段恒为 `None` → 局内链路不会启动（终端会警告）。

**验收步骤（打一局，逐条看）**、以及"出问题要收集什么"写在
[docs/AUGMENT-PANEL.md §十六](../../docs/AUGMENT-PANEL.md)（含最小步骤表与日志清单）。

下面是**录制/验证工具**（产物、标定、离线回放；与常驻覆盖层共用同一条链路）：

```powershell
pnpm --filter @hexbox/overlay debug:augment     # 在一局真实对局中录制（产物 debug/augment/）
# 推荐组合：API 触发 + 强度标签画到卡上（默认就画，HEXBOX_AUGMENT_DRAW=0 可关）
$env:HEXBOX_AUGMENT_TRIGGER='api'; pnpm --filter @hexbox/overlay debug:augment
# 标签大小换档（三档；先用下面的离线预览挑）：
$env:HEXBOX_AUGMENT_BADGE='medium'; pnpm --filter @hexbox/overlay debug:augment
# 面板停留期间的采样间隔（单卡刷新检测；默认 400ms，面板一关即回到常态/零取帧）：
$env:HEXBOX_AUGMENT_REROLL_POLL_MS='300'; pnpm --filter @hexbox/overlay debug:augment
# 约 30 秒截屏基准（对比"一次性截屏"与"常驻流"）：
$env:HEXBOX_AUGMENT_BENCH='1'; pnpm --filter @hexbox/overlay debug:augment
# 节流切换自测（不需要游戏）：
$env:HEXBOX_DEBUG_FORCE='1'; $env:HEXBOX_AUGMENT_SELFTEST_CADENCE='1'; pnpm --filter @hexbox/overlay debug:augment
# 出问题时切回一次性截屏做对照：
$env:HEXBOX_AUGMENT_CAPTURE='oneshot'; pnpm --filter @hexbox/overlay debug:augment
# 离线回放真机帧（跑的是线上同一份检测器）：
node --experimental-strip-types scripts/diag-augment-frames.mts <帧.png...>
# 单卡刷新检测的阈值标定（真机帧；噪声 0.013 ↔ 真变化 0.066，阈值 0.03）：
node --experimental-strip-types scripts/diag-augment-reroll.mts
# 整排行基准（锁）回放：真机 report.json 逐帧的"刷新前 vs 刷新后"y/基线，位移必须是 0
# （修复前如实打出 +8.562 DIP / 12.84 物理像素的整排下移）：
node --experimental-strip-types scripts/diag-augment-row-band.mts
```

#### 标签外观预览（**不用开游戏**）

```powershell
# 仓库根执行：拿真机面板帧当底图，画出三个候选大小「候选 1/2/3」→ debug/label-preview.png
node --experimental-strip-types scripts/preview-augment-labels.mts
# 三张卡都用"上线那一档"、只换三个字母（S/A/B）：
node --experimental-strip-types scripts/preview-augment-labels.mts --preset small
# 只看某一套描边/发光风格（默认两套上下对照，段首标题带写着风格名与参数）：
node --experimental-strip-types scripts/preview-augment-labels.mts --style a
# 换底图 / 叠放两张 / 不裁剪：
node --experimental-strip-types scripts/preview-augment-labels.mts `
  debug/shots/inprogress-152515-raw.png debug/shots/inprogress-152509-raw.png
```

默认产出**四段**（`--style both`）：风格 A 的候选对照段 + A 的行对齐段、
风格 B 的同上。候选对照段里三张卡依次是「候选 1 / 候选 2 / 候选 3」
（= 小 S / 中 A / 大 B，S 金 / A 红 / B 青蓝 —— 参考图的三种档位色），每张卡下沿之外
标注 `CAND n <档名> CAP x.x% OF CARD`（默认档多一个 `[DEFAULT]`）、像素尺寸、
字号、cap 高（DIP）与内容占卡宽；`[ROW ALIGNED]` 段三张卡用**同一个预设**、
而且是**一次 `augmentTierLabelsLocked()` 调用**算出来的（= 局内真实路径，标签纵向对齐），
每张卡下沿标注 `IN GAME <字母> y=NNNNpx`。
终端逐档打印**字体串 / 字号 / cap 高（含占卡高比）/ 描边宽 / 发光半径与分层 /
「发光外廓下沿 ↔ 选取率墨迹上沿」的间隙**，再打一节**行对齐核对**
（改前/改后三个标签各自的 y 与基线，含真机"单卡重随"帧回放，以及
**"刷新前 vs 刷新后"的行基准锁回放** —— 修复后位移必须逐位为 `0.000000`），
最后给出"三个候选一览（含间隙）+ 当前默认档是哪一档"。挑好之后改两处：
`packages/vision/src/label-draw.ts` 的 `TIER_TREATMENT`（描边/发光风格）与
`packages/vision/src/augment-label.ts` 的 `AUGMENT_BADGE_DEFAULT`
（或临时 `HEXBOX_AUGMENT_BADGE=medium|large`）。

> 2026-10-06 用户第二次反馈"**字体似乎没变，还是太大**" → 先量后改：
> 用**渲染端真实产物**截图量像素（`debug/tier-canvas-render.cjs` +
> `debug/measure-tier-canvas.mts`）证明上一版缩小的确生效了
> （字母墨迹 54.0 → 39.3 DIP，实测 −27.2% ≈ 计划 −28.0%），
> 但**描边 + 发光把外廓撑到字母的 1.9 倍**，用户看到的就是那一团 → 于是再缩一档。
> 候选 1/2/3 的字母 cap 高占卡高 **6.6% / 6.9% / 7.4%**。
> 同一次还修了"**同一排三个标签不在一个高度**"（真机"单卡重随"帧实测 y 差 17 物理像素
> → 现在 0）—— 细节见 `docs/AUGMENT-PANEL.md` §十三。
>
> 2026-10-06 用户第三次反馈"**small 字体比较合适，但位置稍微有点靠下，有点覆盖到
> 「选取率」，需要稍微向上移动一点点**" → **默认档 medium → small**，并且只改纵向：
> `marginY` 0.06 → 0.07（整条上移 ≈4.4 DIP）、字母与选取率行之间的空隙 0.26 → 0.38 cap
> （字母再上移 ≈3.5 DIP）、发光半径 0.32 → 0.28 cap —— **字母大小一个像素都没动**
> （cap 仍是 29.4 / 30.8 / 32.9 DIP），预设的 `height` 按 `TIER_STACK_RATIO` 同比例放大
> （0.114 / 0.119 / 0.128）来抵消空隙变大。仍全部按 cap 成比例，没有写死像素。
> 用渲染端真实产物量出来（`debug/tier-gap-render.cjs` + `debug/measure-tier-gap.mts`）：
> 「发光外廓下沿 ↔ 选取率墨迹上沿」从**三档全部重叠**（−2.3 / −1.9 / −2.0 DIP）
> 变成**正间隙**（像素实测 **+4.7 / +4.7 / +5.3 DIP**），
> 放大对照图 `debug/label-small-before-after.png`、`debug/label-gap-3sizes-before-after.png`。
>
> 2026-10-06 **二次验收**"**某次单卡刷新后，三个标签整体下移了一点**" → 整排的纵向
> 基准从"每帧按卡片矩形中位数重算"改成"**开边沿锁定一次、面板存续期间一直复用**"，
> 并且重随重识别的裁剪与几何**一律用开边沿冻结的矩形**。真机 `report.json` 回放：
> 修复前整排下移 **+8.562 DIP（12.84 物理像素）**、基线 +10.299 DIP →
> **修复后 0.000000 DIP**（`node --experimental-strip-types scripts/diag-augment-row-band.mts`）。
> 细节见 `docs/AUGMENT-PANEL.md` §十三 末尾（行基准锁）与 §十五（冻结矩形）。

**字体、字号、位置、配色、尖括号与局内完全同源**（同一份 `augmentTierLabels` +
`labelBoxPlan` + `tierTagPlan`），**字形也是同一套字体**：档位字母用
`"Segoe UI Black", "Arial Black", Impact, "Microsoft YaHei UI", …` + 900，
预览读的是 `packages/vision/src/label-letter-outlines.ts`（由
`scripts/render-tier-letter-glyphs.ps1` 从**同一个字体**导出的轮廓 + 度量）。
剩下的差别只有 canvas 的 hinting，以及「选取率」三个汉字/数字仍是内置点阵
（详见 `docs/AUGMENT-PANEL.md` §十三 / §十四）。

> ⚠️ 改了字体栈**首项**就必须重跑那个生成脚本，否则预览会与局内分家
> （`label-draw.test.ts` 锁住了"字体栈首项 == 字形数据的生成字体"）。

> **强度标签（S5.4c）**：面板开边沿 → 渲染端全分辨率识别（哪张卡是哪颗海克斯）
> → 主进程 join 该英雄的强度评级 + 登场率（`builds.json` 的 `augment_json_irank`）→
> 画到**卡内底部空白区、水平居中**：**大号描边彩色字母 + 两侧尖括号 `‹ S ›`
> + 一行「选取率 12.1%」**，没有色块底（认不准或查不到强度**不画**；
> 选取率查不到/为 0 时**只少那一行**，字母照画）。
> 用的是与选人阶段**同一块全屏透明画布**（`src/main/label-overlay.ts` + `overlay:vision`），
> 面板**关闭边沿立刻清空**（不复用选人那套 6 轮 TTL）。
> 终端会逐卡打印 `标签：卡1 → S（选取率 12.1%）`，产物 `report.json` 的 `labels` 段
> 给出 `tier` / `pickRate` / 标签坐标 / 本局预设。
> 标签尺寸由**一处预设**决定（`packages/vision/src/augment-label.ts` 的
> `AUGMENT_BADGE_PRESETS`，默认「小」档：框 85×51 DIP、
> 字母 cap 高 29.4 DIP ≈ 卡高 0.066、字号 42 DIP / 63 物理像素、距卡底 0.07 卡高），
> 字体与描边/发光风格见 `label-draw.ts` 的 `LABEL_TIER_FONT_FAMILY` / `TIER_TREATMENT`，
> 换档用 `HEXBOX_AUGMENT_BADGE=medium|large`，挑档看上面的离线预览。
>
> **发光外廓不许压到选取率那行**（用户 2026-10-06 真机反馈"有点覆盖到「选取率」"）：
> 字母与选取率行之间的空隙 `TIER_RATE_GAP`(0.38 cap) **必须大于**发光半径
> `TIER_LETTER_GLOW`(0.28 cap)，两者都是 cap 的比例、所以换档/换分辨率都不会重新压上；
> 边界由 `label-draw.ts` 的 `tierTagBounds()` 一处给出（离线预览、像素诊断脚本与单测共用），
> 单测锁三档间隙 ≥2 DIP。真机像素实测三档 **+4.7 / +4.7 / +5.3 DIP**。
>
> **整排行基准的锁**（2026-10-06 二次验收，用户："**某次单卡刷新后，三个标签整体下移了
> 一点**"）：三张标签的 `y`/`h` 不是各自卡片算的，也不是每帧按中位数重算的 —— 整排的
> **纵向基准在开边沿锁定一次，面板存续期间一直复用**
> （`augment-label.ts` 的 `lockLabelRowBand()` / `alignRowLabelsLocked()`，
> 局内走 `augmentTierLabelsLocked()`，锁存在 `debug-augment.ts` 的 `rowLock`）。
> 为什么中位数不够：它只抗**离群**、不保证**不变** —— 重随会把被刷新那张卡的矩形换成
> **翻牌动画中间帧**的矩形，三张里两张一变（真机 `report.json` 第二次重随那一帧）
> 中位数就跟着挪，整排下移 **+8.562 DIP = 12.84 物理像素**。"锁"之后刷新**只更新内容**
> （tier / 选取率 / 是否存在），几何一个字都不许动；横向仍是各自卡片居中，未改。
> 回放（刷新前 vs 刷新后 + 真机 `report.json` 逐帧）：
> `node --experimental-strip-types scripts/diag-augment-row-band.mts` → 修复后 `0.000000 DIP`。
>
> **单卡刷新（reroll，S5.7）**：**每张卡最多刷新一次，且刷新发生在面板保持打开期间**
> —— 面板不会因为刷新而关闭，所以开/关边沿看不到它。做法：面板打开期间按
> `HEXBOX_AUGMENT_REROLL_POLL_MS`（默认 **400ms**）采样，在门控分辨率上算**每张卡的
> 内容指纹**（整体区 16×16 + 图标区 8×8、去掉均值的结构距离，阈值 0.03，真机帧标定
> 噪声 ≤0.013 / 真变化 ≥0.066），与"上次识别时那一帧"比：
> 超过阈值 **且** 本帧已成形 **且** 与上一帧一致（动画已停）→ **只重认那一张卡**
> （**用开边沿冻结的矩形**裁它的区域、只跑一次 OCR —— 卡片在面板存续期间不会动，
> 本帧检测到的动画帧矩形只记日志、不改几何）
> 并**整批重绘**：新卡**认不出/查不到强度 → 它自己的
> 标签消失**，其余两张不动（绝不把上一颗海克斯的字母留在新卡上）。
> 面板一关立刻回到常态（api 模式**一帧不取**），行基准锁同时丢弃。终端可判：
> `📐 整排行基准锁定（3 张卡）：框顶 y=… 框高 h=…`、
> `🔄 检测到卡2 刷新（结构距离 0.081 ≥ 阈值 0.03）→ 只重认这几张…`、
> `🔎 单卡重随重识别 成功（58ms）`、`检测到卡2 刷新 → 重新识别（58ms）→ 卡2 → B（选取率 7.3%）（夜狩）`；
> 产物 `report.json` 的 `labels.reroll` 给 `pollMs/threshold/detected/events[]`，
> `labels.events[].origin` = `open` / `reroll`、`refreshed` = 重认的卡号、`tookMs` = 该次耗时、
> `rowBand` = 本帧用的整排基准（一块面板里所有事件必须逐位相同，`justLocked` 只在开边沿为 true）。
> 纯函数在 `packages/vision/src/augment-reroll.ts`（12 项单测）；
> 阈值标定用 `node --experimental-strip-types scripts/diag-augment-reroll.mts`。
>
> ⚠️ **英雄身份（`labels.championIdSource`）必须看**：档位是"以该英雄为准"的，
> 认错英雄 = 整局显示**别人**的强度表（真机事故：玩无极剑圣解析出 `154` Zac、
> 玩酒桶解析出 `43` Karma —— 都是队友，一个 0 命中、一个 9/9 全中的假阳性）。
> 现在**只认"我自己"**，按优先级逐级退让，全不确定就**一张都不画**：
>
> | `championIdSource` | 来源（官方数据面）|
> |---|---|
> | `activePlayer-raw` | 2999 `activePlayer.rawChampionName`（真机形如 `game_character_displayname_Gragas`）→ 英文别名 → 图鉴 `alias` |
> | `activePlayer-name` | 2999 `activePlayer.championName`（中文名）/ `allPlayers[我].championName` → 图鉴 `name`/`alias` |
> | `lcu-champsession` | LCU 选人会话里**我那一格**（`localPlayerCellId`/`me.cellId`）的 championId |
> | `gameflow-self` | gameflow 里能用**我自己的身份**（puuid/summonerId/cellId）定位到的那条记录 |
> | `none` | 拿不到可靠身份 → **不画标签**（`championReason` 写明每一级为什么失败）|
>
> 判定是纯函数（`packages/lcu/src/champion-identity.ts`，真机形状单测）：
> **禁止**"遍历队伍列表取第一个 championId"—— 该函数必须显式收到"我的身份"，
> 类型上就写不出这种猜法。
>
> **"画了但屏幕上没有"**：先用上面的覆盖窗自测排除窗口问题。
> 画布现在会（1）每次推送重申置顶 + `moveTop()`、（2）标签在屏期间每 1 秒
> **重申置顶并重推一次内容**（局内一局只推一次，被游戏抢走 z 序就再也没机会显示）、
> （3）关掉后台节流（被遮挡时 Chromium 会降频合成 → 渲染端画了但不出帧）、
> （4）**画布位图尺寸只由窗口自身决定**（`canvas = innerWidth × dpr`，加载时 /
> `window.resize` 时 / **每次绘制前**都同步；绝不绑定在"只推一次"的某条消息上 ——
> 否则画布停在 HTML 默认的 300×150，按窗口算出的标签坐标全落在画布之外）。
> 日志里 `[label-overlay]` 那行会打印 `visible/alwaysOnTop/bounds`；
> 渲染端 `[overlay-canvas] draw …` 那行会打印 `canvas=` 与 `window=`（两者应成 dpr 倍关系）。
>
> **坐标系**：调用方一律给**屏幕绝对**逻辑坐标（`cardLabelFor` / `slotLabelFor` /
> `toScreenTierLabels`）；屏幕绝对 → **窗口内**的平移只在 `pushLabelOverlay` 里做一次
> （画布铺满工作区，差的就是 `workArea` 原点）。主显示器原点恰是 `0,0`，
> 所以"某处忘了减原点"在单屏上完全看不出来，换副屏才会整体错位。

> 面板出现的**时刻不固定**，接口也拿不到（2999 端口的 Live Client Data API
> 全量核对无 augment 字段），所以门控只认"屏幕上面板在不在"的开/关边沿。
> 判据已用真机帧标定为「卡片行**结构** + **明暗对比**」
> （3 张等宽卡、内部 <40、边框−内部 ≥70），在 1/4 分辨率下同样成立。
> ⚠️ 第一版用"相对基线压暗"，因录制恰好从面板打开时开始而**整局 0 命中**，已废弃。
>
> **截屏走常驻流**（`getDisplayMedia`），不走"每帧现截"：真机基准实测
> 一次性截屏每次固定 0.5~1.0s（缩到 16px 仍要 707ms），连续跑会吃掉帧率。
> 检测在渲染端 worker 里做（`@hexbox/vision/browser` 的纯函数），
> 状态机在主进程，两者只传一个小 JSON。
>
> **节流：常态 1s / 命中后 250ms / 面板停留期间 400ms**。一局 20 分钟海克斯只出现 4 次
> （开局 / 7 级 / 11 级 / 15 级），没必要一直高频；但"什么时候出现"无法预测，
> 所以低频盯着 + 见苗头立刻升频（[augment-cadence.ts](../../packages/vision/src/augment-cadence.ts)：
> **升频不去抖、降频才去抖** —— 多截几帧只花一点 CPU，漏掉一次三选一就全废）。
> 面板**停留期间**改用 `HEXBOX_AUGMENT_REROLL_POLL_MS`（默认 400ms）—— 那时玩家在
> 做选择（不在战斗），单卡刷新检测要这个节奏；**面板一关立刻回到常态**（api 模式回到
> 一帧不取），所以常态开销没变（见 `docs/AUGMENT-PANEL.md` §三/§十五）。
>
> **更好的方式（用户方案）：常态一帧不取，由 API 触发**。
> 2999 能给出 `level` / `isDead`，所以只在「**死亡** + **等级达标** + **该次还没选**」
> 时开截屏，选完（截屏看不到卡片）关掉：
> ```powershell
> $env:HEXBOX_AUGMENT_TRIGGER='api'; pnpm --filter @hexbox/overlay debug:augment
> ```
> 状态机是纯函数 [augment-trigger.ts](../../packages/vision/src/augment-trigger.ts)（14 项单测）：
> 维护"未选等级集合"，**未选会累积**（开局没选、11 级才死 → 一次死亡连弹多次），
> 所以选完一次后若还有够格的未选会**保持开截屏等连选**。
> 2999 连续 5 次拿不到就**退回像素节流**并告警（一次对局不能白跑）。
> 产物多一份 `api-trigger.csv`，用来复盘"为什么这次没开"。
>
> ⚠️ **取证帧默认不抓**：抓全分辨率帧走 `desktopCapturer.getSources`，
> 真机会让**系统光标卡约 1 秒**（实测一局 3 次，与取证时间戳完全对齐）。
> 需要标定样本时才 `HEXBOX_AUGMENT_FORENSICS=1`（并接受卡顿）。
> 另：门控会同时搜**主区 + 全屏恒等区**，避免"窗口探针认错窗口 → 整局 0 命中"。

> ⚠️ **立绘不能用头像模板匹配**。卡片立绘是实时渲染，与静态头像构图差异大，
> 24×24 灰度模板的正确答案得分仅 ~0.53 而错误冠军可达 0.88（两次真机验证，
> 假阳性系统性存在）。立绘只走名字 OCR；头像模板只用于确认态顶栏的方头像。

> **措辞约束**：海克斯面板回答的是「**这个英雄**官方统计上哪些海克斯强度高」，
> **不是**「你被提供了什么」。UI 已写明这一点，避免误导。
>
> **列名不可写错**：海克斯表的数字是**登场率**（pick rate），不是胜率。

> **ID 桥**：海克斯与装备都是**国服数字 ID**，必须经 `dataset.hextechs`
> 与 `dataset.items` join，不能用 CDragon 的 `Augment.id` 硬匹配 ——
> 两套官方 ID 不可换算。

> **出装不在悬浮窗里**：出装通过配装方案直接写进客户端
> （见 [README.md](../../README.md) 的「配装方案写入」）。

**不采用的手段**：读内存、注入、打开游戏进程句柄、解析封包。
截屏 **不属于**此类 —— 它只读取玩家肉眼可见的屏幕像素，是正常做法。

## 架构

```
src/main/index.ts       主进程：LCU 轮询、数据读取、窗口定位/穿透
                        + 阶段启停局内链路 + 画布归属（选人/局内）交接
                        + **单实例锁** + 托盘接线 + 「关窗口 = 最小化到托盘」
src/main/tray.ts        **托盘图标**（常驻覆盖层唯一的交互入口）：菜单（状态/打开日志/
                        打开数据目录/退出）、气泡、退出标志 `quitting`、`close → hide` 拦截
src/main/augment-controller.ts **局内海克斯链路控制器**（S5.4d）：
                        采集几何 → 常驻屏幕流 → 2999 触发 → 门控边沿 → 识别
                        → 该英雄强度表 → 标签（行基准锁）→ 单卡刷新编排
                        **录制工具与常驻覆盖层共用同一份**；它不建窗口、不落盘
src/main/label-overlay.ts 全屏透明标签画布（创建/定位/置顶/推送/心跳）——选人标签与局内海克斯标签共用
src/main/label-selftest.ts 覆盖窗自测（HEXBOX_LABEL_OVERLAY_TEST=1，不需要游戏）
src/main/augment-stream.ts 常驻截屏流（局内门控/识别的主进程侧；含"只重认某几张卡"与取样矩形复位）
src/capture/worker.ts   截屏 worker（渲染端）：取帧 → 门控检测 → 每卡指纹 → 全分辨率识别（可只认指定卡）
src/debug-augment.ts    录制/验证工具：只用控制器 + 录制专属职责（产物/取证/生命周期/兜底路径）
src/preload/index.ts    桥接：只暴露白名单 IPC（contextIsolation=true）
src/renderer/           渲染端：纯浏览器，只接收主进程推送的状态
build/tray/             托盘图标（tray.ico + tray-16/20/24/32/48.png，由
                        scripts/make-tray-icon.py 生成；打包走 electron-builder 的 extraResources）
```

**画布归属由纯函数决定**（`packages/vision/src/visibility.ts`）：
`labelProducerFor(stage, panelState)` 说明"此刻由谁产出标签"（选人循环 / 局内链路 / 谁都不画），
`augmentChainTransition()` 说明"局内链路该不该跑"；两者都有单测，主进程里**不写第二份阶段判断**。

**标签长什么样由纯函数决定**：底面/描边/字体/字号/锚点，以及局内强度标签的
**居中位置（含逐字母视觉居中）、字母 cap 高、字体栈、发光分层、尖括号折线、选取率行**
全在 `packages/vision/src/label-draw.ts` 的 `labelBoxPlan()`（渲染端与离线预览共用），
标签**大小**在 `packages/vision/src/augment-label.ts` 的 `AUGMENT_BADGE_PRESETS`，
档位**配色**在 `packages/vision/src/augment-tier-label.ts` 的 `AUGMENT_TIER_COLORS`。
别在渲染端另写一套 —— 那样离线预览（`scripts/preview-augment-labels.mts`）
就与局内不一样了（预览的纯 Node 光栅化在 `label-raster.ts` / `label-glyph.ts`，
档位字母的**真字体轮廓与度量**在 `label-letter-outlines.ts` / `label-letter.ts`（`scripts/render-tier-letter-glyphs.ps1` 生成），
「选取率」三个汉字的点阵在 `label-cjk.ts`，由 `scripts/render-cjk-rate-glyphs.ps1` 生成）。

**为什么渲染端不做 IO**：渲染端是浏览器环境，`@hexbox/lcu`（child_process）、
`@hexbox/data-store`（fs）无法在浏览器 bundle 中解析。
所有 Node 工作集中在主进程，渲染端通过 `overlay:state` 单向接收状态。

## 关键实现点

### 窗口

- 尺寸 340×560，`transparent: true` + `frame: false` + `alwaysOnTop: 'screen-saver'`
- `focusable: false` —— **不抢焦点**，否则游戏丢输入
- `showInactive()` 显示，不用 `show()`
- `setIgnoreMouseEvents(true, { forward: true })` 鼠标穿透（右上角按钮可切换）

### 定位

- 定位时轮询游戏窗口矩形（`user32!GetWindowRect`，**只读几何信息**）
- 贴游戏窗口右侧，多显示器 / DPI 自动适配
- 查不到游戏窗口时降级到主显示器右侧

### 数据流

```
LCU (127.0.0.1:port) ──poll 2s──→ 主进程 ──overlay:state──→ 渲染端
data/dataset.json  ─┐
data/rankings.json ─┼─启动时读取一次→ 主进程 join → 随状态推送
data/builds.json   ─┘
```

数据在**启动时读取一次**，而不是每次轮询重读 —— 它们是日更的静态数据。

分阶段视图逻辑放在 `@hexbox/core/src/overlay-view.ts`（纯函数）。
放 core 而非主进程的原因：悬浮窗需要管理员权限 + 真实桌面会话，
**CI 根本跑不起来**，只有把逻辑抽成纯函数才能被单元测试覆盖。

### 连不上客户端时

- **读不到凭证** → 显示诊断面板（探测详情 + 编号排查步骤）
- **有凭证但不在对局** → 显示「已连接客户端，当前未在对局中」的待机说明，
  **不**显示诊断面板（那会让人误以为工具坏了）

### 托盘图标与退出（S6）

覆盖层本体**没有可见窗口**（全屏透明、点击穿透、无标题栏、无 X），
所以**托盘是它唯一的交互入口，也是唯一的退出方式**（用户已拍板）：

| 托盘菜单项 | 作用 |
|---|---|
| `状态：等待客户端 / 选人中 / 局内 / …`（**只读**） | 当前状态；来自**现成**阶段读数（纯函数 `vision/overlay-status.ts` 的 `trayStatus()`）|
| `打开日志` | 资源管理器**定位**到日志文件（还没生成时打开目录）；开发模式未落日志时该项禁用 |
| `打开数据目录` | 打开 `resolveDataDir()` 的解析结果（用户覆盖目录 / `resources/data` 快照）|
| `退出` | **唯一的真退出**：`quitApp()` 置 `quitting` → `app.quit()` → 复用既有 `before-quit` 清理（停屏幕流 + 销毁 worker + 清标签）|

- **关窗口 = 最小化到托盘**：常驻覆盖层自己的两扇窗（侧边面板、全屏标签画布）都挂了
  `attachCloseToTrayHide()` —— 非退出状态下 `preventDefault()` + `hide()`。
  截屏 worker 窗口**不挂**（它是故意 `destroy()` 收掉的，`destroy()` 不发 `close`）。
- tooltip 恒含「**退出请右键托盘图标**」（Windows 的托盘提示是单行文本）。
- **单实例锁**：`app.requestSingleInstanceLock()` 拿不到锁 → 第二个实例**什么都不建**、
  打印原因后退出；第一个实例通过 `second-instance` **只弹一次气泡**（"hexbox 已在运行"），
  **不抢焦点、不显示空窗口**。真机出现过两个实例各画一套标签（"多个标签和胜率重叠"），
  且两条链路算出**不同的强度表**。
- **一次性气泡**：连续 3 轮（≈6 秒）读不到 LCU 凭证 → 弹一次可操作提示；
  稳定连上 6 轮后才重新武装（**每个连接会话最多一次**，抖动不会反复打扰）。
  判定是纯函数 `vision/credential-notice.ts`（有单测）。
- 图标：`build/tray/tray.ico`（含 16/20/24/32/48 五档）+ 同名 PNG 兜底，
  由 `python scripts/make-tray-icon.py` 生成（**透明底**：深色任务栏上 512² 那张
  `icon.png` 的深色底板会糊成一团黑）。打包版经 `extraResources` 落到
  `resources/tray/`，开发版直接读 `apps/overlay/build/tray/`；
  两者都找不到时兜底把 `icon.png` 缩到 16px（会糊，但托盘不会没有）。

不需要人点托盘也能验这两条路径（机器人点不了菜单）：

```powershell
# 自测：8s 后模拟"关窗口"（应最小化到托盘、进程仍在），再过 3s 模拟"托盘菜单退出"
# 日志里应看到：两行「已最小化到托盘」→「关窗口之后进程仍在运行 = true」→「退出清理…」
cd apps/overlay
node run-electron.mjs . --tray-autotest 8000 --log-file D:\hexbox-dev.log   # 开发入口（实测可用）
# 打包版同理：hexbox.exe --tray-autotest 8000 --log-file D:\hexbox.log
# 一次性气泡的验证注入（把"读不到凭证"喂给判据；正常用户不会设）：
$env:HEXBOX_NOTICE_TEST='1'; pnpm dev:overlay
```

> ⚠️ Windows 11 的**新托盘图标默认进"隐藏的图标"浮出菜单**（注册表
> `HKCU\Control Panel\NotifyIconSettings` 里 `IsPromoted` 为空）——
> 用户需要点任务栏的 `^` 或把它拖出来。这是系统行为，不是本程序的问题；
> 所以 tooltip 与那条气泡提示都写清了"退出/日志在托盘菜单里"，避免用户找不到它。

## 构建

```powershell
node build.mjs     # 产物: dist/main/index.cjs, dist/preload/index.cjs, dist/renderer/*
```

### 打包成 Windows 安装包

```powershell
# 仓库根执行；配置在 apps/overlay/electron-builder.yml
pnpm --filter @hexbox/overlay package:win      # → release/hexbox-setup-*.exe + 便携版
pnpm --filter @hexbox/overlay package:dir      # 只出 release/win-unpacked（最快）
```

只发**常驻覆盖层**（`dist/debug-*.cjs` 等诊断入口不进安装包）；
"覆盖窗自测"改为主入口的命令行开关 `--label-overlay-test`。
数据（`data/*.json`）作为快照打进 `resources/data`，日志落在
`%LOCALAPPDATA%\hexbox\logs\overlay.log`。
完整事实（UAC 取舍、代码签名、数据更新、网络镜像、失败点）见
[docs/RELEASE-WINDOWS.md](../../docs/RELEASE-WINDOWS.md)。

### 启动即崩：GPU 子进程起不来（**程序内已修复，不需要用户加参数**）

真机症状（普通终端里双击运行打包版）：数据全都加载成功，然后

```text
ERROR:gpu_process_host.cc(976) GPU process launch failed: error_code=18   ← 刷十余条
FATAL:gpu_data_manager_impl_private.cc(423) GPU process isn't usable. Goodbye.
```

`FATAL` 是 Chromium **直接杀进程**（退出码 `0x80000003`），JS 侧连 catch 的机会都没有，
所以只能在 `app ready` 之前用命令行开关**预防**。主入口（`src/main/index.ts` 开头
`HEXBOX_GRAPHICS_SWITCHES`）现在固定追加：

| 开关 | 干什么 | 为什么需要 |
|---|---|---|
| `--disable-gpu` | 关硬件加速 | 本程序只用 2D canvas + CPU 纯函数识别，零代价（实测自测 ✅）|
| `--in-process-gpu` | **GPU 服务跑进主进程** | 关键一条：光关硬件加速**挡不住**上面的 FATAL（Chromium 仍要为软件合成起 GPU 子进程）；进了主进程 = "子进程起不来"这条路径结构上不存在 |
| `--disable-gpu-sandbox` | 兜底 | 万一某版 Electron 忽略上一条，别让 GPU 沙箱成为起不来的原因（**不**放开渲染进程沙箱）|

> ⚠️ **不要改成 `app.disableHardwareAcceleration()`**：实测它① 挡不住这条 FATAL；
> ② 与 `--in-process-gpu` 同用时**退出必崩**（0xC0000005，3/3 复现）。
> 逐条实测表见 [docs/RELEASE-WINDOWS.md §十三](../../docs/RELEASE-WINDOWS.md)。

日志里每次启动都会有一行 `[hexbox] 图形引导：…（实际生效 3/3）`；子进程/渲染进程
异常消失会打一条 `⚠ 子进程消失：type=… reason=… exitCode=…`，并在**启动 20 秒内**
遇到 `launch-failed`/`crashed` 时自动带 `--no-sandbox` 重启**一次**（有防止重启循环的标记）。

用户侧排查手段（Chromium 自己的开关，直接透传；**必须在终端里跑**才看得到 GPU 报错）：

```powershell
& "$env:LOCALAPPDATA\Programs\hexbox\hexbox.exe" --disable-gpu     # 关硬件加速
& "$env:LOCALAPPDATA\Programs\hexbox\hexbox.exe" --no-sandbox      # 整片沙箱起不来时
& "$env:LOCALAPPDATA\Programs\hexbox\hexbox.exe" --in-process-gpu  # 默认已加
```


为什么用 esbuild 而非纯 tsc：
主进程/preload 需要打包 workspace 依赖（`@hexbox/lcu` 等），
Electron 渲染端也需单文件 IIFE。

### 三个踩过的坑

1. **`"type": "module"` 与 `.js` 产物冲突**
   项目根是 ESM，Electron 会把 `.js` 当 ESM 加载，报 `require is not defined`。
   → 产物用 `.cjs` 扩展名。

2. **`ELECTRON_RUN_AS_NODE=1`（DSH harness 环境）**
   该变量会让 electron.exe 以纯 Node 运行，`require('electron')` 返回路径字符串而非 API。
   → 桌面环境正常；在 harness 内启动会失败，需真实桌面运行。

3. **渲染端产物路径**（真机事故 2026-10-05：「画布 300x150，屏幕上什么都没有」）
   esbuild 的 `outdir` 布局由 **outbase** 决定，而 outbase 是从入口的**公共父目录**
   推断的：入口全在 `src/renderer/` 时产物落在 `dist/renderer/*.js`（正确）；
   一旦加入 `src/capture/worker.ts`，公共父目录变成 `src`，
   `renderer.js` / `overlay-canvas.js` 就被写到 `dist/renderer/renderer/` ——
   而 HTML 里写的是 `./overlay-canvas.js` → 模块 **404**。
   **这个 404 是静默的**（Electron 不把它交给 `console-message`，日志转发看不到），
   于是整块画布脚本一行都没跑：`canvas.width/height` 停在 HTML 默认的 **300×150**，
   按窗口算出来的标签坐标全部落在画布之外 —— 日志说"画了"、屏幕上一个字都没有。
   → 浏览器侧构建给**每个入口显式写 `out`**；并且 `build.mjs` 会自检每个 HTML 里
   `src` / `href` 指向的本地文件是否存在，缺失就**让构建失败**（不再静默）。
