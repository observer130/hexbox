/**
 * 识别核心（`augment-recognize.ts`）测试 —— 以前这段代码只长在渲染端 worker 里，
 * `pnpm test` **一行都碰不到**（只有真机才能验）。
 *
 * 覆盖的是"编排"而不是"判据"：判据（门控/OCR/指纹/矩形来源）都由各自带单测的纯函数
 * 提供，这里锁的是把它们串起来时那些**只有真机才会暴露**的规则：
 *   · 整批识别推进冻结几何，重随重识别**一个字都不改**；
 *   · 指纹只在门控画布上算、取样矩形取"当前门控帧检出的卡片"；
 *   · 失败路径必须把已冻结的几何/指纹**原样回传**（否则主进程的基线会被清掉）；
 *   · 认不准/查不到 → `augmentId: null`（调用方清标签），绝不编一个 id。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectAugmentPanelInRegions, type PanelCard } from './augment-panel.ts';
import { augmentNameStripRect, readAugmentNameStrip, type AugmentNameFingerprint } from './augment-ocr.ts';
import {
  bitmapPixels,
  describeRectShift,
  recognizeOpen,
  recognizeReroll,
  REROLL_RECT_SHIFT_TOLERANCE,
} from './augment-recognize.ts';
import type { Bitmap, Rect } from './types.ts';

const W = 800;
const H = 450;

/** 实测卡片几何（与 `augment-panel.test.ts` 同源）：3 张等宽卡横排在屏幕中部。 */
const CARD_XS = [0.298, 0.441, 0.584] as const;
const CARD_W = 0.115;
const CARD_Y = 0.2;
const CARD_H = 0.36;
const CARDS: readonly Rect[] = CARD_XS.map((x) => ({ x, y: CARD_Y, w: CARD_W, h: CARD_H }));

function blank(v: number): Bitmap {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { width: W, height: H, data };
}

function putPx(bmp: Bitmap, x: number, y: number, v: number): void {
  if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return;
  const i = (y * bmp.width + x) * 4;
  bmp.data[i] = v;
  bmp.data[i + 1] = v;
  bmp.data[i + 2] = v;
  bmp.data[i + 3] = 255;
}

function fill(bmp: Bitmap, r: Rect, v: number): void {
  const x0 = Math.round(r.x * W);
  const y0 = Math.round(r.y * H);
  const x1 = Math.round((r.x + r.w) * W);
  const y1 = Math.round((r.y + r.h) * H);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) putPx(bmp, x, y, v);
}

/** 画一张卡：内部暗、边框亮（门控判据要的正是"内部暗 + 边框−内部够大"）。 */
function drawCard(bmp: Bitmap, r: Rect, interior = 25, edge = 200, thickness = 6): void {
  fill(bmp, r, edge);
  fill(
    bmp,
    {
      x: r.x + thickness / W,
      y: r.y + thickness / H,
      w: r.w - (2 * thickness) / W,
      h: r.h - (2 * thickness) / H,
    },
    interior,
  );
}

/**
 * 在卡片的名字带里画一个**可区分**的白色图案（模拟卡面名字）。
 *
 * `pattern` 是一串横向占位（0~1），每个位置画一根竖条 —— 两串差别越大，
 * 指纹的 Jaccard 距离越大（识别靠的就是这个）。
 */
function paintName(bmp: Bitmap, card: Rect, pattern: readonly number[]): void {
  const strip = augmentNameStripRect(card);
  fill(bmp, { ...strip, x: strip.x - 0.002, w: strip.w + 0.004 }, 20); // 名字底（深色）
  const x0 = Math.round(strip.x * W);
  const y0 = Math.round(strip.y * H);
  const sw = Math.round(strip.w * W);
  const sh = Math.round(strip.h * H);
  const barW = Math.max(2, Math.round(sw * 0.08));
  for (const p of pattern) {
    const bx = x0 + Math.round(p * (sw - barW));
    for (let y = y0; y < y0 + sh; y++) for (let x = bx; x < bx + barW; x++) putPx(bmp, x, y, 255);
  }
}

/** 一张"有面板 + 三张卡名字各不相同"的原生帧。 */
function makeFrameWithNames(patterns: readonly (readonly number[])[]): Bitmap {
  const bmp = blank(120);
  CARDS.forEach((r, i) => {
    drawCard(bmp, r);
    const p = patterns[i];
    if (p) paintName(bmp, r, p);
  });
  return bmp;
}

/** 指纹库：用**同一个 `readAugmentNameStrip`** 从图案上算（与构建期脚本同规格）。 */
function libraryFrom(bmp: Bitmap, patterns: readonly (readonly number[])[]): AugmentNameFingerprint[] {
  return CARDS.map((r, i) => {
    const strip = readAugmentNameStrip(bmp, r);
    assert.ok(strip, `卡${i + 1} 没读出名字位图`);
    return { augmentId: 100 + i, name: `测试海克斯${i + 1}`, width: strip.width, height: strip.height, bits: strip.bits };
  }).filter((_, i) => patterns[i] !== undefined);
}

const PATTERNS: readonly (readonly number[])[] = [
  [0.02, 0.3, 0.62],
  [0.12, 0.44, 0.86],
  [0.05, 0.2, 0.5, 0.8],
];

/** 门控帧（1/3 分辨率）检出的卡片：这里用同一批矩形（数量对上即可）。 */
function gatingCards(rects: readonly Rect[] = CARDS): PanelCard[] {
  return rects.map((rect) => ({ rect, interiorLuma: 28, edgeLuma: 120 }));
}

/* ------------------------------------------------------------------ */
/* 整批识别（开边沿）                                                   */
/* ------------------------------------------------------------------ */

test('recognizeOpen：原生重检命中 → 逐卡认名字 + 冻结几何/指纹', () => {
  const native = makeFrameWithNames(PATTERNS);
  const library = libraryFrom(native, PATTERNS);
  assert.equal(library.length, 3);

  const out = recognizeOpen({
    pixels: bitmapPixels(native),
    regions: [{ x: 0.12, y: 0.1, w: 0.76, h: 0.66 }],
    library,
    gatingCards: gatingCards(),
    fingerprintBasis: { bitmap: native, rects: CARDS },
    frozenRects: null,
    watchRects: null,
    fingerprints: [],
    tookMs: 42,
  });

  assert.equal(out.report.ok, true, out.report.reason);
  assert.equal(out.report.origin, 'open');
  assert.equal(out.report.width, W);
  assert.equal(out.report.height, H);
  assert.equal(out.note, null);
  assert.equal(out.report.cards.length, 3);
  // 每张卡都认成自己那一颗（分数应当很高：图案与指纹同源）
  assert.deepEqual(
    out.report.cards.map((c) => c.augmentId),
    [100, 101, 102],
  );
  for (const c of out.report.cards) {
    assert.ok((c.score ?? 0) > 0.9, `分数太低：${c.score}`);
    assert.ok((c.margin ?? 0) > 0.03, `分差太低：${c.margin}`);
  }
  // 冻结几何：卡片矩形 = 这一批报告的 rect；取样矩形 = 当前门控帧检出的卡片矩形
  assert.deepEqual(out.frozenRects, out.report.cards.map((c) => c.rect));
  assert.equal(out.watchRects?.length, 3);
  // 指纹在**门控画布**上算 → 每张卡都有一份
  assert.equal(out.fingerprints.length, 3);
  assert.ok(out.fingerprints.every((f) => f !== null && f.parts.length > 0));
});

test('recognizeOpen：原生重检不通过但门控验过 3 张 → 用门控矩形兜底（并留下一行日志）', () => {
  // 只画卡片、不画面板外的结构，并把"原生帧"换成一张**亮屏**（重检必然失败）
  const bright = blank(200);
  const out = recognizeOpen({
    pixels: bitmapPixels(bright),
    regions: [{ x: 0.12, y: 0.1, w: 0.76, h: 0.66 }],
    library: [],
    gatingCards: gatingCards(),
    fingerprintBasis: { bitmap: bright, rects: CARDS },
    frozenRects: null,
    watchRects: null,
    fingerprints: [],
    tookMs: 30,
  });
  assert.equal(out.report.ok, true, out.report.reason);
  assert.equal(out.report.cards.length, 3, '应当用门控矩形兜底识别');
  assert.ok(out.note !== null && out.note.includes('门控'), `缺兜底日志：${out.note}`);
  // 空库 → 一张都认不出，但**不许编 id**（调用方据此不画）
  assert.deepEqual(
    out.report.cards.map((c) => c.augmentId),
    [null, null, null],
  );
});

test('recognizeOpen：两边都没有卡片 → 未命中，且已冻结的几何/指纹**原样回传**', () => {
  const frozen: Rect[] = [{ x: 0.1, y: 0.1, w: 0.1, h: 0.2 }];
  const watch: Rect[] = [{ x: 0.2, y: 0.2, w: 0.1, h: 0.2 }];
  const out = recognizeOpen({
    pixels: bitmapPixels(blank(180)),
    regions: [{ x: 0.12, y: 0.1, w: 0.76, h: 0.66 }],
    library: [],
    gatingCards: [], // 门控也没验过卡片
    fingerprintBasis: { bitmap: null, rects: null },
    frozenRects: frozen,
    watchRects: watch,
    fingerprints: [],
    tookMs: 12,
  });
  assert.equal(out.report.ok, false);
  assert.deepEqual(out.report.cards, []);
  assert.equal(out.frozenRects, frozen, '失败路径不许动已冻结的卡片矩形');
  assert.equal(out.watchRects, watch, '失败路径不许动已冻结的取样矩形');
});

test('recognizeOpen：流未就绪 → 未命中（不抛异常）', () => {
  const out = recognizeOpen({
    pixels: null,
    regions: [],
    library: [],
    gatingCards: [],
    fingerprintBasis: { bitmap: null, rects: null },
    frozenRects: null,
    watchRects: null,
    fingerprints: [],
    tookMs: 0,
  });
  assert.equal(out.report.ok, false);
  assert.match(out.report.reason, /流未就绪/);
  assert.equal(out.report.origin, 'open');
});

test('recognizeOpen：门控帧里没有卡片 → 取样矩形被清空（绝不跨面板复用）', () => {
  const native = makeFrameWithNames(PATTERNS);
  const out = recognizeOpen({
    pixels: bitmapPixels(native),
    regions: [{ x: 0.12, y: 0.1, w: 0.76, h: 0.66 }],
    library: libraryFrom(native, PATTERNS),
    gatingCards: gatingCards(),
    fingerprintBasis: { bitmap: native, rects: null }, // 门控这一帧没检出卡片

    frozenRects: null,
    watchRects: null,
    fingerprints: [],
    tookMs: 20,
  });
  assert.equal(out.report.ok, true);
  assert.equal(out.watchRects, null);
  assert.deepEqual(out.fingerprints, []);
});

/* ------------------------------------------------------------------ */
/* 单卡重随重识别                                                       */
/* ------------------------------------------------------------------ */

test('recognizeReroll：只重认指定卡、几何一律用**冻结矩形**、指纹原样沿用', () => {
  // 刷新后的原生帧：卡2 换了名字（图案不同）
  const refreshed: readonly (readonly number[])[] = [PATTERNS[0]!, [0.7, 0.78, 0.9], PATTERNS[2]!];
  const native = makeFrameWithNames(refreshed);
  const library = libraryFrom(makeFrameWithNames(PATTERNS), PATTERNS);
  const fingerprints = [{ parts: [], std: 30 } as never];
  const frozen = CARDS; // 冻结几何 = 上一次整批识别的矩形
  // 本帧检测出来的矩形故意偏一点（翻牌动画中间帧）—— 必须**被忽略**
  const detected = gatingCards(CARDS.map((r) => ({ ...r, y: r.y - 0.02, h: r.h + 0.04 })));

  const out = recognizeReroll({
    pixels: bitmapPixels(native),
    only: [1],
    latestCards: detected,
    frozenRects: frozen,
    library,
    fingerprints,
    tookMs: 55,
  });

  assert.equal(out.report.ok, true);
  assert.equal(out.report.origin, 'reroll');
  assert.deepEqual(out.report.refreshed, [1]);
  assert.equal(out.report.cards.length, 1);
  // 1) 几何用冻结矩形（不是本帧检测到的那个）
  assert.deepEqual(out.report.cards[0]!.rect, frozen[1]);
  // 2) 认出了"刷新后"的名字（图案索引 1 在库里对应 … 我们这里换了图案，
  //    所以要么认不出、要么认成库里最像的那一个 —— 但绝不能是它自己原来的 id）
  assert.notEqual(out.report.cards[0]!.augmentId, 101);
  // 3) 指纹（重随检测的基线）原样沿用，没有重新冻结
  assert.equal(out.report.fingerprints, fingerprints);
  // 4) 返回值里**没有**几何字段：重随路径不许推进冻结几何（改几何 = 整排标签下移）
  assert.deepEqual(Object.keys(out).sort(), ['notes', 'report']);
  // 5) 矩形位移超容差 → 留一行日志（真机复盘用）
  assert.equal(out.notes.length, 1);
  assert.match(out.notes[0]!, /翻牌动画中间帧/);
});

test('recognizeReroll：没有冻结矩形 → 认不出（**不许**用本帧检测矩形兜底）', () => {
  const native = makeFrameWithNames(PATTERNS);
  // 旧实现会退回 `latestCards[0].rect` —— 那正是翻牌动画的中间帧几何。
  // 一旦那样做，OCR 出来的名字会被挂到动画帧的矩形上，并把整排基准带走。
  const withDetected = recognizeReroll({
    pixels: bitmapPixels(native),
    only: [0],
    latestCards: gatingCards(),
    frozenRects: null,
    library: libraryFrom(native, PATTERNS),
    fingerprints: [],
    tookMs: 10,
  });
  assert.equal(withDetected.report.ok, true);
  assert.deepEqual(
    withDetected.report.cards[0]!.rect,
    { x: 0, y: 0, w: 0, h: 0 },
    '没有冻结几何就不画，而不是拿动画帧的矩形顶上',
  );
  assert.equal(withDetected.report.cards[0]!.augmentId, null);
  assert.ok(
    withDetected.notes.some((n) => /没有冻结矩形/.test(n)),
    '跳过这件事要留痕（回放复盘时要能看出"这轮为什么没重认"）',
  );

  const nothing = recognizeReroll({
    pixels: bitmapPixels(native),
    only: [0],
    latestCards: [],
    frozenRects: null,
    library: libraryFrom(native, PATTERNS),
    fingerprints: [],
    tookMs: 10,
  });
  assert.equal(nothing.report.ok, true);
  assert.deepEqual(nothing.report.cards[0]!.rect, { x: 0, y: 0, w: 0, h: 0 });
  assert.equal(nothing.report.cards[0]!.augmentId, null);
});

test('recognizeReroll：流未就绪 → 未命中且带上 refreshed（别被当成整批识别）', () => {
  const out = recognizeReroll({
    pixels: null,
    only: [2],
    latestCards: gatingCards(),
    frozenRects: CARDS,
    library: [],
    fingerprints: [],
    tookMs: 0,
  });
  assert.equal(out.report.ok, false);
  assert.equal(out.report.origin, 'reroll');
  assert.deepEqual(out.report.refreshed, [2]);
  assert.match(out.report.reason, /流未就绪/);
});

test('describeRectShift：容差内不报、超容差才报（只记日志，不改几何）', () => {
  const frozen: Rect = { x: 0.2, y: 0.2, w: 0.1, h: 0.4 };
  const tiny: Rect = { ...frozen, y: frozen.y + REROLL_RECT_SHIFT_TOLERANCE / 2 };
  assert.equal(describeRectShift(0, frozen, tiny), null);
  const big: Rect = { ...frozen, y: frozen.y - 0.02, h: frozen.h + 0.04 };
  const line = describeRectShift(1, frozen, big);
  assert.ok(line !== null);
  assert.match(line, /卡2/);
  assert.match(line, /仍用冻结矩形/);
  assert.equal(describeRectShift(0, frozen, null), null);
});

/* ------------------------------------------------------------------ */
/* 与门控/识别本身的衔接                                                */
/* ------------------------------------------------------------------ */

test('recognizeOpen：原生帧的卡片矩形与门控检测器逐位一致（同一张帧、同一搜索区）', () => {
  const native = makeFrameWithNames(PATTERNS);
  const region = { x: 0.12, y: 0.1, w: 0.76, h: 0.66 };
  const out = recognizeOpen({
    pixels: bitmapPixels(native),
    regions: [region],
    library: [],
    gatingCards: [],
    fingerprintBasis: { bitmap: null, rects: null },
    frozenRects: null,
    watchRects: null,
    fingerprints: [],
    tookMs: 1,
  });
  const direct = detectAugmentPanelInRegions(native, [region]).detection;
  assert.equal(direct.found, true, direct.reason);
  assert.deepEqual(
    out.report.cards.map((c) => c.rect),
    direct.cards.map((c) => c.rect),
  );
  assert.deepEqual(
    out.report.cards.map((c) => c.interiorLuma),
    direct.cards.map((c) => Math.round(c.interiorLuma)),
  );
});
