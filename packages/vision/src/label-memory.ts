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
 * ── 容量上限（真机 bug 修复,2026-10-11：屏幕上冒出"第四个悬浮标签"）──────
 *
 * 只按位置记忆有一个致命盲区：**误检会往记忆里塞进一个"真实世界不存在"的元素**。
 * 真机证据（打包版 `overlay.log` L34 → L40，同一块选人界面）：
 *   · 某轮 `detectCards` 误检成 **2 张**、名字只低置信命中 0.50/0.02 →
 *     产出 1 个标签 @(1160,621)（这个位置本来是卡片之间的美术空隙）;
 *   · 下一轮正确检出 3 张 → 产出 3 个标签;
 *   · 但那个幽灵标签与三个新标签**两两都差 > 24 DIP（容差）** →
 *     位置规则认不出它是"同一个元素重认",于是**原样保留** →
 *     屏幕上是 4 个（3 个正确 + 1 个带旧英雄名的幽灵），持续 6 轮 TTL
 *     （L41~L78 连续 `draw labels=4`，约 20~25 秒）。
 *
 * 修法：记下**本块 UI 见过的最大元素数** `capacity`（`reset()` 清 0，
 * 每轮用本轮输入条目数取 max），合并时 `out.length >= capacity` 就停手。
 * 语义（两条都要保住，别只保一条）：
 *   · 3 张卡某轮只检出 2 张 → `capacity` 仍是 3 → 仍能补齐第 3 个
 *     （这正是本模块最初的目的：检测闪烁不影响显示连续性）;
 *   · 误检成 2 张后再检出 3 张 → `capacity` 升到 3，3 个新标签已经占满
 *     容量 → 幽灵**永远进不来**，输出恒为 3。
 * 关键在于容量由"本轮看到的元素数"取 max 且**只增不减**：屏幕上真实存在过的
 * 最大元素数就是数量的上界，多出来的只能是误检产物。而"到底有几张"这件事
 * 的正确性由 `detectCards`/门控负责，本模块只保证**不凭空多画**。
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
  /**
   * 本块 UI 见过的**最大元素数**（见文件头「容量上限」）。
   *
   * 0 = 还没见过任何元素（`reset()` 后）。只增不减：真实存在过的最大张数
   * 就是数量上界，超出的条目只能是误检产物（幽灵标签）。
   */
  let capacity = 0;

  return {
    update(current, round, active) {
      if (active) {
        // 容量 = max(历史, 本轮) —— 必须在本轮合并之前更新，
        // 否则"误检 1 张 → 正确 3 张"这一轮里幽灵仍会挤进来。
        capacity = Math.max(capacity, current.length);
        // 新识别替换同位记忆;新增的直接入册
        const out: Entry[] = current.map((label) => ({ label, lastSeen: round }));
        for (const m of entries) {
          // 容量已满：本轮标签数已达"本块 UI 见过的最多张"，
          // 再补任何旧条目都只会多画一个不存在的元素。
          if (out.length >= capacity) break;
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
      capacity = 0;
    },
  };
}
