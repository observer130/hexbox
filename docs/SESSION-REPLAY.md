# 会话录制与回放（S5.7）：把"再打一局"变成"跑一次回放"

> 面向的痛点是**验证链路太长**：局内链路的每一个坑都是花一整局真机换来的，
> 而门控/识别/标签的组合行为在此之前**只能**靠真机验证（`pnpm test` 碰不到像素，
> CI 更不可能开游戏）。本文写这套基建的边界、格式、用法与已知限制。
>
> 相关文档：[AUGMENT-PANEL.md](AUGMENT-PANEL.md)（局内识别与标定，§十五 单卡刷新）、
> [ROADMAP.md](ROADMAP.md)、[SCREENSHOT-DEV.md](SCREENSHOT-DEV.md)。

## 一、一句话

把一局对局录成 **帧库 + 2999 采样 + 门控边沿 + 身份留档**，然后用**虚拟时钟**
驱动**线上同一个 `AugmentController`** 重跑那一局：一局 20 分钟在**几秒**内跑完、
完全确定性、不需要游戏/管理员/Electron。

## 二、三层能力（别混在一起谈）

| 层 | 驱动的是什么 | 能回答的问题 | 需要什么 |
|---|---|---|---|
| **决策回放** | 会话里的**数值**（2999 采样、门控边沿）喂给纯函数 | "第 2 次海克斯为什么没抓到"、"改了触发记账会变哪几局" | 只要 `api-trigger.csv`（**已有一局留档**） |
| **识别回放** | 真机帧 → **线上同一份**检测器/OCR/指纹 | "这几帧能不能认出名字"、"阈值改了会漏几颗" | 帧图（已入库 6 张 fixture） |
| **闭环回放** | **线上同一个控制器** + 帧库 + 虚拟时钟 | "面板出现后多久画上标签"、"单卡刷新多久被发现"、"常态到底取了几帧" | 一次完整录制（`HEXBOX_AUGMENT_RECORD=1`） |

**必须守住的纪律：回放只做"驱动"，判据一律来自线上那几份纯函数**
（`augment-panel.ts` / `augment-ocr.ts` / `augment-reroll.ts` / `augment-trigger.ts` /
`augment-cadence.ts` / `augment-tier-label.ts` / `augment-recognize.ts`）。
这个项目踩过"诊断脚本与主流程两份实现"的坑，所以**绝不允许**为回放再写一份判据 ——
那样"回放全绿、真机不对"只是时间问题。

## 三、会话格式

```
debug/sessions/<YYYYMMDD-HHMMSS>-<阶段或英雄>/
  session.json      几何 + 配置 + 环境变量快照 + 身份留档（回放要凭它复原现场）
  frames.idx.jsonl  每帧一行：seq / atMs / kind / file / crop（+ 录制当时的判定，黄金对照）
  gating/NNNNNNNN-N.png   **门控真正看到的那些帧**（1/3 画布，灰度，整幅）
  native/NNNNNNNN-N.png   识别用的原生帧（灰度；一次面板 3~5 张）
  api.jsonl         2999 采样（触发状态机的**输入** + 当时的判定）
  edges.jsonl       门控边沿（开/关）——回放驱动 `notePanelOpen/Closed` 靠它
  phase.jsonl       LCU 阶段采样
  report.json       收工时的控制器快照（回放做 golden 逐项比对）
```

**时间约定（最容易错的地方）**：四类产物的 `atMs` **共用同一个零点** = 会话里第一个事件的
绝对时钟（`session-recorder.ts` 的 `rel()`）。各归一化各的，就会出现"边沿与帧差了几秒"
这种查不出来的错位 —— 回放的时间关系全靠它们。

**为什么是"门控真正看到的那些帧"而不是定时录屏**：定时录（例如固定 4fps）录到的时刻与
门控实际取帧的时刻对不上，边沿/节流/单卡刷新的**时间关系**就被改了。逐个门控帧落盘在语义上
就是 trace，回放逐位一致。代价：**只覆盖门控真的取过帧的那些时刻**（api 模式常态零取帧 ⇒
几乎不录），所以"改采样节奏"的闭环回放只能看到帧库覆盖到的地方（回放报告给 `gaps`）。

**为什么存灰度**：链路的全部判据（门控/OCR/指纹）都只看 `0.299/0.587/0.114` 的亮度，
灰度在语义上无损（`png.test.ts` 与 `augment-panel-fixtures.test.ts` 都锁了这条），
而体积降一个数量级（1/3 画布上一帧约 100~200KB，整幅原生帧约 1~2MB）。

**为什么整幅存档**（不裁到搜索区）：卡片矩形/指纹/标签全在**画布归一化坐标**下，
裁剪存档会给"补贴图坐标换算"这种静默偏移留口子。格式里保留了 `crop` 字段与
`regionsInCrop()`（要求**完整覆盖**，部分覆盖直接返回 null 让调用方跳过，
而不是悄悄缩小检测范围）。

## 四、怎么录

```powershell
# 常驻覆盖层（正常打一局就录；默认关，只有显式打开才录）
$env:HEXBOX_AUGMENT_RECORD='1'; pnpm dev:overlay

# 录制/验证工具（对局中跑；同一条录制路径）
$env:HEXBOX_AUGMENT_RECORD='1'; pnpm --filter @hexbox/overlay debug:augment

# 录到别处
$env:HEXBOX_AUGMENT_RECORD_DIR='D:\hexbox-sessions'
```

| 变量 | 含义 |
|---|---|
| `HEXBOX_AUGMENT_RECORD` | `1`/`true`/`on` = 开录制；**默认关**（关的时候这条路径一个字节都不走） |
| `HEXBOX_AUGMENT_RECORD_DIR` | 会话根目录；默认 `<仓库根>/debug/sessions` |

**体积**（实测口径，用于决定录几局）：门控帧 = 画布 1/3（1080p 上 960×540）灰度 PNG
约 100~200KB；api 模式一局通常只录到"开截屏窗口内"的帧（几十~几百帧）；原生帧一局
约 10~25 张、每张 1~2MB。**一局大约 10~40MB**。

**开销**：帧是**同步**编码 + 同步写盘的（实测：1/3 画布 1529×640 约 6~8ms、
原生 4587×1920 约 47ms）。它只发生在面板出现/翻牌时（玩家正在选）；改成异步写会引入
"退出时尾巴帧还在队列里"的丢数据风险（**真机教训**：一整局产物曾因退出路径没落盘而全丢），所以宁可同步。

⚠️ **录制器必须把"本局英雄"写进 `session.json`**（`observer.onIdentity` → `setMeta({champion})`）。
回放靠它组强度表 —— **不记就是"回放永远一张标签都画不出来"**（而且很难从报告里看出来：
它只会说"未认出英雄"）。同理，`session.json` 里的 `data`（指纹库条数 / 强度表日期）也要写 ——
那是"为什么这次认不出 / 查不到强度"最便宜的一条线索。

⚠️ 产物在 `debug/`（gitignored）：**含个人信息**（对局画面），只在本机用于回放，
不要提交。入库的 fixture 一律是"裁到搜索区的小图"（见 `packages/vision/fixtures/`）。

## 五、怎么回放

```powershell
# ① 触发记账回放：把录到的 2999 采样喂给线上触发状态机（不需要帧、不需要游戏）
node --experimental-strip-types scripts/replay-api-trigger.mts
node --experimental-strip-types scripts/replay-api-trigger.mts debug/augment/api-trigger.csv
node --experimental-strip-types scripts/replay-api-trigger.mts debug/sessions/<会话目录> --json

# ② 闭环回放：线上同一个控制器 + 帧库 + 虚拟时钟
node --experimental-strip-types scripts/replay-session.mts                    # 合成会话（入库的真机帧 + 真机 2999 采样）
node --experimental-strip-types scripts/replay-session.mts debug/sessions/<会话目录>
node --experimental-strip-types scripts/replay-session.mts debug/sessions/<会话目录> --json

# ③ 帧 fixture 重建（源帧在 debug/ 里，脚本把真机帧缩到门控分辨率、裁到搜索区、转灰度后入库）
node --experimental-strip-types scripts/make-frame-fixtures.mts
```

回放报告要连着读的四行：

- `门控：采样 N 帧（帧库唯一 U 帧 / **重复投递 R 次** / 缺口 K 次 / 过期丢弃 D 帧）`
  —— 这四个数**必须一起读**：`K > 0` = 这段虚拟时间里帧库没覆盖；
  `R > 0`（帧库比请求的节奏稀疏）= **改节奏的结论要打折**；
  `D > 0` = 那些重复帧已被控制器的 `STALE_FRAME_MS` 保护丢掉（它在回放里**真的生效**）；
- `触发：模式 api、采样 …、结束时 …、待选 […]` —— `待选` 非空 = **这几次海克斯没被消耗**，
  这正是"某次没抓到"的答案；
- `与录制判定不一致的采样：N 条（漏开 X / 多开 Y）` —— **漏开必须为 0**（录像开着截屏、
  回放却关着 ⇒ 整整漏掉一次海克斯）；**多开是预期的**（录像是历史版本的状态机跑的，
  而且没有门控边沿时窗口只能靠 45 秒超时收场）。

## 六、离线能回答的问题（不需要再打一局）

| 问题 | 命令 / 机制 |
|---|---|
| 这一次海克斯为什么没抓到 | `replay-api-trigger.mts` → `待选` 与窗口表 |
| 改了触发记账（等级/死亡/连选/开局窗口）会变哪几局 | `replay-api-trigger.mts <会话目录>` 的差异清单（**漏开**是硬指标） |
| 面板出现/消失的判定对不对（含翻牌动画、假关闭） | `replay-session.mts` 的边沿表 + `假关闭作废` 计数 |
| 常态是不是真的零取帧 | 闭环回放的 `采样 N 帧`（api 模式常态应当一帧不取）+ `节流` 占比 |
| 单卡刷新多久被发现、阈值会不会误报 | 闭环回放的 `单卡刷新` 事件（`atMs` + 结构距离） |
| 标签为什么没画（认不准 / 查不到强度 / 没认出英雄） | `识别` + `标签` 段 + 控制器日志里的逐卡原因 |
| 阈值/档位改了长什么样 | `scripts/preview-augment-labels.mts`（离线预览，共用同一份几何/配色） |
| 检测器在真机帧上还成立吗 | `packages/vision/fixtures/` 的 6 帧回归（`pnpm test`） |
| 识别核心（开边沿整批 / 单卡重随）逻辑对吗 | `augment-recognize.test.ts`（10 项，以前这段**一行都测不到**） |

## 七、CI 覆盖什么、不覆盖什么

| | CI（`pnpm test` / `pnpm typecheck` / `pnpm build`） |
|---|---|
| 会话解析（含真机旧留档里**未转义**的 `pending` 列） | ✅ `augment-session.test.ts` |
| 触发回放引擎 + 真机 2999 留档不变量（**不许漏开**） | ✅ `augment-session-fixture.test.ts` |
| 真机帧 → 线上检测器（3 正 / 4 负，含"门控说在、原生重检说不在"的现场） | ✅ `augment-panel-fixtures.test.ts` |
| 识别核心（整批 / 单卡重随 / 冻结几何 / 失败回传） | ✅ `augment-recognize.test.ts` |
| 虚拟时钟语义（含 `await new Promise(setTimeout)` 链） | ✅ `virtual-clock.test.ts` |
| 录制 ⇄ 回放目录往返（格式不漂移） | ✅ `apps/overlay/src/main/session-recorder.test.ts` |
| 一次真实会话的端到端闭环回放 | ⛔ 需要 `debug/sessions/` 的录制（**不入库**：含对局画面）→ 本机跑 `scripts/replay-session.mts` |
| 窗口置顶/合成、`getDisplayMedia` 帧率、`desktopCapturer` 的 DWM 卡顿、多显示器 DPI、LCU 凭证、单实例、打包路径 | ⛔ **回放测不了**，仍需一局真机（但可以按里程碑打，而不是每改一行打） |

## 八、保真度与已知限制（结论必须连着它们读）

1. **帧库 = 那时的输入序列，不是"完整的世界"**：闭环回放只能看到录到的帧。
   trace 回放（原样按录制时刻喂）与真机逐位一致；**改采样节奏**的回放只在帧库覆盖处有效
   （报告给 `gaps`）。
2. **没有原生帧就没有标签**：会话里若只有门控帧（旧会话、或只想过门控），识别会明确报
   "回放：会话里没有这一时刻的原生帧"，报告里 `labelsUnavailable > 0` —— 不假装跑过。
3. **降采样近似**：入库 fixture 是把 `debug/` 的真机截图用**盒式平均**缩到门控分辨率的，
   而线上是 Chromium 的 `drawImage`。两者不是逐位相同 —— fixture 是"同分布"，不是"同一帧"。
   出现分歧时先怀疑这一点，再怀疑判据。
4. **重复投递与过期帧都是可见的**（不许假绿）：帧行里的 `atMs` 是**帧的采集时刻**（不是
   "投递时刻"），所以重复投递会计入 `frameReuses`、过旧的帧会被控制器当场丢弃并计入
   `droppedStaleFrames`。一句话：**"采样 N 帧"不等于"看到了 N 幅画面"**。
5. **原生帧过期 ⇒ 明确报失败**：单卡重随时，帧库里常常只有开边沿那一张原生帧；
   拿它重认会得到**刷新前**的名字 → 合并后档位不变 → 报告读起来是"检测到了重随、重认成功、标签没变"   ，与录制**相反**却全绿。所以超过 `MAX_NATIVE_FRAME_AGE_MS`（1500ms）就明确报
   `ok:false`（理由含"原生帧过期"）并计入 `staleNativeFrames` —— **宁可报失败，不报假绿**。
6. **`desktopCapturer` 的帧 ≠ 门控的帧**：真机留档 `open-1.png` 就是现场证据 ——
   门控（屏幕流 1/3 画布）说"3 张卡片"，同一时刻 `desktopCapturer` 抓的那张图上
   原生重检说"0 张"，本仓库的 1/3 重建也说"0 张"。所以**会话必须录门控画布的帧**，
   不能拿取证帧代替（格式与录制器都是按这条结论做的）。
7. **搜索区影响判据**：`detectCards` 的候选桶是**相对搜索区**算的 —— 拿
   `PANEL_ROW_REGION` 去跑 `open-1.png` 会从"3 张卡片"变成"边框带太少"。
   fixture 因此把留档里的 `region` 一起存下来（`frames.json`）。
8. **窗口内再死一次会重新 arm**：一个截屏窗口可以合法地超过 `armWindowMs`（45s），
   所以"每窗 ≤ 45 秒"不是不变量，**"关不掉"**才是要防的。

## 九、设计约束（改这条链路时必须守住）

1. **控制器不许 import Electron**（`augment-controller.ts` 只依赖 `@hexbox/vision` /
   `@hexbox/core` / `@hexbox/data-store` / `@hexbox/lcu`）。带环境依赖的四样东西全部注入：
   | 依赖 | 线上实现 | 回放实现 |
   |---|---|---|
   | 时钟 | `Date.now` | `createVirtualClock()`（时间只在驱动器推进时走） |
   | 截屏源 | `augment-capture-stream.ts`（`AugmentStream` 工厂） | 帧库（`replay/session-replay.ts`） |
   | 采集几何 | `augment-geometry.ts`（`screen` + win-geometry） | `session.json` 存档 |
   | 2999 | `createLiveDataClient()` | `api.jsonl`（按虚拟时间回答"最近一次采样"） |
   | 身份 | LCU + 2999 → `resolveMyChampionIdentity()` | `session.json` 的身份留档 |
2. **识别只有一份**：`packages/vision/src/augment-recognize.ts` 是渲染端 worker 与回放的
   共同实现。要改识别编排，改那一份（`worker.ts` 只留"从屏幕流取像素"这件事）。
3. **观察者是旁路**：录制的三个回调（2999 采样 / 门控边沿 / 帧像素）都只是"把已经算出来的
   东西交出去"，控制器**不碰 fs**，产物怎么落地由入口决定。
4. **`atMs` 一律绝对时钟**：观察者回调给绝对时间，产物内部用同一个零点归一化。

## 十、踩过的坑（都在这套基建自己的实现里出现过）

1. **驱动器"没有到期任务"就退出** ⇒ 回放出来是"0 帧采样、0 次识别"。
   `controller.start()` 里有一串 await，续体要等事件循环推进后才会排新的定时器 ——
   所以循环必须"**先让出一次**再判断"，并且只有"已启动且链路已停"才算结束。
2. **合成会话把面板帧排错了位置**（排在一次"等级还不够"的死亡旁边）⇒ 整段回放 0 命中。
   正确做法是先用**线上同一份触发状态机**算出这一局的截屏窗口，再把帧放进窗口里。
3. **`api-trigger.csv` 的旧版 `pending` 列没有转义**（`[0,7,11,15]` 直接塞在 CSV 里），
   天真的 `split(',')` 会把它拆成四列**而不报错**。解析器按"合回到 `]`"处理，两种形态都吃。
4. **中途启动丢弃 ≠ 选完**：`gameTime > midGameStartSec` 时开局那次会被按"已选"丢弃，
   它与门控关边沿的**真消耗**必须分开记（混在一起会得出"开局那次选完了"的错误结论）。
5. **裁剪存档的坐标基底不能混**：帧库可以是裁剪存档（`crop`），那时"卡片矩形"
   是画布坐标、"帧像素"是裁剪坐标 —— 拿画布矩形去采裁剪位图会**静默取错像素**（基线指纹全错，
   表现只是"重随检测不灵"）。所以 `recognizeOpen` 把**指纹取样基底**（`fingerprintBasis`）显式化：
   调用方自己保证 `bitmap` 与 `rects` 同坐标系。另外 `regionsInCrop()` 要求**完整覆盖**，否则跳过并计数。
6. **"录制器稍后再建"会丢第一帧/第一条采样**：它必须在 `controller.start()` **之前**就存在（几何与英雄
   用 `setMeta()` 事后补写）。同理，**英雄身份必须补写**，否则回放永远不画标签。
7. **`FrameStore` 的解码缓存必须有上限**：一局上千帧×（门控 3.7MB / 原生 33.6MB）是 GB 量级；
   现在只留最近 4 帧（回放本来就只重复访问最近的帧）。

## 十一、后续可做

- **参数扫描**：把 `PANEL_THRESHOLDS` / `AUGMENT_REROLL_THRESHOLD` / `REROLL_POLL_MS` /
  开边沿重试预算当搜索空间，在 N 局录制上跑指标（检出延迟、假阳性帧数、每局取帧数、
  重随延迟、OCR 准确率）。
- **时间伸缩**：把某段帧按 2× 播，测时序余量（真机给不了）。
- **混沌注入**：丢帧、乱序、过期帧（`STALE_FRAME_MS`）、presence 抖动 —— 代码里每种都有
  分支，回放是唯一能确定性测它们的地方。
- **录制视频**（可选人工复核资产）：在已有的 `getDisplayMedia` 流上挂 `MediaRecorder`，
  出问题时直接看那一局（机器可读的输入仍然是帧库）。
