/**
 * 确认阶段识别：选定英雄后（悬停大立绘）,
 * 顶部「可用」栏与左侧玩家条出现**标准方头像**（官方 champion-icons 同源）。
 *
 * 此时卡片已消失,名字 OCR 无对象 —— 切换到头像模板匹配（阶段 2）。
 * 模板即 templates.json 的 24×24 灰度,与方头像同源,匹配可靠。
 *
 * 已知定位（真机 2026-09-27,1600×900 逻辑 / 2.13x 截屏）：
 *   - 顶部栏头像: 第 1 格 x≈0.28..0.30, y≈0.02..0.05（其余为空格子）
 *   - 左侧玩家条头像: x≈0.055..0.075, y≈0.40..0.46（自己那一行）
 *   两处头像均为方形;顶部栏在英雄锁定后出现,最可靠。
 *
 * ⚠️ 这些比例来自单次真机观察,UI 缩放/分辨率变化可能漂移。
 * 提取时裁剪到头像中心 60% 区域,降低边框/高亮干扰;
 * 匹配阈值沿用 matchChampionCareful（0.85/0.10,宁漏勿错）。
 */

import type { Bitmap, PreparedTemplate, Rect } from './index.ts';
import { extractGray, matchChampionCareful } from './match.ts';

/** 候选头像位置（归一化,相对截屏）。 */
export interface PortraitSlot {
  readonly id: string;
  readonly rect: Rect;
}

/** 顶部栏第 1 格（英雄锁定后出现）。 */
export const TOP_BAR_SLOT: PortraitSlot = {
  id: 'top-bar-1',
  rect: { x: 0.278, y: 0.017, w: 0.026, h: 0.046 },
};

/** 左侧玩家条头像（自己那一行）。 */
export const PLAYER_BAR_SLOT: PortraitSlot = {
  id: 'player-bar',
  rect: { x: 0.052, y: 0.398, w: 0.024, h: 0.043 },
};

/** 确认阶段按序尝试的槽位。 */
export const CONFIRM_SLOTS: readonly PortraitSlot[] = [TOP_BAR_SLOT, PLAYER_BAR_SLOT];

/**
 * 在指定槽位尝试识别英雄。
 *
 * @returns 命中的英雄;分数不足/区分度不够/槽位无内容（空格子）→ null
 */
export function identifyConfirmedChampion(
  bmp: Bitmap,
  slots: readonly PortraitSlot[],
  templates: readonly PreparedTemplate[],
): { championId: number; score: number; slot: string } | null {
  if (templates.length === 0) return null;
  // 头像内缩:避开圆环边框与高亮
  const inset = { x: 0.15, y: 0.15, w: 0.7, h: 0.7 };
  for (const slot of slots) {
    const inner: Rect = {
      x: slot.rect.x + slot.rect.w * inset.x,
      y: slot.rect.y + slot.rect.h * inset.y,
      w: slot.rect.w * inset.w,
      h: slot.rect.h * inset.h,
    };
    const gray = extractGray(bmp, inner, 24);
    if (!gray) continue;
    const m = matchChampionCareful(gray, templates);
    if (m) {
      return { championId: m.championId, score: m.score, slot: slot.id };
    }
  }
  return null;
}
