/**
 * 视觉循环的**驱动层**（定时器 + 轮次作废），与 Electron 解耦
 *
 * ── 为什么单独成文件（2026-11 审查，真机风险）────────────────────────────
 *
 * 原实现把"定时器 + 一轮识别 + 推送"整段写在 `vision-loop.ts` 里，而那个文件
 * 在模块顶部 `import { desktopCapturer, screen } from 'electron'` —— 于是在
 * Node/CI 里**连 import 都做不到**，这段最容易出错的时序逻辑一行测试都没有。
 *
 * 真实缺陷：`stop()` 只 `clearInterval`，**不会作废已经飞出去的那一轮**。
 * 截屏 + OCR 要 1~2 秒，期间调用方可能已经离开选人阶段（`stop(); hide()`）；
 * 迟到的 `onResult` 会经 `pushLabelOverlay` → `raiseLabelOverlay` 把**隐藏的
 * 画布重新 showInactive()**，于是选人阶段的胜率标签留在整局画面上。
 *
 * 拆出来之后：本文件只依赖**注入**的 `round` / `primaryDisplay`，用假实现就能
 * 在 CI 里复现"在途轮次 + stop"这个时序（见 `vision-loop-driver.test.ts`）。
 * 真正碰屏幕的那一半仍留在 `vision-loop.ts`（`runVisionRound`）。
 */

import type { Display } from 'electron';

import { createLabelMemory } from '@hexbox/vision';

import type { VisionOverlayMsg, VisionStage } from './vision-loop.ts';

/** 选人阶段的两个子阶段（缺省 unknown = 拿不到 LCU 会话）。 */
export type VisionPickState = 'picking' | 'locked' | 'unknown';

/**
 * 第 `count` 次轮内异常要不要打日志（纯函数，便于单测）。
 *
 * 首次必打（否则用户永远不知道标签为什么不出现）；之后每 20 次打一次
 * （正常一轮 1.5s，异常时否则会刷屏）。
 */
export function shouldLogLoopError(count: number): boolean {
  return count > 0 && (count === 1 || count % 20 === 0);
}

/** 一轮识别的产物（`runVisionRound` 的返回形状）。 */
export interface VisionRoundResult {
  readonly msg: VisionOverlayMsg | null;
  readonly display: Display;
  readonly stage: VisionStage | null;
}

/**
 * 驱动层需要的**全部**外部能力（都注入，因此可单测）。
 *
 * 注意这里刻意只保留四项：其余识别参数（指纹库/榜单/几何）都是 `round` 自己的
 * 事，不属于"什么时候跑、结果要不要采信"。
 */
export interface VisionLoopDriverDeps {
  readonly pickState?: () => VisionPickState;
  /** 跑一轮（生产 = `runVisionRound`；测试 = 可控的假实现）。 */
  readonly round: (pickState: VisionPickState) => Promise<VisionRoundResult>;
  /** 兜底显示器（异常/清空时用）。 */
  readonly primaryDisplay: () => Display;
  readonly onResult: (msg: VisionOverlayMsg, display: Display) => void;
  /**
   * 循环内部异常的去处（默认 `console.warn`）。
   *
   * ⚠️ 以前这里是 `catch {}` —— 这个循环是选人标签的**唯一来源**，异常被吞掉后
   * 表现为"标签就是不出现"，日志里一个字都没有（而且这段代码 CI 测不到）。
   * 限频打印（首次 + 每 20 次），避免每 1.5 秒刷一行。
   */
  readonly onError?: (line: string) => void;
}

/**
 * 视觉循环控制器。
 *
 * 内部串行执行（上一轮完成才开始下一轮），避免截屏堆积；
 * **每轮回来后校验代次**，被 `stop()`/重开作废的轮次一律丢弃。
 *
 * 标签记忆（真机 bug 修复,2026-09-28）：卡片检测对动画/光效敏感,
 * 「3 张卡某轮只检出 2 张」的部分失败会以 active=true 覆盖旧结果,
 * 第三张卡片的胜率因此消失。现在每轮结果先经 `rememberLabels`
 * 按**位置**补齐 TTL 内缺失的旧标签,再推送 —— 显示连续性不受
 * 单轮检测抖动影响（TTL 6 轮 × 1.5s = 9s,足够覆盖检测闪烁）。
 */
export class VisionLoop {
  private readonly deps: VisionLoopDriverDeps;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /**
   * 代次：`start()` / `stop()` 都 +1。
   *
   * `tick` 在 `await round(...)` **之前**记下当时的值，回来后再比一次 ——
   * 不一致说明这一轮已经被作废（离开选人阶段 / 重开），结果必须丢弃，
   * 否则会把手已经清掉的画布重新显示出来（见文件头）。
   */
  private generation = 0;
  /** 标签记忆（rememberLabels 的状态体）。 */
  private memory = createLabelMemory();
  private round = 0;
  private failCount = 0;
  /** 上一轮所处的子阶段（用于检测切换并立刻清空记忆）。 */
  private lastPickState: VisionPickState | null = null;
  /**
   * 上一轮**真正落在**的子阶段（`round` 回报；`null` = 还没有证据）。
   *
   * ⚠️ 为什么不能只看 `pickState`（真机 bug，2026-10-11）：LCU 的 `pickState`
   * 可能是 `unknown`/'picking' 而屏幕上顶栏已经有头像（占用 > 0）→
   * `isPhase2` 为真、走顶栏分支，但 `pickState` 一直没变 → 换阶段判据**永不触发**
   * → 卡片标签以 TTL 挂在二阶段（日志 L86：`第二阶段(locked): 顶栏占用 2 格,
   * 识别成功 0 格` 却仍推送 3 个卡片标签）。所以换阶段要按**实际阶段**判。
   */
  private lastStage: VisionStage | null = null;
  private readonly warn: (line: string) => void;
  /** 累计的轮内异常数（仅用于限频日志）。 */
  private errors = 0;

  constructor(deps: VisionLoopDriverDeps, intervalMs = 1500) {
    this.deps = deps;
    this.intervalMs = intervalMs;
    this.warn = deps.onError ?? ((line: string): void => console.warn(line));
  }

  start(): void {
    if (this.timer) return;
    // 新的一段观察：以前飞出去的轮次全部作废
    this.generation++;
    const tick = async (): Promise<void> => {
      if (this.running) return;
      this.running = true;
      const gen = this.generation;
      try {
        // ⚠️ **每 tick 只读一次** `pickState`，并把同一个值传进 `round`：
        // 截屏 await 有 1~2 秒，期间 LCU（每 2 秒轮询）完全可能把 picking 翻成
        // locked —— 两次读取会得到两个阶段，于是"用于重置记忆的阶段"与
        // "用于画标签的阶段"不一致（真机日志 L86 的成因）。
        const pickState = this.deps.pickState?.() ?? 'unknown';
        const { msg, display, stage } = await this.deps.round(pickState);
        // ⚠️ 在飞期间被 `stop()`（或重新 `start()`）→ 这一轮作废：
        // 不推送、不动记忆、不推进计数（否则会把已经隐藏的画布重新显示出来）
        if (gen !== this.generation) return;
        this.round++;
        // 子阶段切换（第一阶段⇄第二阶段）时**立刻**清空标签记忆 —— 否则
        // 卡片胜率会在选定后继续残留最多 6 轮（≈9 秒），真机反馈为
        // "进入二阶段还不消失"。卡片与顶栏的标签位置完全不同，不能混用。
        //
        // 两条判据都留着（各自覆盖对方漏掉的情形）：
        //   · `pickState` 变化（LCU 说得清时最灵敏）；
        //   · **实际阶段**变化（LCU 说 unknown/picking、靠顶栏占用进二阶段时，
        //     `pickState` 根本不会变 —— 只有这条能兜住）。
        // 重置放在本轮输出之后、`memory.update()` 之前：效果与"轮前重置"等价，
        // 而且用的是**本轮真正使用的**那个阶段。
        const pickChanged = this.lastPickState !== null && pickState !== this.lastPickState;
        const stageChanged = stage !== null && this.lastStage !== null && stage !== this.lastStage;
        if (pickChanged || stageChanged) {
          this.memory.reset();
        }
        this.lastPickState = pickState;
        if (stage !== null) this.lastStage = stage;

        const active = msg !== null && msg.active;
        // 记忆补齐:本轮识别到的标签 + TTL 内未过期的旧标签
        const produced = msg?.labels.length ?? 0;
        const labels = this.memory.update(msg?.labels ?? [], this.round, active);
        if (active) {
          this.failCount = 0;
        } else {
          this.failCount++;
        }
        const shown = active || labels.length > 0;
        // ⚠️ 诊断必须把"**本轮产出 X 个 → 实际推出 Y 个**"打在同一行：
        // 幽灵标签那个 bug 里，两行日志（产出 3 / 推送 4）要靠人工对比才发现
        //（真机日志 L40 vs L34）。
        const flow = `本轮产出 ${produced} → 实际推出 ${labels.length}`;
        this.deps.onResult(
          shown
            ? { active: true, labels, diag: `${msg?.diag ?? '记忆保持'}（${flow}）` }
            : { active: false, labels: [], diag: `${msg?.diag ?? '未找到游戏窗口'}（${flow}）` },
          display,
        );
      } catch (e) {
        // 作废的轮次连"识别异常"都不推（它描述的是已经过去的那一屏）
        if (gen !== this.generation) return;
        // ⚠️ 不许静默：这个循环是选人标签的唯一来源，吞掉异常 = "标签就是不出现"
        //    且没有任何线索。限频（首次 + 每 20 次），否则每 1.5s 刷一行。
        this.errors++;
        if (shouldLogLoopError(this.errors)) {
          const detail = e instanceof Error ? e.stack ?? e.message : String(e);
          this.warn(`[hexbox:vision] 识别循环异常（第 ${this.errors} 次）：${detail}`);
        }
        this.deps.onResult(
          { active: false, labels: [], diag: '识别异常' },
          this.deps.primaryDisplay(),
        );
      } finally {
        this.running = false;
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), this.intervalMs);
  }

  stop(): void {
    // ⚠️ 先作废在途轮次，再清定时器：顺序反了的话，已经飞出去的那一轮
    //    回来后仍会被当成"当前轮次"，把画布重新显示出来
    this.generation++;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.memory.reset();
    this.round = 0;
    this.failCount = 0;
    // 新会话不该继承上一段的阶段（否则第一 tick 会拿着旧阶段做一次无意义的重置）
    this.lastPickState = null;
    this.lastStage = null;
    this.deps.onResult({ active: false, labels: [] }, this.deps.primaryDisplay());
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }
}
