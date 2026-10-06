/**
 * 诊断：海克斯卡面**图标匹配**验证（v2：保纵横比归一化 + alpha 掩码）
 *
 * v1 失败的两个根因（都已修）：
 *   1. **参考图标是带 alpha 的**（不透明 18.7%），掩码必须用 alpha，
 *      而不是"亮度偏离背景"——透明底上算亮度差没有意义；
 *   2. 把两边墨迹包围盒**硬拉到正方形**会按不同系数拉伸（两个裁剪框不同），
 *      形状直接错位。正确做法是**保纵横比**、把长边缩到网格、居中留白。
 *
 * 另一条 v1 的教训：卡内搜索区不能太大 —— 卡片亮边框/内发光落在 6% 内缩区里，
 * 会把包围盒撑成整张卡宽，掩码被边框主导（所有模板都 0.2 分）。收紧到卡内中央。
 *
 * 用法：
 *   node --experimental-strip-types scripts/diag-augment-cards.mts --fetch-icons
 *   node --experimental-strip-types scripts/diag-augment-cards.mts debug/shots/inprogress-152515-raw.png
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  decodePng,
  detectAugmentPanel,
  extractGrayRaw,
  type Bitmap,
  type Rect,
} from '../packages/vision/src/index.ts';

const REF_DIR = join('debug', 'augment-ref');
const ALL_DIR = join(REF_DIR, 'all');
const GRID = 48;
/** 卡面墨迹：亮度偏离卡内背景超过此值即为"有东西"。 */
const INK_DELTA = 35;

/** 卡面图标区（**卡内**归一化）：y 4%~42% 是图标带，42% 以下开始是名字/描述。 */
const CARD_ICON_ZONE: Rect = { x: 0.1, y: 0.04, w: 0.8, h: 0.38 };

const DATA = JSON.parse(readFileSync(join('data', 'dataset.json'), 'utf8')) as {
  hextechs: Array<{
    id: number;
    augmentNameId: string;
    name: string;
    rarity: string;
    modes?: string[];
    largeIcon?: string;
  }>;
};
type Hex = (typeof DATA)['hextechs'][number];

/* ------------------------------------------------------------------ */
/* 掩码：像素级 → 保纵横比 → 网格                                         */
/* ------------------------------------------------------------------ */

interface Mask {
  readonly bits: Uint8Array;
  readonly inkRatio: number;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * 保纵横比网格化：长边缩到 `grid`，短边居中留白。
 *
 * ⚠️ 不能两边都硬拉到正方形：两个裁剪框的纵横比不同，拉伸系数就不同，
 * 形状会错位（v1 的真实失败原因）。
 */
function toGrid(box: Box, grid: number, inkAt: (x: number, y: number) => boolean): Mask {
  const bw = box.x1 - box.x0 + 1;
  const bh = box.y1 - box.y0 + 1;
  const bits = new Uint8Array(grid * grid);
  if (bw <= 0 || bh <= 0) return { bits, inkRatio: 0 };
  const scale = grid / Math.max(bw, bh);
  const tw = Math.max(1, Math.round(bw * scale));
  const th = Math.max(1, Math.round(bh * scale));
  const ox = Math.floor((grid - tw) / 2);
  const oy = Math.floor((grid - th) / 2);
  let ink = 0;
  let total = 0;
  for (let ty = 0; ty < th; ty++) {
    const sy0 = box.y0 + Math.floor((ty * bh) / th);
    const sy1 = Math.max(sy0 + 1, box.y0 + Math.floor(((ty + 1) * bh) / th));
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = box.x0 + Math.floor((tx * bw) / tw);
      const sx1 = Math.max(sx0 + 1, box.x0 + Math.floor(((tx + 1) * bw) / tw));
      let on = 0;
      let n = 0;
      for (let y = sy0; y < sy1; y++) {
        for (let x = sx0; x < sx1; x++) {
          if (inkAt(x, y)) on++;
          n++;
        }
      }
      const v = n > 0 && on / n >= 0.5 ? 1 : 0;
      bits[(oy + ty) * grid + ox + tx] = v;
      if (v === 1) ink++;
      total++;
    }
  }
  return { bits, inkRatio: total > 0 ? ink / total : 0 };
}

/** 参考图标：**用 alpha** 定形状（透明底，亮度差无意义）。 */
function refMask(bmp: Bitmap, grid = GRID): Mask {
  const { width, height, data } = bmp;
  const inkAt = (x: number, y: number): boolean => data[(y * width + x) * 4 + 3]! > 128;
  const box: Box = { x0: width, y0: height, x1: -1, y1: -1 };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inkAt(x, y)) continue;
      if (x < box.x0) box.x0 = x;
      if (x > box.x1) box.x1 = x;
      if (y < box.y0) box.y0 = y;
      if (y > box.y1) box.y1 = y;
    }
  }
  return toGrid(box, grid, inkAt);
}

/** 卡面：卡内图标区 → 亮度偏离背景为墨迹 → 裁剪到墨迹包围盒 → 保纵横比网格化。 */
function cardIconMask(bmp: Bitmap, card: Rect, grid = GRID): Mask | null {
  const zone: Rect = {
    x: card.x + card.w * CARD_ICON_ZONE.x,
    y: card.y + card.h * CARD_ICON_ZONE.y,
    w: card.w * CARD_ICON_ZONE.w,
    h: card.h * CARD_ICON_ZONE.h,
  };
  const g = extractGrayRaw(bmp, zone);
  if (!g) return null;
  const hist = new Uint32Array(256);
  for (const v of g.gray) hist[v]!++;
  let bg = 0;
  let bestN = -1;
  for (let i = 0; i < 256; i++) {
    if (hist[i]! > bestN) {
      bestN = hist[i]!;
      bg = i;
    }
  }
  const inkAt = (x: number, y: number): boolean => Math.abs(g.gray[y * g.width + x]! - bg) > INK_DELTA;
  const box: Box = { x0: g.width, y0: g.height, x1: -1, y1: -1 };
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      if (!inkAt(x, y)) continue;
      if (x < box.x0) box.x0 = x;
      if (x > box.x1) box.x1 = x;
      if (y < box.y0) box.y0 = y;
      if (y > box.y1) box.y1 = y;
    }
  }
  if (box.x1 < box.x0) return null;
  return toGrid(box, grid, inkAt);
}

function jaccard(a: Uint8Array, b: Uint8Array): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === 1 || y === 1) union++;
    if (x === 1 && y === 1) inter++;
  }
  return union === 0 ? 0 : inter / union;
}

/* ------------------------------------------------------------------ */
/* 参考集                                                               */
/* ------------------------------------------------------------------ */

function loadRefs(): Array<{ hex: Hex; mask: Mask }> {
  const out: Array<{ hex: Hex; mask: Mask }> = [];
  for (const hex of DATA.hextechs) {
    try {
      const img = decodePng(new Uint8Array(readFileSync(join(ALL_DIR, `${hex.id}.png`))));
      out.push({ hex, mask: refMask({ width: img.width, height: img.height, data: img.data }) });
    } catch {
      /* 未下载 */
    }
  }
  return out;
}

async function fetchIcons(): Promise<void> {
  mkdirSync(ALL_DIR, { recursive: true });
  let ok = 0;
  for (const hex of DATA.hextechs) {
    if (!(hex.modes ?? []).includes('KIWI') || !hex.largeIcon) continue;
    try {
      const r = await fetch(hex.largeIcon, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      writeFileSync(join(ALL_DIR, `${hex.id}.png`), Buffer.from(await r.arrayBuffer()));
      ok++;
    } catch {
      /* 记数在调用方 */
    }
  }
  console.log(`图标下载：${ok} 个 → ${ALL_DIR}`);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const files = argv.filter((a) => !a.startsWith('--'));
if (argv.includes('--fetch-icons')) {
  await fetchIcons();
  if (files.length === 0) process.exit(0);
}

const refs = loadRefs();
console.log(`参考图标 ${refs.length} 个（alpha 掩码，${GRID}×${GRID} 保纵横比）\n`);

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
  console.log(`=== ${basename(file)} 卡片 ${det.cards.length} 张 ===`);
  for (const [i, card] of det.cards.entries()) {
    const q = cardIconMask(bmp, card.rect);
    if (!q) {
      console.log(`  卡${i + 1} 掩码失败`);
      continue;
    }
    const scored = refs
      .map((r) => ({ hex: r.hex, score: jaccard(q.bits, r.mask.bits) }))
      .sort((a, b) => b.score - a.score);
    console.log(`  卡${i + 1} 墨迹占比=${(q.inkRatio * 100).toFixed(1)}%`);
    for (const s of scored.slice(0, 4)) {
      console.log(
        `      ${s.hex.name.padEnd(12)} ${String(s.hex.id).padEnd(5)} ${s.hex.augmentNameId.padEnd(26)} ${s.score.toFixed(3)}`,
      );
    }
    console.log(`      分差 ${(scored[0]!.score - (scored[1]?.score ?? 0)).toFixed(3)}`);
  }
  console.log();
}
