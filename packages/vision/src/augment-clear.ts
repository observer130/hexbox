/**
 * 「强度标签被清空」的**原因词表** + 一行日志（纯函数，可单测）
 *
 * ── 为什么值得单独一个模块（真机缺陷的可观测性，2026-10-06）──────────────
 *
 * 用户报的现象是「局内海克斯面板开着不动，标签几秒后自己消失」。这条链路上
 * 会清空标签的地方**不止一处**，而且形态不同：
 *
 *   · `AugmentController.clearLabels()` —— 显式清空（面板关闭边沿 / 链路停止）；
 *   · `AugmentController.drawTierLabels()` 推 `active:false` —— **隐式清空**
 *     （这次识别一个可画的标签都没有，包括"重随后那张卡认不出"）；
 *   · `main/index.ts` 的画布换手 `clearLabelOverlay()` —— 生产者变了；
 *   · 选人视觉循环 `stop()` 也会推一帧 `active:false`（同一块画布）。
 *
 * 排查时唯一能问的问题就是"**是谁、因为什么**把标签清掉的"。所以：
 *   1. 每一次清空都必须打印**同一格式**的一行（原因来自本文件的词表，
 *      不是各处自己拼的字符串 —— 拼出来的字符串会漂移，用户就没法 grep）；
 *   2. 词表本身**有单测锁住字面量**：改了字面量 = 改了用户的排查手册，
 *      必须是一次显式修改（这是刻意的：日志格式是**契约**）。
 *
 * 日志形如：
 *
 *   [augment] 🧹 清空强度标签：原因=面板关闭边沿（第 1 次）
 *   [augment] 🧹 清空强度标签：原因=链路停止（离开对局）
 *   [augment] 🧹 清空强度标签：原因=刷新后认不出（卡2）
 *   [hexbox]  🧹 清空强度标签：原因=阶段换手（augment → none）
 */

/** 清空原因词表（**唯一来源**；界面/文档/日志都用这里的字面量）。 */
export const AUGMENT_CLEAR_REASONS = {
  /** 面板**关闭边沿**（门控连续未认定面板）—— 已验收的正常清空。 */
  panelClosed: '面板关闭边沿',
  /**
   * 链路**停止** —— ⚠️ 只在调用方**明确要求**时才会出现
   * （程序退出 / 录制收工）；局内正常的"离开对局"停止**不再清标签**
   * （清空由画布换手负责，见 `augmentStopClearsLabels()`）。
   * 字面量保持不变：用户的排查手册按它 grep。
   */
  chainStop: '链路停止',
  /** 画布**换手**（选人生产者 ⇄ 局内生产者 ⇄ 无）。 */
  stageHandover: '阶段换手',
  /** 重随（单卡刷新）之后**那张卡认不出**（OCR 宁漏勿错）→ 它的标签消失。 */
  rerollUnknown: '刷新后认不出',
  /** 重随之后认出了新卡，但**该英雄的强度表里查不到**它 → 它的标签消失。 */
  rerollNoTier: '刷新后查不到强度',
  /** 一次（重）识别**整体**没有可画的结果（认不出 / 查不到强度都算）。 */
  recognizeFailed: '重识别失败',
} as const;

/** 一个清空原因（词表里的字面量之一）。 */
export type AugmentClearReason = (typeof AUGMENT_CLEAR_REASONS)[keyof typeof AUGMENT_CLEAR_REASONS];

/**
 * 一行「清空强度标签」日志（**每一次清空都必须能回答"为什么"**）。
 *
 * 返回的是**不带模块前缀**的正文（调用方自己加 `[augment] ` / `[hexbox] `）——
 * 两个入口共用同一份格式，用户 grep `🧹 清空强度标签：原因=` 就能看到全部清空。
 *
 * @param reason 词表里的原因
 * @param detail 可选补充（第几次 / 卡号 / 触发者），空串 = 不打印括号
 */
export function augmentClearLogLine(reason: AugmentClearReason, detail = ''): string {
  return `🧹 清空强度标签：原因=${reason}${detail === '' ? '' : `（${detail}）`}`;
}

/**
 * 一次（重）识别**一个标签都画不出来**时的清空原因。
 *
 * · `reroll`（面板停留期间的单卡重随）→ `刷新后认不出`：这是用户报的
 *   "贴着错字母"那条底线的执行点；
 * · `open`（面板开边沿的整批识别）→ `重识别失败`：那时本来就还没有标签，
 *   但它同样要有一行原因（否则"面板开了却什么都没有"在日志里是静默的）。
 */
export function augmentClearReasonForEmptyLabels(origin: 'open' | 'reroll'): AugmentClearReason {
  return origin === 'reroll'
    ? AUGMENT_CLEAR_REASONS.rerollUnknown
    : AUGMENT_CLEAR_REASONS.recognizeFailed;
}

/* ------------------------------------------------------------------ */
/* 标签生命周期 ⇄ 链路生命周期：谁有权清空（2026-10-06 真机缺陷的修正）      */
/* ------------------------------------------------------------------ */

/**
 * 链路停止时**要不要连带清空标签**（唯一判据；控制器 `stop()` 调它）。
 *
 * ⚠️ 为什么要有这条（用户真机反馈："面板刚弹出、标签刚画上，随即被清掉"）：
 * 改前 `AugmentController.stop()` **无条件**清标签 —— 于是"链路生命周期（起/停）"
 * 与"标签生命周期"绑在一起，**任何**一次停止（包括"在途启动被作废"误伤新会话、
 * 屏幕流判定不可用）都会把屏幕上**面板还开着**的标签一起抹掉。而局内强度标签
 * 一局只推一次（开边沿），链路一停那块面板就再也画不出标签 → 用户看到"闪一下
 * 就没了"。
 *
 * 现在的规则（标签只由这三件事决定）：
 *   ① 面板**关闭边沿**（门控连续 2 帧未认定面板）—— 已验收的正确行为；
 *   ② **确认离开对局**（阶段换手 → 主进程 `clearLabelOverlay()`）；
 *   ③ 本次（重）识别一个可画标签都没有（隐式清空，底线行为）。
 *
 * 只有调用方**明确**说"停完屏幕上不该再有标签"时才清：
 *   · 程序退出（`before-quit`：窗口马上销毁）；
 *   · 录制工具收工（`debug-augment.ts` 的 `finish()`：不该留残留字母）。
 *
 * 代价（诚实记录）：链路因故停掉、而**面板确实还开着**时，标签会多留一会儿
 * （最多一个轮询周期到下一次真离开）—— 比"闪一下就没了"好得多（见
 * docs/AUGMENT-PANEL.md §十六 6 的边界表）。
 */
export function augmentStopClearsLabels(explicit: boolean | undefined): boolean {
  // 默认**不清**：不传 = "这次停止与标签无关"
  return explicit === true;
}

/**
 * 「链路停止但**不**清标签」的一行说明（出现它 = 这次停止没有动屏幕上的标签）。
 *
 * 用户按 `grep 不清标签` 一搜就能排除"标签是被链路停掉的"这个猜测 ——
 * 上一次真机排查时这条信息只能靠推断（见 docs/AUGMENT-PANEL.md §十六 6）。
 */
export function augmentChainStopKeepsLabelsLine(why: string, panelOpen: boolean): string {
  return (
    `⏹ 链路停止但不清标签${panelOpen ? '（面板仍开）' : '（面板不在屏）'}：原因=${why}` +
    ' —— 标签只由「面板关闭边沿」或「确认离开对局」清空'
  );
}

/**
 * 重随后**某一张卡**没有可画结果时的原因（`null` = 这张卡有可画结果，不清）。
 *
 * ⚠️ 两种情形必须**分开**（已验收的底线行为，两者都要求标签消失）：
 *   · `augmentId === null` —— 新卡**认不出**（OCR 宁漏勿错）；
 *   · `augmentId` 有值但 `tier === null` —— 认出来了，但**该英雄的强度表里
 *     没有这一颗**（官方每个英雄只有 95~162 条，37 颗海克斯没有任何官方强度）。
 *
 * 分开的理由是排查：前者是识别问题（换分辨率/换字体要复标定），后者是数据
 * 覆盖问题（上游就没有）—— 混成一句话会让排查方向完全跑偏。
 */
export function augmentClearReasonForRefreshedCard(
  augmentId: number | null,
  tier: string | null,
): AugmentClearReason | null {
  if (augmentId === null) return AUGMENT_CLEAR_REASONS.rerollUnknown;
  if (tier === null) return AUGMENT_CLEAR_REASONS.rerollNoTier;
  return null;
}
