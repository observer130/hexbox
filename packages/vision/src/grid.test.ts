/**
 * grid 测试
 *
 * 用**合成位图**验证检测逻辑：手工画出带金色边框的卡片，
 * 看能否被正确找出。这样不依赖真实截屏即可回归。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Bitmap } from './types.ts';
import {
  cardsFromLines,
  DEFAULT_GOLD,
  detectCards,
  findVerticalLines,
  goldColumnProjection,
  isGoldPixel,
  toCardSlots,
} from './grid.ts';

/* ------------------------------------------------------------------ */
/* 合成位图工具                                                        */
/* ------------------------------------------------------------------ */

function blankBitmap(width: number, height: number): Bitmap {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function setPx(bmp: Bitmap, x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return;
  const i = (y * bmp.width + x) * 4;
  bmp.data[i] = r;
  bmp.data[i + 1] = g;
  bmp.data[i + 2] = b;
  bmp.data[i + 3] = 255;
}

/** 画一个金色矩形边框（模拟英雄卡片）。 */
function drawGoldFrame(
  bmp: Bitmap,
  x: number,
  y: number,
  w: number,
  h: number,
  thickness = 2,
): void {
  for (let t = 0; t < thickness; t++) {
    for (let i = x; i < x + w; i++) {
      setPx(bmp, i, y + t, 200, 160, 60); // 金色
      setPx(bmp, i, y + h - 1 - t, 200, 160, 60);
    }
    for (let j = y; j < y + h; j++) {
      setPx(bmp, x + t, j, 200, 160, 60);
      setPx(bmp, x + w - 1 - t, j, 200, 160, 60);
    }
  }
}

/* ------------------------------------------------------------------ */
/* isGoldPixel                                                         */
/* ------------------------------------------------------------------ */

test('isGoldPixel：识别暖金色', () => {
  assert.equal(isGoldPixel(200, 160, 60), true);
  assert.equal(isGoldPixel(180, 140, 70), true);
});

test('isGoldPixel：排除白色、灰色、蓝色', () => {
  assert.equal(isGoldPixel(255, 255, 255), false, '白色不应算金色（B 太高）');
  assert.equal(isGoldPixel(128, 128, 128), false, '灰色不应算金色（R-B 差为 0）');
  assert.equal(isGoldPixel(60, 80, 200), false, '蓝色不应算金色');
  // 偏紫的洋红：R 高但 G 低
  assert.equal(isGoldPixel(200, 60, 200), false);
});

test('DEFAULT_GOLD：阈值参数齐全且合理', () => {
  assert.ok(DEFAULT_GOLD.minR > DEFAULT_GOLD.minG);
  assert.ok(DEFAULT_GOLD.minRBGap > 0);
  assert.ok(DEFAULT_GOLD.maxB < DEFAULT_GOLD.minR);
});

/* ------------------------------------------------------------------ */
/* 列投影                                                              */
/* ------------------------------------------------------------------ */

test('goldColumnProjection：只在金色列上产生计数', () => {
  const bmp = blankBitmap(100, 50);
  // 在 x=20 画一条竖线
  for (let y = 0; y < 50; y++) setPx(bmp, 20, y, 200, 160, 60);

  const proj = goldColumnProjection(bmp);
  assert.equal(proj[20], 50);
  assert.equal(proj[0], 0);
  assert.equal(proj[99], 0);
});

test('goldColumnProjection：忽略半透明像素（alpha 低）', () => {
  const bmp = blankBitmap(10, 10);
  const i = (5 * 10 + 5) * 4;
  bmp.data[i] = 200;
  bmp.data[i + 1] = 160;
  bmp.data[i + 2] = 60;
  bmp.data[i + 3] = 10; // 几乎透明
  assert.equal(goldColumnProjection(bmp)[5], 0);
});

/* ------------------------------------------------------------------ */
/* 竖线检测                                                            */
/* ------------------------------------------------------------------ */

test('findVerticalLines：找出投影尖峰的位置', () => {
  const proj = new Uint32Array(100);
  proj[10] = 200;
  proj[50] = 200;
  proj[90] = 200;
  const lines = findVerticalLines(proj);
  assert.deepEqual(lines, [10, 50, 90]);
});

test('findVerticalLines：合并同一根边框的相邻列', () => {
  const proj = new Uint32Array(100);
  proj[10] = 200;
  proj[11] = 190; // 同一根线宽 2px
  proj[50] = 200;
  const lines = findVerticalLines(proj);
  assert.equal(lines.length, 2);
  assert.ok(Math.abs(lines[0]! - 10.5) <= 1);
});

test('findVerticalLines：全零投影返回空', () => {
  assert.deepEqual(findVerticalLines(new Uint32Array(50)), []);
});

test('findVerticalLines：自适应阈值随强度缩放', () => {
  const proj = new Uint32Array(100);
  proj[10] = 1000; // 很强的线
  proj[50] = 100; // 相对弱，低于 35% 阈值
  const lines = findVerticalLines(proj, { ratio: 0.35 });
  assert.deepEqual(lines, [10]);
});

/* ------------------------------------------------------------------ */
/* 由竖线推断卡片                                                      */
/* ------------------------------------------------------------------ */

test('cardsFromLines：把成对竖线转成卡片矩形', () => {
  const res = cardsFromLines([100, 300, 350, 550], 1000, 800, {
    topRatio: 0.1,
    heightRatio: 0.4,
  });
  assert.equal(res.confident, true);
  assert.equal(res.cards.length, 2);
  // 第一张：x=0.1 w=0.2
  assert.ok(Math.abs(res.cards[0]!.x - 0.1) < 1e-9);
  assert.ok(Math.abs(res.cards[0]!.w - 0.2) < 1e-9);
  assert.equal(res.cards[0]!.y, 0.1);
  assert.equal(res.cards[0]!.h, 0.4);
});

test('cardsFromLines：按从左到右排序', () => {
  // 输入乱序；卡片 [100,300] [340,540] [560,760]，间隙均 = 40（紧凑布局）
  const res = cardsFromLines([560, 760, 100, 300, 340, 540], 1000, 800);
  assert.equal(res.confident, true);
  assert.equal(res.cards.length, 3);
  assert.ok(res.cards[0]!.x < res.cards[1]!.x);
  assert.ok(res.cards[1]!.x < res.cards[2]!.x);
});

test('cardsFromLines：周期线（等距长链）不构成卡片', () => {
  // 均匀分布的竖线：宽度 250 的「间距对」有 4 条，远多于真卡对。
  // 若被误配成卡片，间隙(250) = 卡宽(250)，会被小间隙校验拒绝。
  const res = cardsFromLines([100, 350, 600, 850, 1100], 2000, 800);
  assert.equal(res.confident, false);
  assert.equal(res.cards.length, 0);
});

test('cardsFromLines：竖线不足 4 条时判为不可信', () => {
  const res = cardsFromLines([100, 300], 1000, 800);
  assert.equal(res.confident, false);
  assert.equal(res.cards.length, 0);
  assert.match(res.reason ?? '', /竖线太少/);
});

test('cardsFromLines：宽度不一致时判为误检（关键防线）', () => {
  // 第二张卡片明显更窄 → 很可能是把别的 UI 元素当成卡片了。
  // 新逻辑下这类输入在「宽度众数」阶段就被拒（无重复宽度），
  // 拒绝原因可能是 旧语义(宽度不一致) 或 新语义(全是孤立噪声)。
  const res = cardsFromLines([100, 300, 320, 400], 1000, 800, { widthTolerance: 0.2 });
  assert.equal(res.confident, false);
  assert.match(res.reason ?? '', /宽度|噪声/);
});

test('cardsFromLines：真实噪声场景（结算界面金色元素）不误报', () => {
  // 模拟结算界面：金色数字/图标产生的一堆不规则竖线，
  // 宽度互不相同、间距杂乱 —— 任何配对都不应通过等宽等距校验。
  const res = cardsFromLines([138, 881, 893, 1531, 1690, 1701, 1711, 1719, 3028, 3041], 3413, 1920);
  assert.equal(res.confident, false);
  assert.equal(res.cards.length, 0);
});

test('cardsFromLines：噪声线混在真卡片之间时仍能筛出真卡片', () => {
  // 三张真卡片 [100,300] [350,550] [600,800]，中间混入一条噪声线 480
  // 与真卡片右侧边界重合的干扰。等宽众数 = 200 应占主导。
  const res = cardsFromLines([100, 300, 350, 480, 550, 600, 800], 1000, 800, {
    widthTolerance: 0.15,
  });
  assert.equal(res.confident, true, res.reason ?? '');
  assert.equal(res.cards.length, 3);
  assert.ok(Math.abs(res.cards[0]!.w - 0.2) < 0.02);
});

test('cardsFromLines：宽度一致时通过校验', () => {
  // 三张紧凑卡片（间隙 50 = 卡宽 200 × 0.25，真实选人 UI 形态）
  const res = cardsFromLines([100, 300, 350, 550, 600, 800], 1000, 800, {
    widthTolerance: 0.2,
  });
  assert.equal(res.confident, true);
  assert.equal(res.cards.length, 3);
});

test('cardsFromLines：图像尺寸非法时安全返回', () => {
  const res = cardsFromLines([10, 20, 30, 40], 0, 0);
  assert.equal(res.confident, false);
});

/* ------------------------------------------------------------------ */
/* 端到端：合成截屏                                                     */
/* ------------------------------------------------------------------ */

test('detectCards：在合成截屏上找出 3 张卡片', () => {
  const bmp = blankBitmap(1000, 800);
  // 三张等宽卡片，x = 100/300, 350/550, 600/800
  const frames: Array<[number, number]> = [
    [100, 300],
    [350, 550],
    [600, 800],
  ];
  for (const [x0, x1] of frames) {
    drawGoldFrame(bmp, x0, 100, x1 - x0, 400, 2);
  }

  const res = detectCards(bmp, { topRatio: 0.125, heightRatio: 0.5 });
  assert.equal(res.confident, true, res.reason ?? '(无 reason)');
  assert.equal(res.cards.length, 3);
  // 卡片的归一化位置应与画的一致
  assert.ok(Math.abs(res.cards[0]!.x - 0.1) < 0.02);
  assert.ok(Math.abs(res.cards[2]!.x - 0.6) < 0.02);
});

test('detectCards：空白图（没有卡片）判为不可信', () => {
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

test('detectCards：只有杂色没有卡片结构时不误报', () => {
  const bmp = blankBitmap(1000, 800);
  // 随机撒一些金色噪点（不构成边框）
  for (let i = 0; i < 200; i++) {
    setPx(bmp, (i * 37) % 1000, (i * 53) % 800, 200, 160, 60);
  }
  const res = detectCards(bmp);
  // 无论是否 confident，都**不应**给出多张等宽卡片
  if (res.confident) {
    assert.fail('散点噪声不应被判为可信的卡片布局');
  }
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
