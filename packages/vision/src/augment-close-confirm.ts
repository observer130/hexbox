/**
 * 「门控说面板关了」→ **确认之后**才让 API 触发状态机处理（纯函数，可单测）
 *
 * ── 为什么需要它（2026-10-06 真机回归：标签出现一瞬间就消失了）─────────────
 *
 * 门控的关闭边沿会**同时**触发三件不可逆的事：
 *
 *   1. 清空强度标签（`AugmentController.clearLabels()`）；
 *   2. 让 API 触发状态机 `notePanelClosed()` —— 它会**消耗一次待选**并**关截屏**
 *      （`capture=false` → 采样间隔下发 0 → **一帧都不再取**）；
 *   3. 丢弃重随基线与整排行基准锁。
 *
 * 于是**一次误判就能让那块面板永久空白**：截屏关了 → 门控再也看不到画面 →
 * 不可能产生新的开边沿；而 API 那边没有新的"死亡 + 等级达标 + 未选"事件
 * （玩家还站着没死），也不会再开一次。真机日志（`debug/overlay-augment.log`）
 * 就是这个形状：
 *
 *   [augment] 🔌 关截屏：未见面板即关闭：关截屏，待选 […] 保留
 *   [augment] ⏱ 采样间隔 → 停（常态零取帧）：…
 *   [augment] ◀ 面板消失 #1 @44.0s
 *   [augment] 🧹 清空强度标签：原因=面板关闭边沿（第 1 次）
 *
 * ── 本模块做的事 ────────────────────────────────────────────────────────
 *
 * 把"上报关闭"这件事**推迟一个复检窗口**（`AUGMENT_CLOSE_CONFIRM_MS`）：
 *
 *   · 关闭边沿 → 进入复检（`rechecking=true`）：**继续以复检节奏取帧**
 *     （控制器据此把采样间隔设为 ACTIVE_MS，而不是 0）；
 *   · 复检窗口内**又出现开边沿** → 那次关闭是**假关闭**：作废（`notifyClosed=false`），
 *     不消耗待选、不关截屏；开边沿本身会重新识别并重新画出标签（自愈）；
 *   · 复检窗口内一直没有开边沿 → 确认关闭（`notifyClosed=true`，**只报一次**）。
 *
 * 代价：真关闭时"关截屏 + 消耗一次待选"晚 `AUGMENT_CLOSE_CONFIRM_MS`（3 秒），
 * 并多取 ~12 帧（250ms 节奏、1/3 分辨率，一帧约 18ms → 总共约 0.2 秒 CPU）。
 * 换来的是"误判也能自己回来"。**标签的清空时机不受它影响**（仍然是关闭边沿
 * 立刻清，用户验收过的"选完立刻清空"）。
 *
 * ⚠️ 它**不改** `augment-trigger.ts` 的状态机语义：只是**调用方**把
 * "何时算一次面板关闭已经发生"推迟到确认之后（这正是允许修的那一处）。
 */

/** 关闭边沿之后等多久确认（ms）：覆盖翻牌动画（实测约 1.2s）后再留一拍。 */
export const AUGMENT_CLOSE_CONFIRM_MS = 3000;

export interface CloseConfirmOptions {
  /** 复检窗口（默认 `AUGMENT_CLOSE_CONFIRM_MS`）。 */
  readonly recheckMs?: number;
}

/** 一帧门控边沿 + 时刻（控制器每帧喂一次）。 */
export interface CloseConfirmInput {
  readonly edge: 'open' | 'close' | null;
  /** 单调时钟（与门控同一时基，ms）。 */
  readonly nowMs: number;
}

export interface CloseConfirmDecision {
  /**
   * 是否**现在**把"面板关闭"上报给 API 触发状态机
   * （true 只在一次确认上出现一次）。
   */
  readonly notifyClosed: boolean;
  /** 是否处于"关闭待确认"的复检窗口里（true = 调用方要继续取帧）。 */
  readonly rechecking: boolean;
  /** 累计被作废的假关闭次数（自愈统计；产物/日志用）。 */
  readonly cancelled: number;
  /** 人读原因（**每一次都要能解释**）。 */
  readonly reason: string;
}

export interface CloseConfirmState {
  /** 待确认的关闭边沿时刻（null = 没有待确认的关闭）。 */
  readonly pendingAtMs: number | null;
  readonly rechecking: boolean;
  readonly cancelled: number;
}

export interface CloseConfirmMachine {
  /** 喂一帧的边沿（无门控帧的时刻也可以喂 `edge: null` 让它判到期）。 */
  push(input: CloseConfirmInput): CloseConfirmDecision;
  readonly state: CloseConfirmState;
  reset(): void;
}

/**
 * 建一台"关闭确认"状态机（**一次对局一台**：`stop()` 时 `reset()`）。
 */
export function createCloseConfirm(options: CloseConfirmOptions = {}): CloseConfirmMachine {
  const recheckMs = Math.max(0, Math.round(options.recheckMs ?? AUGMENT_CLOSE_CONFIRM_MS));
  let pendingAtMs: number | null = null;
  let cancelled = 0;

  const decision = (notifyClosed: boolean, reason: string): CloseConfirmDecision => ({
    notifyClosed,
    rechecking: pendingAtMs !== null,
    cancelled,
    reason,
  });

  const push = (input: CloseConfirmInput): CloseConfirmDecision => {
    if (input.edge === 'open') {
      // 假关闭：面板又出现了 → 作废，不消耗待选、不关截屏
      if (pendingAtMs !== null) {
        cancelled++;
        const waited = Math.round(input.nowMs - pendingAtMs);
        pendingAtMs = null;
        return decision(
          false,
          `面板又出现（关闭边沿后 ${waited}ms）→ 上次是**假关闭**（累计第 ${cancelled} 次），` +
            '不消耗待选、不关截屏',
        );
      }
      return decision(false, '开边沿（没有待确认的关闭）');
    }
    if (input.edge === 'close') {
      const again = pendingAtMs !== null;
      pendingAtMs = input.nowMs;
      return decision(
        false,
        `${again ? '又收到关闭边沿（顺延）' : '关闭边沿'} → 进复检窗口 ${recheckMs}ms` +
          '（这期间继续取帧：面板若还在就能自己回来）',
      );
    }
    if (pendingAtMs !== null && input.nowMs - pendingAtMs >= recheckMs) {
      const waited = Math.round(input.nowMs - pendingAtMs);
      pendingAtMs = null;
      return decision(true, `复检 ${waited}ms 内没再看到面板 → 确认关闭（上报触发状态机）`);
    }
    return decision(
      false,
      pendingAtMs !== null
        ? `关闭待确认中（已 ${Math.round(input.nowMs - pendingAtMs)}/${recheckMs}ms）`
        : '无待确认的关闭',
    );
  };

  return {
    push,
    get state(): CloseConfirmState {
      return { pendingAtMs, rechecking: pendingAtMs !== null, cancelled };
    },
    reset(): void {
      pendingAtMs = null;
      cancelled = 0;
    },
  };
}
