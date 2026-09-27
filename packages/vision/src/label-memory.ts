/**
 * 标签记忆：跨轮保留最近可信的识别结果
 *
 * 真机验收 bug（2026-09-28）：三选一阶段三张卡片的胜率都正确显示,
 * 但几秒后第三张的胜率消失,只剩前两张。
 *
 * 根因：卡片检测对动画/光效敏感,某轮只检出 2 张（confident=true,
 * 但卡片数变少）。VisionLoop 的 FAIL_TOLERANCE 只在**整轮失败**
 * （active=false）时保留旧内容;部分失败会以"成功"的姿态覆盖
 * 上一轮的 3 张标签 —— 少掉的卡片标签随之消失。
 *
 * 方案：按**位置**记忆。每轮识别后：
 *   1. 新识别的标签覆盖同位置（±容差）的记忆,刷新其时间戳;
 *   2. 本轮缺失、但距上次命中 ≤ TTL 轮的记忆**继续显示** ——
 *      检测闪烁不影响显示连续性,超时才真正丢弃;
 *   3. 同位置但文本更新（数据刷新）视为替换,不产生重复。
 *
 * 实现为闭包工厂（状态在闭包内,含每条记忆的真实 lastSeen）——
 * 「从上一轮输出重建状态」的纯函数式写法会丢失 lastSeen、
 * 使 TTL 永不超时（真实踩过,勿改回）。
 */

import type { CardLabel } from './card-overlay.ts';

export interface LabelMemoryOptions {
  /** 缺失标签保留多少轮（×识别间隔 = 实际时长）。默认 6。 */
  readonly ttlRounds?: number;
  /** 视为「同一位置」的位置容差（逻辑 DIP）。默认 24。 */
  readonly positionTolerance?: number;
}

const DEFAULTS = { ttlRounds: 6, positionTolerance: 24 } as const;

/** 一条带时间戳的记忆条目。 */
interface Entry {
  readonly label: CardLabel;
  /** 最近一次被识别命中的轮次序号。 */
  lastSeen: number;
}

/** 两个标签是否指向同一个视觉元素（位置容差内,文本不参与 ——
 *  文本变化是数据刷新,不是新元素）。 */
function sameSpot(a: CardLabel, b: CardLabel, tol: number): boolean {
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
}

export interface LabelMemory {
  /**
   * 每轮调用一次。
   *
   * @param current 本轮识别的标签（整轮失败传 []）
   * @param round   本轮序号（单调递增）
   * @param active  本轮识别是否可信
   * @returns 本轮应显示的标签集
   */
  update(current: readonly CardLabel[], round: number, active: boolean): CardLabel[];
  /** 清空记忆（离开选人阶段时调用）。 */
  reset(): void;
}

/** 创建一个标签记忆体。 */
export function createLabelMemory(options: LabelMemoryOptions = {}): LabelMemory {
  const { ttlRounds, positionTolerance } = { ...DEFAULTS, ...options };
  let entries: Entry[] = [];

  return {
    update(current, round, active) {
      if (active) {
        // 新识别替换同位记忆;新增的直接入册
        const out: Entry[] = current.map((label) => ({ label, lastSeen: round }));
        for (const m of entries) {
          const superseded = current.some((c) => sameSpot(m.label, c, positionTolerance));
          if (!superseded && round - m.lastSeen <= ttlRounds) {
            out.push(m);
          }
        }
        entries = out;
      } else {
        // 整轮失败:全部按 TTL 衰减
        entries = entries.filter((m) => round - m.lastSeen <= ttlRounds);
      }
      return entries.map((e) => e.label);
    },

    reset() {
      entries = [];
    },
  };
}
