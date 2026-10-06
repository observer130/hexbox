/**
 * 软件光栅化测试（纯函数）
 *
 * 它只服务于离线预览，但必须**真的对**：预览与局内的差异只允许来自这里，
 * 一旦圆角/描边/字形画错，"不用开游戏挑尺寸"这件事就变成误导。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  blendPixel,
  distanceToSegment,
  fillRect,
  fillRoundedRect,
  inkDistanceField,
  rasterizePolygons,
  roundedRectDistance,
  strokePolyline,
  strokeRoundedRect,
  strokeSegment,
} from './label-raster.ts';
import {
  ASCII_GLYPH_H,
  ASCII_GLYPH_W,
  GLYPH_CAP_RATIO,
  GLYPH_STROKE_RATIO,
  asciiGlyph,
  asciiTextHeight,
  asciiTextWidth,
  drawAsciiText,
  drawGlowGlyph,
  drawRateLine,
  drawTierLetter,
  drawVectorGlyph,
  glyphInkAspect,
  glyphInkBox,
  glyphSupported,
  outlineStrokeRatio,
} from './label-glyph.ts';
import { CJK_RATE_GLYPHS, cjkRateGlyph } from './label-cjk.ts';
import { LABEL_CAP_RATIO, tierGlowLayers } from './label-draw.ts';
import { TIER_LETTER_OUTLINES, tierLetterGlyph } from './label-letter-outlines.ts';
import type { Bitmap, Rect } from './types.ts';
import type { Rgba } from './label-draw.ts';

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/** 黑色不透明位图（未画的像素 = 黑）。 */
function makeBitmap(width: number, height: number): Bitmap {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
}

/** 某个像素的红通道（黑底上 = 覆盖率 × 255）。 */
function red(bmp: Bitmap, x: number, y: number): number {
  return bmp.data[(y * bmp.width + x) * 4]!;
}

/** 墨迹（非黑）包围盒；没有任何墨迹时返回 null。 */
function inkBox(bmp: Bitmap): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = bmp.width;
  let minY = bmp.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < bmp.height; y++) {
    for (let x = 0; x < bmp.width; x++) {
      if (red(bmp, x, y) < 8) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

function inkCount(bmp: Bitmap): number {
  let n = 0;
  for (let y = 0; y < bmp.height; y++) {
    for (let x = 0; x < bmp.width; x++) if (red(bmp, x, y) >= 8) n++;
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* 距离场与形状                                                        */
/* ------------------------------------------------------------------ */

test('roundedRectDistance：内部为负、边界为零、外部为正，圆角处更远', () => {
  const rect: Rect = { x: 10, y: 10, w: 100, h: 60 };
  assert.ok(roundedRectDistance(60, 40, rect, 12) < -10, '中心深处应为大负值');
  assert.ok(Math.abs(roundedRectDistance(10, 40, rect, 12)) < 1e-9, '左边中点恰在边界上');
  assert.ok(roundedRectDistance(5, 40, rect, 12) > 0, '左侧外面为正');
  // 左上角 (10,10)：圆角半径 12 → 角点到圆心 (22,22) 的距离约 17 − 12 ≈ 5，明显在矩形外
  assert.ok(roundedRectDistance(10, 10, rect, 12) > 1, '圆角把直角削掉');
  // 半径退化（0）就是普通矩形：角点落在边界上
  assert.ok(Math.abs(roundedRectDistance(10, 10, rect, 0)) < 1e-9);
});

test('fillRoundedRect：中心实心、圆角处留空、外面不画', () => {
  const bmp = makeBitmap(120, 80);
  const rect: Rect = { x: 10, y: 10, w: 100, h: 60 };
  fillRoundedRect(bmp, rect, 16, WHITE);
  assert.ok(red(bmp, 60, 40) > 250, '中心应完全不透明');
  assert.ok(red(bmp, 80, 40) > 250, '靠右边（非圆角）也应是实心');
  // 直角角落被圆角削掉：点 (10,10) 距离场 > 0 → 不画
  assert.equal(red(bmp, 10, 10), 0, '圆角外应保持背景');
  assert.equal(red(bmp, 9, 40), 0, '框外不画');
  assert.equal(red(bmp, 60, 9), 0, '框外不画');
  const box = inkBox(bmp)!;
  assert.ok(box.minX >= 9 && box.maxX <= 110, '墨迹不越出矩形 ±1px');
});

test('fillRoundedRect：半透明底色按 alpha 混合（深色底 0.88）', () => {
  const bmp = makeBitmap(40, 20);
  fillRect(bmp, { x: 0, y: 0, w: 40, h: 20 }, WHITE); // 先铺白
  fillRoundedRect(bmp, { x: 0, y: 0, w: 40, h: 20 }, 0, { r: 10, g: 14, b: 24, a: 0.88 });
  // 结果 ≈ 白 × 0.12 + 底色 × 0.88 ≈ 39
  assert.ok(Math.abs(red(bmp, 20, 10) - 39) <= 2, `实际 ${red(bmp, 20, 10)}`);
});

test('strokeRoundedRect：只画边框带，内部不被填满；线宽加倍则带更宽', () => {
  const rect: Rect = { x: 20, y: 20, w: 100, h: 60 };
  const thin = makeBitmap(140, 100);
  const thick = makeBitmap(140, 100);
  strokeRoundedRect(thin, rect, 8, 2, WHITE);
  strokeRoundedRect(thick, rect, 8, 6, WHITE);
  assert.ok(red(thin, 70, 20) > 200, '上边中点在描边上');
  assert.equal(red(thin, 70, 50), 0, '内部不该被填');
  assert.equal(red(thick, 70, 50), 0, '内部不该被填');
  assert.ok(inkCount(thick) > inkCount(thin), '线宽越大墨迹越多');
});

test('blendPixel：src-over 混合、越界与零覆盖率安全', () => {
  const bmp = makeBitmap(4, 4);
  blendPixel(bmp, 1, 1, WHITE, 0.5);
  assert.ok(Math.abs(red(bmp, 1, 1) - 128) <= 1, `0.5 覆盖应约 128，实际 ${red(bmp, 1, 1)}`);
  blendPixel(bmp, 1, 1, WHITE, 0);
  assert.ok(Math.abs(red(bmp, 1, 1) - 128) <= 1, '覆盖率为 0 不改动像素');
  blendPixel(bmp, -1, 1, WHITE, 1);
  blendPixel(bmp, 9, 9, WHITE, 1);
  blendPixel(bmp, 2, 2, { r: 255, g: 255, b: 255, a: 0 }, 1);
  assert.equal(red(bmp, 2, 2), 0, 'alpha=0 不画');
});

test('distanceToSegment / strokeSegment / strokePolyline：圆头线段与折线', () => {
  assert.ok(Math.abs(distanceToSegment(5, 3, 0, 0, 10, 0) - 3) < 1e-9);
  assert.ok(Math.abs(distanceToSegment(-2, 0, 0, 0, 10, 0) - 2) < 1e-9, '端点外侧也算距离（圆头）');

  const bmp = makeBitmap(40, 40);
  strokeSegment(bmp, 5, 20, 35, 20, 4, WHITE);
  assert.ok(red(bmp, 20, 20) > 200, '中点在线上');
  assert.ok(red(bmp, 20, 21) > 200, '线宽 4 → 中线两侧各 2px');
  assert.ok(red(bmp, 20, 24) < 8, '线宽之外不画');

  const poly = makeBitmap(40, 40);
  strokePolyline(
    poly,
    [
      [10, 10],
      [30, 10],
      [30, 30],
    ],
    3,
    WHITE,
  );
  assert.ok(red(poly, 20, 10) > 200, '第一段');
  assert.ok(red(poly, 30, 20) > 200, '第二段');
  assert.equal(red(poly, 10, 30), 0, '没走过的位置不画');
});

/* ------------------------------------------------------------------ */
/* 矢量字形（档位字母）                                                 */
/* ------------------------------------------------------------------ */

test('S/A/B/C 四个档位字母都有字形，墨迹纵横比合理', () => {
  for (const ch of ['S', 'A', 'B', 'C']) {
    assert.ok(glyphSupported(ch), `${ch} 应有字形`);
    const aspect = glyphInkAspect(ch)!;
    assert.ok(aspect > 0.5 && aspect < 0.9, `${ch} 纵横比 ${aspect.toFixed(3)} 应在 0.5~0.9`);
    const box = glyphInkBox(ch)!;
    // 折线采样是离散的：端点外的极值点可能差不到一个采样步（<0.5% cap），容差取 0.01
    assert.ok(Math.abs(box.minY) < 0.01, `${ch} 墨迹上沿应是 cap 顶（y=0），实际 ${box.minY}`);
    assert.ok(Math.abs(box.maxY - 1) < 0.01, `${ch} 墨迹下沿应是基线（y=1），实际 ${box.maxY}`);
  }
  assert.equal(glyphSupported('D'), false, '没定义的字形要明确不支持（预览会画提示框）');
  assert.ok(glyphSupported('s'), '小写输入按大写处理');
});

test('drawVectorGlyph：画在框心、墨迹高 ≈ 字号 × cap 比，不支持时返回 false', () => {
  const size = 60;
  const bmp = makeBitmap(200, 120);
  assert.equal(drawVectorGlyph(bmp, 'S', size, 100, 60, WHITE), true);
  const box = inkBox(bmp)!;
  const h = box.maxY - box.minY + 1;
  const w = box.maxX - box.minX + 1;
  assert.ok(Math.abs(h - size * GLYPH_CAP_RATIO) <= 3, `墨迹高 ${h} 应≈ ${size * GLYPH_CAP_RATIO}`);
  assert.ok(Math.abs((box.minX + box.maxX) / 2 - 100) <= 2, '水平居中');
  assert.ok(Math.abs((box.minY + box.maxY) / 2 - 60) <= 2, '垂直居中');
  assert.ok(w < h, '单字宽度应小于高度');

  const small = makeBitmap(200, 120);
  drawVectorGlyph(small, 'S', 30, 100, 60, WHITE);
  assert.ok(inkCount(small) < inkCount(bmp) / 3, '字号减半 → 墨迹应大幅减少');
  assert.equal(drawVectorGlyph(small, 'D', 30, 100, 60, WHITE), false);
});

/* ------------------------------------------------------------------ */
/* 5×7 点阵标注字                                                       */
/* ------------------------------------------------------------------ */

test('点阵字：每个字符都是 7 行 5 列，宽度/高度可算', () => {
  for (const ch of ['A', 'Z', '0', '9', ':', 'S']) {
    const rows = asciiGlyph(ch);
    assert.equal(rows.length, ASCII_GLYPH_H);
    for (const r of rows) assert.equal(r.length, ASCII_GLYPH_W);
  }
  assert.equal(asciiTextWidth('SMALL', 3), (5 * 6 - 1) * 3);
  assert.equal(asciiTextWidth('', 3), 0);
  assert.equal(asciiTextHeight(3), ASCII_GLYPH_H * 3);
  assert.equal(inkCount(asciiBmp(' ')), 0, '空格不画东西');
});

function asciiBmp(text: string, scale = 2): Bitmap {
  const bmp = makeBitmap(asciiTextWidth(text, scale) + 4, asciiTextHeight(scale) + 4);
  drawAsciiText(bmp, text, 2, 2, scale, WHITE);
  return bmp;
}

test('drawAsciiText：左上角起笔、像素是纯色（不走抗锯齿），倍率翻倍则尺寸翻倍', () => {
  const one = asciiBmp('AB', 2);
  const two = asciiBmp('AB', 4);
  const b1 = inkBox(one)!;
  const b2 = inkBox(two)!;
  assert.equal(b1.minY, 2, '(x, y) 是左上角：第一行就是墨迹');
  assert.ok(b1.minX >= 2 && b1.minX <= 3, '横向从笔位开始（有的字符首行左侧留白）');
  // 点阵不做抗锯齿：所有墨迹像素都是同一个纯色
  const colors = new Set<number>();
  for (let y = 0; y < one.height; y++) {
    for (let x = 0; x < one.width; x++) {
      const v = red(one, x, y);
      if (v >= 8) colors.add(v);
    }
  }
  assert.deepEqual([...colors], [255], '点阵是纯色块');
  assert.equal(b2.maxX - b2.minX + 1, (b1.maxX - b1.minX + 1) * 2, '倍率翻倍 → 宽翻倍');
  assert.equal(b2.maxY - b2.minY + 1, (b1.maxY - b1.minY + 1) * 2, '倍率翻倍 → 高翻倍');
  assert.ok(b1.maxX < asciiTextWidth('AB', 2) + 2, '不越出预算宽度');
  // 百分号是「选取率 12.1%」那一行要用的字形，必须有（否则会静默画成空格）
  assert.ok(asciiGlyph('%').some((r) => r.includes('#')), '% 应有墨迹');
});

/* ------------------------------------------------------------------ */
/* 发光 / 选取率行（局内强度标签专用的两笔）                              */
/* ------------------------------------------------------------------ */

test('outlineStrokeRatio：canvas 的 lineWidth 与预览字形笔画是"同外扩量"', () => {
  // canvas：lineWidth=w 居中压在墨迹边界上 → 向外扩 w/2
  // 预览：字形笔画加宽到 (base + w/字号) → 也向外扩 w/2
  const size = 100;
  assert.equal(outlineStrokeRatio(size, 0), GLYPH_STROKE_RATIO, 'w=0 就是原字形笔画');
  assert.ok(Math.abs(outlineStrokeRatio(size, 20) - (GLYPH_STROKE_RATIO + 0.2)) < 1e-9);
  // 外扩量 = (笔画宽 − 基础笔画宽)/2 × 字号 = w/2
  const pen = outlineStrokeRatio(size, 20) * size;
  assert.ok(Math.abs((pen - GLYPH_STROKE_RATIO * size) / 2 - 10) < 1e-9);
});

test('drawGlowGlyph：比不画时墨迹更多、且都在字母周围（远不过分）', () => {
  const size = 60;
  const plain = makeBitmap(220, 160);
  const glow = makeBitmap(220, 160);
  drawVectorGlyph(plain, 'S', size, 110, 80, WHITE);
  const layers = tierGlowLayers({ r: 255, g: 255, b: 255, a: 1 }, 12);
  assert.equal(drawGlowGlyph(glow, 'S', size, 110, 80, layers), true);
  const g = inkBox(glow)!;
  const p = inkBox(plain)!;
  assert.ok(inkCount(glow) > inkCount(plain), '发光层应增加墨迹');
  // 最外层 reach = 12 → 最多向外扩 ~12px（再加半个笔画宽）
  assert.ok(g.minX < p.minX && g.maxX > p.maxX, '发光向左右扩散');
  assert.ok(g.minY < p.minY && g.maxY > p.maxY, '发光向上下扩散');
  assert.ok(p.minX - g.minX <= 16 && p.minY - g.minY <= 16, '扩散量不该远超 reach');
  // 不支持的字符明确返回 false（调用方据此画提示框）
  assert.equal(drawGlowGlyph(glow, 'D', size, 110, 80, layers), false);
});

test('汉字点阵数据：只有「选取率」三个字，尺寸与十六进制字符都合法', () => {
  assert.deepEqual(Object.keys(CJK_RATE_GLYPHS).sort(), ['取', '率', '选']);
  for (const [ch, g] of Object.entries(CJK_RATE_GLYPHS)) {
    assert.ok(g.w > 8 && g.h > 8, `${ch} 点阵太小`);
    assert.equal(g.rows.length, g.h, `${ch} 行数应等于 h`);
    for (const row of g.rows) {
      assert.equal(row.length, g.w, `${ch} 每行长度应等于 w`);
      assert.ok(/^[0-9a-f]+$/.test(row), `${ch} 每行只能是十六进制`);
    }
    // 墨迹不能是空的，也不能整块不透明（否则画出来是一个方块）
    const ink = g.rows.join('').split('').filter((c) => c !== '0').length;
    assert.ok(ink > g.w * g.h * 0.05 && ink < g.w * g.h * 0.9, `${ch} 墨迹占比不合理（${ink}）`);
  }
  assert.equal(cjkRateGlyph('选'), CJK_RATE_GLYPHS['选']);
  assert.equal(cjkRateGlyph('中'), null, '没有内置的字形要明确返回 null');
});

test('drawRateLine：汉字 + 数字都画上、整行以给定中心居中、坐在基线上', () => {
  const size = 40;
  const ink = size * 0.95;
  const bmp = makeBitmap(600, 120);
  const drew = drawRateLine(bmp, '选取率 12.1%', size, ink, 300, 80, WHITE);
  assert.equal(drew, 3, '三个汉字都要画上（内置点阵）');
  const box = inkBox(bmp)!;
  assert.ok(inkCount(bmp) > 200, '整行应有可观墨迹');
  // 基线：所有墨迹都在基线上方（汉字 + 点阵数字都坐在基线上）
  assert.ok(box.maxY <= 80, `墨迹下沿 ${box.maxY} 不应低于基线 80`);
  assert.ok(box.minY >= 80 - Math.ceil(ink) - 1, '墨迹上沿 ≈ 基线 − 墨迹高');
  // 居中：整行**墨迹包围盒**的中心就在给定的中心线上（容差 = 半个点阵字符宽）
  assert.ok(
    Math.abs((box.minX + box.maxX) / 2 - 300) <= 8,
    `墨迹中心 ${((box.minX + box.maxX) / 2).toFixed(1)} 应≈ 300`,
  );
  // 字号翻倍 → 墨迹高翻倍
  const big = makeBitmap(900, 200);
  drawRateLine(big, '选取率 12.1%', size * 2, ink * 2, 400, 140, WHITE);
  const bigBox = inkBox(big)!;
  assert.ok(
    Math.abs((bigBox.maxY - bigBox.minY) / (box.maxY - box.minY) - 2) < 0.2,
    '字号翻倍 → 墨迹高约翻倍',
  );
});

/* ------------------------------------------------------------------ */
/* 多边形填充（真字体轮廓）与距离场                                       */
/* ------------------------------------------------------------------ */

/** 某个像素的某通道值（0~255）。 */
function channel(bmp: Bitmap, x: number, y: number, c: number): number {
  return bmp.data[(y * bmp.width + x) * 4 + c]!;
}

/** 覆盖率缓冲里某个像素的值。 */
function cov(buf: Float32Array, width: number, x: number, y: number): number {
  return buf[y * width + x]!;
}

test('rasterizePolygons：整数边界的正方形内部满覆盖、外部零覆盖', () => {
  const w = 12;
  const h = 12;
  const buf = rasterizePolygons([[0, 0, 10, 0, 10, 8, 0, 8]], w, h, 0, 0);
  assert.equal(cov(buf, w, 5, 4), 1, '内部满覆盖');
  assert.equal(cov(buf, w, 0, 0), 1, '像素中心在边界内 → 满覆盖');
  assert.equal(cov(buf, w, 10, 4), 0, '右边界之外不画');
  assert.equal(cov(buf, w, 2, 8), 0, '下边界之外不画');
  // 总覆盖 ≈ 面积（10 × 8 = 80）
  let sum = 0;
  for (const v of buf) sum += v;
  assert.ok(Math.abs(sum - 80) < 1e-3, `总覆盖 ${sum} 应≈ 80`);
});

test('rasterizePolygons：半像素偏移的边有解析抗锯齿（覆盖率在 0~1 之间）', () => {
  const w = 12;
  const buf = rasterizePolygons([[0.5, 0.5, 9.5, 0.5, 9.5, 9.5, 0.5, 9.5]], w, w, 0, 0);
  assert.equal(cov(buf, w, 5, 5), 1, '内部仍是满覆盖');
  assert.ok(Math.abs(cov(buf, w, 0, 5) - 0.5) < 1e-6, `左边界像素应 50%（实际 ${cov(buf, w, 0, 5)}）`);
  assert.ok(Math.abs(cov(buf, w, 9, 5) - 0.5) < 1e-6, '右边界像素应 50%');
  assert.ok(Math.abs(cov(buf, w, 5, 0) - 0.5) < 1e-6, '上边界像素应 50%');
  assert.ok(cov(buf, w, 0, 0) > 0 && cov(buf, w, 0, 0) < 1, '角上是部分覆盖（不是 0/1 硬边）');
});

test('rasterizePolygons：偶奇规则 → 内层轮廓是**洞**（字怀不能填实）', () => {
  const w = 14;
  const outer = [0, 0, 12, 0, 12, 12, 0, 12];
  const inner = [4, 4, 8, 4, 8, 8, 4, 8];
  const buf = rasterizePolygons([outer, inner], w, w, 0, 0);
  assert.equal(cov(buf, w, 1, 1), 1, '外环有墨');
  assert.equal(cov(buf, w, 6, 6), 0, '内层应被挖空');
  assert.equal(cov(buf, w, 2, 6), 1, '内层外面（左边）仍是墨');
  assert.equal(cov(buf, w, 6, 2), 1, '内层外面（上边）仍是墨');
  // 内层方向反过来（同向 vs 反向）在偶奇规则下结果必须一样
  const reversed = rasterizePolygons([[0, 0, 12, 0, 12, 12, 0, 12], [4, 8, 8, 8, 8, 4, 4, 4]], w, w, 0, 0);
  assert.equal(cov(reversed, w, 6, 6), 0, '轮廓方向不影响偶奇结果');
});

test('rasterizePolygons：缓冲区偏移与越界都安全（只画落在缓冲内的部分）', () => {
  const w = 6;
  const h = 6;
  // 一个覆盖 [-5, 5] × [-5, 5] 的大方块，缓冲只截取 [0,6) × [0,6)
  const buf = rasterizePolygons([[-5, -5, 5, -5, 5, 5, -5, 5]], w, h, 0, 0);
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) assert.equal(cov(buf, w, x, y), 1, `(${x},${y}) 应满覆盖`);
  }
  assert.equal(cov(buf, w, 5, 0), 0, '方块之外（x=5）不画');
  const off = rasterizePolygons([[2, 2, 4, 2, 4, 4, 2, 4]], w, h, -3, -3);
  assert.equal(cov(off, w, 5, 5), 1, 'origin 偏移要生效（缓冲内的 (5,5) 对应位图 (2,2)）');
  assert.equal(cov(off, w, 0, 0), 0);
  assert.equal(rasterizePolygons([], w, h, 0, 0).length, w * h, '空输入返回全零缓冲');
  assert.equal(rasterizePolygons([[0, 0, 1, 1]], 0, 0, 0, 0).length, 0, '零尺寸安全');
});

test('inkDistanceField：墨迹内为 0、相邻为 1、斜对角为 √2', () => {
  const w = 5;
  const h = 5;
  const c = new Float32Array(w * h);
  c[2 * w + 2] = 1; // (2,2) 一个墨迹像素
  const d = inkDistanceField(c, w, h);
  assert.equal(cov(d, w, 2, 2), 0, '墨迹内距离 0');
  assert.equal(cov(d, w, 1, 2), 1, '左右相邻 = 1');
  assert.equal(cov(d, w, 2, 3), 1, '上下相邻 = 1');
  assert.ok(Math.abs(cov(d, w, 1, 1) - Math.SQRT2) < 1e-5, '斜对角 ≈ √2');
  assert.ok(Math.abs(cov(d, w, 0, 0) - 2 * Math.SQRT2) < 1e-5, '再远一格 = 2√2');
  // 半覆盖（抗锯齿边）不算"墨迹"：阈值取 0.5
  const edge = new Float32Array(w * h);
  edge[2 * w + 2] = 0.4;
  const de = inkDistanceField(edge, w, h);
  assert.equal(cov(de, w, 2, 2), 1e9, '覆盖率 < 0.5 的像素不当墨迹（距离留最大）');
});

/* ------------------------------------------------------------------ */
/* 档位字母：真字体轮廓 + 距离场向外扩（与局内 canvas 同语义）            */
/* ------------------------------------------------------------------ */

const NO_PAINT = { glow: [], outlineWidth: 0, outline: WHITE, fill: WHITE } as const;

test('drawTierLetter：墨迹高 = 字号 × cap 比，平底字母坐在基线上（"预览 = 局内"）', () => {
  const size = 120;
  const textX = 150;
  const baselineY = 180;
  const bmp = makeBitmap(300, 260);
  const g = tierLetterGlyph('H')!;
  assert.equal(drawTierLetter(bmp, 'H', size, textX, baselineY, NO_PAINT), true);
  const box = inkBox(bmp)!;
  const height = box.maxY - box.minY + 1;
  // 轮廓是矢量的：像素化的墨迹高与 cap 高差在 1~2 像素内（远好于任何固定分辨率的点阵）
  assert.ok(
    Math.abs(height - size * LABEL_CAP_RATIO) <= 2,
    `H 墨迹高 ${height} 应≈ 字号×cap 比 = ${(size * LABEL_CAP_RATIO).toFixed(1)}`,
  );
  assert.ok(Math.abs(box.maxY + 1 - baselineY) <= 1, `H 下沿 ${box.maxY + 1} 应坐在基线 ${baselineY} 上`);
  // 横向：canvas 的 textAlign='center' 居中的是**前进宽**（视觉居中由计划加在 textX 上）
  const inkCenter = textX - (g.advance / 2 - (g.inkLeft + g.inkRight) / 2) * size;
  assert.ok(
    Math.abs((box.minX + box.maxX + 1) / 2 - inkCenter) <= 1.5,
    `墨迹中心 ${((box.minX + box.maxX + 1) / 2).toFixed(1)} 应≈ ${inkCenter.toFixed(1)}`,
  );
});

test('drawTierLetter：抗锯齿（边缘有中间灰度）且放大不会糊（矢量轮廓）', () => {
  const small = makeBitmap(200, 160);
  const big = makeBitmap(400, 320);
  drawTierLetter(small, 'S', 60, 100, 110, NO_PAINT);
  drawTierLetter(big, 'S', 120, 200, 220, NO_PAINT);
  const levels = new Set<number>();
  for (let y = 0; y < small.height; y++) {
    for (let x = 0; x < small.width; x++) {
      const v = channel(small, x, y, 0);
      if (v > 0) levels.add(v);
    }
  }
  assert.ok(levels.size > 8, `边缘应有丰富灰度（抗锯齿），实际只有 ${levels.size} 级`);
  assert.ok(Math.max(...levels) === 255, '内部应完全不透明');
  // 字号翻倍 → 墨迹高翻倍（同一份轮廓，不是位图放大）
  const b1 = inkBox(small)!;
  const b2 = inkBox(big)!;
  const ratio = (b2.maxY - b2.minY + 1) / (b1.maxY - b1.minY + 1);
  assert.ok(Math.abs(ratio - 2) < 0.05, `墨迹高应随字号等比（${ratio.toFixed(3)}）`);
});

test('drawTierLetter：发光/描边按"向外扩 reach"（与 canvas strokeText 同语义）', () => {
  const size = 100;
  const textX = 120;
  const baselineY = 140;
  const plain = makeBitmap(320, 260);
  drawTierLetter(plain, 'B', size, textX, baselineY, NO_PAINT);
  const p = inkBox(plain)!;

  // 发光总半径 12 → 墨迹向四周各扩 ~12px
  const glow = makeBitmap(320, 260);
  drawTierLetter(glow, 'B', size, textX, baselineY, {
    glow: tierGlowLayers({ r: 255, g: 255, b: 255, a: 1 }, 12),
    outlineWidth: 0,
    outline: WHITE,
    fill: WHITE,
  });
  const g = inkBox(glow)!;
  assert.ok(g.minX < p.minX && g.maxX > p.maxX, '发光向左右扩散');
  assert.ok(g.minY < p.minY && g.maxY > p.maxY, '发光向上下扩散');
  const reach = p.minX - g.minX;
  assert.ok(Math.abs(reach - 12) <= 1.5, `左扩 ${reach} 应≈ 发光半径 12`);
  assert.ok(inkCount(glow) > inkCount(plain), '发光层应有额外墨迹');

  // 深色描边 lineWidth = w → 向外扩 w/2（canvas 的居中描边语义）
  const outlined = makeBitmap(320, 260);
  drawTierLetter(outlined, 'B', size, textX, baselineY, {
    glow: [],
    outlineWidth: 20,
    outline: { r: 255, g: 0, b: 0, a: 1 },
    fill: { r: 0, g: 255, b: 0, a: 1 },
  });
  const o = inkBox(outlined)!;
  assert.ok(Math.abs((p.minX - o.minX) - 10) <= 1.5, `描边外扩 ${p.minX - o.minX} 应≈ lineWidth/2 = 10`);
  // 字母本体盖住描边向内那半：中心像素应是填充色（绿），描边只在四周
  let greenInside = 0;
  for (let y = 0; y < outlined.height; y++) {
    for (let x = 0; x < outlined.width; x++) {
      if (channel(outlined, x, y, 1) > 200 && channel(outlined, x, y, 0) < 60) greenInside++;
    }
  }
  assert.ok(greenInside > 100, '描边向内的那一半必须被字母本体盖住');
});

test('drawTierLetter：A~Z 全部能画（每个字母都有墨迹、都在字形数据里）', () => {
  for (const ch of Object.keys(TIER_LETTER_OUTLINES)) {
    const bmp = makeBitmap(200, 160);
    assert.equal(drawTierLetter(bmp, ch, 80, 100, 120, NO_PAINT), true, `${ch} 应能画`);
    assert.ok(inkCount(bmp) > 50, `${ch} 应有墨迹`);
  }
});

test('drawTierLetter：没有字形 → false；画在画布外 → true（不是字形缺失）', () => {
  const bmp = makeBitmap(120, 80);
  assert.equal(drawTierLetter(bmp, '中', 60, 60, 60, NO_PAINT), false, '非 A~Z 明确返回 false');
  assert.equal(drawTierLetter(bmp, '', 60, 60, 60, NO_PAINT), false);
  assert.equal(inkCount(bmp), 0, '返回 false 时不该画任何东西');
  assert.equal(
    drawTierLetter(bmp, 'S', 60, -500, -500, NO_PAINT),
    true,
    '完全在画布外仍算"画了"（否则调用方会误回退到单线字形）',
  );
  assert.equal(inkCount(bmp), 0);
});

