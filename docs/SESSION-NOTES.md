# P2-S2 会话交接备忘（2026-09-28 收工）

> 用途：下次会话直接续上,不重复排查。状态以本文为准。
> 上一份备忘（09-27）中「确认态误检」问题的修复记录见下。

## 当前状态：S2 阶段一 ✅ / 阶段二 ✅（离线回放验证,待真机验收）

### 09-28 修复：确认态（锁定英雄后）无显示

**需求语义修正（重要,勿回退）**：
旧实现把确认态当成「识别已锁定的英雄、把它的胜率画在左上角」——
**错的**。正确需求（用户确认）：锁定后顶部「可用」栏列出的是
**未选的备选英雄**（方头像）,应给**每个有头像的格子**各显示一个胜率标签。

**离线回放已验证**（用 debug/confirmed-state.png 真机截图）：
- 格 1 狂暴之心 0.950 / 格 2 炼金术士 0.943（方头像与模板库同源,得分远超卡片立绘）
- 标签正确落在槽位正下方 (752,80) / (826,80)
- 悬停态（raw.png）不受影响:2 张卡片 + OCR 正常

### 根因链（三处叠加,都已修）

| # | 根因 | 修复 |
|---|---|---|
| 1 | 提取头像时内缩 0.15（为卡片立绘设计的参数）把方头像得分从 0.93 压到 0.79,永远过不了 0.85 | 方头像用**整个槽位盒**提取（inset=0）,得分 0.93+ |
| 2 | `matchChampionCareful` 的 minMargin=0.10 会误杀真机数据（肯恩 vs 炼金 margin=0.094） | 顶栏用独立阈值 0.80/0.05（`detectTopBarCandidates`） |
| 3 | 旧槽位几何偏差 ~20px 且只处理第 1 格 | 实测校准 10 格几何（见 confirmed.ts TOP_BAR_ROW）,逐格处理 |

另修:`data/templates.json` 里的 **60000+ 变体 ID**（CDragon 静态占位,
如 60038 = 虚空行者的变体,与真英雄同名同图）会让匹配命中后 join 不到
数据 → 主进程与 debug 工具加载模板时已排除（championId < 60000）。

### 关键实测数据（2026-09-28,勿凭印象改）

- **槽位几何**（2400×1350 逻辑坐标）:第 1 格左缘 x=659,顶 y=19,
  格盒 93×94,步进 110,共 10 格。归一化后与分辨率无关 ——
  两张不同分辨率真机截图（3413×1920 / 2400×1344）的竖线归一化中心
  完全一致（x0=0.2746, step=0.0458）。
- **占用检测**:12% 内缩 16×16 灰度的标准差 —— 占用格 60+,空格 <9;
  阈值取 0.18×255≈46。
- **快照形态**:本机显示器 2294×960@1.5（宽高比 2.39）,两态截图
  都判为 **window 形态**;`windowRectToCapture` 在 display 形态下的
  平移缩放由单测覆盖。

### 新增代码地图

| 文件 | 内容 |
|---|---|
| `vision/confirmed.ts` | 重写:TOP_BAR_ROW 几何 / isSlotOccupied / detectTopBarCandidates / diagnoseTopBarSlots（旧单格接口标 @deprecated 保留） |
| `vision/win-geometry.ts` | 增 `windowRectToCapture`（窗口归一化→截屏归一化,window 形态恒等） |
| `vision/card-overlay.ts` | 增 `slotLabelFor`（槽位下方紧凑标签,最小宽 56,不翻转） |
| `overlay/main/vision-loop.ts` | 确认态分支:逐格识别 → 每格一个 slotLabelFor 标签;全失败时降级提示（diag 可见） |
| `overlay/main/index.ts` | 模板加载排除 60000+ 变体 ID |
| `overlay/debug-capture.ts` | result.json 增 topBar 逐格诊断;标注图画出 10 个槽位框 |
| `overlay/renderer/overlay-canvas.ts` | 紧凑标签渲染（高 <30 单行:胜率+英雄名截断） |

### 验收环境备忘（沿袭 09-27）
- 显示器 2294×960@1.5,截屏 3413×1920,窗口 1600×900(逻辑,GetWindowRect 直出)
- 诊断日志: `[hexbox:vision]` 每轮打印判定形态;确认态 diag 打印每格 `英雄=分数`
- 覆盖层自测: `$env:OVERLAY_TEST_VISIBLE='1'; pnpm --filter @hexbox/overlay debug:overlay-test`

### 测试与文档状态
- vision 112 项（新增 confirmed 10 项 + geometry/card-overlay 各 3 项）,全仓 260 项全绿
- `docs/SCREENSHOT-DEV.md` §3.3 已更新为两阶段新语义

### 下一步（真机验收清单）
1. 进入选人,悬停 2~3 张卡片 → 覆盖层每张卡片下方显示胜率（原有功能,应不回归）
2. 锁定英雄 → 顶栏每个备选头像下方显示胜率标签;**核对标签与头像对齐**
3. 对局内/其它界面 → 覆盖层清空,不残留
4. 若标签错位:跑 `pnpm --filter @hexbox/overlay debug:capture`,看 result.json
   的 topBar 逐格诊断 + annotated.png 的槽位框（紫=占用,灰=空）

### S2 剩余 + S3/S4
- S3: 召唤师技能推荐(需先调研数据源,勿假设)
- S4: 移除侧边悬浮窗(当前保留用于对照)
