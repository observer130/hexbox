/**
 * grid 测试
 *
 * 用**合成位图**验证检测逻辑：在暗背景上画「亮边框」卡片
 * （真实选人卡片边框是象牙白双描边 —— 亮度特征，不是金色）。
 *
 * ⚠️ 历史教训（勿回退）：最初版本用「金色检测」（R-B 色差），
 * 真实截图上边框是去饱和象牙白（RGB≈150,143,138，R-B≈15），
 * 一个卡片都检不出来。现行算法用**亮度垂直梯度**（暗底上的亮竖线），
 * 与色相无关。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Bitmap } from './types.ts';
import {
  cardsFromBands,
  detectCards,
  edgeColumnProjection,
  findBands,
  toCardSlots,
  type Band,
} from './grid.ts';

/* ------------------------------------------------------------------ */
/* 合成位图工具                                                        */
/* ------------------------------------------------------------------ */

function blankBitmap(width: number, height: number): Bitmap {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function setPx(bmp: Bitmap, x: number, y: number, v: number): void {
  if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return;
  const i = (y * bmp.width + x) * 4;
  bmp.data[i] = v;
  bmp.data[i + 1] = v;
  bmp.data[i + 2] = v;
  bmp.data[i + 3] = 255;
}

/**
 * 画一张「亮边框卡片」：暗底 + 亮竖线（左右边框）+ 亮横线（上下边框）。
 * w×h 是卡片外框尺寸；边框厚 thickness（默认 13，模拟真实双描边结构）。
 */
function drawCard(
  bmp: Bitmap,
  x: number,
  y: number,
  w: number,
  h: number,
  brightness = 160,
  thickness = 13,
): void {
  for (let t = 0; t < thickness; t++) {
    for (let j = y; j < y + h; j++) {
      setPx(bmp, x + t, j, brightness);
      setPx(bmp, x + w - 1 - t, j, brightness);
    }
    for (let i = x; i < x + w; i++) {
      setPx(bmp, i, y + t, brightness);
      setPx(bmp, i, y + h - 1 - t, brightness);
    }
  }
}

/** 造一条边框带。 */
function band(start: number, end: number): Band {
  return { start, end, center: Math.round((start + end) / 2), strength: 100 };
}

/* ------------------------------------------------------------------ */
/* 列投影 / 带提取                                                      */
/* ------------------------------------------------------------------ */

test('edgeColumnProjection：亮竖线产生计数，暗列不产生', () => {
  const bmp = blankBitmap(100, 60);
  for (let y = 10; y < 50; y++) setPx(bmp, 40, y, 180);

  const proj = edgeColumnProjection(bmp);
  assert.ok(proj[40]! > 20);
  assert.equal(proj[10], 0);
});

test('findBands：合并相邻子线（真实边框是 2~3 条相邻亮线）', () => {
  const proj = new Uint32Array(200);
  // 一条边框由 1166..1201 这样的相邻亮线构成（间隔 < mergeGap）
  const spans: Array<[number, number]> = [[10, 12], [16, 18], [100, 102]];
  for (const [a, b] of spans) {
    for (let x = a; x <= b; x++) proj[x] = 100;
  }
  const bands = findBands(proj, { mergeGap: 6, minPixels: 20 });
  assert.equal(bands.length, 2);
  assert.equal(bands[0]!.start, 10);
  assert.equal(bands[0]!.end, 18);
  assert.equal(bands[1]!.center, 101);
});

test('findBands：绝对下限防噪点（投影最大值过小时不误报）', () => {
  const proj = new Uint32Array(100);
  for (let x = 0; x < 100; x++) proj[x] = 1; // 均匀弱噪
  assert.deepEqual(findBands(proj, { minPixels: 20 }), []);
});

/* ------------------------------------------------------------------ */
/* 等宽等距配对                                                          */
/* ------------------------------------------------------------------ */

test('cardsFromBands：等宽配对 + 纵横比校验通过', () => {
  // 两张卡：宽 500 高 795（比例 1.59），带厚 26
  const bands = [band(1166, 1192), band(1638, 1664), band(1741, 1767), band(2215, 2241)];
  const res = cardsFromBands(bands, 3413, 1920, {}, () => ({ top: 477, bottom: 1269 }));
  assert.equal(res.confident, true, res.reason ?? '');
  assert.equal(res.cards.length, 2);
  assert.ok(Math.abs(res.cards[0]!.x - 1166 / 3413) < 1e-9);
  assert.ok(Math.abs(res.cards[1]!.w - (2241 - 1741 + 1) / 3413) < 1e-9);
});

test('cardsFromBands：带不足 4 条时判为不可信', () => {
  const res = cardsFromBands([band(10, 20), band(30, 40)], 1000, 800);
  assert.equal(res.confident, false);
  assert.match(res.reason ?? '', /边框带太少/);
});

test('cardsFromBands：宽度互不重复（结算界面噪声）判为不可信', () => {
  // 真实案例：结算界面 10 条金线，宽度两两不同
  const lines = [138, 881, 893, 1531, 1690, 1701, 1711, 1719, 3028, 3041];
  const bands = lines.map((c) => band(c, c + 2));
  const res = cardsFromBands(bands, 3413, 1920, {}, () => ({ top: 100, bottom: 800 }));
  assert.equal(res.confident, false);
  assert.match(res.reason ?? '', /噪声|校验/);
});

test('cardsFromBands：周期线（均匀网格）被间隙校验拒绝', () => {
  // 等距线对：宽 250、间隙 250 > 250×0.3 → 拒绝
  const bands = [band(100, 102), band(352, 354), band(604, 606), band(856, 858)];
  const res = cardsFromBands(bands, 2000, 800, {}, () => ({ top: 100, bottom: 500 }));
  assert.equal(res.confident, false);
});

test('cardsFromBands：弧线+卡片拼出的等宽对被纵横比拒绝', () => {
  // 真实案例：卡1(1166..1664) 与 弧线(1741..2241) 恰好构成与真卡同宽的组合 ——
  // 被淘汰的是「纵横比不符」的场景：这里把 extent 返回一个扁矩形。
  const bands = [band(1166, 1192), band(1638, 1664), band(1741, 1767), band(2215, 2241)];
  const res = cardsFromBands(bands, 3413, 1920, {}, () => ({ top: 800, bottom: 1200 }));
  // 高 401 / 宽 499 ≈ 0.80,偏离 1.59 超过容差 → 全部候选被拒
  assert.equal(res.confident, false);
  assert.match(res.reason ?? '', /纵横比|校验/);
});

test('cardsFromBands：无实测纵向范围（extent 返回 null）时判为不可信', () => {
  const bands = [band(100, 120), band(560, 580), band(640, 660), band(1100, 1120)];
  const res = cardsFromBands(bands, 3413, 1920, {}, () => null);
  assert.equal(res.confident, false);
});

/* ------------------------------------------------------------------ */
/* 端到端：合成截屏                                                      */
/* ------------------------------------------------------------------ */

test('detectCards：合成选人界面（2 张卡片）正确检出', () => {
  const bmp = blankBitmap(1706, 960); // 与真机窗口物理尺寸一致
  // 卡片宽 249 高 396（比例 1.59），纵向 238..634。
  // 边框厚 13px：真实边框是「双描边」结构（实测带厚 ~25px @2x），
  // 太薄的合成边框会让行投影分成 4 条细带（与真实 UI 结构不符）。
  drawCard(bmp, 583, 238, 249, 396, 160, 13);
  drawCard(bmp, 870, 238, 249, 396, 160, 13);

  const res = detectCards(bmp);
  assert.equal(res.confident, true, res.reason ?? '');
  assert.equal(res.cards.length, 2);
  const c0 = res.cards[0]!;
  assert.ok(Math.abs(c0.x * bmp.width - 583) < 8, `x=${c0.x * bmp.width}`);
  assert.ok(Math.abs(c0.y * bmp.height - 238) < 10, `y=${c0.y * bmp.height}`);
  assert.ok(Math.abs(c0.h * bmp.height - 396) < 14, `h=${c0.h * bmp.height}`);
});

test('detectCards：空白图判为不可信', () => {
  const bmp = blankBitmap(1000, 800);
  const res = detectCards(bmp);
  assert.equal(res.confident, false);
  assert.equal(res.cards.length, 0);
});

test('detectCards：位图为空时安全返回', () => {
  const res = detectCards({ width: 0, height: 0, data: new Uint8ClampedArray(0) });
  assert.equal(res.confident, false);
  assert.match(res.reason ?? '', /位图为空/);
});

test('detectCards：象牙白边框（低饱和亮色）也能检出 —— 回归防线', () => {
  // 真实边框颜色 RGB≈150,143,138（R-B 差仅 15,金色检测判定不了它）。
  // 该用例锁定「亮度梯度」方案对去饱和亮色边框有效。
  const bmp = blankBitmap(1706, 960);
  const ivory = (x: number, y: number): void => {
    const i = (y * bmp.width + x) * 4;
    bmp.data[i] = 150;
    bmp.data[i + 1] = 143;
    bmp.data[i + 2] = 138;
    bmp.data[i + 3] = 255;
  };
  const card = (x: number, y: number, w: number, h: number): void => {
    const t = 13;
    for (let k = 0; k < t; k++) {
      for (let j = y; j < y + h; j++) {
        ivory(x + k, j);
        ivory(x + w - 1 - k, j);
      }
      for (let i = x; i < x + w; i++) {
        ivory(i, y + k);
        ivory(i, y + h - 1 - k);
      }
    }
  };
  card(500, 240, 250, 397);
  card(790, 240, 250, 397);

  const res = detectCards(bmp);
  assert.equal(res.confident, true, res.reason ?? '');
  assert.equal(res.cards.length, 2);
});

/* ------------------------------------------------------------------ */
/* toCardSlots                                                         */
/* ------------------------------------------------------------------ */

test('toCardSlots：包装为未识别状态', () => {
  const slots = toCardSlots([{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }]);
  assert.equal(slots.length, 1);
  assert.equal(slots[0]!.championId, null);
  assert.equal(slots[0]!.score, 0);
});
