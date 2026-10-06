/**
 * 诊断：用**真机面板帧**标定「单卡刷新（reroll）」的指纹阈值
 *
 * 为什么需要：Refresh 检测的阈值必须由真实数据定，不能凭感觉。它要卡在两个分布之间：
 *
 *   · **噪声组**（同一内容：重采样相位差 / 视频编码噪声 / 量化 / 模糊 / 亮度漂移 /
 *     卡片矩形 ±1~2px 抖动）→ 距离必须**低于**阈值，
 *     否则面板一开就假刷新（白跑 OCR，还会先把标签清掉）；
 *   · **真变化组**（把同一槽位换成**另一张真机卡** = 另一颗海克斯）
 *     → 距离必须**不低于**阈值，否则标签一直停在刷新前那颗上（用户报的那个 bug）。
 *
 * 两个分布都由 `packages/vision/src/augment-reroll.ts` 的**线上同一份纯函数**算出
 * （`augmentCardFingerprint` / `fingerprintDistance`，两区取最大值）——
 * 脚本里没有第二份实现。为了与局内一致，指纹算在**门控分辨率**上
 * （`gateCanvasWidth(targetScale = 1/3)`，与 `capture/worker.ts` 同一公式）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/diag-augment-reroll.mts [帧.png...]
 *
 * 默认底图（都不入库，见 .gitignore）：`debug/shots/inprogress-152515-raw.png`
 * 与 `debug/shots/inprogress-152509-raw.png`。这两张真机帧**卡1/卡2 是同一颗
 * 海克斯、卡3 真的被换过**（跨帧同槽位那一组会把它打出来）——
 * 正好一组"最干净的噪声样本" + 一个"真实的一次单卡刷新"。
 *
 * 退出码非 0 = 阈值没有把两个分布分开（需要重新标定，别直接上线）。
 *
 * 合规：只读本地 PNG 像素。不联网、不开游戏、不注入、不读内存。
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import {
  AUGMENT_FINGERPRINT_MIN_STD,
  AUGMENT_REROLL_THRESHOLD,
  augmentCardFingerprint,
  decodePng,
  detectAugmentPanel,
  fingerprintDistance,
  gateCanvasWidth,
  type AugmentCardFingerprint,
  type Bitmap,
  type Rect,
} from '../packages/vision/src/index.ts';

/* ------------------------------------------------------------------ */
/* 位图小工具（只用于"造同一内容的抖动"与"把另一张卡贴过来"）              */
/* ------------------------------------------------------------------ */

/** 盒式降采样（模拟门控画布）。 */
function downsample(bmp: Bitmap, factor: number): Bitmap {
  if (factor <= 1) return bmp;
  const w = Math.floor(bmp.width / factor);
  const h = Math.floor(bmp.height / factor);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          s += bmp.data[((y * factor + dy) * bmp.width + (x * factor + dx)) * 4]!;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      const v = s / n;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** 带**采样相位偏移**的裁剪（模拟"两次取帧的网格没对齐"）。 */
function shifted(bmp: Bitmap, dx: number, dy: number): Bitmap {
  const w = bmp.width - dx;
  const h = bmp.height - dy;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y + dy) * bmp.width + (x + dx)) * 4;
      const o = (y * w + x) * 4;
      data[o] = bmp.data[i]!;
      data[o + 1] = bmp.data[i + 1]!;
      data[o + 2] = bmp.data[i + 2]!;
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** 逐像素变换（亮度 / 噪声 / 量化）。 */
function transform(bmp: Bitmap, fn: (v: number) => number): Bitmap {
  const data = new Uint8ClampedArray(bmp.data.length);
  for (let i = 0; i < bmp.data.length; i += 4) {
    data[i] = fn(bmp.data[i]!);
    data[i + 1] = fn(bmp.data[i + 1]!);
    data[i + 2] = fn(bmp.data[i + 2]!);
    data[i + 3] = 255;
  }
  return { width: bmp.width, height: bmp.height, data };
}

/** 确定性伪随机（标定必须可复现）。 */
function rng(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** 3×3 盒式模糊（近似视频压缩/缩放的平滑）。 */
function blur(bmp: Bitmap): Bitmap {
  const out: Bitmap = {
    width: bmp.width,
    height: bmp.height,
    data: new Uint8ClampedArray(bmp.data.length),
  };
  for (let y = 0; y < bmp.height; y++) {
    for (let x = 0; x < bmp.width; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const sx = x + dx;
          const sy = y + dy;
          if (sx < 0 || sy < 0 || sx >= bmp.width || sy >= bmp.height) continue;
          s += bmp.data[(sy * bmp.width + sx) * 4]!;
          n++;
        }
      }
      const v = Math.round(s / n);
      const o = (y * bmp.width + x) * 4;
      out.data[o] = v;
      out.data[o + 1] = v;
      out.data[o + 2] = v;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** 把 `src` 帧里 `srcCard` 的内容**贴到** `dst` 帧的 `dstCard` 槽位（= 一次真实的重随）。 */
function pasteCard(dst: Bitmap, dstCard: Rect, src: Bitmap, srcCard: Rect): Bitmap {
  const out: Bitmap = { width: dst.width, height: dst.height, data: new Uint8ClampedArray(dst.data) };
  const x0 = Math.round(dstCard.x * dst.width);
  const y0 = Math.round(dstCard.y * dst.height);
  const w = Math.round(dstCard.w * dst.width);
  const h = Math.round(dstCard.h * dst.height);
  const sx0 = Math.round(srcCard.x * src.width);
  const sy0 = Math.round(srcCard.y * src.height);
  const sw = Math.round(srcCard.w * src.width);
  const sh = Math.round(srcCard.h * src.height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sxp = sx0 + Math.min(sw - 1, Math.round((x / w) * sw));
      const syp = sy0 + Math.min(sh - 1, Math.round((y / h) * sh));
      const si = (syp * src.width + sxp) * 4;
      const di = ((y0 + y) * dst.width + (x0 + x)) * 4;
      out.data[di] = src.data[si]!;
      out.data[di + 1] = src.data[si + 1]!;
      out.data[di + 2] = src.data[si + 2]!;
      out.data[di + 3] = 255;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 载入真机帧 → 门控分辨率 + 卡片 + 指纹                                 */
/* ------------------------------------------------------------------ */

interface Frame {
  readonly name: string;
  readonly gating: Bitmap;
  readonly cards: readonly Rect[];
  readonly fps: readonly AugmentCardFingerprint[];
}

const DEFAULTS = [
  'debug/shots/inprogress-152515-raw.png',
  'debug/shots/inprogress-152509-raw.png',
];

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const inputs = files.length > 0 ? files : DEFAULTS;

const frames: Frame[] = [];
for (const file of inputs) {
  let full: Bitmap;
  try {
    const img = decodePng(new Uint8Array(readFileSync(file)));
    full = { width: img.width, height: img.height, data: img.data };
  } catch (e) {
    console.error(`✗ ${file}：${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  // 与 capture/worker.ts 同一个门控画布宽度公式（targetScale 1/3、minWidth 960）
  const targetW = gateCanvasWidth(full.width, { targetScale: 1 / 3, minWidth: 960 });
  const factor = Math.max(1, Math.round(full.width / targetW));
  const gating = downsample(full, factor);
  const det = detectAugmentPanel(gating);
  if (!det.found || det.cards.length === 0) {
    console.warn(`⚠ ${file}：门控分辨率(${gating.width}×${gating.height})下未认定面板（${det.reason}）→ 跳过`);
    continue;
  }
  const rects = det.cards.map((c) => c.rect);
  const fps = rects.map((r) => augmentCardFingerprint(gating, r));
  if (fps.some((f) => f === null)) {
    console.warn(`⚠ ${file}：有卡算不出指纹 → 跳过`);
    continue;
  }
  frames.push({ name: basename(file), gating, cards: rects, fps: fps as AugmentCardFingerprint[] });
}

if (frames.length === 0) {
  console.error('✗ 没有可用帧（默认底图存在吗？debug/shots/inprogress-1525*-raw.png）');
  process.exit(1);
}

console.log('\n真机帧 → 门控画布（指纹区与线上同一份：整卡 16×16 + 图标 8×8）：');
for (const f of frames) {
  console.log(
    `  ${f.name.padEnd(30)} ${f.gating.width}×${f.gating.height}  卡片 ${f.cards.length} 张` +
      `  整卡区 std=[${f.fps.map((x) => x.std.toFixed(1)).join('/')}]`,
  );
}

/* ------------------------------------------------------------------ */
/* 噪声组 / 真变化组                                                     */
/* ------------------------------------------------------------------ */

interface Sample {
  readonly label: string;
  readonly d: number;
}

const base = frames[0]!;
const noise: Sample[] = [];
const rectStress: Sample[] = [];
const changes: Sample[] = [];
const crossFrame: Sample[] = [];
const frozenCrossFrame: Sample[] = [];

const noiseBmp = (amp: number): Bitmap => {
  const r = rng(11 + amp);
  const r2 = rng(29 + amp);
  return transform(base.gating, (v) => v + Math.round((r() + r2() - 1) * amp));
};

const jitters: Array<{ label: string; bmp: () => Bitmap }> = [
  { label: '采样相位 +1px', bmp: () => shifted(base.gating, 1, 0) },
  { label: '采样相位 +1,+1px', bmp: () => shifted(base.gating, 1, 1) },
  { label: '亮度 +12', bmp: () => transform(base.gating, (v) => v + 12) },
  { label: '亮度 −12', bmp: () => transform(base.gating, (v) => v - 12) },
  { label: '3×3 模糊', bmp: () => blur(base.gating) },
  { label: '量化 5bit（编码）', bmp: () => transform(base.gating, (v) => Math.round(v / 8) * 8) },
  { label: '均匀噪声 ±4', bmp: () => noiseBmp(4) },
  { label: '均匀噪声 ±8', bmp: () => noiseBmp(8) },
  {
    label: '组合（模糊+亮度+量化+噪声）',
    bmp: () => {
      const r = rng(97);
      return transform(blur(base.gating), (v) => Math.round(Math.max(0, Math.min(255, v - 8)) / 8) * 8 + Math.round((r() * 2 - 1) * 6));
    },
  },
];

for (const [i, card] of base.cards.entries()) {
  const baseFp = base.fps[i]!;
  for (const j of jitters) {
    const f = augmentCardFingerprint(j.bmp(), card);
    if (f) noise.push({ label: `卡${i + 1} ${j.label}`, d: fingerprintDistance(baseFp, f) });
  }
}

// 压力组：**卡片矩形 ±1~2px 抖动**。
// ⚠️ 局内不会出现这一项：面板停留期间取样矩形被**冻结**（worker 的 watchRects），
// 基线帧与本帧用的是同一个矩形。这里打出来是为了说明"为什么必须冻结"——
// 不冻结的话这一项单独就有 0.035，直接把噪声顶到阈值上。
for (const [i, card] of base.cards.entries()) {
  const baseFp = base.fps[i]!;
  for (const [dx, dy] of [[1, 0], [0, 1], [2, 0], [2, 2], [-1, 0], [0, -2]] as const) {
    const jittered: Rect = {
      x: card.x + dx / base.gating.width,
      y: card.y + dy / base.gating.height,
      w: card.w,
      h: card.h,
    };
    const f = augmentCardFingerprint(base.gating, jittered);
    if (f) rectStress.push({ label: `卡${i + 1} 矩形抖动 ${dx},${dy}px`, d: fingerprintDistance(baseFp, f) });
  }
}

// 真变化①：本帧内把槽位换成另一张卡（另一颗真实海克斯，几何完全一致）
for (const [i, card] of base.cards.entries()) {
  for (const [j, src] of base.cards.entries()) {
    if (i === j) continue;
    const f = augmentCardFingerprint(pasteCard(base.gating, card, base.gating, src), card);
    if (f) changes.push({ label: `卡${i + 1} ← 本帧卡${j + 1}`, d: fingerprintDistance(base.fps[i]!, f) });
  }
}

// 真变化② + 噪声：跨帧同槽位（两张真机帧）。卡1/卡2 是同一颗海克斯（应与噪声同量级），
// 卡3 真的被换过（真变化）—— 所以这一组单独打印，不混进上面两组。
for (let fi = 1; fi < frames.length; fi++) {
  const other = frames[fi]!;
  for (const [i, card] of base.cards.entries()) {
    const src = other.cards[i];
    if (!src) continue;
    const f = augmentCardFingerprint(pasteCard(base.gating, card, other.gating, src), card);
    if (f) {
      crossFrame.push({
        label: `卡${i + 1} ← ${other.name.slice(0, 24)} 的卡${i + 1}`,
        d: fingerprintDistance(base.fps[i]!, f),
      });
    }
  }
}

// 跨帧同槽位（**冻结矩形**）= 局内真实语义：面板停留期间取样矩形是**冻结**的
// （worker 的 `watchRects`），所以两帧都用**第一帧**检出的那组矩形取样，
// 第二帧的像素只换内容、不换矩形。上面那组是"贴过来"（会引入一次重采样），
// 这一组才是"面板开着不动、相隔几秒"时线上真正算出来的距离。
//
// 真机实测（`debug/shots/inprogress-1525{09,15}-raw.png`，相隔 6 秒、面板一直开着、
// 没有任何操作）：卡1/卡2 是同一颗海克斯（OCR 复核 缩小引擎 / 夜狩）→
// **0.0006 / 0.0001**（远低于阈值 0.03，即"待机画面不会被误判成刷新"）；
// 卡3 真的被换过 → 0.0681（用另一帧的卡3 矩形取样是 0.1054 —— 卡3 的检测矩形
// 随内容变过，两个方向都 ≥ 阈值，结论不变）。见 docs/AUGMENT-PANEL.md §十五 的复核表。
for (let fi = 1; fi < frames.length; fi++) {
  const other = frames[fi]!;
  for (const [i, card] of base.cards.entries()) {
    if (!other.cards[i]) continue;
    const f = augmentCardFingerprint(other.gating, card);
    if (f) {
      frozenCrossFrame.push({
        label: `卡${i + 1} ← ${other.name.slice(0, 24)}（冻结矩形）`,
        d: fingerprintDistance(base.fps[i]!, f),
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* 汇总与判读                                                          */
/* ------------------------------------------------------------------ */

function report(title: string, xs: readonly Sample[]): { min: number; max: number } {
  const ds = xs.map((x) => x.d);
  const sorted = [...ds].sort((a, b) => a - b);
  const min = sorted[0] ?? Number.NaN;
  const max = sorted[sorted.length - 1] ?? Number.NaN;
  const med = sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
  console.log(
    `\n${title}（${xs.length} 个样本）\n  距离 min ${min.toFixed(4)} / 中位 ${med.toFixed(4)} / max ${max.toFixed(4)}`,
  );
  const byDesc = [...xs].sort((a, b) => b.d - a.d);
  console.log(`  最大三个：${byDesc.slice(0, 3).map((w) => `${w.label}=${w.d.toFixed(4)}`).join('  ')}`);
  console.log(`  最小三个：${byDesc.slice(-3).reverse().map((w) => `${w.label}=${w.d.toFixed(4)}`).join('  ')}`);
  return { min, max };
}

const ns = report('噪声组（同一内容、同一取样矩形 → 必须 < 阈值）', noise);
report('压力组（同一内容、但取样矩形抖动 ±1~2px；局内已冻结矩形，不会出现）', rectStress);
const cs = report('真变化组（换成另一颗真实海克斯 → 必须 ≥ 阈值）', changes);
report('跨帧同槽位（两组混合：内容相同的那两个应与噪声同量级，卡3 是真变化）', crossFrame);
const fs = report(
  '跨帧同槽位 · **冻结矩形**（局内真实语义：面板开着不动时线上算的就是这一组）',
  frozenCrossFrame,
);

const threshold = AUGMENT_REROLL_THRESHOLD;
// 冻结矩形那一组是**混合**的：同一颗海克斯的那几张必须 < 阈值（待机/静态不误判），
// 真被换过的那张必须 ≥ 阈值（真实刷新不漏判）—— 两边都要有样本才算标定成立。
const frozenOk =
  frozenCrossFrame.length === 0 ||
  (Number.isFinite(fs.min) && Number.isFinite(fs.max) && fs.min < threshold && fs.max >= threshold);
const ok =
  Number.isFinite(ns.max) &&
  Number.isFinite(cs.min) &&
  ns.max < threshold &&
  cs.min >= threshold &&
  frozenOk;
console.log(
  `\n线上阈值 = ${threshold}（AUGMENT_REROLL_THRESHOLD，两区取最大值）` +
    `\n  对噪声的余量：阈值 / 噪声上界 = ${(threshold / Math.max(1e-9, ns.max)).toFixed(2)}×` +
    `\n  对真变化的余量：真变化下界 / 阈值 = ${(cs.min / threshold).toFixed(2)}×` +
    (frozenCrossFrame.length > 0
      ? `\n  冻结矩形跨帧：同内容最小 ${fs.min.toFixed(4)}（须 < 阈值）/ 真变化最大 ${fs.max.toFixed(4)}（须 ≥ 阈值）`
      : '') +
    `\n  "已成形"下限 std = ${AUGMENT_FINGERPRINT_MIN_STD}（实测整卡区 std 见上表；空白/翻转中间帧远低于它）`,
);
console.log(
  ok
    ? '\n✅ 阈值把两个分布分开了：噪声全部低于阈值、真变化全部不低于阈值。'
    : '\n❌ 阈值没有分开两个分布 —— 需要重新标定（不要直接上线）。',
);
process.exit(ok ? 0 : 1);
