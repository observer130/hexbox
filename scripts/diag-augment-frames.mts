/**
 * 诊断：把**真机帧**回放进局内海克斯门控（跑的是**线上同一份代码**）
 *
 * 为什么需要：门控判据与阈值必须由真实数据定，不能凭印象。
 * 本脚本直接调用 `vision/augment-panel.ts` 的 `detectAugmentPanel`
 * ——不是复制一份算法，否则"脚本全绿但线上不对"（本项目真实踩过同类坑：
 * 诊断脚本与主流程两份实现会漂移）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/diag-augment-frames.mts <帧.png...> [--annotate]
 *
 * 典型输入（都不入库，见 .gitignore）：
 *   正样本 debug/shots/inprogress-*.png、debug/augment/open-*.png、closed-sample-*.png
 *   负样本 debug/augment/closed-sample-*.png（未弹面板的那几张）、选人帧
 *
 * 输出：每帧的判定 + 卡片数/内部亮度/边框亮度，以及 1/2/4/8 降采样后的结果
 * （用来确认"门控截屏最小能用多少分辨率"）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import {
  PANEL_ROW_REGION,
  PANEL_THRESHOLDS,
  decodePng,
  detectAugmentPanel,
  encodePng,
  type Bitmap,
  type PanelCard,
  type Rect,
} from '../packages/vision/src/index.ts';

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

/** 盒式降采样（模拟门控用更小的截屏）。 */
function downsample(bmp: Bitmap, factor: number): Bitmap {
  if (factor <= 1) return bmp;
  const w = Math.floor(bmp.width / factor);
  const h = Math.floor(bmp.height / factor);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const i = ((y * factor + dy) * bmp.width + (x * factor + dx)) * 4;
          r += bmp.data[i]!;
          g += bmp.data[i + 1]!;
          b += bmp.data[i + 2]!;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      data[o] = r / n;
      data[o + 1] = g / n;
      data[o + 2] = b / n;
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** 全帧平均亮度（每 4 像素采样）。 */
function frameLuma(bmp: Bitmap): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < bmp.height; y += 4) {
    for (let x = 0; x < bmp.width; x += 4) {
      const i = (y * bmp.width + x) * 4;
      sum += 0.299 * bmp.data[i]! + 0.587 * bmp.data[i + 1]! + 0.114 * bmp.data[i + 2]!;
      n++;
    }
  }
  return sum / n;
}

function drawRect(ann: Uint8ClampedArray, W: number, H: number, r: Rect, rgb: readonly [number, number, number]): void {
  const x0 = Math.max(0, Math.round(r.x * W));
  const y0 = Math.max(0, Math.round(r.y * H));
  const x1 = Math.min(W - 1, Math.round((r.x + r.w) * W));
  const y1 = Math.min(H - 1, Math.round((r.y + r.h) * H));
  const set = (x: number, y: number): void => {
    const i = (y * W + x) * 4;
    ann[i] = rgb[0];
    ann[i + 1] = rgb[1];
    ann[i + 2] = rgb[2];
  };
  for (let t = 0; t < 3; t++) {
    for (let x = x0; x <= x1; x++) {
      set(x, Math.min(H - 1, y0 + t));
      set(x, Math.max(0, y1 - t));
    }
    for (let y = y0; y <= y1; y++) {
      set(Math.min(W - 1, x0 + t), y);
      set(Math.max(0, x1 - t), y);
    }
  }
}

function annotate(bmp: Bitmap, cards: readonly PanelCard[]): Uint8ClampedArray {
  const ann = new Uint8ClampedArray(bmp.data);
  drawRect(ann, bmp.width, bmp.height, PANEL_ROW_REGION, [0x6f, 0xb3, 0xd2]);
  for (const c of cards) {
    const ok = c.interiorLuma < PANEL_THRESHOLDS.interiorMax && c.edgeLuma - c.interiorLuma >= PANEL_THRESHOLDS.contrastMin;
    drawRect(ann, bmp.width, bmp.height, c.rect, ok ? [0x4a, 0xde, 0x80] : [0xe0, 0xb6, 0x4a]);
  }
  return ann;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const doAnnotate = argv.includes('--annotate');
const files = argv.filter((a) => !a.startsWith('--'));

if (files.length === 0) {
  console.error('用法: node --experimental-strip-types scripts/diag-augment-frames.mts <帧.png...> [--annotate]');
  process.exit(1);
}

interface Result {
  readonly name: string;
  readonly size: string;
  readonly found: boolean;
  readonly cards: number;
  readonly bands: number;
  readonly interior: readonly number[];
  readonly edge: readonly number[];
  readonly reason: string;
  readonly luma: number;
  readonly perScale: readonly {
    factor: number;
    size: string;
    found: boolean;
    cards: number;
    interior: readonly number[];
    edge: readonly number[];
  }[];
}

const results: Result[] = [];

for (const file of files) {
  let bmp: Bitmap;
  try {
    const img = decodePng(new Uint8Array(readFileSync(file)));
    bmp = { width: img.width, height: img.height, data: img.data };
  } catch (e) {
    console.error(`✗ ${file}: ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  const det = detectAugmentPanel(bmp);
  const perScale = [1, 2, 4, 8].map((factor) => {
    const small = downsample(bmp, factor);
    const d = detectAugmentPanel(small);
    return {
      factor,
      size: `${small.width}x${small.height}`,
      found: d.found,
      cards: d.cards.length,
      interior: d.cards.map((c) => c.interiorLuma),
      edge: d.cards.map((c) => c.edgeLuma),
    };
  });
  results.push({
    name: basename(file),
    size: `${bmp.width}x${bmp.height}`,
    found: det.found,
    cards: det.cards.length,
    bands: det.bands,
    interior: det.cards.map((c) => c.interiorLuma),
    edge: det.cards.map((c) => c.edgeLuma),
    reason: det.reason,
    luma: frameLuma(bmp),
    perScale,
  });
  if (doAnnotate) {
    const out = file.replace(/\.png$/i, '') + '.augannot.png';
    writeFileSync(out, encodePng({ width: bmp.width, height: bmp.height, data: annotate(bmp, det.cards) }));
    console.log(`  标注图 → ${out}`);
  }
}

console.log(
  `\n线上检测器回放（阈值：内部<${PANEL_THRESHOLDS.interiorMax}，边框−内部≥${PANEL_THRESHOLDS.contrastMin}，卡片 ${PANEL_THRESHOLDS.minCards}~${PANEL_THRESHOLDS.maxCards} 张）`,
);
for (const r of results) {
  const fmt = (v: readonly number[]): string => (v.length === 0 ? '—' : v.map((x) => x.toFixed(0)).join('/'));
  console.log(
    `  ${r.found ? '✅ 面板' : '    无  '} ${r.name.slice(0, 30).padEnd(31)} ${r.size.padEnd(11)} ` +
      `帧亮度=${r.luma.toFixed(1).padStart(5)} 卡片=${r.cards} 带=${r.bands} 内部=[${fmt(r.interior)}] 边框=[${fmt(r.edge)}]`,
  );
  console.log(`         ${r.reason}`);
}

console.log('\n分辨率扫（同一检测器，1/2/4/8 降采样后是否仍成立）');
for (const r of results) {
  const fmt = (v: readonly number[]): string => (v.length === 0 ? '—' : v.map((x) => x.toFixed(0)).join('/'));
  console.log(`  ${r.name.slice(0, 30).padEnd(31)}`);
  for (const s of r.perScale) {
    console.log(
      `      ${s.size.padEnd(11)} ${s.found ? '✅面板' : '  无  '} 卡片=${s.cards} 内部=[${fmt(s.interior)}] 边框=[${fmt(s.edge)}]`,
    );
  }
}

const pos = results.filter((r) => r.found).length;
console.log(
  `\n汇总：认定面板 ${pos} / ${results.length} 帧。` +
    `（真机正样本：inprogress-1525*.png 与"录制从面板开始"的那张 closed-sample-1.png 应全 ✅；` +
    `游戏画面与选人帧应全 ❌。若不符，先把对应帧与本文一起发回。）`,
);
