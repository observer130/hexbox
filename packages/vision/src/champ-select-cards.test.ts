/**
 * 选人候选卡几何/检出测试
 *
 * 这些用例锁的是**真机标定出来的常数与判据口径**（改动它们必须同时改
 * `debug/cards-check/replay-out.txt` 的对照结果）：
 *   · 布局：居中一行、卡宽 0.1459、中心距 0.1686、上缘 0.2484、高 0.4167；
 *   · 判据：四边"亮线 vs 卡外背景"全部达标（单边 ≥14、四边和 ≥90）；
 *   · **不判"卡内暗"** —— 真机候选卡里是英雄立绘，亮度与第二阶段立绘重叠；
 *   · 阴性：局内海克斯面板（3 张、另一套布局）/ 大立绘帧 → 一张都不出；
 *   · 全有或全无：任意一张不达标就整个假设作废。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHAMP_SELECT_CARD_LAYOUT,
  champSelectCardMode,
  champSelectCardRects,
  chooseChampSelectCards,
  detectChampSelectCards,
  type ChampSelectCardsResult,
} from './champ-select-cards.ts';
import type { Bitmap, Rect } from './types.ts';

/* ------------------------------------------------------------------ */
/* 合成帧：暗底 + 象牙白双描边（外软描边 + 内高光）= 真机边框结构          */
/* ------------------------------------------------------------------ */

interface FrameSpec {
  readonly width: number;
  readonly height: number;
  readonly cards: readonly Rect[];
  /** 窗口在截屏里的归一化矩形（默认整幅）。 */
  readonly region?: Rect;
  /** 卡内亮度（立绘可以很亮 —— 判据不依赖它）。 */
  readonly inner?: number;
  /** 软描边爬升宽度（像素）。 */
  readonly rampPx?: number;
  /** 软描边平台宽度（像素）—— 真机剖面在峰值前有一段 ~0.4×峰值 的平台。 */
  readonly plateauPx?: number;
  /** 高光宽度（像素）。 */
  readonly highlightPx?: number;
}

function makeFrame(spec: FrameSpec): Bitmap {
  const { width, height } = spec;
  const data = new Uint8ClampedArray(width * height * 4);
  const bg = 18;
  const ramp = spec.rampPx ?? 8;
  const plateau = spec.plateauPx ?? 6;
  const hl = spec.highlightPx ?? 5;
  const plateauLuma = 95;
  const put = (x: number, y: number, v: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, bg);

  const region = spec.region ?? { x: 0, y: 0, w: 1, h: 1 };
  const winW = region.w * width;
  const winH = region.h * height;
  const px = (n: number): number => region.x * width + n * winW;
  const py = (n: number): number => region.y * height + n * winH;

  for (const c of spec.cards) {
    const x0 = Math.round(px(c.x));
    const y0 = Math.round(py(c.y));
    const x1 = Math.round(px(c.x + c.w));
    const y1 = Math.round(py(c.y + c.h));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) put(x, y, spec.inner ?? 40);
    // 四条边：软描边爬升 → 平台 → 象牙白高光（真机的双描边结构）
    for (let k = 0; k < ramp + plateau + hl; k++) {
      const v =
        k < ramp
          ? bg + ((plateauLuma - bg) * (k + 1)) / ramp
          : k < ramp + plateau
            ? plateauLuma
            : 215;
      for (let x = x0 + k; x < x1 - k; x++) {
        put(x, y0 + k, v);
        put(x, y1 - 1 - k, v);
      }
      for (let y = y0 + k; y < y1 - k; y++) {
        put(x0 + k, y, v);
        put(x1 - 1 - k, y, v);
      }
    }
  }
  return { width, height, data };
}

/** 期望矩形 ↔ 检出矩形 的像素偏差（归一化 × 尺寸）。 */
function maxDevPx(a: readonly Rect[], b: readonly Rect[], w: number, h: number): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    const q = b[i]!;
    m = Math.max(
      m,
      Math.abs(p.x - q.x) * w,
      Math.abs(p.y - q.y) * h,
      Math.abs(p.w - q.w) * w,
      Math.abs(p.h - q.h) * h,
    );
  }
  return m;
}

/* ------------------------------------------------------------------ */
/* 布局                                                                */
/* ------------------------------------------------------------------ */

test('布局：2 张 / 3 张都居中，卡宽与中心距是标定值', () => {
  const two = champSelectCardRects(2);
  assert.equal(two.length, 2);
  const L = CHAMP_SELECT_CARD_LAYOUT;
  assert.ok(Math.abs(two[0]!.w - L.cardWidth) < 1e-9);
  assert.ok(Math.abs(two[0]!.h - L.cardHeight) < 1e-9);
  assert.ok(Math.abs(two[0]!.y - L.top) < 1e-9);
  // 中心距
  assert.ok(Math.abs(two[1]!.x - two[0]!.x - L.pitch) < 1e-9);
  // 整体居中：首尾外沿相对窗口中心对称
  const center2 = (two[0]!.x + two[1]!.x + two[1]!.w) / 2;
  assert.ok(Math.abs(center2 - 0.5) < 1e-9, `2 张未居中：${center2}`);

  const three = champSelectCardRects(3);
  assert.equal(three.length, 3);
  const center3 = (three[0]!.x + three[2]!.x + three[2]!.w) / 2;
  assert.ok(Math.abs(center3 - 0.5) < 1e-9, `3 张未居中：${center3}`);
  // 真机标定值：3 张首卡 x ≈ 0.2581（日志 标签0@(760,…) → 窗口 1600 DIP 下 413）
  assert.ok(Math.abs(three[0]!.x - 0.2584) < 0.002, `3 张首卡 x=${three[0]!.x}`);
  // 2 张首卡 x ≈ 0.3426（日志 标签0@(894,…) → 547）
  assert.ok(Math.abs(two[0]!.x - 0.3426) < 0.002, `2 张首卡 x=${two[0]!.x}`);
  assert.deepEqual(champSelectCardRects(0), []);
});

/* ------------------------------------------------------------------ */
/* 检出：正样本                                                        */
/* ------------------------------------------------------------------ */

test('检出：2 张候选卡（合成帧）→ 矩形与标定布局一致', () => {
  const frame = makeFrame({ width: 1600, height: 900, cards: champSelectCardRects(2) });
  const res = detectChampSelectCards(frame);
  assert.equal(res.confident, true, res.reason);
  assert.equal(res.count, 2);
  assert.ok(maxDevPx(champSelectCardRects(2), res.cards, 1600, 900) <= 5, res.reason);
});

test('检出：3 张候选卡（合成帧）→ 不会被 2 张假设抢走', () => {
  const frame = makeFrame({ width: 1600, height: 900, cards: champSelectCardRects(3) });
  const res = detectChampSelectCards(frame);
  assert.equal(res.confident, true, res.reason);
  assert.equal(res.count, 3, res.reason);
  assert.ok(maxDevPx(champSelectCardRects(3), res.cards, 1600, 900) <= 5, res.reason);
});

test('检出：卡内很亮（立绘）也能检出 —— 判据不依赖"内部暗"', () => {
  const bright = makeFrame({
    width: 1600,
    height: 900,
    cards: champSelectCardRects(2),
    inner: 150,
  });
  const res = detectChampSelectCards(bright);
  assert.equal(res.confident, true, `亮卡也必须检出：${res.reason}`);
});

test('检出：窗口只占截屏一部分（显示器快照形态）时按 region 换算', () => {
  const region = { x: 0.15, y: 0.05, w: 0.7, h: 0.9 };
  const frame = makeFrame({
    width: 1600,
    height: 900,
    cards: champSelectCardRects(2),
    region,
  });
  const res = detectChampSelectCards(frame, { region });
  assert.equal(res.confident, true, res.reason);
  assert.equal(res.count, 2);
  // 返回的是**窗口归一化**矩形：偏差按"窗口在截屏里的实际像素尺寸"衡量
  // （吸附偏移是截屏整数像素，窗口只占截屏一部分时同样的偏移折算更大）
  assert.ok(
    maxDevPx(champSelectCardRects(2), res.cards, region.w * 1600, region.h * 900) <= 6,
    res.reason,
  );
});

/* ------------------------------------------------------------------ */
/* 检出：负样本（宁可不画）                                             */
/* ------------------------------------------------------------------ */

test('阴性：局内海克斯面板布局（3 张、更窄更靠上）→ 一张都不出', () => {
  // 真机标定值：x≈0.297/0.440/0.580, w≈0.125, h≈0.49（fusion 面板）
  const panel: Rect[] = [
    { x: 0.2974, y: 0.1776, w: 0.1254, h: 0.4896 },
    { x: 0.4399, y: 0.1776, w: 0.1245, h: 0.4896 },
    { x: 0.5795, y: 0.1776, w: 0.1293, h: 0.4896 },
  ];
  const frame = makeFrame({ width: 1600, height: 900, cards: panel, inner: 30 });
  const res = detectChampSelectCards(frame);
  assert.equal(res.confident, false, `局内面板不得被选人检出器认下：${res.reason}`);
  assert.deepEqual([...res.cards], []);
});

test('阴性：纯背景（无卡）→ 一张都不出', () => {
  const frame = makeFrame({ width: 1200, height: 700, cards: [] });
  const res = detectChampSelectCards(frame);
  assert.equal(res.confident, false);
  assert.deepEqual([...res.cards], []);
});

test('阴性：只有 1 张（假设需要 2~3 张）→ 不出（避免把单个亮框当候选行）', () => {
  const one: Rect[] = [{ x: 0.427, y: 0.2484, w: 0.1459, h: 0.4167 }];
  const frame = makeFrame({ width: 1600, height: 900, cards: one });
  const res = detectChampSelectCards(frame);
  assert.equal(res.confident, false, res.reason);
});

test('全有或全无：3 张里缺 1 张 → 整个假设作废（不给部分结果）', () => {
  const rects = champSelectCardRects(3);
  const frame = makeFrame({ width: 1600, height: 900, cards: [rects[0]!, rects[2]!] });
  const res = detectChampSelectCards(frame);
  assert.equal(res.confident, false, `缺卡不得给出部分结果：${res.reason}`);
  assert.deepEqual([...res.cards], []);
});

test('边界：空位图 / 非法 region → 明确拒绝而不是抛异常', () => {
  const empty: Bitmap = { width: 0, height: 0, data: new Uint8ClampedArray(0) };
  assert.equal(detectChampSelectCards(empty).confident, false);
  const frame = makeFrame({ width: 800, height: 600, cards: champSelectCardRects(2) });
  assert.equal(detectChampSelectCards(frame, { region: { x: 0, y: 0, w: 0, h: 1 } }).confident, false);
});

/* ------------------------------------------------------------------ */
/* 开关                                                                */
/* ------------------------------------------------------------------ */

test('开关 HEXBOX_CHAMP_SELECT_CARDS：默认几何，legacy/off 可显式指定', () => {
  assert.equal(champSelectCardMode(undefined), 'geometry');
  assert.equal(champSelectCardMode(''), 'geometry');
  assert.equal(champSelectCardMode('geometry'), 'geometry');
  assert.equal(champSelectCardMode(' LEGACY '), 'legacy');
  assert.equal(champSelectCardMode('off'), 'off');
  assert.equal(champSelectCardMode('0'), 'off');
  assert.equal(champSelectCardMode('false'), 'off');
  assert.equal(champSelectCardMode('???'), 'geometry', '未知值按默认（不改行为）');
});

const OK2: ChampSelectCardsResult = {
  cards: champSelectCardRects(2),
  confident: true,
  reason: '合成：2 张',
  count: 2,
  probes: [],
};
const FAIL: ChampSelectCardsResult = {
  cards: [],
  confident: false,
  reason: '合成：未检出',
  count: 0,
  probes: [],
};

test('选择来源：几何模式**不**回退旧检出器（旧检出器有假阳性）', () => {
  const legacy = { cards: [{ x: 0.31, y: 0.11, w: 0.2, h: 0.6 }], confident: true };
  // 几何失败 + 旧检出器"成功" → 仍然什么都不画
  const c = chooseChampSelectCards({ mode: 'geometry', geometric: FAIL, legacy });
  assert.equal(c.confident, false);
  assert.equal(c.source, 'none');
  assert.deepEqual([...c.cards], []);
  // 几何成功 → 用几何
  const c2 = chooseChampSelectCards({ mode: 'geometry', geometric: OK2, legacy });
  assert.equal(c2.source, 'geometry');
  assert.equal(c2.cards.length, 2);
});

test('选择来源：legacy 仍可用（对照组），off 一张都不画', () => {
  const legacy = { cards: champSelectCardRects(2), confident: true, reason: '旧检出器' };
  const l = chooseChampSelectCards({ mode: 'legacy', geometric: FAIL, legacy });
  assert.equal(l.source, 'legacy');
  assert.equal(l.cards.length, 2);
  const l2 = chooseChampSelectCards({
    mode: 'legacy',
    geometric: FAIL,
    legacy: { cards: [], confident: false, reason: '未检出' },
  });
  assert.equal(l2.confident, false);
  const o = chooseChampSelectCards({ mode: 'off', geometric: OK2, legacy });
  assert.equal(o.source, 'none');
  assert.deepEqual([...o.cards], []);
  assert.match(o.reason, /已关闭/);
});
