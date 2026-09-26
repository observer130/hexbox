# P2-S2 会话交接备忘（2026-09-27 收工）

> 用途：下次会话直接续上,不重复排查。状态以本文为准。

## 当前状态：S2 阶段一 ✅ / 阶段二 ❌(已知问题,明天修)

### 已验证可用 ✅

1. **卡片定位**（vision/grid.ts）：多轮真机稳定检出 2~3 张卡片
2. **名字 OCR**（vision/ocr.ts + templates.json 名字指纹库）：
   离线回放 2/2 正确;真机识别出 戏命师 48.9% / 腕豪 52.1% / 冰霜女巫 等
3. **胜率 join**（core/champSelectInfo + rankings.json）
4. **覆盖窗口渲染**（overlay.html + overlay-canvas.ts）：
   截图证实标签正确绘制在卡片下方
5. **侧边悬浮窗数据**：首次真正工作(封魔剑魂 56.0% 截图证实)
6. **失败容忍**：连续 4 轮失败才清空,标签不再闪失

### 待修问题 ❌（明天从这里开始）

**问题：确认态(锁定英雄后,大立绘)出现 2 个「暂无数据/未识别」标签,
画在了皮肤轮播缩略图附近(x≈830 和 x≈1380, y≈930 逻辑)——
而预期是: 左上角(24,90)显示已锁定英雄的胜率。**

分析（按可能性排序）:
1. 确认态截屏里 detectCards 仍检出了 2 个"卡片"(误检,把皮肤
   缩略图/轮播 UI 当卡片) → 走了卡片分支而非确认分支 →
   OCR 失败 → 暂无数据。日志应有 `卡片 2 张` 而非 `确认态` —— **明天先看日志确认**
2. identifyConfirmedChampion 的槽位仍不准确
   (TOP_BAR_SLOT y=0.0185 需实测复核;PLAYER_BAR_SLOT 0.3741 同)

**修复方向（明天）**:
- 若日志是 `确认态: top-bar-1 score=...` 但标签画错位置 → 纯坐标问题
- 若日志是 `卡片 2 张` → 确认态下 detectCards 误检 → 需要在
  detectCards 加"皮肤轮播区"拒绝条件,或确认态先于卡片检测
  （检查顶部栏第 1 格是否有头像 → 有则直接走确认分支）

### 验收环境备忘
- 用户显示器: 2400×1350 逻辑? 实际日志 `显示器2294x960@1.5`,
  截屏 3413×1920, 窗口 1600×900(逻辑,GetWindowRect 直出,勿除 scaleFactor)
- snapshotKind 判定=window;vision-loop 每轮打印
  `[hexbox:vision] 截屏...判定=...scale=...`
- 诊断日志: `[overlay:renderer]` 转发渲染端 console/preload-error/did-fail-load
- 覆盖层自测: `$env:OVERLAY_TEST_VISIBLE='1'; pnpm --filter @hexbox/overlay debug:overlay-test`
  （本机 4 标签渲染正确）

### 本轮已提交（git log 摘要）
- 56de21c 渲染端路径错误回滚 + 诊断转发（preload 路径是真凶）
- 12fb126 失败容忍(FAIL_TOLERANCE=4)
- ba10326 GetWindowRect 逻辑坐标口径修正(勿除 scaleFactor)
- 6ecb163 window/display 分支分离(标签超宽根因)
- 21d322c/debug-overlay-test.ts 可见模式自测
- 2e6abcb debug:overlay-test npm script

### S2 验收清单（docs/SCREENSHOT-DEV.md §六）
1. ✅ 分辨率/窗口变化自适应
2. ✅ 识别不确定时不绘制(暂无数据/未识别标签是灰色的,不猜数字)
3. ⏳ 覆盖层不影响操作(用户未报告异常,待确认)
4. ✅ 纯函数单测(vision 96 项)+ 标注图人工核对
5. ✅ 三闸门全绿

### S2 剩余 + S3/S4
- S2 收尾: 确认态修复(上文)
- S3: 召唤师技能推荐(需先调研数据源,勿假设)
- S4: 移除侧边悬浮窗(当前保留用于对照)
