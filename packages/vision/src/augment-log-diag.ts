/**
 * 常驻路径的**轻量诊断**（纯函数，可单测；无行为变化）
 *
 * ── 为什么需要（2026-10-11 复盘真机日志时的真实代价）───────────────────────
 *
 * 打包版日志 `%LOCALAPPDATA%\hexbox\logs\overlay.log` **没有时间戳**：只有
 * `▶ 面板出现 #N @Xs` 那几行带"对局秒数"。于是下面这件事无法回答：
 *
 * ```
 * 🔌 开截屏：死亡（等级 13，待选 [11]）：开截屏
 * ⏱ 采样间隔 → 250ms：死亡（等级 13，待选 [11]）：开截屏
 * · 门控间隔改为 250ms
 * 🔌 关截屏：窗口超时（未见面板）：关截屏，待选 [11,15] 保留
 * ```
 *
 * 这两条"开→关"之间到底是**一个采样周期**还是 **45 秒**（`armWindowMs`）？
 * 光看日志分不出来 —— 而"到底多久"直接决定根因是"窗口没重置"还是"窗口内没有面板"。
 * 本次复盘就因为这一点差点把根因定错（代码算术证明是 45 秒，但日志本身不支持）。
 *
 * 所以本模块只做两件**不加行为**的事：
 *   1. `withLogOffset()`：每条日志带上"链路建立以来的秒数"（`[+123.4s]`）；
 *   2. `formatCaptureWindowLine()`：每次**采样窗口**结束时打一行统计与**裁决** ——
 *      "这 45 秒里取了几帧、卡片判据命中几帧、面板信号托底几帧"。
 *      这一行的价值在于把"面板不在窗内"和"取帧链路坏了"彻底分开：
 *      真机上一次漏抓到底是 `samples=0`（没取帧）还是 `samples=178, hits=0`
 *      （帧在跑、门控就是没看到面板）——只有这一行能一眼回答。
 */

/* ------------------------------------------------------------------ */
/* 1. 日志时间偏移                                                       */
/* ------------------------------------------------------------------ */

/**
 * 把 `[+123.4s]` 插到日志行的**标签之后**。
 *
 * - `[augment] 🔌 开截屏：…` → `[augment] [+123.4s] 🔌 开截屏：…`
 * - `[hexbox] 🧹 清空强度标签：…` → `[hexbox] [+123.4s] 🧹 …`
 * - 以空格开头的**续行**（`      卡1 渴血  分数 …`）→ 原样返回（它属于上一行）
 * - 没有标签的行 → 前缀在最前
 *
 * 为什么插在标签之后而不是行首：`Select-String '🔌 开截屏'` 这类过滤、以及
 * 文档里记的日志形状（`[augment] ▶ 面板出现 #1 @10.9s`）都还能一眼对上。
 */
export function withLogOffset(line: string, offsetMs: number): string {
  if (line.startsWith(' ')) return line;
  const tag = /^(\[[a-zA-Z:_-]+\])\s?/.exec(line);
  const stamp = `[+${(Math.max(0, offsetMs) / 1000).toFixed(1)}s]`;
  if (tag === null) return `${stamp} ${line}`;
  const rest = line.slice(tag[0].length);
  return rest === '' ? `${tag[1]} ${stamp}` : `${tag[1]} ${stamp} ${rest}`;
}

/* ------------------------------------------------------------------ */
/* 2. 一个采样窗口的统计与裁决                                            */
/* ------------------------------------------------------------------ */

export interface CaptureWindowStats {
  /** 窗口时长（ms）：从"开截屏"到"关截屏"（或到打这一行时）。 */
  readonly ms: number;
  /** 本窗口门控实际处理的帧数（`samples` 增量）—— **0 = 一帧都没取到**。 */
  readonly samples: number;
  /** 卡片判据命中的帧数。 */
  readonly hits: number;
  /** "面板仍在"信号托底的帧数（卡片判据失效但面板信号仍在）。 */
  readonly presenceFrames: number;
  /** 本窗口内出现的开边沿次数。 */
  readonly openEdges: number;
  /** 本窗口内出现的关边沿次数。 */
  readonly closeEdges: number;
}

/**
 * 本窗口的**裁决**（人读一句话）——把"没取帧"和"取帧了但门控没看到面板"分开。
 *
 * 这是整行日志的重点：复盘时只需要看这一句话，不必再去数前后几行。
 */
export function captureWindowVerdict(s: CaptureWindowStats): string {
  if (s.samples === 0) {
    return '一帧都没取到（取帧链路/门控定时器没跑）—— 这一窗的"没见面板"不作数';
  }
  // 开边沿优先："面板出现过"是硬事实（卡片判据连续 2 帧命中才会给出开边沿），
  // 它比后面的计数更能定性这一窗。
  if (s.openEdges > 0) {
    return `本窗内面板出现过（开边沿 ${s.openEdges} 次、关边沿 ${s.closeEdges} 次）`;
  }
  if (s.hits === 0 && s.presenceFrames === 0) {
    return '帧在跑，但门控两条判据（卡片判据 + 面板信号）都说没面板 → 面板不在这一窗里';
  }
  if (s.hits === 0) {
    return '卡片判据从未命中，只有面板信号托底 → 面板可能在屏，但卡片判据没过';
  }
  return `卡片判据命中 ${s.hits} 帧但没形成开边沿（命中不连续，需连续 2 帧）`;
}

/**
 * 采样窗口的一行汇总（`reason` 是窗口关闭的原因，来自触发状态机）。
 *
 * 形如：
 * `[augment] 🪟 采样窗口 45.0s：采样 178 帧、卡片判据命中 0 帧、面板信号托底 0 帧、开边沿 0 次、关边沿 0 次 —— 帧在跑，但门控两条判据都说没面板 → 面板不在这一窗里`
 */
export function formatCaptureWindowLine(
  stats: CaptureWindowStats,
  reason: string,
): string {
  const header =
    `🪟 采样窗口 ${(Math.max(0, stats.ms) / 1000).toFixed(1)}s：` +
    `采样 ${stats.samples} 帧、卡片判据命中 ${stats.hits} 帧、` +
    `面板信号托底 ${stats.presenceFrames} 帧、开边沿 ${stats.openEdges} 次、关边沿 ${stats.closeEdges} 次`;
  return `[augment] ${reason === '' ? header : `${header}（${reason}）`} —— ${captureWindowVerdict(stats)}`;
}

/* ------------------------------------------------------------------ */
/* 3. 2999 逐次采样的可选追踪行（`HEXBOX_AUGMENT_API_TRACE=1`）            */
/* ------------------------------------------------------------------ */

/**
 * 一行 API 采样追踪。**默认关闭**（`HEXBOX_AUGMENT_API_TRACE`）：打开后每秒一行，
 * 一局 20 分钟约 1200 行（≈100KB，日志轮转 4MB，代价可接受）。
 *
 * 为什么需要它：`apiCaptureInterval`/触发状态机的**非变化决策不写日志**（去重），
 * 所以"玩家什么时候死的、当时几级、待选集合是什么"在常驻日志里**完全看不到** ——
 * 而"第 2 次海克斯为什么没抓到"恰恰要回答这个（等级/死亡条件是否与真机模式不符）。
 */
export function formatApiTraceLine(s: {
  readonly offsetMs: number;
  readonly gameTime: number;
  readonly level: number;
  readonly isDead: boolean;
  readonly respawnTimer: number;
  readonly capture: boolean;
  readonly pending: readonly number[];
  readonly reason: string;
}): string {
  return (
    `[augment] 👁 API [+${(Math.max(0, s.offsetMs) / 1000).toFixed(1)}s] ` +
    `对局 ${s.gameTime.toFixed(1)}s 等级 ${s.level} ` +
    `${s.isDead ? '死亡' : '存活'}(复活${s.respawnTimer.toFixed(1)}s) ` +
    `capture=${s.capture ? 'on' : 'off'} 待选 [${s.pending.join(',')}]：${s.reason}`
  );
}
