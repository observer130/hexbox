/**
 * **虚拟时钟 / 虚拟定时器**（纯函数；离线回放用，不参与线上运行）
 *
 * 为什么需要它：闭环回放要求"同一条链路、同一段代码"，但线上代码是**定时器驱动**的
 * —— `AugmentController.startApiPolling()` 用 `setTimeout` 每 1 秒问一次 2999、
 * 常驻流的门控每 `intervalMs` 出一帧、等渲染端就绪时 `await new Promise(setTimeout)`。
 * 如果回放时用真实定时器，就只能"真的等 20 分钟"，而且结果随机器负载抖动（不可复现）。
 *
 * 所以回放把全局定时器换成这里这一份（`install()`），并把控制器的时钟注入为
 * `clock.now()`：时间只在**驱动器显式推进**时才走，于是
 *   · 一局 20 分钟可以**秒级**跑完；
 *   · 同样的输入必然得到同样的输出（可回归、可写进 CI）。
 *
 * ⚠️ 语义刻意与 Node 的定时器对齐（这是"能替换"的前提）：
 *   · `setTimeout(fn, ms)` → 到期时刻 = 当前虚拟时间 + ms（负数按 0 处理）；
 *   · `setInterval(fn, ms)` → 到点执行一次后**重新排期**（周期最小 1ms，防死循环）；
 *   · 任务里再排的任务会被看到（`advanceTo` 只看"当前时刻之前到期"的）。
 */

/** 一个待执行任务。 */
interface Task {
  readonly id: number;
  dueAt: number;
  /** `interval` 的周期；`timeout` 为 null。 */
  periodMs: number | null;
  readonly fn: () => void;
}

export interface VirtualClock {
  /** 当前虚拟时间（ms）。与线上一样是单调递增的毫秒数。 */
  now(): number;
  setTimeout(fn: () => void, ms?: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms?: number): number;
  clearInterval(id: number): void;
  /**
   * 把时钟推进到 `t`（含），按到期顺序执行**全部**到点任务。
   *
   * @returns 执行了多少个任务（诊断用）。
   */
  advanceTo(t: number): number;
  /**
   * 执行**下一个**到期任务（不改变"没有任务时的时间"）；没有待执行任务返回 false。
   *
   * 驱动器用它做"跑一个 tick → 让出给事件循环（微任务/真实 I/O）→ 再跑下一个"，
   * 这样 `await` 链（控制器里大量使用）才能推进。
   */
  runNext(): boolean;
  /** 下一个到期时刻（null = 没有待执行任务）。 */
  nextDueAt(): number | null;
  /** 待执行任务数（防泄漏：回放结束时应当为 0 或只剩常驻轮询）。 */
  readonly pending: number;
  /**
   * 把这一份装成**全局** `setTimeout/clearTimeout/setInterval/clearInterval`
   * （回放脚本用）。返回卸载函数 —— 测试里不要装（node:test 自己也用定时器）。
   */
  install(): () => void;
}

export function createVirtualClock(startMs = 0): VirtualClock {
  let current = startMs;
  let nextId = 1;
  const tasks = new Map<number, Task>();

  const schedule = (fn: () => void, ms: number | undefined, periodMs: number | null): number => {
    const delay = Math.max(0, Number.isFinite(ms ?? 0) ? Math.round(ms ?? 0) : 0);
    const id = nextId++;
    tasks.set(id, { id, dueAt: current + delay, periodMs, fn });
    return id;
  };

  const earliest = (): Task | null => {
    let best: Task | null = null;
    for (const t of tasks.values()) {
      if (!best || t.dueAt < best.dueAt || (t.dueAt === best.dueAt && t.id < best.id)) best = t;
    }
    return best;
  };

  const run = (task: Task): void => {
    if (task.periodMs === null) {
      tasks.delete(task.id);
    } else {
      // 重新排期**在调用之前**完成：任务里若 clearInterval 掉自己，删除仍然生效
      task.dueAt = current + Math.max(1, task.periodMs);
    }
    task.fn();
  };

  const clock: VirtualClock = {
    now: () => current,
    setTimeout: (fn, ms) => schedule(fn, ms, null),
    clearTimeout: (id) => {
      tasks.delete(id);
    },
    setInterval: (fn, ms) => schedule(fn, ms, Math.max(1, Math.round(ms ?? 1))),
    clearInterval: (id) => {
      tasks.delete(id);
    },
    advanceTo: (t) => {
      let ran = 0;
      for (;;) {
        const next = earliest();
        if (!next || next.dueAt > t) break;
        current = Math.max(current, next.dueAt);
        run(next);
        ran++;
        // 防呆：一个任务在"当前时刻"无限自我重排（周期 0 已被夹到 1ms，这里只兜底）
        if (ran > 1_000_000) throw new Error('虚拟时钟：任务数异常（疑似死循环）');
      }
      if (t > current) current = t;
      return ran;
    },
    runNext: () => {
      const next = earliest();
      if (!next) return false;
      current = Math.max(current, next.dueAt);
      run(next);
      return true;
    },
    nextDueAt: () => earliest()?.dueAt ?? null,
    get pending() {
      return tasks.size;
    },
    install: () => {
      const g = globalThis as unknown as {
        setTimeout: unknown;
        clearTimeout: unknown;
        setInterval: unknown;
        clearInterval: unknown;
      };
      const before = {
        setTimeout: g.setTimeout,
        clearTimeout: g.clearTimeout,
        setInterval: g.setInterval,
        clearInterval: g.clearInterval,
      };
      g.setTimeout = ((fn: () => void, ms?: number): number => clock.setTimeout(fn, ms)) as unknown;
      g.clearTimeout = ((id: number): void => clock.clearTimeout(id)) as unknown;
      g.setInterval = ((fn: () => void, ms?: number): number => clock.setInterval(fn, ms)) as unknown;
      g.clearInterval = ((id: number): void => clock.clearInterval(id)) as unknown;
      return () => {
        g.setTimeout = before.setTimeout;
        g.clearTimeout = before.clearTimeout;
        g.setInterval = before.setInterval;
        g.clearInterval = before.clearInterval;
      };
    },
  };
  return clock;
}
