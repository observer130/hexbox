/**
 * 确认阶段识别（锁定英雄后）
 *
 * ⚠️ 需求语义（2026-09-28 与用户确认,推翻旧设计）：
 *   锁定英雄后,顶部「可用」栏列出的是**未选的备选英雄**（方头像,
 *   与官方 champion-icons 同源）。此阶段玩家在**看下一个备选**,
 *   因此应给顶栏**每个有头像的格子**各显示一个胜率标签 ——
 *   不是旧实现的「只识别第 1 格、把已锁定英雄画在左上角」。
 *
 * 槽位几何（2026-09-28 真机实测校准,勿凭印象改）：
 *   - 2400×1350 逻辑坐标系下测得：第 1 格左缘 x=659,顶 y=19,
 *     格盒 93×94,步进 110（格间净隙 17）,共 10 格;
 *   - 归一化后与分辨率无关：两张不同分辨率真机截图
 *     （3413×1920 / 2400×1344）的竖线归一化中心完全一致
 *     （x0=0.2746, step=0.0458, 线对间距 0.0039）。
 *
 * 占用检测：有头像的格子内部纹理复杂（std 高）,空格近乎纯色
 * （真机:占用 std ≥ 60,空格 ≤ 9）。取 16×16 内部灰度的标准差判定。
 *
 * 匹配参数（真机实测,与卡片立绘完全不同的可靠度）：
 *   - 提取**整个槽位盒**（inset=0）时 NCC 得分 0.93~0.95 ——
 *     旧实现的 inset 0.15 是为卡片立绘设计的,把得分压到 0.79,
 *     永远过不了 0.85 阈值（这是「确认态无显示」的根因之一）;
 *   - margin 0.094（肯恩 vs 炼金）在真机上真实出现,
 *     旧的 minMargin=0.10 会误杀 —— 方头像同源匹配比立绘可靠,
 *     用独立于 matchChampionCareful 的宽松阈值（0.80/0.05）。
 */

import type { Bitmap, PreparedTemplate, Rect } from './index.ts';
import { extractGray, extractGrayRaw, extractRgb, normalizeGray, similarity } from './match.ts';

/* ------------------------------------------------------------------ */
/* 顶栏几何（归一化,真机实测）                                           */
/* ------------------------------------------------------------------ */

/** 顶栏槽位行（归一化,相对截屏全图）。 */
export const TOP_BAR_ROW = {
  /** 第 1 格左缘（x/H 均为归一化）。 */
  x0: 659 / 2400,
  /** 槽位顶缘。 */
  y: 19 / 1350,
  /** 单格宽。 */
  slotW: 93 / 2400,
  /** 单格高。 */
  slotH: 94 / 1350,
  /** 相邻格左缘步进。 */
  step: 110 / 2400,
  /** 槽位总数（选人顶栏固定 10 格）。 */
  count: 10,
} as const;

/** 第 k 格（k 从 0 起）的归一化矩形。 */
export function topBarSlotRect(k: number): Rect {
  if (k < 0 || k >= TOP_BAR_ROW.count) {
    throw new Error(`topBarSlotRect: 槽位序号越界 ${k}`);
  }
  return {
    x: TOP_BAR_ROW.x0 + k * TOP_BAR_ROW.step,
    y: TOP_BAR_ROW.y,
    w: TOP_BAR_ROW.slotW,
    h: TOP_BAR_ROW.slotH,
  };
}

/** 全部槽位矩形（按从左到右）。 */
export function topBarSlotRects(): Rect[] {
  return Array.from({ length: TOP_BAR_ROW.count }, (_, k) => topBarSlotRect(k));
}

/* ------------------------------------------------------------------ */
/* 占用检测                                                             */
/* ------------------------------------------------------------------ */

/** 内部统计（用于占用判定）。 */
interface InteriorStats {
  readonly mean: number;
  /** 灰度方差（0..1，已按 255² 归一化）。 */
  readonly grayVar: number;
  /** 色度（通道间最大差）方差（0..1）。 */
  readonly chromaVar: number;
  /** 水平相邻像素平均灰度差（0..255）。 */
  readonly edgeDensity: number;
}

/** 在内部区域上一次性算出三个指标（单次遍历 + 一次色度均值修正）。 */
function interiorStats(gray: Uint8Array, rgb: Uint8ClampedArray, side: number): InteriorStats {
  const n = gray.length;
  let m = 0;
  for (const v of gray) m += v;
  m /= n;

  let gv = 0;
  const chromas = new Float64Array(n);
  let cm = 0;
  for (let i = 0; i < n; i++) {
    const d = gray[i]! - m;
    gv += d * d;
    const p = i * 4;
    const r = rgb[p]!;
    const g = rgb[p + 1]!;
    const b = rgb[p + 2]!;
    const c = Math.max(r, g, b) - Math.min(r, g, b);
    chromas[i] = c;
    cm += c;
  }
  cm /= n;
  let cv = 0;
  for (let i = 0; i < n; i++) {
    const d = chromas[i]! - cm;
    cv += d * d;
  }

  // 边缘密度：水平相邻像素的灰度差（按行，跳过每行首像素）
  let edge = 0;
  let edgeN = 0;
  for (let y = 0; y < side; y++) {
    for (let x = 1; x < side; x++) {
      edge += Math.abs(gray[y * side + x]! - gray[y * side + x - 1]!);
      edgeN++;
    }
  }

  return {
    mean: m,
    grayVar: gv / n / (255 * 255),
    chromaVar: cv / n / (255 * 255),
    edgeDensity: edge / Math.max(1, edgeN),
  };
}

/**
 * 占用判定阈值。
 *
 * ⚠️ 依据（2026-10-04 实测 `debug/shots/champselect-locked-152419-raw.png`）：
 *   · **空槽**（第一阶段 10 格全空）：灰度 std 1.0~5.2、色度 std 1.7~7.4、
 *     边缘密度 **≤0.06**；
 *   · **有内容的英雄卡片区域**（同图对照）：灰度 std 39.3、色度 std 27.7、
 *     边缘密度 **1.99**。
 *   两者差 30 倍以上，因此三指标取**宽松下限**即可：宁可误判为"占用"
 *   （多跑一次 0.6ms 的模板匹配，无副作用），也不要漏判导致第二阶段
 *   整格不显示。
 */
export const OCCUPANCY = {
  /** 灰度方差下限（空槽 ≤(5.2/255)²≈4.2e-4）。 */
  grayVar: 0.002,
  /** 色度方差下限（空槽 ≤(7.4/255)²≈8.4e-4）。 */
  chromaVar: 0.002,
  /** 边缘密度下限（空槽 ≤0.06，有内容 ≈2.0）。 */
  edgeDensity: 0.25,
} as const;

export function isSlotOccupied(bmp: Bitmap, rect: Rect): boolean {
  // 内缩 12%：避开边框亮线（边框会抬高各指标造成误判）
  const inner: Rect = {
    x: rect.x + rect.w * 0.12,
    y: rect.y + rect.h * 0.12,
    w: rect.w * 0.76,
    h: rect.h * 0.76,
  };
  return isRegionOccupied(bmp, inner);
}

/** 在给定矩形（归一化）上做占用判定；`side` 为采样网格边长。 */
export function isRegionOccupied(bmp: Bitmap, rect: Rect, side = 16): boolean {
  const g = extractGray(bmp, rect, side);
  const rgb = extractRgb(bmp, rect, side);
  if (!g || !rgb) return false;
  const st = interiorStats(g, rgb, side);
  return (
    st.edgeDensity >= OCCUPANCY.edgeDensity ||
    st.grayVar >= OCCUPANCY.grayVar ||
    st.chromaVar >= OCCUPANCY.chromaVar
  );
}

/**
 * 统计顶栏有多少格被头像占用。
 *
 * 这个数是**「当前处于哪个阶段」的判据**（用户确认的流程）：
 *   · 第一阶段（卡片刚发出来、还没人选）→ 0 格 → 显示卡片胜率；
 *   · 第二阶段（选定后未选的进「可用」区）→ ≥1 格 → 显示顶栏逐格胜率。
 *
 * ⚠️ 真机 bug：第二阶段卡片已消失，但 `detectCards` 仍会在美术图上误检
 * 出 2 张矩形；没有阶段判据时屏幕上会冒出两个**错误的**胜率框。
 */
export function countOccupiedSlots(bmp: Bitmap, slots: readonly Rect[]): number {
  let n = 0;
  for (const s of slots) if (isSlotOccupied(bmp, s)) n++;
  return n;
}

/* ------------------------------------------------------------------ */
/* 逐格识别                                                             */
/* ------------------------------------------------------------------ */

/** 一个顶栏候选（已识别出英雄的格子）。 */
export interface TopBarCandidate {
  /** 槽位序号（0 起,从左到右）。 */
  readonly slotIndex: number;
  /** 槽位归一化矩形。 */
  readonly rect: Rect;
  readonly championId: number;
  /** NCC 得分（0..1）。 */
  readonly score: number;
}

export interface TopBarScanOptions {
  /**
   * @deprecated 占用判定已改为多指标联合（见 `OCCUPANCY`），
   * 不再接受单一灰度阈值。保留字段仅为兼容既有调用，**不再生效**。
   */
  readonly occupiedStd?: number;
  /** 匹配最低得分。默认 0.80（方头像同源,真机 0.93+）。 */
  readonly minScore?: number;
  /** 前两名最小分差。默认 0.05（真机最小 0.094,留余量）。 */
  readonly minMargin?: number;
}

/**
 * 扫描顶栏全部槽位,返回有头像且识别成功的格子。
 *
 * ⚠️ `captureSlots` 必须是**截屏归一化**矩形：调用方先用
 * `windowRectToCapture` 把 `topBarSlotRects()`（窗口归一化）
 * 变换到截屏空间（window 形态截屏两者相等,display 形态
 * 窗口只是截屏的子矩形 —— 不变换必然整体错位）。
 *
 * 与旧 identifyConfirmedChampion 的区别：
 *   - 逐格处理而非只试第 1 格;
 *   - 占用检测先行（空格跳过匹配,避免把纯色格匹配到错误英雄）;
 *   - 匹配阈值独立于卡片立绘（0.80/0.05,依据见文件头）。
 *
 * 识别失败的格子**静默跳过**（宁漏勿错）,诊断信息由调用方按需打日志。
 */
export function detectTopBarCandidates(
  bmp: Bitmap,
  captureSlots: readonly Rect[],
  templates: readonly PreparedTemplate[],
  options: TopBarScanOptions = {},
): TopBarCandidate[] {
  const minScore = options.minScore ?? 0.8;
  const minMargin = options.minMargin ?? 0.05;
  const out: TopBarCandidate[] = [];
  if (templates.length === 0) return out;

  for (let k = 0; k < captureSlots.length && k < TOP_BAR_ROW.count; k++) {
    const rect = captureSlots[k]!;
    // 占用检测：统一走 isSlotOccupied（多指标联合，见 OCCUPANCY 的实测依据）
    if (!isSlotOccupied(bmp, rect)) continue;

    // 匹配用整个槽位盒（真机:inset=0 得分最高 0.93+;内缩反而降分）
    const gray = extractGray(bmp, rect, 24);
    if (!gray) continue;
    const q = normalizeGray(gray);
    const scored = templates
      .map((t) => ({ championId: t.championId, score: similarity(q, t.norm) }))
      .sort((a, b) => b.score - a.score);
    const first = scored[0];
    const second = scored[1];
    if (!first || first.score < minScore) continue;
    if (second && first.score - second.score < minMargin) continue;
    out.push({ slotIndex: k, rect, championId: first.championId, score: first.score });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 诊断（debug 工具用）                                                  */
/* ------------------------------------------------------------------ */

/** 逐格诊断行。 */
export interface TopBarSlotDiag {
  readonly slotIndex: number;
  readonly occupied: boolean;
  /** 占用格才有:top3 候选与得分。 */
  readonly top?: readonly { readonly championId: number; readonly score: number }[];
}

/**
 * 逐格诊断：占用状态 + 占用格的 top3 候选（无论是否过阈值）。
 *
 * `captureSlots` 语义同 detectTopBarCandidates（截屏归一化）。
 *
 * 旧实现只返回 null,无法区分「槽位错了」与「阈值过高」——
 * 这是 S2 确认态问题排查了两轮的根本原因。诊断输出是硬要求。
 */
export function diagnoseTopBarSlots(
  bmp: Bitmap,
  captureSlots: readonly Rect[],
  templates: readonly PreparedTemplate[],
  options: TopBarScanOptions = {},
): TopBarSlotDiag[] {
  const out: TopBarSlotDiag[] = [];
  for (let k = 0; k < captureSlots.length && k < TOP_BAR_ROW.count; k++) {
    const rect = captureSlots[k]!;
    const occupied = isSlotOccupied(bmp, rect);
    if (!occupied) {
      out.push({ slotIndex: k, occupied: false });
      continue;
    }
    const gray = extractGray(bmp, rect, 24);
    const top = gray
      ? templates
          .map((t) => ({ championId: t.championId, score: similarity(normalizeGray(gray), t.norm) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
      : [];
    out.push({ slotIndex: k, occupied: true, top });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 旧接口（保留兼容,供测试平滑迁移）                                      */
/* ------------------------------------------------------------------ */

/** 候选头像位置（旧接口,已废弃的语义 —— 见文件头需求变更说明）。 */
export interface PortraitSlot {
  readonly id: string;
  readonly rect: Rect;
}

/**
 * @deprecated 旧「单英雄确认态识别」已废弃:确认态的正确需求是
 * 逐格显示顶栏备选英雄的胜率（detectTopBarCandidates）。
 * 保留导出仅为兼容既有 import;不再被 vision-loop 使用。
 */
export const TOP_BAR_SLOT: PortraitSlot = {
  id: 'top-bar-1',
  rect: topBarSlotRect(0),
};

/**
 * @deprecated 同 TOP_BAR_SLOT。
 */
export const PLAYER_BAR_SLOT: PortraitSlot = {
  id: 'player-bar',
  rect: { x: 0.0442, y: 0.3741, w: 0.0433, h: 0.0778 },
};

/**
 * @deprecated 同 TOP_BAR_SLOT。
 */
export const CONFIRM_SLOTS: readonly PortraitSlot[] = [TOP_BAR_SLOT, PLAYER_BAR_SLOT];

/**
 * @deprecated 旧的提取逻辑（内缩 0.15）会把方头像得分压到 0.79,
 * 且只处理单格。保留导出仅为兼容,不再被 vision-loop 使用。
 */
export function identifyConfirmedChampion(
  bmp: Bitmap,
  slots: readonly PortraitSlot[],
  templates: readonly PreparedTemplate[],
): { championId: number; score: number; slot: string } | null {
  if (templates.length === 0) return null;
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
    const q = normalizeGray(gray);
    const scored = templates
      .map((t) => ({ championId: t.championId, score: similarity(q, t.norm) }))
      .sort((a, b) => b.score - a.score);
    const first = scored[0];
    const second = scored[1];
    if (!first || first.score < 0.85) continue;
    if (second && first.score - second.score < 0.1) continue;
    return { championId: first.championId, score: first.score, slot: slot.id };
  }
  return null;
}

/** 名字带提取辅助（诊断用,保持与 match.ts 一致的签名）。 */
export function slotGrayRaw(bmp: Bitmap, rect: Rect): { gray: Uint8Array; width: number; height: number } | null {
  return extractGrayRaw(bmp, rect);
}
