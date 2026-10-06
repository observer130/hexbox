/**
 * 诊断：把"图标掩码"这件事看清（参考图 vs 卡面）
 *
 * 为什么单独写：图标匹配连续两版失败（正确项进不了前四、分差 0.01），
 * 而失败原因只能看图判断 —— 是"参考图有 alpha / 渐变导致掩码不完整"，
 * 还是"卡面渲染与参考图形状差太多"。盲调参数只会继续错。
 *
 * 用法：
 *   node --experimental-strip-types scripts/diag-augment-masks.mts <参考图标.png> <面板帧.png> [卡片序号]
 *
 * 产物（debug/augment-mask/）：
 *   ref.png / ref-mask.png    参考图原图 + 计算出的掩码（放大 8 倍便于看）
 *   card.png / card-mask.png  卡面图标区原图 + 掩码
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  decodePng,
  detectAugmentPanel,
  encodePng,
  extractGrayRaw,
  type Bitmap,
  type Rect,
} from '../packages/vision/src/index.ts';

const OUT = join('debug', 'augment-mask');
const GRID = 32;

function loadBmp(path: string): Bitmap {
  const img = decodePng(new Uint8Array(readFileSync(path)));
  return { width: img.width, height: img.height, data: img.data };
}

/** 灰度图 → 放大 N 倍写 PNG（看得见二值结果）。 */
function writeMask(bmp: Bitmap, rect: Rect, file: string): void {
  const g = extractGrayRaw(bmp, rect);
  if (!g) {
    console.log(`  ✗ ${file} 取样失败`);
    return;
  }
  let bg = 0;
  const hist = new Uint32Array(256);
  for (const v of g.gray) hist[v]!++;
  let best = -1;
  for (let i = 0; i < 256; i++) if (hist[i]! > best) { best = hist[i]!; bg = i; }
  const s = 2;
  const rgba = new Uint8ClampedArray(g.width * s * g.height * s * 4);
  for (let y = 0; y < g.height * s; y++) {
    for (let x = 0; x < g.width * s; x++) {
      const v = Math.abs(g.gray[Math.floor(y / s) * g.width + Math.floor(x / s)]! - bg) > 40 ? 255 : 20;
      const i = (y * g.width * s + x) * 4;
      rgba[i] = v;
      rgba[i + 1] = v;
      rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  writeFileSync(file, encodePng({ width: g.width * s, height: g.height * s, data: rgba }));
  console.log(`  → ${file}  (${g.width}x${g.height}，背景亮度 ${bg})`);
}

/** 原图裁剪直接写 PNG（看游戏到底画了什么）。 */
function writeCrop(bmp: Bitmap, rect: Rect, file: string): void {
  const x0 = Math.round(rect.x * bmp.width);
  const y0 = Math.round(rect.y * bmp.height);
  const w = Math.round(rect.w * bmp.width);
  const h = Math.round(rect.h * bmp.height);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * bmp.width + x0 + x) * 4;
      const di = (y * w + x) * 4;
      data[di] = bmp.data[si]!;
      data[di + 1] = bmp.data[si + 1]!;
      data[di + 2] = bmp.data[si + 2]!;
      data[di + 3] = 255;
    }
  }
  writeFileSync(file, encodePng({ width: w, height: h, data }));
  console.log(`  → ${file}  (${w}x${h})`);
}

const [refPath, framePath, cardArg] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });

if (refPath) {
  const ref = loadBmp(refPath);
  console.log(`参考图 ${basename(refPath)} ${ref.width}x${ref.height}`);
  // alpha 统计（关键：若有 alpha，掩码应当用 alpha 而不是亮度差）
  let aMin = 255;
  let aMax = 0;
  let aSum = 0;
  let opaque = 0;
  let transparent = 0;
  const n = ref.width * ref.height;
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let nOpaque = 0;
  for (let i = 0; i < n; i++) {
    const a = ref.data[i * 4 + 3]!;
    aMin = Math.min(aMin, a);
    aMax = Math.max(aMax, a);
    aSum += a;
    if (a > 128) {
      opaque++;
      const p = i * 4;
      rSum += ref.data[p]!;
      gSum += ref.data[p + 1]!;
      bSum += ref.data[p + 2]!;
      nOpaque++;
    } else transparent++;
  }
  console.log(
    `  alpha: min=${aMin} max=${aMax} 均值=${(aSum / n).toFixed(1)} —— 不透明 ${((opaque / n) * 100).toFixed(1)}% / 透明 ${((transparent / n) * 100).toFixed(1)}%`,
  );
  if (nOpaque > 0) {
    console.log(
      `  不透明像素的平均 RGB = ${(rSum / nOpaque).toFixed(0)},${(gSum / nOpaque).toFixed(0)},${(bSum / nOpaque).toFixed(0)}`,
    );
  }
  writeCrop(ref, { x: 0, y: 0, w: 1, h: 1 }, join(OUT, 'ref.png'));
  writeMask(ref, { x: 0, y: 0, w: 1, h: 1 }, join(OUT, 'ref-mask.png'));
}

if (framePath) {
  const bmp = loadBmp(framePath);
  const det = detectAugmentPanel(bmp);
  const idx = cardArg ? Number(cardArg) - 1 : 0;
  const card = det.cards[idx];
  console.log(`卡面 ${basename(framePath)} 卡${idx + 1}/${det.cards.length}`);
  if (!card) {
    console.log('  ✗ 没有这张卡');
  } else {
    // 图标区：卡内中央偏上（先看大范围，之后由剖面定稿）
    const zone: Rect = {
      x: card.rect.x + card.rect.w * 0.15,
      y: card.rect.y + card.rect.h * 0.04,
      w: card.rect.w * 0.7,
      h: card.rect.h * 0.4,
    };
    writeCrop(bmp, zone, join(OUT, 'card.png'));
    writeMask(bmp, zone, join(OUT, 'card-mask.png'));
    console.log(`  （卡片 rect=${JSON.stringify(card.rect)} 内部亮度 ${card.interiorLuma.toFixed(0)} 边框 ${card.edgeLuma.toFixed(0)}）`);
  }
}
