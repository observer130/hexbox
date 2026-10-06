/**
 * 局内海克斯面板检测（纯函数 + 去抖状态机，可单测）
 *
 * 为什么需要它：局内「三选一海克斯」出现的**时刻不固定** —— 回合节奏不固定、
 * 玩家可以重随（同一块面板换掉三张卡）、可以不马上选、也可以关了再开。
 * 而接口侧没有任何可用信号：2999 端口的 Live Client Data API 经真机 swagger
 * 全量核对（24 端点 / 24 schema）**不含** augment / cherry / kiwi 字段
 * （见 docs/AUGMENT-PANEL.md §一）。
 *
 * 所以唯一可靠的信号是**屏幕本身**：面板"在"与"不在"的跳变就是刷新事件。
 *
 * ── 判据（2026-10-04 用真机帧标定，勿凭印象改）──────────────────────────
 *
 * 真实面板的样子（`debug/shots/inprogress-*.png`，4587×1920）：
 *   · 三张大卡横排在屏幕中部：x = 0.298/0.441/0.583 起，各宽 0.115、间距 0.020，
 *     y 范围 0.179~0.666（占屏高 48.7%）；
 *   · 每张卡的边框是**亮象牙白双描边**（一对亮线相隔 ≈ 0.0083×宽，
 *     会各自被投影检出 —— mergeGap 必须 ≈ 0.010×区宽才能合并，
 *     这个坑 grid.ts 已经踩过：见其 `findBands` 的 mergeGap 说明）；
 *   · 卡片**内部近黑**（实测平均亮度 25~29），边框很亮（151~158）。
 *
 * 因此判据是「**结构 + 明暗对比**」，不是「相对基线变暗」：
 *   1. 结构：在卡片行搜索区跑 grid.ts 的 `detectCards`（等宽聚桶 → 互不相交链
 *      → 小间隙 → 纵横比），要求重建出 2~3 张卡；
 *   2. 对比：每张卡内部平均亮度 < 40 **且** 「边框环 − 内部」≥ 70
 *      （用对比而不是边框绝对亮度，理由见 `PanelThresholds.contrastMin`）。
 *
 * 实测区分度（同一份帧图，见 `scripts/diag-augment-frames.mts`）：
 *
 *   帧                    卡片  内部亮度   边框−内部   判定
 *   面板（3 张真机帧）      3  25~29      92~129     ✅ 面板（1/1、1/2、1/4 分辨率皆成立）
 *   正常游玩（5 帧）       0~2  52~103     -1~18      ❌
 *   选人界面（3 帧）        0~2  53~83      -1~55      ❌
 *
 * ⚠️ **不要用"相对基线压暗"（EMA）**：真实踩过。录制恰好从"面板已经打开"
 * 开始（`closed-sample-1.png` 就是面板帧），基线被播种成面板的暗值，
 * 之后正常游玩反而更亮 → dimDrop 永远为负，门控自锁。绝对量 + 结构判据
 * 没有这个失效模式，也不需要维护基线状态。
 *
 * ── 关闭判定是**两个信号**（2026-10-06 真机回归：面板开着标签却消失）──────
 *
 * 上面这套卡片判据会被**单卡重随的翻牌动画**连续打掉约 1 秒（真机时间线实测
 * 1178ms，见 `augment-presence.ts` 头部）。旧版"卡片判据连续 2 帧未命中 = 关闭"
 * 在 400ms 采样下只有 0.8 秒 → 误判关闭 → 清标签 + 关截屏 → 那块面板永久空白。
 * 现在：
 *   · **卡片判据**（本文件，标定值不动）；
 *   · **"面板仍在"信号**（`augment-presence.ts`：卡片上下缘两条亮带还在）；
 * 只有**两者都说不在**、连续 `PANEL_CLOSE_CONFIRM_FRAMES`(3) 帧，才判关闭
 * （400ms 采样 = 1.2 秒，是用户验收过的清空延迟上限）；期间"面板信号仍在"的帧
 * 由 `PANEL_PRESENCE_TRUST_FRAMES`(5) 帧的额度托底，额度用完就不再托底
 * （避免误报让标签永远不消失）。
 *
 * ⚠️⚠️ **别把这一步当成"已经修好了"**（2026-10-06 交接时明确写下的事实）：
 * 本文件这次的改动只是把关闭确认从 **2 帧（0.8 秒）** 提到 **3 帧（1.2 秒）**，
 * 而真机实测（`debug/augment/timeline.csv`：32524 命中 → 32930/33333/33612/33862
 * 连续失效 → 34108 又命中）翻牌会让卡片判据失效 **1178ms** ——
 * **余量只有 22ms，等于没修**（采样抖动、实测 405ms 的帧间隔这类正常波动就能吃掉它）。
 * 真正的修复是**接线**那条独立信号与关闭确认状态机：
 *   · `augment-presence.ts` 的 `detectPanelPresence()`（渲染端未命中帧回传）；
 *   · `augment-close-confirm.ts` 的 `createCloseConfirm()`（延后 `notePanelClosed`，
 *     并在复检窗口内继续取帧，让误判能自己回来）。
 * 只改本文件的帧数**不足以**解决"面板还在却判关闭"——接线完成前，
 * 那块面板仍然可能在翻牌后永久空白。
 *
 * ⚠️ 本文件必须保持**浏览器安全**（渲染端截屏 worker 会 import 它）：
 * 只允许依赖 types / grid / match 这类纯计算模块。坐标换算
 * （需要 win-geometry → PowerShell）在 `augment-region.ts`，由主进程算好经 IPC 传入。
 */

import { detectCards } from './grid.ts';
import { extractGray } from './match.ts';
import {
  NO_PANEL_PRESENCE,
  PANEL_PRESENCE_REGION,
  detectPanelPresence,
  type PanelPresence,
} from './augment-presence.ts';
import type { Bitmap, Rect } from './types.ts';

/* ------------------------------------------------------------------ */
/* 几何与阈值（真机标定值）                                              */
/* ------------------------------------------------------------------ */

/**
 * 卡片行搜索区（**窗口/截屏归一化**）。
 *
 * ── 为什么要这么宽（分辨率无关性，2026-10-05 用户要求）────────────────
 *
 * LoL 的 UI 按**屏幕高度**缩放，所以面板的尺寸应当用"帧高"作单位：
 * 实测卡片**行宽 = 0.956 × 帧高**（与分辨率无关），行中心在水平正中。
 * 换成帧宽比例就随纵横比变：
 *
 *   纵横比              卡片行在帧宽中的范围      旧区 x 0.22~0.78
 *   16:10  (1.600)      x 0.201 ~ 0.799          ❌ 左右各切掉 ~0.02
 *   16:9   (1.778)      x 0.231 ~ 0.769          ✅
 *   21:9   (2.333)      x 0.295 ~ 0.705          ✅
 *   32:9   (3.556)      x 0.366 ~ 0.634          ✅
 *
 * 纵向是帧高比例，与纵横比无关（实测 y 0.179~0.666）。
 *
 * 所以搜索区取 **x 0.12~0.88 / y 0.10~0.76**：从 4:3 到 32:9 全都包得住，
 * 不再依赖"用户和我用同一种显示器"。加宽会让检测面积从 0.34 涨到 0.50
 * （检测耗时 ~2ms → ~3ms，对 250ms 门控可忽略），假阳性由
 * `scripts/diag-augment-frames.mts` 在真机负样本上回归（见文件头部的实测表）。
 *
 * ⚠️ 用前必须经 `augment-region.ts` 的 `panelRowRectInCapture()` 变换到截屏空间：
 * 截屏可能是**显示器快照**（含窗口外区域），此时窗口归一化 ≠ 截屏归一化，
 * 直接用会错位 —— S2 真机验收的标签错位就是这个原因（见 win-geometry 函数头注）。
 */
export const PANEL_ROW_REGION: Rect = { x: 0.12, y: 0.1, w: 0.76, h: 0.66 };

export interface PanelThresholds {
  /** 卡片纵横比（实测 1.56~1.77，取 1.77 给上偏余量）。 */
  readonly aspectRatio: number;
  readonly aspectTolerance: number;
  /** 同链相邻卡片的间隙上限（占卡宽；实测 0.020/0.115 = 0.17）。 */
  readonly maxGapRatio: number;
  /** 卡片内部平均亮度上限（实测面板 25~29，画面/选人 ≥ 52；各分辨率都稳）。 */
  readonly interiorMax: number;
  /**
   * **边框 − 内部** 的对比下限。
   *
   * ⚠️ 不能用"边框绝对亮度"当判据：薄亮边框在降采样时会被邻域暗像素平均掉，
   * 实测同一张面板帧的边框亮度 1.0 分辨率 155 → 0.5 时 144 → 0.25 时 120，
   * 而 0.25 分辨率下游戏画面最高也有 110 —— 绝对阈值无法同时服务两种分辨率。
   * 对比量则很稳：面板 92~129，游戏画面/选人界面 ≤ 55（各分辨率皆然）。
   */
  readonly contrastMin: number;
  /** 卡片高度下限（归一化；实测面板 0.487）。 */
  readonly minCardHeight: number;
  /** 卡片数量区间（实测面板 3；重随/动画中间帧可能只重建出 2 张）。 */
  readonly minCards: number;
  readonly maxCards: number;
}

export const PANEL_THRESHOLDS: PanelThresholds = {
  aspectRatio: 1.77,
  aspectTolerance: 0.45,
  maxGapRatio: 0.3,
  interiorMax: 40,
  contrastMin: 70,
  minCardHeight: 0.3,
  minCards: 2,
  maxCards: 3,
};

/* ------------------------------------------------------------------ */
/* 检测                                                                */
/* ------------------------------------------------------------------ */

/** 一张被重建出来的候选卡（含用于验证对比结构的亮度）。 */
export interface PanelCard {
  /** 卡片矩形（**截屏归一化**）。 */
  readonly rect: Rect;
  /** 内部平均亮度（内缩 15%，避开边框与发光）。 */
  readonly interiorLuma: number;
  /** 边框环平均亮度。 */
  readonly edgeLuma: number;
}

export interface PanelDetection {
  /** 是否认定"海克斯三选一面板在屏幕上"。 */
  readonly found: boolean;
  readonly cards: readonly PanelCard[];
  /** 竖线投影出的边框带数量（诊断；合并后 3 张卡应为 6）。 */
  readonly bands: number;
  readonly reason: string;
}

/**
 * 依次尝试多个候选搜索区，返回**第一个命中**的结果。
 *
 * 抽成"注入检测器"的泛型函数而不是把循环写死在检测里，是为了**能测**：
 * 检测器本身的结构判据是在真机帧上标定的，合成图复现不出那套结构
 * （试过按真机比例造三张等宽卡，检测器仍不认），
 * 所以回退语义用一个假检测器来锁，检测器本身用真机帧的离线脚本核对。
 */
export function firstHit<T>(
  items: readonly T[],
  detect: (item: T) => PanelDetection,
): { readonly detection: PanelDetection; readonly regionIndex: number; readonly tried: number } {
  let first: PanelDetection | null = null;
  let tried = 0;
  for (const [i, item] of items.entries()) {
    const det = detect(item);
    tried++;
    if (det.found) return { detection: det, regionIndex: i, tried };
    if (first === null) first = det;
  }
  return {
    detection: first ?? { found: false, cards: [], bands: 0, reason: '没有候选搜索区' },
    regionIndex: -1,
    tried,
  };
}

/**
 * 依次在多个候选搜索区里找面板，返回**第一个命中**的那个。
 *
 * ⚠️ 为什么需要它（2026-10-05 真机事故）：窗口矩形探针**认错窗口**时
 * （实测：游戏全屏 2293×960，探针却给出 1600×900 @ (347,6) 的**别的**窗口），
 * 换算出的搜索区会把外侧卡边框切掉 → **整局 0 命中，一局白跑**。
 *
 * 与其去猜"探针可不可信"（窗口化游戏时探针给出的正是这种"小而不等比"的矩形，
 * 猜错就把窗口化支持弄坏了），不如**两个候选区都搜一遍**：
 * 每次多 2~4ms 检测（对 250ms 门控完全可忽略），换"探针错也不会瞎"。
 *
 * @param regions 候选区（**截屏归一化**），按优先级排列
 */
export function detectAugmentPanelInRegions(
  bmp: Bitmap,
  regions: readonly Rect[],
  thresholds: PanelThresholds = PANEL_THRESHOLDS,
): { readonly detection: PanelDetection; readonly regionIndex: number; readonly tried: number } {
  return firstHit(regions, (region) => detectAugmentPanel(bmp, region, thresholds));
}

/**
 * 门控画布尺寸（**按流原生分辨率**算，而不是按 DIP/显示器尺寸估）。
 *
 * ⚠️ 为什么（分辨率无关性，2026-10-05 用户要求）：原实现取
 * `display.size.width * 2 * 0.25`，即"逻辑宽 × 2 × 1/4"——它**隐含假设
 * 缩放倍率 = 1.5**。有效分辨率 = 0.5 / scaleFactor：
 *
 *   scaleFactor 1.0 → 1/2  ✅（标定下限是 1/4）
 *   scaleFactor 1.5 → 1/3  ✅
 *   scaleFactor 2.0 → 1/4  ⚠️ 卡在下限
 *   scaleFactor 2.5 → 1/5  ❌ 低于标定下限，检测不稳（4K 屏常用 250%）
 *
 * 改成"占流原生宽度的固定比例 + 最小宽度"后，与 DPI、分辨率都无关：
 * 1080p / 2K / 3440×1440 / 4K 一律取同样的比例。
 *
 * @param videoWidth  流的原生宽度（`video.videoWidth`）
 * @param options.targetScale 目标比例（默认 1/3）
 * @param options.minWidth    最小宽度（默认 960；保证低于 4K 的屏也有足够像素）
 */
export function gateCanvasWidth(
  videoWidth: number,
  options: { readonly targetScale?: number; readonly minWidth?: number } = {},
): number {
  const targetScale = options.targetScale ?? 1 / 3;
  const minWidth = options.minWidth ?? 960;
  if (!Number.isFinite(videoWidth) || videoWidth <= 0) return Math.round(minWidth);
  return Math.max(160, Math.round(Math.max(videoWidth * targetScale, Math.min(minWidth, videoWidth))));
}

/** 裁剪子位图（越界或空尺寸返回 null）。 */
export function cropBitmap(bmp: Bitmap, rect: Rect): Bitmap | null {
  const x0 = Math.round(rect.x * bmp.width);
  const y0 = Math.round(rect.y * bmp.height);
  const w = Math.round(rect.w * bmp.width);
  const h = Math.round(rect.h * bmp.height);
  if (w <= 0 || h <= 0 || x0 < 0 || y0 < 0) return null;
  if (x0 + w > bmp.width || y0 + h > bmp.height) return null;

  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * bmp.width + x0) * 4;
    data.set(bmp.data.subarray(src, src + w * 4), y * w * 4);
  }
  return { width: w, height: h, data };
}

/** 矩形平均亮度（面积平均降采样）。 */
function meanLuma(bmp: Bitmap, rect: Rect, side: number): number | null {
  const g = extractGray(bmp, rect, side);
  if (!g) return null;
  let s = 0;
  for (const v of g) s += v;
  return s / g.length;
}

/** 卡片内部平均亮度（内缩 15%）。 */
function interiorLuma(bmp: Bitmap, rect: Rect): number {
  const inner: Rect = {
    x: rect.x + rect.w * 0.15,
    y: rect.y + rect.h * 0.15,
    w: rect.w * 0.7,
    h: rect.h * 0.7,
  };
  return meanLuma(bmp, inner, 16) ?? 0;
}

/** 卡片边框环平均亮度（四条细边带的均值）。 */
function edgeLuma(bmp: Bitmap, rect: Rect, thickness = 0.006): number {
  const strips: Rect[] = [
    { x: rect.x, y: rect.y, w: rect.w, h: thickness },
    { x: rect.x, y: rect.y + rect.h - thickness, w: rect.w, h: thickness },
    { x: rect.x, y: rect.y, w: thickness, h: rect.h },
    { x: rect.x + rect.w - thickness, y: rect.y, w: thickness, h: rect.h },
  ];
  let sum = 0;
  let n = 0;
  for (const s of strips) {
    const v = meanLuma(bmp, s, 8);
    if (v !== null) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

/**
 * 检测一帧里是否存在海克斯三选一面板（纯函数）。
 *
 * @param region 卡片行搜索区（**截屏归一化**；默认直接用 `PANEL_ROW_REGION`，
 *               实机调用应传 `panelRowRectInCapture(...)` 的结果）。
 */
export function detectAugmentPanel(
  bmp: Bitmap,
  region: Rect = PANEL_ROW_REGION,
  thresholds: PanelThresholds = PANEL_THRESHOLDS,
): PanelDetection {
  const crop = cropBitmap(bmp, region);
  if (!crop) return { found: false, cards: [], bands: 0, reason: '搜索区越界' };

  const det = detectCards(crop, {
    aspectRatio: thresholds.aspectRatio,
    aspectTolerance: thresholds.aspectTolerance,
    maxGapRatio: thresholds.maxGapRatio,
  });
  const cards: PanelCard[] = det.cards.map((r) => {
    const rect: Rect = {
      x: region.x + r.x * region.w,
      y: region.y + r.y * region.h,
      w: r.w * region.w,
      h: r.h * region.h,
    };
    return { rect, interiorLuma: interiorLuma(bmp, rect), edgeLuma: edgeLuma(bmp, rect) };
  });
  const bands = det.lines.length;

  if (cards.length < thresholds.minCards) {
    return { found: false, cards, bands, reason: `卡片数 ${cards.length}（${det.reason ?? '?'}）` };
  }
  if (cards.length > thresholds.maxCards) {
    return { found: false, cards, bands, reason: `卡片数 ${cards.length} > ${thresholds.maxCards}（多列网格？）` };
  }
  const short = cards.find((c) => c.rect.h < thresholds.minCardHeight);
  if (short) {
    return { found: false, cards, bands, reason: `卡片太矮(${short.rect.h.toFixed(2)} < ${thresholds.minCardHeight})` };
  }
  const bright = cards.find((c) => c.interiorLuma >= thresholds.interiorMax);
  if (bright) {
    return {
      found: false,
      cards,
      bands,
      reason: `卡片内部不够暗(${bright.interiorLuma.toFixed(0)} ≥ ${thresholds.interiorMax})`,
    };
  }
  const flat = cards.find((c) => c.edgeLuma - c.interiorLuma < thresholds.contrastMin);
  if (flat) {
    return {
      found: false,
      cards,
      bands,
      reason:
        `卡片对比不够(边框 ${flat.edgeLuma.toFixed(0)} − 内部 ${flat.interiorLuma.toFixed(0)} = ` +
        `${(flat.edgeLuma - flat.interiorLuma).toFixed(0)} < ${thresholds.contrastMin})`,
    };
  }
  return {
    found: true,
    cards,
    bands,
    reason:
      `${cards.length} 张卡片：内部暗(${cards.map((c) => c.interiorLuma.toFixed(0)).join('/')})` +
      ` 边框亮(${cards.map((c) => c.edgeLuma.toFixed(0)).join('/')})`,
  };
}

/* ------------------------------------------------------------------ */
/* 去抖状态机                                                          */
/* ------------------------------------------------------------------ */

/**
 * 连续多少帧命中才算"开了"（去抖）。
 *
 * 开边沿比关边沿**敏感**是对的：漏开 = 这块面板没有标签（用户什么都看不到），
 * 而面板出现的淡入/飞入动画本来就带几帧噪声，2 帧已经够。
 */
export const PANEL_OPEN_CONFIRM_FRAMES = 2;

/**
 * 连续多少帧"**两个信号都说不在**"才算"关了"。
 *
 * ⚠️ 这条阈值是 2026-10-06 真机回归的直接产物 ——
 * **单卡重随的翻牌动画会让卡片判据连续失效约 1 秒**（实测 32930→34108 = 1178ms，
 * 见 `augment-presence.ts` 头部的时间线）。旧阈值 2 帧在 400ms 采样下只有 0.8 秒，
 * 必被穿过去 → 误判关闭 → 清标签 + 关截屏 → **那块面板永久空白**。
 *
 * 3 帧的账（按线上节奏算）：
 *   · 面板停留期间采样 `HEXBOX_AUGMENT_REROLL_POLL_MS`（默认 400ms）→ 3 帧 = **1.2 秒**；
 *   · 用户已验收的"选完立刻清空"延迟上限就是这个 1.2 秒（再长就明显了）；
 *   · 而翻牌动画那 ~1.2 秒**由 `augment-presence.ts` 的独立信号托底**
 *     （面板信号仍在 → 不计入关闭），所以这里不需要靠"更多帧"硬扛。
 *
 * ⚠️ 单靠这条帧数**修不掉它**：真机实测翻牌失效 **1178ms**，3 帧只有 1200ms ——
 * **余量 22ms**（低于一帧的抖动）。没有"面板仍在"信号托底时，它随时会再被穿过。
 */
export const PANEL_CLOSE_CONFIRM_FRAMES = 3;

/**
 * "面板仍在"信号最多能托底多少帧（自上次**卡片判据命中**之后算）。
 *
 * 为什么要有上限：该信号是廉价的亮度结构判据，误报（例如恰好两条亮线落位）
 * 会让门控永远不关 → 标签永远挂在屏幕上。给一个明确的额度（5 帧 ≈ 2 秒，
 * 覆盖实测 1.2 秒的翻牌），额度用完后该信号不再托底，未命中照常累计。
 */
export const PANEL_PRESENCE_TRUST_FRAMES = 5;

export interface PanelTrackerOptions {
  /** 连续多少帧命中才算"开了"（去抖；默认 `PANEL_OPEN_CONFIRM_FRAMES`）。 */
  readonly openAfterHits?: number;
  /**
   * 连续多少帧"卡片判据 + 面板信号**都**说不在"才算"关了"
   *（默认 `PANEL_CLOSE_CONFIRM_FRAMES`）。
   */
  readonly closeAfterMisses?: number;
  /** "面板仍在"信号最多托底多少帧（默认 `PANEL_PRESENCE_TRUST_FRAMES`）。 */
  readonly presenceTrustFrames?: number;
  readonly thresholds?: PanelThresholds;
}

/** 一帧的读数（含状态与边沿）。 */
export interface PanelReading {
  readonly state: 'closed' | 'open';
  /** 本帧是否发生状态跳变；无跳变为 null。 */
  readonly edge: 'open' | 'close' | null;
  /** 本帧检测结果（未命中时 false）。 */
  readonly found: boolean;
  /** 本帧检测到的卡片（未命中时通常为空）。 */
  readonly cards: readonly PanelCard[];
  readonly bands: number;
  readonly hits: number;
  /**
   * 连续多少帧"**两个信号都不在**"。
   *
   * ⚠️ 语义与旧版不同：旧版是"卡片判据连续未命中"，现在是"卡片判据未命中
   * **且**面板信号也不在（或托底额度已用完）" —— 关闭判定只看它。
   */
  readonly misses: number;
  /**
   * 连续多少帧"卡片判据失效但**面板信号仍在**"（托底计数）。
   *
   * 它 >0 就说明"翻牌/内容切换"正在发生 —— 真机复盘时这一列就是
   * "刚才那几帧不是面板关了，是卡片在动"的直接证据。
   */
  readonly presenceHolds: number;
  /** 本帧的"面板仍在"信号（渲染端没给时是 null）。 */
  readonly presence: PanelPresence | null;
  readonly reason: string;
}

export interface PanelTracker {
  /**
   * 每帧调用一次（串行，勿并发）。
   *
   * 接受 `PanelDetection` 而不是位图：检测（`detectAugmentPanel`）在**渲染端**
   * 常驻截屏 worker 里跑（那里拿得到画面），状态机在主进程里跑（那里发指令、
   * 触发全分辨率识别）。两者只通过这个纯数据对象交接。
   *
   * @param presence 渲染端算的"面板仍在"独立信号（`augment-presence.ts`）。
   *                 不给 = 按"不在"处理（与接线前完全一致的行为）。
   */
  push(detection: PanelDetection, presence?: PanelPresence | null): PanelReading;
  /** 便捷：一站式"位图 → 检测（+未命中时的面板信号）→ 状态机"（一次性截屏路径与单测用）。 */
  pushBitmap(bmp: Bitmap, region?: Rect): PanelReading;
  readonly state: 'closed' | 'open';
  reset(): void;
}

/**
 * 面板开/关的**边沿**检测器（纯状态机，无时间概念）。
 *
 * 去抖的理由：面板出现/消失都带一段动画（卡片飞入、发光渐显），
 * 单帧命中/单帧丢失都会误报；连续 2 帧才认，同时保持对"重随"不敏感
 * （重随不改变"面板还在"这个事实，`state` 会一直是 open）。
 *
 * ⚠️ 关闭判定看**两个信号**（2026-10-06 真机回归，见文件头与该文件里
 * `PANEL_CLOSE_CONFIRM_FRAMES` / `augment-presence.ts`）：
 *   卡片判据（结构 + 明暗对比）**且**"面板仍在"信号（卡片上下缘亮带）都不在，
 *   连续 `closeAfterMisses` 帧才算关闭。"卡片判据失效"单独一票**不足以**关闭 ——
 *   单卡重随的翻牌动画会让卡片判据失效约 1 秒，而面板一直在屏上。
 */
export function createPanelTracker(options: PanelTrackerOptions = {}): PanelTracker {
  const openAfterHits = options.openAfterHits ?? PANEL_OPEN_CONFIRM_FRAMES;
  const closeAfterMisses = options.closeAfterMisses ?? PANEL_CLOSE_CONFIRM_FRAMES;
  const presenceTrustFrames = options.presenceTrustFrames ?? PANEL_PRESENCE_TRUST_FRAMES;
  const thresholds = options.thresholds ?? PANEL_THRESHOLDS;

  let state: 'closed' | 'open' = 'closed';
  let hits = 0;
  let misses = 0;
  let presenceHolds = 0;

  const push = (det: PanelDetection, presence: PanelPresence | null = null): PanelReading => {
    let edge: 'open' | 'close' | null = null;
    let reason = det.reason;
    if (det.found) {
      hits++;
      misses = 0;
      presenceHolds = 0;
      if (state === 'closed' && hits >= openAfterHits) {
        state = 'open';
        edge = 'open';
      }
    } else {
      hits = 0;
      // 卡片判据失效 ≠ 面板不在：面板信号仍在（且在托底额度内）→ 本帧不算未命中
      const trusted =
        presence !== null && presence.present && presenceHolds < presenceTrustFrames;
      if (trusted) {
        presenceHolds++;
        misses = 0;
        // ⚠️ **两条判据的原文都要留下**：只说"面板信号仍在"会丢掉"卡片判据为什么挂"
        //（排查时分不清是翻牌（内容变亮）还是结构没重建出来）。
        reason =
          `${det.reason} → 卡片判据失效但**面板信号仍在**（第 ${presenceHolds}/${presenceTrustFrames} 次）` +
          `→ 不判关闭（面板信号：${presence.reason}）`;
      } else {
        misses++;
        if (presence !== null && presence.present) {
          reason =
            `${det.reason} → 面板信号已用完托底额度（${presenceTrustFrames} 帧）` +
            `→ 计入未命中（面板信号：${presence.reason}）`;
        }
        if (state === 'open' && misses >= closeAfterMisses) {
          state = 'closed';
          edge = 'close';
        }
      }
    }
    return {
      state,
      edge,
      found: det.found,
      cards: det.cards,
      bands: det.bands,
      hits,
      misses,
      presenceHolds,
      presence,
      reason,
    };
  };

  return {
    push,
    pushBitmap(bmp: Bitmap, region: Rect = PANEL_ROW_REGION): PanelReading {
      const det = detectAugmentPanel(bmp, region, thresholds);
      // 只在未命中时算"面板仍在"信号（命中帧当然在）：这在正常状态下是**零成本**，
      // 只有翻牌/真关闭那几帧才多一次按行扫描。
      // 搜索区用**同一块**区（`PANEL_PRESENCE_REGION` 与 `PANEL_ROW_REGION` 的值
      // 由单测锁住相等）：两处若用了不同的区，就会"卡片判据看一块、面板信号看另一块"。
      const presence = det.found ? null : detectPanelPresence(bmp, region);
      return push(det, presence);
    },
    get state(): 'closed' | 'open' {
      return state;
    },
    reset(): void {
      state = 'closed';
      hits = 0;
      misses = 0;
      presenceHolds = 0;
    },
  };
}

/**
 * 一行「面板关闭判定的依据」（纯函数；**每一次关闭都要能解释**）。
 *
 * 用户报"标签出现一瞬间就消失了"时，唯一能回答的问题就是"门控凭什么说面板没了"。
 * 所以把这几个量一次打全：卡片判据连续未命中几帧、面板信号连续成立几帧、
 * 阈值各是多少、这一帧的判据原文。
 *
 * 形如：
 *   `卡片判据连续未命中 3/3 帧；面板信号 0/5 帧仍成立（阈值：未命中 3 帧、托底 5 帧）
 *    — 卡片数 0（全是孤立噪声）`
 */
export function panelGateEvidence(
  reading: PanelReading,
  options: { readonly closeFrames?: number; readonly presenceTrustFrames?: number } = {},
): string {
  const closeFrames = options.closeFrames ?? PANEL_CLOSE_CONFIRM_FRAMES;
  const trustFrames = options.presenceTrustFrames ?? PANEL_PRESENCE_TRUST_FRAMES;
  const p = reading.presence;
  return (
    `卡片判据连续未命中 ${reading.misses}/${closeFrames} 帧；` +
    `面板信号 ${reading.presenceHolds}/${trustFrames} 帧仍成立` +
    `（阈值：未命中 ${closeFrames} 帧、托底 ${trustFrames} 帧；` +
    `面板信号=${p === null ? '未提供' : p.present ? '在' : '不在'}）` +
    ` — ${reading.reason}`
  );
}

/** 无面板信号时用的常量（旧渲染端 / 调用方不想算时显式传它）。 */
export { NO_PANEL_PRESENCE };

