/**
 * 标签悬停提示框的**文案**（纯函数 + 单测）
 *
 * ── 为什么文案也要纯函数 + 单测 ────────────────────────────────────────────
 *
 * 提示框会显示**比标签更细**的数据，于是它有两个新的"说错话"风险，
 * 而且都会被用户当真：
 *   ① **统计口径**：标签上的数字是"官方榜单"的，提示框必须写清是哪天的、
 *      哪来的；`dataDate` 非法时**宁可不说日期**，也不许拼一个错位的日期
 *      （复用 `parseDataDate` 的既有规则）。
 *   ② **海克斯那一条**：标签只有档位字母，提示框如果写成"推荐/给你的选项"
 *      就越界了 —— 官方表是**该英雄的强度**，不是"这一局系统给你的三选一"。
 *      所以文案里显式带上"非本局选项"这层含义（见 `TIP_AUGMENT_SOURCE`）。
 *
 * 内容为空时返回空行数组（调用方据此让该标签**没有**提示框，而不是弹一个空框）。
 */

import { pickRateText } from './augment-tier-label.ts';
import { parseDataDate } from './data-update-stamp.ts';

/** 榜单口径说明（选人标签）。 */
export const TIP_CHAMPION_SOURCE = '来源：腾讯国服官方公开榜单';

/**
 * 海克斯评级口径说明（局内标签）。
 *
 * ⚠️ 措辞是**契约**：官方强度表描述的是"该英雄配这颗海克斯"的统计表现，
 * 与"这一局系统给你的三个选项"无关 —— 用户明确要求不能让人误读成后者。
 */
export const TIP_AUGMENT_SOURCE = '评级来自官方单英雄强度表（不是本局给你的选项）';

/** 屏幕识别说明（放最前，提醒数据来自本地识别而非接口）。 */
export const TIP_RECOGNIZED_FROM_SCREEN = '识别自屏幕';

export interface ChampionLabelTipInput {
  /** 英雄名（选人标签已有；空串 = 用 `英雄` 兜底）。 */
  readonly name: string;
  /** 胜率 0..1；`null` = 没有官方数据。 */
  readonly winRate: number | null;
  readonly pickRate?: number | null;
  /** 综合排名（1 起）；`<= 0`/缺省 = 不显示。 */
  readonly rank?: number | null;
  /** 名次变化描述原文（`上升1位` / `未变化`）。 */
  readonly rankChangeDesc?: string;
  /** 官方统计日期（`20261005`）。 */
  readonly dataDate?: string | null;
}

/** 选人标签的提示框文案。 */
export function championLabelTip(input: ChampionLabelTipInput): {
  readonly tipTitle: string;
  readonly tip: string[];
} {
  const title = input.name.trim() !== '' ? input.name.trim() : '英雄';
  const lines: string[] = [];

  if (input.winRate !== null && Number.isFinite(input.winRate)) {
    lines.push(`胜率 ${(input.winRate * 100).toFixed(1)}%`);
  }
  if (input.pickRate !== null && input.pickRate !== undefined && Number.isFinite(input.pickRate)) {
    lines.push(`选取率 ${(input.pickRate * 100).toFixed(1)}%`);
  }
  if (typeof input.rank === 'number' && input.rank > 0) {
    const change = (input.rankChangeDesc ?? '').trim();
    lines.push(`榜单排名 第 ${input.rank} 名${change !== '' ? `（${change}）` : ''}`);
  }
  if (lines.length === 0) {
    lines.push('暂无官方统计（该英雄不在榜单里）');
  }

  // ⚠️ 只有**解析得出来的**日期才写；非法/缺失一律不提（宁可不说）
  const date = parseDataDate(input.dataDate);
  lines.push(date !== null ? `统计日期 ${date}` : '统计日期：未知');
  lines.push(TIP_CHAMPION_SOURCE);
  return { tipTitle: title, tip: lines };
}

export interface AugmentTierLabelTipInput {
  /** 档位字母（`S`/`A`/`B`/`C`）。 */
  readonly tier: string;
  /** 该英雄口径的选取率 0..1；`null` = 查不到（那一行在标签上也不画）。 */
  readonly pickRate: number | null;
  /** 本局英雄名（有就写出来，便于核对"这是谁的强度表"）。 */
  readonly championName?: string;
  readonly dataDate?: string | null;
}

/** 局内海克斯强度标签的提示框文案。 */
export function augmentTierLabelTip(input: AugmentTierLabelTipInput): {
  readonly tipTitle: string;
  readonly tip: string[];
} {
  const tier = input.tier.trim();
  const title = tier !== '' ? `强度评级 ${tier}` : '强度评级';
  const lines: string[] = [];

  const hero = (input.championName ?? '').trim();
  if (hero !== '') lines.push(`本局英雄：${hero}`);

  // 与标签上那一行**同源同格式**（同一个 `pickRateText`）。
  // ⚠️ 它把 `null / 0 / 负数 / 非有限值` 都变成空串（标签上"不画那一行"），
  //    但提示框不能**省掉**这一行 —— 否则用户会以为"没查"，而实际是"官方表里是 0"。
  const rate = pickRateText(input.pickRate);
  lines.push(rate !== '' ? `${rate}（该英雄口径）` : '该英雄暂无官方选取率');

  const date = parseDataDate(input.dataDate);
  if (date !== null) lines.push(`统计日期 ${date}`);

  lines.push(TIP_RECOGNIZED_FROM_SCREEN);
  lines.push(TIP_AUGMENT_SOURCE);
  return { tipTitle: title, tip: lines };
}
