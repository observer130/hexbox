/**
 * 海克斯「何时开截屏」触发状态机（纯函数，可单测）
 *
 * 用户定的方案（2026-10-05）：**常态不截屏**，改由 Live Client Data API 触发。
 *   1. 维护"哪些海克斯还没选"的状态；
 *   2. 开局触发一次；
 *   3. API 检测到**死亡** + **等级达标** + **该次海克斯还没选** → 才开截屏；
 *      **升级跨过待选等级**时也开一次（见下"升级定向开窗"）；
 *      选完（截屏里看不到卡片）→ 关。
 *
 * ⚠️ 最容易错的一点：**未选的海克斯会累积，一次死亡可能连选多次**。
 * 例如：开局出门后再没死过，直到 11 级才死亡 —— 此时 7 级和 11 级两次都还没选，
 * 游戏会**连着弹两次三选一**。所以状态必须是"未选等级集合"（pending），
 * 而不是"当前等级对应的那一次"。
 *
 * ── 为什么死亡是主要时机 ──────────────────────────────────────────────
 * 面板的出现条件（真机观察 + docs/AUGMENT-PANEL.md §一）是「等级达标」**且**
 * 「死亡回泉水」（外加开局必出一次），而"什么时候死"无法预测。
 * API 能直接给出 `isDead` / `level`，所以：
 *   · 死亡是**开截屏的时机**（等级不达标就不开）；
 *   · 关截屏由**像素门控**决定（看不到卡片 = 选完了）——
 *     API 不知道面板什么时候消失，只有屏幕知道。
 *
 * 两个信号分工明确：**API 决定"什么时候看"，像素决定"看到了什么"。**
 *
 * ── 升级定向开窗（2026-10-12 新增，用户裁决"直接修"）──────────────────
 * 真机证据（`debug/augment/api-trigger.csv` 同一台机器）：
 *   · 一局里**四次 offer 全部在死亡窗口内 4~5 秒抓到**（等级 7/11/15 + 开局），
 *     且 7 级那次是"升级后 202 秒才第一次死亡、面板随即被选掉"；
 *   · 而**同机另一局**（`%LOCALAPPDATA%\hexbox\logs\overlay.log` 第 2 局）
 *     出现 7 级 offer 连续**三个死亡窗口（各 45 秒）都没见到面板**，
 *     15 级 offer 更是**五个窗口全空**、整局没抓到。
 * 也就是说"面板只在死亡时出现"这个模型**解释不了**那一局 —— 面板可能在
 * 死亡窗口之外出现，或者在常态（零取帧）期间就被选掉（那样 `pending`
 * 会永远留着该等级，之后每个窗口都在找一块早已不在屏上的面板）。
 *
 * 因为等级是 API 直接给的、offer 等级集合固定，**升级那一刻**是唯一
 * "我们能预知"的候选时刻，所以在跨越待选等级时定向开一次窗 ——
 * 平时（没有未选 offer / 没跨等级）依然**零取帧**。
 * 若面板确实只在死亡时出现，代价只是升级那一刻多开一个 ≤45s 的窗口
 * （`armWindowMs`，超时自愈、`pending` 不消耗）。
 *
 * ── 自愈设计（每一条都对应一种真实失败）────────────────────────────────
 * · 门控漏检面板 → 不会走到"关"，但 `armWindowMs` 到点自动关，pending 保留
 *   → 下次死亡/升级会再开一次（不会永久卡死）。
 * · 面板一直开着（玩家在思考）→ **只要门控说还开着就绝不超时**，并顺延窗口。
 * · 工具在对局中途启动 → 开局那次多半已被选掉，首帧若 gameTime 已超过
 *   `midGameStartSec` 就把"开局"标记为已选，避免第一次死亡时误判成连选。
 */

/** 一次 API 采样（只取触发需要的字段）。 */
export interface AugmentTriggerSample {
  /** 对局时间（秒）。 */
  readonly gameTime: number;
  /** 我的等级。 */
  readonly level: number;
  /** 我是否处于死亡状态。 */
  readonly isDead: boolean;
  /** 复活剩余秒数（`isDead` 的交叉验证）。 */
  readonly respawnTimer: number;
}

export interface AugmentTriggerConfig {
  /**
   * 会出现海克斯的等级（**0 = 开局那一次**）。
   *
   * 用户实测：开局必出一次，之后是 7 / 11 / 15 级且需死亡回泉水。
   */
  readonly offerLevels?: readonly number[];
  /** 死亡后维持"开截屏"的窗口（ms）。窗口内没等到面板就关，pending 留着下次死亡再试。 */
  readonly armWindowMs?: number;
  /**
   * 关边沿之后的**连选等待**（ms）。
   *
   * 选完第一次后，若还有未选的海克斯（本轮死亡够格的），
   * 游戏会紧接着再弹一次 —— 这段时间保持开截屏，否则会漏掉第二次。
   */
  readonly chainGraceMs?: number;
  /** `gameTime` 小于此值视为"开局"。 */
  readonly startWindowSec?: number;
  /** 启动时 `gameTime` 已超过此值 → 认为开局那次已经选过（工具中途启动）。 */
  readonly midGameStartSec?: number;
}

export const AUGMENT_TRIGGER_DEFAULTS = {
  offerLevels: [0, 7, 11, 15] as readonly number[],
  armWindowMs: 45000,
  chainGraceMs: 20000,
  startWindowSec: 25,
  midGameStartSec: 60,
} as const;

export type AugmentTriggerStopReason =
  | 'none'
  | 'panel-closed-all-consumed'
  | 'arm-window-expired';

export interface AugmentTriggerDecision {
  /** 是否应当开截屏（false = 常态不截屏）。 */
  readonly capture: boolean;
  /** 相比上一次决策是否变化（主进程据此下发 IPC，避免刷通道）。 */
  readonly changed: boolean;
  /** 人读原因（写日志/CSV）。 */
  readonly reason: string;
  /** 还没选的海克斯等级（0 = 开局）。 */
  readonly pending: readonly number[];
}

export interface AugmentTrigger {
  /**
   * 喂一次 API 采样，返回"现在要不要开截屏"。
   *
   * @param nowMs 单调时钟（与门控同一时基）
   */
  onSample(sample: AugmentTriggerSample, nowMs: number): AugmentTriggerDecision;
  /** 门控说"看到卡片了"。 */
  notePanelOpen(nowMs: number): void;
  /** 门控说"卡片消失了"（= 选完一次）→ 消耗一次并决定是否继续开着。 */
  notePanelClosed(nowMs: number): AugmentTriggerDecision;
  /** 当前是否开着截屏。 */
  readonly capture: boolean;
  /** 还没选的海克斯等级。 */
  readonly pending: readonly number[];
  reset(): void;
}

export function createAugmentTrigger(config: AugmentTriggerConfig = {}): AugmentTrigger {
  const offerLevels = [...(config.offerLevels ?? AUGMENT_TRIGGER_DEFAULTS.offerLevels)];
  const armWindowMs = config.armWindowMs ?? AUGMENT_TRIGGER_DEFAULTS.armWindowMs;
  const chainGraceMs = config.chainGraceMs ?? AUGMENT_TRIGGER_DEFAULTS.chainGraceMs;
  const startWindowSec = config.startWindowSec ?? AUGMENT_TRIGGER_DEFAULTS.startWindowSec;
  const midGameStartSec = config.midGameStartSec ?? AUGMENT_TRIGGER_DEFAULTS.midGameStartSec;

  /** 还没选的海克斯（按等级升序）。 */
  let pending: number[] = [...offerLevels];
  let capture = false;
  /** 开截屏的截止时刻（门控说"还开着"时会顺延）。 */
  let captureUntil = 0;
  let panelOpen = false;
  /** 本轮开的窗口里，是否已经见过面板（用于区分"刚开"与"选完了"）。 */
  let sawPanel = false;
  let lastLevel = 0;
  let lastIsDead = false;
  let seenFirstSample = false;
  let lastReason = '常态：不截屏';
  /**
   * 是否"开过边沿还没等到关边沿"。
   *
   * ⚠️ 用来挡住**重复的关边沿**：消耗必须发生在一个真实的"开 → 关"周期里。
   * 否则多消耗一次，下次死亡就不会开截屏 —— 直接漏掉一整个海克斯（代价太大）。
   */
  let awaitingClose = false;
  /** 工具中途启动 → 开局那次按"已选"处理（只做一次）。 */
  let midGameInitDone = false;

  const decision = (changed: boolean, reason: string): AugmentTriggerDecision => {
    lastReason = reason;
    return { capture, changed, reason, pending: [...pending] };
  };

  /** 够格的未选等级（≤ 当前等级）。 */
  const eligible = (): number[] => pending.filter((lv) => lv <= lastLevel);

  const startCapture = (nowMs: number, reason: string): boolean => {
    const changed = !capture;
    capture = true;
    captureUntil = Math.max(captureUntil, nowMs + armWindowMs);
    sawPanel = false;
    // ⚠️ 必须在这里写 reason：否则上报的是上一次的原因字符串（测试抓到过）
    lastReason = reason;
    return changed;
  };

  const stopCapture = (reason: string): boolean => {
    const changed = capture;
    capture = false;
    sawPanel = false;
    panelOpen = false;
    lastReason = reason;
    return changed;
  };

  return {
    onSample(sample, nowMs) {
      const first = !seenFirstSample;
      seenFirstSample = true;
      const prevDead = lastIsDead;
      const prevLevel = lastLevel;
      lastLevel = sample.level;
      lastIsDead = sample.isDead;

      // 工具中途启动：开局那次多半已被选掉，避免第一次死亡时把它算成连选
      //
      // ⚠️ 这里**不能 return**：首帧可能同时就是一次死亡（工具在死亡瞬间启动），
      // 提前返回会把这次死亡吞掉 → 那一轮就不开截屏了（写测试时抓到过）。
      let initNote: string | null = null;
      if (!midGameInitDone) {
        midGameInitDone = true;
        if (sample.gameTime > midGameStartSec) {
          const before = pending.length;
          pending = pending.filter((lv) => lv !== 0);
          if (pending.length !== before) {
            initNote = `中途启动（对局 ${sample.gameTime.toFixed(0)}s）：开局那次按已选处理`;
          }
        }
      }

      // 1) 开局：开局那一次一定出现
      //
      // ⚠️ **只在还没开截屏时才 `startCapture()`**（真机 bug，2026-10-11）：
      //    开局窗口有 `startWindowSec`(25) 秒，而 API 每 1 秒轮询一次 → 这 25 次采样
      //    都会走到这一行。`startCapture()` 里有一句 `sawPanel = false`，
      //    于是门控刚通过 `notePanelOpen()` 置的"见过面板"**下一秒就被抹掉** →
      //    关边沿走 `wasSaw === false` 分支，日志出现自相矛盾的
      //    `🔌 关截屏：未见面板即关闭`（前面明明有 `▶ 面板出现 #1`，L213/L291），
      //    而且 25 秒内采样间隔在 0/250ms 之间反复跳（capture 被反复"重新打开"）。
      //    第 4 条 `if (!capture)` 就是这条修复：已经在开截屏 → 一个字都不改。
      let alreadyOpenNote: string | null = null;
      if (sample.gameTime <= startWindowSec && pending.includes(0)) {
        if (!capture) {
          const changed = startCapture(nowMs, `开局（对局 ${sample.gameTime.toFixed(0)}s）：开截屏`);
          if (changed || first) return decision(changed, lastReason);
        } else {
          // 已经在开截屏：**保持**（不清 sawPanel、不推窗口），只留一句人读原因
          alreadyOpenNote =
            `开局窗口（对局 ${sample.gameTime.toFixed(0)}s）：已在开截屏，保持（不重置"见过面板"）`;
        }
      }
      // 2) 死亡：等级达标才有意义
      const died = sample.isDead && !prevDead;
      if (died) {
        const ok = eligible();
        if (ok.length > 0) {
          const changed = startCapture(
            nowMs,
            `死亡（等级 ${sample.level}，待选 [${ok.join(',')}]）：开截屏`,
          );
          return decision(changed, lastReason);
        }
        // 等级不够 / 都选完了 —— 明确记一笔，便于复盘"为什么没开"
        if (!capture) {
          return decision(false, `死亡但无待选（等级 ${sample.level}，待选 [${pending.join(',')}]）：不开`);
        }
      }

      // 3) **升级定向开窗**（用户裁决 2026-10-12）：本次采样跨过了某个仍未选的
      //    待选等级 → 立刻开一次窗看一眼。
      //
      // 为什么不能只等死亡：真机日志里第 2 次 offer（7 级）出现过"整窗 45s
      // 内两条判据一次没命中"（`api-trigger.csv` 同机的另一局却是四次 offer
      // 全在死亡窗口内抓到），而**面板可能在死亡窗口之外出现/被选掉**：
      // 一旦它在常态（零取帧）期间被选掉，`pending` 就永远留在 [7,…]，
      // 之后每个死亡窗口都在找一块早就不在屏上的面板 —— 记账还会整体偏一位。
      // 升级那一刻是唯一"我们能预知"的候选时刻：等级是 API 直接给的，
      // 而 offer 等级集合是固定的（[0,7,11,15]）。
      //
      // 代价（如实记录）：升级到待选等级时可能白开一个 ≤45s 的窗口（面板其实在
      // 死亡时才出现）。判据是**有向**的：只在"仍未选的待选等级**被本次升级跨过**"
      // 时开，别的一律不开（`pending` 空了就永不开）；跳过 0（开局那次由第 1 条管）。
      const crossed =
        sample.level > prevLevel
          ? pending.filter((lv) => lv > 0 && lv > prevLevel && lv <= sample.level)
          : [];
      if (crossed.length > 0) {
        const span = `${prevLevel}→${sample.level}`;
        if (!capture) {
          const changed = startCapture(
            nowMs,
            `升级到待选等级 ${crossed.join(',')}（等级 ${span}，待选 [${pending.join(',')}]）：开截屏`,
          );
          return decision(changed, lastReason);
        }
        // 已经在开截屏：保持（不清 sawPanel、不推窗口）—— 与开局窗口同一条教训
        return decision(
          false,
          `升级到待选等级 ${crossed.join(',')}（等级 ${span}）：已在开截屏，保持（不重置"见过面板"）`,
        );
      }

      // 3b) 等级变了但没跨过待选等级（例如该等级早选完了）：只记录，不开
      //
      // ⚠️ 这里保留"等死亡"的结论：面板**可能**要等死亡才出现（真机日志里
      //    四次 offer 都是在死亡窗口内 4~5 秒抓到的），所以没有新信息时不开窗。
      if (!capture && sample.level !== prevLevel) {
        const ok = eligible();
        if (ok.length > 0) {
          return decision(false, `等级 ${sample.level}（待选 [${ok.join(',')}]）：未跨待选等级，等死亡`);
        }
      }

      // 4) 超时关闭：窗口内没见到面板就关掉，pending 留着下次死亡再试
      if (capture && !panelOpen && nowMs > captureUntil) {
        stopCapture(`窗口超时（未见面板）：关截屏，待选 [${pending.join(',')}] 保留`);
        return decision(true, lastReason);
      }

      if (alreadyOpenNote !== null) return decision(false, alreadyOpenNote);
      if (initNote !== null) return decision(false, initNote);
      return decision(false, lastReason);
    },

    notePanelOpen(nowMs) {
      panelOpen = true;
      sawPanel = true;
      awaitingClose = true;
      // 面板还开着 → 顺延窗口，避免玩家思考时被超时打断
      captureUntil = Math.max(captureUntil, nowMs + armWindowMs);
    },

    notePanelClosed(nowMs) {
      panelOpen = false;
      const wasSaw = sawPanel;
      sawPanel = false;

      // 没有对应的开边沿 → 重复/多余的关边沿，忽略（否则会多消耗一次待选）
      if (!awaitingClose) {
        return decision(false, `多余的关边沿（忽略，待选 [${pending.join(',')}] 不变）`);
      }
      awaitingClose = false;

      // 消耗一次：取最小的够格未选等级（游戏按等级从低到高给）。
      //
      // 这里**不检查 capture**：门控既然报过"面板出现过"，就说明确实弹过一次 ——
      // 哪怕当时因为状态机的别的原因没在开截屏（例如工具刚启动的那一帧），
      // 也不该把这次当成"没发生"（否则 pending 记多，下次死亡会误判连选）。
      const ok = eligible();
      const consumed = ok[0] ?? pending[0];
      if (consumed !== undefined) {
        pending = pending.filter((lv) => lv !== consumed);
      }
      // ⚠️ 消耗发生在**上面**（门控既然报过"面板出现过"，就说明确实弹过一次），
      //    所以这条 reason 必须如实说明"已经消耗了一次" —— 沿用它之前的字符串
      //    会打出"窗口超时…关截屏"这种**看起来没消耗**的假日志（真机复盘时
      //    正是靠这两条 reason 判断"记账有没有偏位"，不能含糊）。
      if (!capture) {
        return decision(
          false,
          `选完一次（等级 ${lastLevel}）：当时没在开截屏，不关表；待选 [${pending.join(',')}]`,
        );
      }

      // 选完后游戏可能紧接着再弹一次（连选）→ 保持开截屏
      if (eligible().length > 0) {
        captureUntil = Math.max(captureUntil, nowMs + chainGraceMs);
        return decision(
          false,
          `选完一次（等级 ${lastLevel}）：还有 [${eligible().join(',')}] 未选，保持开截屏等连选`,
        );
      }
      stopCapture(
        wasSaw
          ? `选完（等级 ${lastLevel}）：本次待选已清空，关截屏`
          : `未见面板即关闭：关截屏，待选 [${pending.join(',')}] 保留`,
      );
      return decision(true, lastReason);
    },

    get capture() {
      return capture;
    },
    get pending() {
      return [...pending];
    },
    reset() {
      pending = [...offerLevels];
      capture = false;
      captureUntil = 0;
      panelOpen = false;
      sawPanel = false;
      lastLevel = 0;
      lastIsDead = false;
      seenFirstSample = false;
      awaitingClose = false;
      midGameInitDone = false;
      lastReason = '常态：不截屏';
    },
  };
}
