/**
 * 悬浮窗可见性与视觉循环开关判定（纯函数）
 *
 * 为什么抽出来：主进程需要「用户可见状态」与「实际已应用状态」比较后
 * 才动窗口 —— 直接调 `showInactive()`/`hide()` 有两个真实问题：
 *   1. 每 2s 轮询都调一次，窗口会被反复 show（闪烁且无意义地重排）；
 *   2. 只在**阶段变化**时才处理，会漏掉「阶段没变但连接状态变了」的场景。
 *
 * 问题 2 是真实 bug：原实现只在 `phase !== lastPhase` 时更新窗口，
 * 于是中途客户端掉线（connected 由 true→false，phase 仍是非对局值）时
 * 不会重新应用窗口状态。
 *
 * 本模块是纯函数：主进程在 CI 里跑不起来（需管理员 + 真实桌面），
 * 只有抽成纯函数才能被单测覆盖（与 overlay-view / itemset 同一惯例）。
 *
 * ⚠️ 2026-10-04 按用户决策调整（选人阶段只留覆盖层）：
 *   · 侧边窗**只在局内**出现。选人阶段由截屏覆盖层在游戏画面内直接标注
 *     卡片与顶栏胜率，侧边窗与它信息重复，还会叠在英雄立绘上抢地方
 *     —— 用户反馈"悬浮窗大小和位置不对"即由此而来。
 *   · 连不上客户端时也**不再**弹窗（用户选择"干脆不要了，只写日志"）。
 */

/** 一份「应该长什么样」的判定结果。 */
export interface VisibleState {
  /**
   * 侧边悬浮窗是否应显示（**仅局内**）。
   *
   * 选人阶段为 false：该阶段的信息由覆盖层画在游戏画面内。
   */
  readonly showPanel: boolean;
  /** S2 全屏覆盖层是否应显示。 */
  readonly showVision: boolean;
  /**
   * 视觉循环是否应运行（= 处于选人阶段）。
   *
   * 与 `showVision` 分开的理由：覆盖层窗口的显隐只在进入/离开选人时变，
   * 而视觉循环有自己的标签记忆 TTL（见 label-memory.ts），
   * 两者都由本对象派生，避免主进程里出现第二处阶段判断。
   */
  readonly visionActive: boolean;
}

/**
 * 依据当前阶段与连接状态算出应显示什么。
 *
 * @param phase     游戏流阶段（`ChampSelect` / `InProgress` / `None` …）。
 * @param connected 是否已连上客户端（有凭证即视为已连；仅用于日志/诊断语义，
 *                  不再影响窗口显隐）。
 *
 * 规则：
 *   - 侧边窗：**仅对局中**（选人阶段看覆盖层；大厅/未连接不弹窗）。
 *   - 覆盖层与视觉循环：**仅选人阶段**（对局内英雄卡片已不存在，截屏无意义）。
 */
export function decideVisible(phase: string, connected: boolean): VisibleState {
  const inChampSelect = phase === 'ChampSelect';
  const inGame = phase === 'InProgress';
  return {
    // connected 目前不改变可见性（用户要求不再弹诊断面板），保留形参
    // 是为了让调用方不必在阶段判断之外再做一次连接状态分支。
    showPanel: inGame,
    showVision: inChampSelect,
    visionActive: inChampSelect,
  };
}

/** 两份判定结果是否等价（用于避免每轮无谓地 show/hide）。 */
export function sameVisibleState(a: VisibleState | null, b: VisibleState): boolean {
  return (
    a !== null &&
    a.showPanel === b.showPanel &&
    a.showVision === b.showVision &&
    a.visionActive === b.visionActive
  );
}
