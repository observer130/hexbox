/**
 * 门控节流策略：**常态低频 + 命中后高频**（纯状态机，可单测）
 *
 * 为什么需要：海克斯面板一局只出现 **4 次**（开局 / 7 级 / 11 级 / 15 级，
 * 20 分钟一局），而"面板出现的时刻"无法预测 —— 所以不能按时间猜，
 * 但**也没必要一直高频截屏**：
 *
 *   模式      间隔      占空比（每帧约 17ms）  何时进入
 *   idle     1000ms    ~1.7%                 常态
 *   probe     250ms    ~6.8%                 看到**单帧**命中的瞬间（先升频再确认）
 *   active    250ms    ~6.8%                 确认面板已打开；持续到"最后一次命中"之后 tailMs
 *
 * 关键的取舍：**升频不需要去抖，降频才需要**。
 * 去抖（连续 2 帧才算开）是为了不误报；但"多截几帧"的代价只是一点点 CPU，
 * 而"漏掉一次三选一"的代价是整次功能失效。所以：
 *   · 单帧命中 → 立刻进 probe（高频）；
 *   · probe 期间若确认打开 → 进 active（长时间高频）；
 *   · probe 期间一无所获（动画闪烁/误检）→ probeMs 后自动回 idle，代价约 24 帧。
 *
 * ⚠️ **出现规律的两个条件（用户 2026-10-05 更正）**：到达指定等级 **且**
 * 死亡回泉水（开局必出一次）。因此"到 7 级就该升频"是**错的** —— 到 7 级时
 * 可能还在中路打架，面板要等下一次阵亡才出现。触发点由死亡时机决定，
 * 任何按等级/时间预测的方案都会挑错时刻；只认"屏幕上面板在不在"。
 *
 * ⚠️ 本文件是纯函数：主进程用 `onReading()` 的 `changed` 决定要不要给渲染端
 * 下发新间隔。这样"什么时候该快、什么时候该慢"能被单测覆盖，
 * 而不是散在主进程里（本项目已有先例：`visibility.ts`）。
 */

import type { PanelReading } from './augment-panel.ts';

export type CadenceMode = 'idle' | 'probe' | 'active';

export interface CadenceOptions {
  /** 常态间隔（ms）。 */
  readonly idleMs: number;
  /** 高频间隔（ms）；probe 与 active 都用它。 */
  readonly activeMs: number;
  /** probe 最长持续多久仍无确认就退回 idle（ms）。 */
  readonly probeMs: number;
  /**
   * 确认打开后，最后一次命中之后再持续高频多久才降频（ms）。
   *
   * ⚠️ 这**不是正确性所需**，只是"少一次升频延迟"的优化：面板关掉后再打开，
   * 1 秒一次的常态轮询也能在 ~1.3 秒内把它抓回来。所以别为了"保险"把它设得很大
   * —— 它直接决定常态省了多少资源（20 秒对应一局约 13% 时间在高频）。
   */
  readonly tailMs: number;
}

/**
 * 默认值。
 *
 * `idleMs = 1000`：面板一出现通常会停留十几秒（要等玩家选），1 秒一次足以命中，
 * 最坏延迟 ≈ 1s + 确认两帧 ≈ 1.3s；再慢（2~3 秒）会让"手快连点选完"的情况抓不到。
 *
 * ⚠️ 为什么不用"按等级预测"（到 7/11/15 级就升频）：**海克斯出现要同时满足两个条件**
 * ——到达指定等级 **且** 死亡回泉水（开局必出一次）。到 7 级时你可能正在中路打架，
 * 面板要等下一次阵亡才出现（可能几分钟后），按等级升频会挑错时刻。
 * 触发点由死亡时机决定 → 预测不可靠 → 只认"屏幕上面板在不在"。
 */
export const CADENCE_DEFAULTS: CadenceOptions = {
  idleMs: 1000,
  activeMs: 250,
  probeMs: 6000,
  tailMs: 20_000,
};

export interface CadenceUpdate {
  readonly mode: CadenceMode;
  readonly intervalMs: number;
  /** 与上一次输出相比是否变化（调用方据此决定要不要下发 IPC）。 */
  readonly changed: boolean;
  readonly reason: string;
}

export interface CadencePolicy {
  /** 每帧调用一次（串行，勿并发）。 */
  onReading(reading: PanelReading, nowMs: number): CadenceUpdate;
  readonly mode: CadenceMode;
  readonly intervalMs: number;
  reset(): void;
}

/** 面板停留期结束后，还要高频多久（`tailMs`），是"最后命中时刻"驱动的。 */
export function createCadencePolicy(options: Partial<CadenceOptions> = {}): CadencePolicy {
  const opts: CadenceOptions = { ...CADENCE_DEFAULTS, ...options };

  let mode: CadenceMode = 'idle';
  let lastFoundAt: number | null = null;
  let probeStartedAt: number | null = null;

  const intervalFor = (m: CadenceMode): number => (m === 'idle' ? opts.idleMs : opts.activeMs);

  return {
    onReading(reading: PanelReading, nowMs: number): CadenceUpdate {
      const before = mode;
      let reason = '常态低频';

      if (reading.found) {
        lastFoundAt = nowMs;
        if (reading.state === 'open') {
          // 确认打开 → 长时间高频（覆盖重随 / 关了再开）
          mode = 'active';
          probeStartedAt = null;
          reason = '面板已确认';
        } else if (mode === 'idle') {
          // 单帧命中即升频：宁可多截几帧，也别漏掉一次三选一
          mode = 'probe';
          probeStartedAt = nowMs;
          reason = '单帧命中 → 升频确认';
        } else {
          reason = mode === 'probe' ? 'probe 中' : '面板已确认';
        }
      } else if (mode === 'probe') {
        const since = probeStartedAt === null ? 0 : nowMs - probeStartedAt;
        if (since >= opts.probeMs) {
          mode = 'idle';
          probeStartedAt = null;
          reason = `probe ${opts.probeMs}ms 无确认 → 降频`;
        } else {
          reason = 'probe 中（等待确认）';
        }
      } else if (mode === 'active') {
        const sinceLast = lastFoundAt === null ? Number.POSITIVE_INFINITY : nowMs - lastFoundAt;
        if (sinceLast >= opts.tailMs) {
          mode = 'idle';
          reason = `面板消失 ${Math.round(sinceLast / 1000)}s（> ${opts.tailMs / 1000}s）→ 降频`;
        } else {
          reason = '面板停留/刚消失（保持高频）';
        }
      }

      const intervalMs = intervalFor(mode);
      return {
        mode,
        intervalMs,
        changed: mode !== before || intervalFor(before) !== intervalMs,
        reason,
      };
    },

    get mode(): CadenceMode {
      return mode;
    },

    get intervalMs(): number {
      return intervalFor(mode);
    },

    reset(): void {
      mode = 'idle';
      lastFoundAt = null;
      probeStartedAt = null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* api 模式的采样间隔决策（面板状态**优先于**触发状态机）                  */
/* ------------------------------------------------------------------ */

/**
 * **api 触发模式**下"下一段采样间隔取多少"的纯函数（真机缺陷 2026-10-11）。
 *
 * ── 为什么必须单独一条规则、而且要"面板状态优先" ──────────────────────────
 *
 * api 模式的常态是**一帧不取**（`0`）：只有"死亡 + 等级达标 + 该次未选"才开。
 * 但面板**停留期间**必须改成 `REROLL_POLL_MS`（默认 400ms）—— 单卡刷新
 * （reroll）检测靠这个节奏比对每张卡的指纹。于是"谁说了算"必须写死顺序：
 *
 *   1. **面板在屏**（`state === 'open'`）→ `rerollPollMs`
 *      —— 这一条**优先于触发状态机**：门控亲眼看到面板在屏，比"API 认为该不该开"
 *      权威。真机缺陷：API 那边因为记账偏位而 `capture=false`，可是面板明明开着，
 *      结果间隔被压回 0 → 一帧不取 → 面板上的标签永远不更新（也永远关不掉）。
 *   2. 触发状态机说在开截屏 → `activeMs`（等面板/等连选）。
 *   3. 关闭待确认的复检窗口 → `activeMs`（没有帧就不可能有开边沿，自愈无从谈起）。
 *   4. **待选未选**（`offerOutstanding`）且 `pendingProbeMs > 0`（**默认 0 = 关闭**）
 *      → `pendingProbeMs`：验证"面板是否出现在死亡窗口之外"（见 `pendingProbeMs`）。
 *   5. 其余 → `0`（严格常态零取帧）。
 *
 * ── 关后自愈探针（**默认关闭**，见 `API_CADENCE_DEFAULTS.healProbe`）─────────
 *
 * `augment-close-confirm.ts` 的头注写明了一个死锁：api 模式下"确认关闭"之后
 * 间隔是 0（一帧不取），**若面板其实还开着**（误判关闭），没有帧 → 没有开边沿 →
 * 永远无法自愈。录制工具默认 pixel 模式帧永不停，所以同一个误判在录制里能自愈，
 * 在常驻路径不能。
 *
 * 第 4 条分支就是为这个死锁准备的**低频自愈探针**：确认关闭后的
 * `healWindowMs`(20s) 内用 `probeMs`(6000) 采一帧（≈1 帧/6 秒），窗口过后回到 0。
 * 代价与收益（**产品取舍**）：从"严格零取帧"变成"误判后最多 6 秒自愈，
 * 代价是关闭后 20 秒内每 6 秒 1 帧"。
 *
 * ⚠️ **用户 2026-10-11 裁决：保持严格零取帧** → `healProbe: false`（默认）。
 *    也就是说第 4 条分支**在线上是关的**：误判关闭后间隔仍然回 0、由
 *    "修 trigger 记账 + 修幽灵标签"来降低误判概率。要重新打开只改这一个常量
 *    （或在控制器里传 `{ healProbe: true }`），不需要动任何调用点。
 */
export interface ApiCadenceInput {
  /** 门控本帧是否认定面板在屏（控制器传 `reading.state === 'open'`）。 */
  readonly panelOpen: boolean;
  /** API 触发状态机是否在开截屏（`trigger.capture`）。 */
  readonly capture: boolean;
  /** 是否处于"关闭待确认"的复检窗口（`closeConfirm.state.rechecking`）。 */
  readonly rechecking: boolean;
  /**
   * 是否**还有没选的海克斯**（`trigger.pending.length > 0`）。
   *
   * 只喂给"待选未选时的低频探针"（`pendingProbeMs`，**默认关闭**）：见本文件
   * `ApiCadenceOptions.pendingProbeMs` 的说明 —— 2026-10-11 真机两局里
   * "第 2 次海克斯"都出现在**死亡窗口之外**，光靠死亡触发根本看不到它。
   */
  readonly offerOutstanding: boolean;
  /**
   * 上一次"确认关闭"的时刻（ms，与 `nowMs` 同一时基）；
   * `null` = 本局还没有确认过关闭（或已复位）。
   */
  readonly lastConfirmedCloseAtMs: number | null;
  /** 当前时刻（ms，与门控同一时基）。 */
  readonly nowMs: number;
}

export interface ApiCadenceOptions {
  /** 面板停留期间的采样间隔（单卡刷新检测靠它）。 */
  readonly rerollPollMs: number;
  /** "已开截屏"期间的采样间隔。 */
  readonly activeMs: number;
  /** 关后自愈探针的采样间隔（低频）。 */
  readonly probeMs: number;
  /** 关后自愈窗口（超过它就回到 0）。 */
  readonly healWindowMs: number;
  /** 关后自愈探针总开关（**默认关闭**：用户选择严格零取帧）。 */
  readonly healProbe: boolean;
  /**
   * **待选未选时**的低频探针间隔（ms；`0` = 关闭，默认）。
   *
   * ── 为什么要有（2026-10-11 真机两局的直接产物）──────────────────────────
   *
   * 严格零取帧（`0`）只在"海克斯一定出现在死亡窗口内"这个前提下才安全。
   * 两局真机日志都不满足：`pending [7]` 时玩家在 7/8/9 级各死了一次，
   * 每次 45 秒窗口里门控**一条判据都没看见面板**（另一局同样）；
   * 而同一个状态机在 10/11 级、14/15 级的死亡窗口里都抓到了面板。
   *
   * 所以"面板到底会不会出现在死亡窗口之外（例如活着的时候）"必须能**验证**：
   * 打开这个探针（`HEXBOX_AUGMENT_PENDING_PROBE_MS=6000`）就退化成
   * "还有未选海克斯时，每 6 秒扫一帧"。代价与收益与关后自愈探针同量级
   * （一局 20 分钟约 200 帧 ≈ 4 秒 CPU），但**它是产品取舍**：
   * 用户 2026-10-11 明确选了"严格零取帧"，所以这里**默认 0（关闭）**，
   * 要改默认值只需要改这一个常量。
   */
  readonly pendingProbeMs: number;
}

export const API_CADENCE_DEFAULTS: ApiCadenceOptions = {
  rerollPollMs: 400,
  activeMs: 250,
  probeMs: 6000,
  healWindowMs: 20_000,
  // ⚠️ 回退点：用户裁决"严格常态零取帧"，所以这条探针**默认不启用**。
  //    打开它 = 误判关闭后最多 6 秒自愈（代价：关闭后 20 秒内 1 帧/6 秒）。
  healProbe: false,
  // ⚠️ 回退点：同上（用户裁决"严格零取帧"）。打开它 = 还有未选海克斯时
  //    每 N 毫秒采一帧，用来验证"面板会出现在死亡窗口之外"（见上面长注）。
  pendingProbeMs: 0,
};

export interface ApiCadenceDecision {
  readonly intervalMs: number;
  readonly reason: string;
  /** 本决策是否来自"关后自愈探针"（诊断/单测用）。 */
  readonly healProbe: boolean;
}

/**
 * 算 api 模式下下一段采样间隔（**0 = 一帧不取**）。
 *
 * 纯函数：不读环境变量、不碰状态 —— 控制器只负责把三个入参（`capture` /
 * `state` / `rechecking`）喂进来，顺序规则全部由这里决定（可单测）。
 */
export function apiCaptureInterval(
  input: ApiCadenceInput,
  options: Partial<ApiCadenceOptions> = {},
): ApiCadenceDecision {
  const o: ApiCadenceOptions = { ...API_CADENCE_DEFAULTS, ...options };
  if (input.panelOpen) {
    return {
      intervalMs: o.rerollPollMs,
      reason: `面板在屏 → 重随轮询 ${o.rerollPollMs}ms（面板状态优先于触发状态机）`,
      healProbe: false,
    };
  }
  if (input.capture) {
    return { intervalMs: o.activeMs, reason: `已开截屏（等面板/等连选）${o.activeMs}ms`, healProbe: false };
  }
  if (input.rechecking) {
    return {
      intervalMs: o.activeMs,
      reason: `关闭待确认 → 复检取帧 ${o.activeMs}ms（面板若还在就会自己回来）`,
      healProbe: false,
    };
  }
  // 待选未选时的低频探针（**默认关闭**，见 `pendingProbeMs`）：
  // 面板可能出现在死亡窗口之外，这条分支是"验证它"的唯一手段。
  // 它**不改**触发状态机的 `capture`（消耗/开窗仍然只由死亡决定），只是取帧看一眼。
  if (o.pendingProbeMs > 0 && input.offerOutstanding) {
    return {
      intervalMs: o.pendingProbeMs,
      reason:
        `还有未选海克斯 → 待选探针 ${o.pendingProbeMs}ms` +
        `（验证"面板是否出现在死亡窗口之外"；capture=false 不变）`,
      healProbe: false,
    };
  }
  if (o.healProbe && input.lastConfirmedCloseAtMs !== null) {
    const since = input.nowMs - input.lastConfirmedCloseAtMs;
    if (since >= 0 && since <= o.healWindowMs) {
      return {
        intervalMs: o.probeMs,
        reason:
          `确认关闭后 ${Math.round(since / 1000)}s（≤ ${o.healWindowMs / 1000}s）：` +
          `自愈探针 ${o.probeMs}ms（误判最多 6 秒自愈）`,
        healProbe: true,
      };
    }
  }
  return { intervalMs: 0, reason: '常态：api 模式一帧不取', healProbe: false };
}
