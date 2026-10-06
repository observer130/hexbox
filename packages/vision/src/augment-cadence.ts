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
