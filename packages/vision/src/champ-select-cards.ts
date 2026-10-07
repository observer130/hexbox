/**
 * 选人第一阶段「候选卡」的**专用几何与检出**（纯函数，可单测）
 *
 * ── 为什么必须另开一个模块（而不是继续用 `grid.ts` 的 `detectCards`）────────
 *
 * 用户真机日志（打包版）里选人第一阶段有两个肉眼可见的缺陷：
 *
 * 1. `detectCards` 在**选人帧**上极不稳定 —— 同一套「选择你的英雄」界面
 *    （卡片位置逐像素相同），有的帧检出 3 张、有的帧检出 2 张、有的帧
 *    `等宽候选桶均未通过间隙/纵横比校验` 一张都没有：
 *    ```
 *    第一阶段(picking)但未检出卡片: 等宽候选桶均未通过间隙/纵横比校验（共 6 个候选桶）
 *    第一阶段(picking): 卡片 3 张 → 出标签 2 个 [得分/分差 0.52/0.05 拒绝:分数不够(墨迹6%) …]
 *    ```
 *    根因（离线复现，已证实）：`cardsFromBands` 按**宽度 ±2% 聚桶**，而选人卡的
 *    左右边框在真机帧上会与相邻装饰线合并成**不同厚度**的带（左边框 26px、
 *    右边框 36px），于是同一张卡的两个方向量出 473px / 462px（差 2.3%）→
 *    落进两个桶 → 每个桶只有 1 对 → `pairs.length >= 2` 过滤掉 → 0 张。
 *    同一块面板在别的帧里量出 472/467（差 1.1%）→ 成 2 张。**0 与 2 张之间
 *    只差 1.2% 的测量噪声** —— 这就是"识别准确率非常低"的直接来源。
 *
 * 2. 它会**在错的位置**给出 2 张"卡片"：锁定后的第二阶段（大立绘）帧上，
 *    检出的是美术图圆环里的两块区域（`x≈0.3191/0.5432, w≈0.2025, h≈0.61`）。
 *    一旦此时顶栏又恰好读不到占用（`pickState=unknown && 占用=0`），
 *    屏幕上就会出现两个**位置与英雄都对不上**的胜率框。
 *
 * ── 真机标定（2026-10-12，用户帧 + 打包版日志交叉验证）──────────────────
 *
 * 布局是**居中、等宽、等间距**的一行卡片，张数 **2 或 3**（两种都真实出现过）：
 * 日志里第一张卡的 `标签0@(x)` 与卡片宽度（标签与卡片同宽）直接给出几何：
 *
 * | 张数 | 实测（窗口归一化） | 来源 |
 * |---|---|---|
 * | 3 | 卡宽 0.14621、首卡 x 0.25813 | 日志 `标签0@(760,…) w=233.93`（窗口 1600×900，x=347） |
 * | 2 | 卡宽 0.14591、首卡 x 0.34188 | 日志 `标签0@(894,…) w=233.46` |
 * | 2 | 卡宽 0.14562、首卡 x 0.34161 | `debug/shots/champselect-*-raw.png` 边框带外缘 1166..1663 |
 *
 * 两者用同一套常数（卡宽 0.1459、中心距 0.1686、居中排布）复现：
 * 3 张 → 首卡 0.25845（实测 0.25813，差 0.5 DIP）、2 张 → 首卡 0.34275
 * （实测 0.34188，差 1.4 DIP）。纵向 477..1277 / 1920 → `top=0.2484, h=0.4167`。
 *
 * ── 判据（同一套通用判据能不能稳定检出 3 张卡：能，但**不是**"内部暗"）────
 *
 * 逐帧量测（`debug/cards-check/criteria-probe.txt`，正样本 6 帧 / 负样本 6 帧）：
 *
 * | 判据 | 正样本（真候选卡） | 负样本（第二阶段大立绘 / 局内海克斯面板） |
 * |---|---|---|
 * | 四条边框"亮线 vs 卡外背景"亮度差 | 最小单边 **16.2**，四边和 **156~231** | 单边 ≤ 8；局内面板只有一条边亮（另三边 ≈0） |
 * | 卡内平均亮度（"内部暗"） | 48.7~73.3（**立绘可以很亮**） | 39.7~117.9（与正样本**重叠**） |
 *
 * 结论（如实记录）：**"内部暗"这条判据对候选卡无效** —— 候选卡里是英雄立绘
 * （火男、K'Sante 之类的亮卡），平均亮度与第二阶段的整屏立绘重叠；只有
 * **"四条边框都在、且都比卡外背景亮"** + **严格按标定布局取位**才能把
 * 两种界面分开。所以本模块只用边框判据，并且**不**退化成自由搜索：
 * 先在标定位置附近 ±0.5% 内吸附边框线（把布局误差吃掉），再要求
 * **每一张卡的四条边全部达标**（全有或全无，绝不给部分结果）。
 *
 * ⚠️ 宁可不画：任何一张卡不达标 → 整个假设作废；两个假设（3 张、2 张）
 * 都不过 → 返回 0 张，调用方按既有约定清空标签。
 *
 * ⚠️ 本模块**不做**窗口/显示器形态换算：`region` 是"游戏窗口在截屏里的
 * 归一化矩形"，由调用方用 `windowRectToCapture({0,0,1,1}, …)` 给出
 * （窗口快照形态下它就是恒等 0,0,1,1）。返回值是**窗口归一化**矩形，
 * 与 `cardLabelFor` / `topBarSlotRects` 同一坐标系。
 */

import type { Bitmap, Rect } from './types.ts';

/**
 * 选人候选卡布局（**窗口归一化**）。
 *
 * 真机交叉标定：`3413×1920`（窗口快照，窗口 1600×900@347,6）与
 * `2393×1347` 两套帧 + 打包版日志里 2 张/3 张两种排布的标签坐标。
 */
export const CHAMP_SELECT_CARD_LAYOUT = {
  /** 单张卡的宽度（占窗口宽）。 */
  cardWidth: 0.1459,
  /** 单张卡的高度（占窗口高）。 */
  cardHeight: 0.4167,
  /** 卡片上缘（占窗口高）。 */
  top: 0.2484,
  /** 相邻卡片中心距（占窗口宽）→ 间隙 = pitch - cardWidth。 */
  pitch: 0.1686,
} as const;

export const CHAMP_SELECT_CARD_THRESHOLDS = {
  /**
   * 边框吸附的搜索半径（占窗口宽/高）。
   *
   * 0.005 ≈ 真机 3413px 帧上的 17px：足以吃掉"居中偏差 + 探针误差"
   * （实测最大 5px），又不至于吸到美术图里的亮线上去。
   */
  edgeSearch: 0.005,
  /**
   * "可见外缘"的口径（见 `snapEdge`）：从象牙白高光峰往卡外退，
   * 退到亮度 = 背景 + 这个比例 ×（峰值 − 背景）为止。
   *
   * 取值由**真机识别率**扫描定（`debug/cards-check/sweep.mts`，6 帧/12 张卡；
   * 目视真值矩形对照的识别率是 8/12）：
   *
   * | 比例 | 0.15 | 0.20 | 0.25 | **0.30** | **0.35** | **0.40** | 0.50 |
   * |---|---|---|---|---|---|---|---|
   * | OCR 正确 | 4/12 | 4/12 | 7/12 | 10/12 | 10/12 | 10/12 | 10/12 |
   *
   * 0.35 取平台中值。取值偏小（0.15~0.25）时框会整体**缩进**卡片里，
   * 名字带下缘切到卡片底边，识别率立刻掉一半 —— 这条就是"几何差几个像素、
   * 标签还在原位但一个名字都认不出"的真机来源（比错画更常见，也更难查）。
   */
  edgeRampFraction: 0.35,
  /** 单条边框的最小亮度差（正样本 ≥16.2，负样本 ≤8）。 */
  minBorderDelta: 14,
  /** 四条边框亮度差之和的下限（正样本 156~231，负样本 ≤55）。 */
  minBorderSum: 90,
  /** 至少几张才算一批（选人界面实测 2 或 3 张）。 */
  minCards: 2,
  /** 最多几张（3 = 游戏给出的上限）。 */
  maxCards: 3,
} as const;

/* ------------------------------------------------------------------ */
/* 布局 → 矩形                                                         */
/* ------------------------------------------------------------------ */

/**
 * 按标定布局生成 `count` 张卡的矩形（窗口归一化，整体水平居中）。
 *
 * 居中口径由真机验证：2 张卡外缘 1166..2240（中心 1703，窗口中心 1706.5）；
 * 3 张卡时日志给出首卡 x=413 DIP（本函数 413.5）。
 */
export function champSelectCardRects(
  count: number,
  layout: {
    readonly cardWidth: number;
    readonly cardHeight: number;
    readonly top: number;
    readonly pitch: number;
  } = CHAMP_SELECT_CARD_LAYOUT,
): Rect[] {
  const n = Math.max(0, Math.trunc(count));
  if (n === 0) return [];
  const gap = layout.pitch - layout.cardWidth;
  const total = n * layout.cardWidth + (n - 1) * gap;
  const left = (1 - total) / 2;
  const rects: Rect[] = [];
  for (let i = 0; i < n; i++) {
    rects.push({
      x: left + i * layout.pitch,
      y: layout.top,
      w: layout.cardWidth,
      h: layout.cardHeight,
    });
  }
  return rects;
}

/* ------------------------------------------------------------------ */
/* 位图采样                                                            */
/* ------------------------------------------------------------------ */

/** 亮度（Rec.601），与 `grid.ts` 同一口径。 */
function lumaAt(data: Uint8ClampedArray, width: number, x: number, y: number): number {
  const i = (y * width + x) * 4;
  return 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
}

/** 中位数（空数组 → NaN，调用方据此判"取不到样"）。 */
function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  return values.length % 2 === 1
    ? values[mid]!
    : (values[mid - 1]! + values[mid]!) / 2;
}

/** 采样一个小矩形区域的全部像素亮度（越界部分自动裁剪，x/y 顺序无所谓）。 */
function sampleRect(
  bmp: Bitmap,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): number[] {
  const ax0 = Math.max(0, Math.round(Math.min(x0, x1)));
  const ax1 = Math.min(bmp.width, Math.round(Math.max(x0, x1)));
  const ay0 = Math.max(0, Math.round(Math.min(y0, y1)));
  const ay1 = Math.min(bmp.height, Math.round(Math.max(y0, y1)));
  const out: number[] = [];
  for (let y = ay0; y < ay1; y++) {
    for (let x = ax0; x < ax1; x++) out.push(lumaAt(bmp.data, bmp.width, x, y));
  }
  return out;
}

/** 一条边的量测结果。 */
export interface ChampSelectCardEdge {
  /** 边框亮线 − 卡外背景（0~255 亮度空间）。 */
  readonly delta: number;
  /** 吸附到的偏移（像素，正 = 向右/向下）。 */
  readonly offsetPx: number;
}

export interface ChampSelectCardProbe {
  readonly index: number;
  /** 吸附后的矩形（窗口归一化）。 */
  readonly rect: Rect;
  readonly left: ChampSelectCardEdge;
  readonly right: ChampSelectCardEdge;
  readonly top: ChampSelectCardEdge;
  readonly bottom: ChampSelectCardEdge;
  /** 四条边亮度差之和（负值说明根本不像卡）。 */
  readonly sum: number;
  /** 四条边里的最小值（短板）。 */
  readonly minEdge: number;
  readonly ok: boolean;
}

export interface ChampSelectCardsResult {
  /** 检出结果（窗口归一化）；空 = 这一帧不画。 */
  readonly cards: readonly Rect[];
  readonly confident: boolean;
  /** 人读原因（诊断行会带上它）。 */
  readonly reason: string;
  /** 假设的张数（0 = 两个假设都没过）。 */
  readonly count: number;
  /** 逐卡量测（诊断用；即使判定失败也保留，便于复盘"为什么没检出"）。 */
  readonly probes: readonly ChampSelectCardProbe[];
}

export interface DetectChampSelectCardsOptions {
  /**
   * 游戏窗口在**截屏**里的归一化矩形。
   *
   * 默认 `{x:0,y:0,w:1,h:1}`（窗口快照形态 = 截屏就是窗口内容）。
   * 显示器快照形态下由调用方用 `windowRectToCapture({0,0,1,1}, …)` 给出。
   */
  readonly region?: Rect;
  /** 尝试的张数（默认从大到小：3、2）。 */
  readonly counts?: readonly number[];
  readonly layout?: {
    readonly cardWidth: number;
    readonly cardHeight: number;
    readonly top: number;
    readonly pitch: number;
  };
  readonly thresholds?: Partial<typeof CHAMP_SELECT_CARD_THRESHOLDS>;
}

/**
 * 一条边的"垂直亮度剖面"取样点（沿边的另一个方向取中位数，抗噪）。
 *
 * @param at 采样位置（像素，在剖面的变化轴上）
 */
function edgeProfile(
  bmp: Bitmap,
  side: 'left' | 'right' | 'top' | 'bottom',
  at: number,
  span0: number,
  span1: number,
  scale: number,
): number {
  const half = Math.max(1, Math.round(scale * 0.001));
  return side === 'left' || side === 'right'
    ? median(sampleRect(bmp, at - half, at + half + 1, span0, span1))
    : median(sampleRect(bmp, span0, span1, at - half, at + half + 1));
}

/**
 * 在期望位置附近吸附边框线，并取到**视觉外缘**。
 *
 * 为什么不能只取"亮线峰值"（真机实测的坑）：选人卡的边框是**双描边** ——
 * 外侧一条软描边（亮度从背景缓升，占 12~16px）+ 内侧一条锐利象牙白高光
 * （峰值 180~220）。直接取峰值会把每条边都往卡内缩 ~13px，四边加起来整框
 * 小 5%（标签窄 12 DIP、名字带上移 8px）。真机左边缘剖面（y=900）：
 * `…1160:17 1161:14 1162:10 1164:23 1166:49 1170:70 1175:73 1179:164 1183:88 1185:64…`
 * —— 背景 18、软描边爬升段 1164~1176、高光峰 1179。
 *
 * 所以口径是：**先找高光峰（= 这条边确实存在），再沿剖面往卡外退到
 * "亮度回到背景 + 30% 峰值"的那一点**，那一点就是卡片可见的外缘。
 * 实测该口径把四边都定在目视真值 ±3px 内（见 `debug/cards-check/replay-out.txt`）。
 */
function snapEdge(
  bmp: Bitmap,
  side: 'left' | 'right' | 'top' | 'bottom',
  expected: number,
  span0: number,
  span1: number,
  scale: number,
  searchPx: number,
  th: typeof CHAMP_SELECT_CARD_THRESHOLDS,
): ChampSelectCardEdge {
  const outward = side === 'left' || side === 'top' ? -1 : 1;
  const step = 1;
  const positions: number[] = [];
  for (let off = -searchPx; off <= searchPx; off += step) positions.push(expected + off);
  const prof = positions.map((at) => edgeProfile(bmp, side, at, span0, span1, scale));
  const finite = prof.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { delta: 0, offsetPx: 0 };

  // 背景 = 剖面**最靠外**那一端的取值（卡外永远是背景）
  const outerCount = Math.max(1, Math.round(positions.length * 0.25));
  const outerVals = outward < 0 ? prof.slice(0, outerCount) : prof.slice(-outerCount);
  const bg = median(outerVals.filter((v) => Number.isFinite(v)));

  // 高光峰
  let peakIdx = 0;
  for (let i = 1; i < prof.length; i++) {
    if ((prof[i] ?? Number.NEGATIVE_INFINITY) > (prof[peakIdx] ?? Number.NEGATIVE_INFINITY)) {
      peakIdx = i;
    }
  }
  const peak = prof[peakIdx] ?? bg;
  const delta = peak - bg;
  if (!Number.isFinite(delta) || delta <= 0) return { delta: 0, offsetPx: 0 };

  // 从峰往卡外退：最后一个仍 ≥ 背景 + 30% 峰值的位置 = 可见外缘
  const cut = bg + th.edgeRampFraction * delta;
  let edgeIdx = peakIdx;
  for (let i = peakIdx; outward < 0 ? i >= 0 : i < prof.length; i += outward) {
    if ((prof[i] ?? Number.NEGATIVE_INFINITY) >= cut) edgeIdx = i;
  }
  return { delta, offsetPx: (positions[edgeIdx] ?? expected) - expected };
}

/**
 * 一站式的"选人候选卡"检出。
 *
 * @param bmp 截屏位图（RGBA）
 * @param options.region 游戏窗口在截屏里的归一化矩形（默认整幅 = 窗口快照）
 *
 * 步骤（每一步都可单测）：
 *   1. 按标定布局生成 `counts`（默认 3、2）张卡的期望矩形；
 *   2. 每条边在 ±`edgeSearch` 内吸附到最亮的边框线（同时吃掉布局误差）；
 *   3. 四边都过 `minBorderDelta`、且和过 `minBorderSum` → 这张卡成立；
 *   4. **全部**卡成立才算这个假设可信（绝不给部分结果）；
 *   5. 依次尝试，返回第一个成立的假设；都不成立 → 0 张 + 原因。
 */
export function detectChampSelectCards(
  bmp: Bitmap,
  options: DetectChampSelectCardsOptions = {},
): ChampSelectCardsResult {
  const th = { ...CHAMP_SELECT_CARD_THRESHOLDS, ...(options.thresholds ?? {}) };
  const layout = options.layout ?? CHAMP_SELECT_CARD_LAYOUT;
  const region = options.region ?? { x: 0, y: 0, w: 1, h: 1 };
  if (bmp.width === 0 || bmp.height === 0) {
    return { cards: [], confident: false, reason: '位图为空', count: 0, probes: [] };
  }
  if (region.w <= 0 || region.h <= 0) {
    return { cards: [], confident: false, reason: '窗口区域非法', count: 0, probes: [] };
  }

  const counts = (options.counts ?? [3, 2]).filter(
    (n) => n >= th.minCards && n <= th.maxCards,
  );
  if (counts.length === 0) {
    return { cards: [], confident: false, reason: '候选张数配置非法', count: 0, probes: [] };
  }

  const winW = region.w * bmp.width;
  const winH = region.h * bmp.height;
  const toPxX = (n: number): number => (region.x + n * region.w) * bmp.width;
  const toPxY = (n: number): number => (region.y + n * region.h) * bmp.height;
  const searchX = Math.max(1, Math.round(th.edgeSearch * winW));
  const searchY = Math.max(1, Math.round(th.edgeSearch * winH));

  let lastReason = '';
  for (const count of counts) {
    const expected = champSelectCardRects(count, layout);
    const probes: ChampSelectCardProbe[] = [];
    for (let i = 0; i < expected.length; i++) {
      const r = expected[i]!;
      // 期望矩形的像素位置（窗口归一化 → 截屏像素）
      const lx = toPxX(r.x);
      const rx = toPxX(r.x + r.w);
      const ty = toPxY(r.y);
      const by = toPxY(r.y + r.h);
      const halfW = (rx - lx) / 2;
      const halfH = (by - ty) / 2;
      // 采样只用边的中间 60%，避开圆角与装饰
      const sx0 = lx + halfW * 0.2;
      const sx1 = lx + halfW * 1.8;
      const sy0 = ty + halfH * 0.2;
      const sy1 = ty + halfH * 1.8;
      const left = snapEdge(bmp, 'left', lx, sy0, sy1, winW, searchX, th);
      const right = snapEdge(bmp, 'right', rx, sy0, sy1, winW, searchX, th);
      const top = snapEdge(bmp, 'top', ty, sx0, sx1, winH, searchY, th);
      const bottom = snapEdge(bmp, 'bottom', by, sx0, sx1, winH, searchY, th);
      const sum = left.delta + right.delta + top.delta + bottom.delta;
      const minEdge = Math.min(left.delta, right.delta, top.delta, bottom.delta);
      const ok = minEdge >= th.minBorderDelta && sum >= th.minBorderSum;
      // 吸附结果换算回**窗口归一化**（吸附量是像素 → 除以窗口在该轴的像素宽）
      const snapped: Rect = {
        x: r.x + left.offsetPx / winW,
        y: r.y + top.offsetPx / winH,
        w: r.w + (right.offsetPx - left.offsetPx) / winW,
        h: r.h + (bottom.offsetPx - top.offsetPx) / winH,
      };
      probes.push({ index: i, rect: snapped, left, right, top, bottom, sum, minEdge, ok });
    }
    const failed = probes.filter((p) => !p.ok);
    const detail = probes
      .map(
        (p) =>
          `#${p.index}[${p.ok ? '过' : '不过'} Δ${Math.round(p.left.delta)}/` +
          `${Math.round(p.right.delta)}/${Math.round(p.top.delta)}/${Math.round(p.bottom.delta)}` +
          ` 和${Math.round(p.sum)}]`,
      )
      .join(' ');
    if (failed.length === 0) {
      return {
        cards: probes.map((p) => p.rect),
        confident: true,
        reason:
          `选人候选卡 ${count} 张（标定布局，边框判据全过）：${detail}`,
        count,
        probes,
      };
    }
    lastReason = `${count} 张假设未通过：${detail}`;
  }
  return {
    cards: [],
    confident: false,
    reason: `选人候选卡未检出（${lastReason || '无可用假设'}）—— 宁可不画`,
    count: 0,
    probes: [],
  };
}

/* ------------------------------------------------------------------ */
/* 开关：几何 / 老检出器 / 关                                          */
/* ------------------------------------------------------------------ */

/**
 * 第一阶段卡片检出的来源。
 *
 * · `geometry`（默认）—— 本模块的标定布局 + 边框判据；
 * · `legacy` —— 旧的 `detectCards`（自由搜索 + ±2% 等宽聚桶）。
 *   ⚠️ 已知在选人帧上不稳定（0/2/3 张之间抖动），且在第二阶段大立绘帧上
 *   会给出**位置错误**的 2 个矩形；只作为对照/兜底开关保留。
 * · `off` —— 一张都不画（只由顶栏出标签）。
 */
export type ChampSelectCardMode = 'geometry' | 'legacy' | 'off';

/** 解析 `HEXBOX_CHAMP_SELECT_CARDS`（默认 `geometry`；未知值按默认）。 */
export function champSelectCardMode(value: string | null | undefined): ChampSelectCardMode {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'legacy' || v === 'old' || v === 'detectcards') return 'legacy';
  if (v === 'off' || v === '0' || v === 'false' || v === 'none') return 'off';
  return 'geometry';
}

export interface ChampSelectCardChoice {
  readonly cards: readonly Rect[];
  readonly confident: boolean;
  readonly source: 'geometry' | 'legacy' | 'none';
  /** 人读原因（诊断行直接带上它，用户据此判断"为什么没画/画的是哪套几何"）。 */
  readonly reason: string;
}

/**
 * 按开关挑这一轮用哪套卡片矩形。
 *
 * ⚠️ `geometry` 模式下**不会**自动回退到 `legacy`：旧检出器的假阳性正是
 * 这次要修的东西（"绝不允许画在错位置"），漏画只是少一次标注。
 */
export function chooseChampSelectCards(input: {
  readonly mode: ChampSelectCardMode;
  readonly geometric: ChampSelectCardsResult;
  readonly legacy: {
    readonly cards: readonly Rect[];
    readonly confident: boolean;
    readonly reason?: string | undefined;
  };
  readonly minCards?: number;
}): ChampSelectCardChoice {
  const minCards = input.minCards ?? CHAMP_SELECT_CARD_THRESHOLDS.minCards;
  if (input.mode === 'off') {
    return {
      cards: [],
      confident: false,
      source: 'none',
      reason: '第一阶段卡片检出已关闭（HEXBOX_CHAMP_SELECT_CARDS=off）→ 只出顶栏标签',
    };
  }
  if (input.mode === 'legacy') {
    const ok = input.legacy.confident && input.legacy.cards.length >= minCards;
    return {
      cards: ok ? input.legacy.cards : [],
      confident: ok,
      source: ok ? 'legacy' : 'none',
      reason: `旧检出器（HEXBOX_CHAMP_SELECT_CARDS=legacy）：${input.legacy.reason ?? '?'}`,
    };
  }
  return {
    cards: input.geometric.cards,
    confident: input.geometric.confident,
    source: input.geometric.confident ? 'geometry' : 'none',
    reason: input.geometric.reason,
  };
}
