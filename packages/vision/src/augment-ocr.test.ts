/**
 * 海克斯卡面名字 OCR 测试
 *
 * 无法在 CI 里真机截图，所以这里锁三件事：
 *   1. **名字带几何**（卡内 y=0.470、水平居中、不越界）—— 位置错一切皆错；
 *   2. **自洽识别**：拿指纹库里的位图当输入，必须认回同一个名字（分数接近 1）；
 *   3. **宁漏勿错**：空白条 / 噪声条 / 两个同名指纹并存（分差为 0）都要返回 null。
 *
 * 真机标定值（Bold@40 得分 0.62~0.73）记录在 augment-ocr.ts 头注里，
 * 这里不写死具体分数（那会随字体渲染细节漂移），只锁逻辑与余量关系。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUGMENT_NAME_STRIP,
  augmentNameStripRect,
  matchAugmentName,
  readAugmentNameStrip,
  type AugmentNameFingerprint,
} from './augment-ocr.ts';
import { stretchBitsToGrid } from './ocr.ts';
import type { Bitmap, Rect } from './types.ts';

const CARD: Rect = { x: 0.3, y: 0.19, w: 0.124, h: 0.463 };

/** 造一个"名字位图"指纹（画一个矩形笔画，尺寸可变）。 */
function fp(augmentId: number, name: string, w: number, h: number, fill: (x: number, y: number) => boolean): AugmentNameFingerprint {
  const bits = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bits[y * w + x] = fill(x, y) ? 1 : 0;
  return { augmentId, name, width: w, height: h, bits };
}

/** 把指纹当作"识别输入"（模拟真机提取出的条带）：拉伸到网格即可。 */
function stripOfLibrary(f: AugmentNameFingerprint): { bits: Uint8Array; width: number; height: number } {
  const s = stretchBitsToGrid(
    { championId: f.augmentId, name: f.name, width: f.width, height: f.height, bits: f.bits },
    AUGMENT_NAME_STRIP.gridWidth,
    AUGMENT_NAME_STRIP.gridHeight,
  );
  return { bits: s.bits, width: s.width, height: s.height };
}

/** 造一张位图：在卡片的名字带位置画一块白字块。 */
function frameWithNameBlock(): Bitmap {
  const W = 800;
  const H = 450;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 10;
    data[i + 1] = 10;
    data[i + 2] = 10;
    data[i + 3] = 255;
  }
  const r = augmentNameStripRect(CARD);
  const x0 = Math.round((r.x + r.w * 0.25) * W);
  const x1 = Math.round((r.x + r.w * 0.75) * W);
  const y0 = Math.round((r.y + r.h * 0.2) * H);
  const y1 = Math.round((r.y + r.h * 0.8) * H);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      data[i] = 240;
      data[i + 1] = 240;
      data[i + 2] = 240;
    }
  }
  return { width: W, height: H, data };
}

/* ------------------------------------------------------------------ */
/* 几何                                                                */
/* ------------------------------------------------------------------ */

test('名字带：水平居中、纵向以 yCenter 为中心、不越出卡片', () => {
  const r = augmentNameStripRect(CARD);
  assert.ok(Math.abs(r.x + r.w / 2 - (CARD.x + CARD.w / 2)) < 1e-9, '应水平居中');
  assert.ok(
    Math.abs(r.y + r.h / 2 - (CARD.y + CARD.h * AUGMENT_NAME_STRIP.yCenter)) < 1e-9,
    '纵向中心应为 yCenter',
  );
  assert.ok(r.y > CARD.y && r.y + r.h < CARD.y + CARD.h, '应落在卡片内');
  assert.ok(r.w < CARD.w, '两侧要留边距（避开边框发光）');
});

test('名字带：位置在卡片中部，而不是选人卡的下部 0.856（防回退）', () => {
  const r = augmentNameStripRect(CARD);
  const rel = (r.y + r.h / 2 - CARD.y) / CARD.h;
  assert.ok(rel > 0.4 && rel < 0.55, `实测 0.47 附近，实得 ${rel.toFixed(3)}`);
});

/* ------------------------------------------------------------------ */
/* 自洽识别                                                            */
/* ------------------------------------------------------------------ */

test('matchAugmentName：库里的指纹当输入 → 认回同一名字（分数 ~1）', () => {
  const lib = [
    fp(1, '缩小引擎', 60, 20, (x, y) => x % 7 < 3 && y > 2 && y < 18),
    fp(2, '夜狩', 30, 20, (x, y) => y % 5 < 2),
    fp(3, '威能之追求', 80, 20, (x, y) => x % 9 < 4),
  ];
  for (const f of lib) {
    const m = matchAugmentName(stripOfLibrary(f), lib);
    assert.ok(m !== null, `${f.name} 应能认出`);
    assert.equal(m.augmentId, f.augmentId);
    assert.ok(m.score > 0.95, `自洽分数应接近 1，实得 ${m.score}`);
  }
});

test('matchAugmentName：库为空 → null（不抛异常）', () => {
  const f = fp(1, '测试', 40, 20, (x) => x % 3 === 0);
  assert.equal(matchAugmentName(stripOfLibrary(f), []), null);
});

/* ------------------------------------------------------------------ */
/* 宁漏勿错                                                            */
/* ------------------------------------------------------------------ */

test('matchAugmentName：全零条带 → null', () => {
  const lib = [fp(1, '缩小引擎', 60, 20, (x) => x % 5 === 0)];
  const strip = {
    bits: new Uint8Array(AUGMENT_NAME_STRIP.gridWidth * AUGMENT_NAME_STRIP.gridHeight),
    width: AUGMENT_NAME_STRIP.gridWidth,
    height: AUGMENT_NAME_STRIP.gridHeight,
  };
  assert.equal(matchAugmentName(strip, lib), null);
});

test('matchAugmentName：两个一模一样但不同名的指纹 → 分差为 0 → null', () => {
  const same = (id: number, name: string): AugmentNameFingerprint =>
    fp(id, name, 60, 20, (x, y) => (x + y) % 6 < 2);
  const lib = [same(1, '甲名字'), same(2, '乙名字')];
  const strip = stripOfLibrary(same(1, '甲名字'));
  const m = matchAugmentName(strip, lib);
  assert.equal(m, null, '分不开就必须返回 null，不能瞎选一个');
});

test('matchAugmentName：分数够但分差太小 → null（真机出现过近似混淆对）', () => {
  const a = fp(1, '威能之追求', 60, 20, (x, y) => (x + y) % 7 < 3);
  // 与 a 只差一点点：整体右移一列的同类笔画
  const b = fp(2, '急速之追求', 60, 20, (x, y) => (x + y) % 7 < 3 || (x === 0 && y < 19));
  const strip = stripOfLibrary(a);
  // 默认分差会挡住；显式放开分差则能选出 a（证明"挡"来自分差而不是分数）
  assert.equal(matchAugmentName(strip, [a, b]), null);
  const loose = matchAugmentName(strip, [a, b], { minMargin: 0 });
  assert.equal(loose?.augmentId, 1);
});

test('matchAugmentName：分数不足 → null（阈值生效）', () => {
  const lib = [fp(1, '缩小引擎', 60, 20, (x, y) => x % 3 === 0)];
  const noise = {
    bits: Uint8Array.from({ length: AUGMENT_NAME_STRIP.gridWidth * AUGMENT_NAME_STRIP.gridHeight }, (_, i) => (i % 11 === 0 ? 1 : 0)),
    width: AUGMENT_NAME_STRIP.gridWidth,
    height: AUGMENT_NAME_STRIP.gridHeight,
  };
  assert.equal(matchAugmentName(noise, lib), null);
});

/* ------------------------------------------------------------------ */
/* 从位图提取                                                          */
/* ------------------------------------------------------------------ */

test('readAugmentNameStrip：卡面名字带里的白块能被提取到', () => {
  const strip = readAugmentNameStrip(frameWithNameBlock(), CARD);
  assert.ok(strip !== null);
  let ink = 0;
  for (const b of strip.bits) ink += b;
  assert.ok(ink > 0, '应提取到笔画');
});

test('readAugmentNameStrip：整卡全黑 → null（不画）', () => {
  const W = 400;
  const H = 200;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) data[i + 3] = 255; // 全黑
  assert.equal(readAugmentNameStrip({ width: W, height: H, data }, CARD), null);
});
