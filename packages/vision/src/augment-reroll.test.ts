/**
 * 单卡刷新（reroll）检测测试
 *
 * 锁住四件事（每一条都对应一个真实失效模式）：
 *   ① **同内容不判变**：同一张卡连算两帧指纹 → 距离 0、不判刷新；
 *   ② **内容替换要判出来**：把卡上的图标/名字/描述换成另一套（合成像素，
 *      以及"整块换掉"的真实做法：换另一张卡的画面）→ 判定刷新；
 *   ③ **噪声/压缩抖动不判变**：±灰度噪声、子像素偏移、降采样相位不同、
 *      轻度模糊、**整体亮度平移**（技能闪光）都不能触发；
 *   ④ 边界：没有基线 / 指纹为 null / 网格尺寸不符 / 零尺寸卡 / 越界卡都不炸、不误报；
 *      以及"**覆盖窗自己画的标签区不参与指纹**"（否则每开一次面板都会假刷新一次）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUGMENT_FINGERPRINT_MAIN_ZONE,
  AUGMENT_FINGERPRINT_MIN_STD,
  AUGMENT_FINGERPRINT_ZONE,
  AUGMENT_FINGERPRINT_ZONES,
  AUGMENT_REROLL_THRESHOLD,
  augmentCardFingerprint,
  augmentFingerprintRect,
  augmentWatchFingerprints,
  fingerprintDistance,
  fingerprintIsFlat,
  isCardRerolled,
  mergeRefreshedCards,
  rerolledCardIndices,
  type AugmentCardFingerprint,
  type RerollCardState,
} from './augment-reroll.ts';
import type { Bitmap, Rect } from './types.ts';
import { augmentTierLabels } from './augment-tier-label.ts';

/* ------------------------------------------------------------------ */
/* 合成位图：一张假海克斯卡（帧 1000×1000，卡 200×400 像素）              */
/* ------------------------------------------------------------------ */

const FRAME = { width: 1000, height: 1000 };
/** 卡片矩形（归一化）：200×400 像素，正好是海克斯卡的纵横比（≈1:1.56）。 */
const CARD: Rect = { x: 0.2, y: 0.15, w: 0.2, h: 0.4 };

/** 确定性伪随机（不用 Math.random：测试必须可复现）。 */
function rng(seed: number): () => number {
  let s = (seed | 0) || 1;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function px(bmp: Bitmap, x: number, y: number, v: number): void {
  if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return;
  const i = (y * bmp.width + x) * 4;
  bmp.data[i] = v;
  bmp.data[i + 1] = v;
  bmp.data[i + 2] = v;
  bmp.data[i + 3] = 255;
}

function fill(bmp: Bitmap, rect: Rect, v: number): void {
  const x0 = Math.round(rect.x * bmp.width);
  const y0 = Math.round(rect.y * bmp.height);
  const x1 = Math.round((rect.x + rect.w) * bmp.width);
  const y1 = Math.round((rect.y + rect.h) * bmp.height);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px(bmp, x, y, v);
}

/**
 * 用 `fn(u, v)`（u/v = 区内 0..1）铺一块**有渐变**的内容。
 *
 * 为什么要渐变而不是纯色块：真机卡面的图标是**带明暗渐变的插画**、文字有抗锯齿，
 * 而纯色硬块会在"再加一次压缩平滑"时产生远大于现实的结构变化
 * （实测硬块 3×3 模糊 → 0.032，真机帧同一操作 → ≤0.013）。
 */
function fillPattern(bmp: Bitmap, rect: Rect, fn: (u: number, v: number) => number): void {
  const x0 = Math.round(rect.x * bmp.width);
  const y0 = Math.round(rect.y * bmp.height);
  const w = Math.max(1, Math.round(rect.w * bmp.width));
  const h = Math.max(1, Math.round(rect.h * bmp.height));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) px(bmp, x0 + x, y0 + y, Math.round(fn((x + 0.5) / w, (y + 0.5) / h)));
  }
}

/** 径向光斑（图标那种"中间亮、往外渐暗"的插画）：`peak` 亮、`base` 暗。 */
function blob(peak: number, base: number, cx = 0.5, cy = 0.5, r = 0.75): (u: number, v: number) => number {
  return (u, v) => {
    const d = Math.hypot(u - cx, v - cy) / r;
    const k = Math.max(0, 1 - d * d);
    return base + (peak - base) * k * k;
  };
}

/** 一条软边横条（文字行）：纵向按到中心的距离淡出。 */
function softBar(peak: number, base: number, falloff = 0.5): (u: number, v: number) => number {
  return (_u, v) => {
    const k = Math.max(0, 1 - Math.abs(v - 0.5) / falloff);
    return base + (peak - base) * k * k * (0.75 + 0.25 * Math.sin(_u * Math.PI * 3));
  };
}

/** 卡内归一化矩形 → 截屏归一化。 */
function inCard(card: Rect, r: Rect): Rect {
  return { x: card.x + card.w * r.x, y: card.y + card.h * r.y, w: card.w * r.w, h: card.h * r.h };
}

/**
 * 卡内多次 3×3 盒式平滑（让合成内容像真机那样"没有硬边"）。
 *
 * ⚠️ 为什么要**两遍**：门控画布本身就是"视频流 → 降采样"的产物（已经挺糊），
 * 而合成图是逐像素画出来的硬块。只平滑一遍时，再叠一次 3×3 模糊会测出 0.031
 * 的距离（≈ 阈值 0.03），而真机帧上同一操作只有 **≤0.013**（见
 * `scripts/diag-augment-reroll.mts` 的输出）—— 那是合成图比现实更锐利造成的偏差。
 */
function softenCard(bmp: Bitmap, passes = 2): void {
  const x0 = Math.round(CARD.x * bmp.width);
  const y0 = Math.round(CARD.y * bmp.height);
  const x1 = Math.round((CARD.x + CARD.w) * bmp.width);
  const y1 = Math.round((CARD.y + CARD.h) * bmp.height);
  for (let pass = 0; pass < passes; pass++) {
    const src = new Uint8ClampedArray(bmp.data);
    for (let y = y0 + 1; y < y1 - 1; y++) {
      for (let x = x0 + 1; x < x1 - 1; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) sum += src[((y + dy) * bmp.width + x + dx) * 4]!;
        }
        px(bmp, x, y, Math.round(sum / 9));
      }
    }
  }
}

/**
 * 造一张卡面：`variant` 决定图标/名字/描述三块的位置与亮度（结构不同 = 换了一颗海克斯）。
 *
 * 三块内容画完会**先做一遍 3×3 平滑**（`softenCard`）：真机画面里没有 1 像素的
 * 硬边（文字有抗锯齿、图标是带渐变的插画），而合成图直接画硬块会让"再加一次
 * 模糊"显得比现实严重得多。平滑之后，噪声组里的 `blur: true` 才是"真实内容的
 * 一次压缩平滑"，与真机帧上量到的量级可比。
 *
 * 额外的 `opts` 用来造"同一内容的噪声版本"：
 *   · `noise`：全图叠加 ±noise 灰度；
 *   · `shift`：整张卡的内容在卡内平移 `shift` 卡内比例（模拟重采样/子像素偏移）；
 *   · `brightness`：全图整体加一个常数（技能闪光）；
 *   · `blur`：3×3 盒式模糊一次（模拟压缩/缩放）；
 *   · `label`：在**卡底标签区**画一个大字母（模拟覆盖窗自己画上去的强度标签）。
 */
function makeCardBmp(
  variant: 'a' | 'b',
  opts: {
    noise?: number;
    shift?: number;
    brightness?: number;
    blur?: boolean;
    label?: 'none' | 'S';
  } = {},
): Bitmap {
  const bmp: Bitmap = {
    width: FRAME.width,
    height: FRAME.height,
    data: new Uint8ClampedArray(FRAME.width * FRAME.height * 4),
  };
  fill(bmp, { x: 0, y: 0, w: 1, h: 1 }, 12);
  // 卡体：暗底 + 亮边框（与真机一样：内部 ~25、边框 ~155）
  fill(bmp, CARD, 150);
  fill(bmp, inCard(CARD, { x: 0.03, y: 0.02, w: 0.94, h: 0.96 }), 26);

  const s = opts.shift ?? 0;
  const put = (r: Rect, v: number): void =>
    fill(bmp, inCard(CARD, { x: r.x + s, y: r.y + s, w: r.w, h: r.h }), v);
  const pattern = (r: Rect, fn: (u: number, v: number) => number): void =>
    fillPattern(bmp, inCard(CARD, { x: r.x + s, y: r.y + s, w: r.w, h: r.h }), fn);

  if (variant === 'a') {
    pattern({ x: 0.2, y: 0.09, w: 0.6, h: 0.26 }, blob(215, 26)); // 图标（中心亮、往外渐暗）
    pattern({ x: 0.15, y: 0.44, w: 0.7, h: 0.06 }, softBar(240, 26)); // 名字
    pattern({ x: 0.15, y: 0.6, w: 0.7, h: 0.1 }, softBar(150, 26, 0.7)); // 描述
  } else {
    pattern({ x: 0.12, y: 0.12, w: 0.32, h: 0.2 }, blob(190, 26, 0.4, 0.55, 0.5)); // 图标（偏左、小）
    pattern({ x: 0.55, y: 0.16, w: 0.3, h: 0.14 }, blob(240, 26, 0.5, 0.5, 0.9));
    pattern({ x: 0.15, y: 0.45, w: 0.5, h: 0.05 }, softBar(225, 26)); // 名字（更短）
    pattern({ x: 0.15, y: 0.58, w: 0.7, h: 0.06 }, softBar(155, 26, 0.6)); // 描述（两行）
    pattern({ x: 0.15, y: 0.66, w: 0.6, h: 0.05 }, softBar(110, 26, 0.6));
  }

  // 覆盖窗画的强度标签：在卡底空白区（y 0.79~0.93），**必须不参与指纹**
  if (opts.label === 'S') {
    pattern({ x: 0.36, y: 0.8, w: 0.28, h: 0.12 }, blob(250, 26, 0.5, 0.5, 0.9));
  }

  if (opts.shift) {
    // 平移后卡外会露出背景：把卡的边缘补一层暗底，避免把"露底"误当结构差异
    fill(bmp, inCard(CARD, { x: 0, y: 0, w: 0.04, h: 1 }), 26);
    fill(bmp, inCard(CARD, { x: 0.96, y: 0, w: 0.04, h: 1 }), 26);
  }

  // 真机内容没有 1 像素硬边：整卡先平滑一遍（见函数头注）
  softenCard(bmp);

  if (opts.brightness) {
    for (let i = 0; i < bmp.data.length; i += 4) {
      const v = bmp.data[i]! + opts.brightness;
      bmp.data[i] = v;
      bmp.data[i + 1] = v;
      bmp.data[i + 2] = v;
    }
  }

  if (opts.noise) {
    const r = rng(7);
    for (let i = 0; i < bmp.data.length; i += 4) {
      const d = Math.round((r() * 2 - 1) * opts.noise);
      const v = bmp.data[i]! + d;
      bmp.data[i] = v;
      bmp.data[i + 1] = v;
      bmp.data[i + 2] = v;
    }
  }

  if (opts.blur) {
    const src = new Uint8ClampedArray(bmp.data);
    for (let y = 1; y < bmp.height - 1; y++) {
      for (let x = 1; x < bmp.width - 1; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) sum += src[((y + dy) * bmp.width + x + dx) * 4]!;
        }
        px(bmp, x, y, Math.round(sum / 9));
      }
    }
  }

  return bmp;
}

function fp(bmp: Bitmap, card: Rect = CARD): AugmentCardFingerprint {
  const f = augmentCardFingerprint(bmp, card);
  assert.ok(f, '指纹应能算出来');
  return f;
}

/** 两张位图逐像素取平均（造"卡片翻转的中间帧"：两张卡面各半）。 */
function avgBmp(x: Bitmap, y: Bitmap): Bitmap {
  const data = new Uint8ClampedArray(x.data.length);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.round((x.data[i]! + y.data[i]!) / 2);
    data[i + 1] = Math.round((x.data[i + 1]! + y.data[i + 1]!) / 2);
    data[i + 2] = Math.round((x.data[i + 2]! + y.data[i + 2]!) / 2);
    data[i + 3] = 255;
  }
  return { width: x.width, height: x.height, data };
}

/* ------------------------------------------------------------------ */
/* 指纹取样区                                                          */
/* ------------------------------------------------------------------ */

test('指纹取样区：整体区在卡内上部（不含卡底标签带）+ 图标区，网格 16/8', () => {
  const r = augmentFingerprintRect(CARD);
  assert.ok(Math.abs(r.x - (CARD.x + CARD.w * 0.1)) < 1e-12);
  assert.ok(Math.abs(r.w - CARD.w * 0.8) < 1e-12);
  // 整体区必须整个落在标签带（标签顶 ≥ 卡内 0.788）之上
  const top = AUGMENT_FINGERPRINT_ZONE.y;
  const bottom = AUGMENT_FINGERPRINT_ZONE.y + AUGMENT_FINGERPRINT_ZONE.h;
  assert.equal(top, 0.06);
  assert.ok(bottom <= 0.78, `取样区下沿 ${bottom} 必须低于标签带（标签实测从卡内 0.788 起）`);
  assert.ok(bottom > 0.713, '取样区要包住最长描述（实测 0.713），否则换了描述也看不出来');
  assert.equal(AUGMENT_FINGERPRINT_ZONE.x + AUGMENT_FINGERPRINT_ZONE.w, 0.9);
  // 两区：整体区（16×16）+ 图标区（8×8）；主区必须是整体区
  assert.deepEqual(AUGMENT_FINGERPRINT_ZONES.map((z) => z.name), ['body', 'icon']);
  assert.deepEqual(AUGMENT_FINGERPRINT_ZONES.map((z) => z.grid), [16, 8]);
  assert.equal(AUGMENT_FINGERPRINT_MAIN_ZONE, 0);
  const icon = AUGMENT_FINGERPRINT_ZONES[1]!;
  assert.ok(icon.zone.y >= 0.06 && icon.zone.y + icon.zone.h <= 0.4, '图标区落在真机图标位置(0.07~0.37)内');
  assert.ok(icon.zone.x > 0.1 && icon.zone.x + icon.zone.w < 0.9, '图标区在整体区内部');
});

test('指纹：同内容 → 距离 0；不同内容 → 距离远大于阈值', () => {
  const a1 = fp(makeCardBmp('a'));
  const a2 = fp(makeCardBmp('a'));
  const b = fp(makeCardBmp('b'));
  assert.equal(fingerprintDistance(a1, a2), 0, '同一内容两次取样必须完全一致');
  const d = fingerprintDistance(a1, b);
  assert.ok(d > AUGMENT_REROLL_THRESHOLD * 1.8, `换了一颗海克斯的距离 ${d.toFixed(3)} 应远大于阈值`);
  assert.ok(d <= 1);
  // 指纹是两区灰度格 + 统计
  assert.equal(a1.parts.length, 2);
  assert.equal(a1.cells.length, 256);
  assert.equal(a1.size, 16);
  assert.equal(a1.parts[0]!.cells.length, 256);
  assert.equal(a1.parts[1]!.cells.length, 64);
  assert.ok(a1.mean > 0 && a1.mean < 255);
  assert.ok(a1.std > AUGMENT_FINGERPRINT_MIN_STD, '真卡片取样区应有明显结构（std 不低）');
});

/* ------------------------------------------------------------------ */
/* ① 同内容 / ② 内容替换                                                */
/* ------------------------------------------------------------------ */

test('① 同内容不判刷新（连续两帧、以及重算指纹）', () => {
  const baseline = [fp(makeCardBmp('a')), fp(makeCardBmp('b'))];
  const current = [fp(makeCardBmp('a')), fp(makeCardBmp('b'))];
  assert.deepEqual(rerolledCardIndices({ baseline, current }), []);
  assert.equal(isCardRerolled(baseline[0]!, current[0]!), false);
});

test('② 内容替换判刷新：只报变化的那张卡', () => {
  const baseline = [fp(makeCardBmp('a')), fp(makeCardBmp('b')), fp(makeCardBmp('a'))];
  // 卡2 换成了另一颗（a → b），其余两张原样
  const current = [fp(makeCardBmp('a')), fp(makeCardBmp('a')), fp(makeCardBmp('a'))];
  assert.deepEqual(rerolledCardIndices({ baseline, current }), [1]);
  // 三张一起换 → 三张都报（不能只处理一张）
  const all = [fp(makeCardBmp('b')), fp(makeCardBmp('a')), fp(makeCardBmp('b'))];
  assert.deepEqual(rerolledCardIndices({ baseline, current: all }), [0, 1, 2]);
});

/* ------------------------------------------------------------------ */
/* ③ 噪声 / 压缩抖动 / 亮度                                              */
/* ------------------------------------------------------------------ */

test('③ 噪声与压缩抖动**不**判刷新（阈值能容忍编码噪声）', () => {
  const baseline = [fp(makeCardBmp('a'))];
  // 这一组是**比真机更严**的压力样本：合成内容的边缘仍比真机帧锐利，
  // 真机帧上同一操作的实测上界是 0.013（见 scripts/diag-augment-reroll.mts），
  // 这里允许到 0.021 左右——仍然全部低于阈值 0.03。
  const noisy = [
    fp(makeCardBmp('a', { noise: 4 })),
    fp(makeCardBmp('a', { noise: 8 })),
    fp(makeCardBmp('a', { blur: true })),
    fp(makeCardBmp('a', { shift: 0.004 })), // 卡内 0.4% ≈ 1.6 像素的采样相位差
    fp(makeCardBmp('a', { shift: -0.004 })),
    fp(makeCardBmp('a', { noise: 6, blur: true, shift: 0.003 })),
  ];
  for (const [i, f] of noisy.entries()) {
    const d = fingerprintDistance(baseline[0]!, f);
    assert.ok(
      d < AUGMENT_REROLL_THRESHOLD,
      `抖动样本 #${i} 的距离 ${d.toFixed(4)} 必须低于阈值 ${AUGMENT_REROLL_THRESHOLD}`,
    );
    assert.deepEqual(rerolledCardIndices({ baseline, current: [f] }), [], `抖动样本 #${i} 不该判刷新`);
  }
  // 同时对比：真变化的距离量级必须明显更大（阈值不是"两边都卡住"）
  const real = fingerprintDistance(baseline[0]!, fp(makeCardBmp('b')));
  const worstNoise = Math.max(
    ...noisy.map((f) => fingerprintDistance(baseline[0]!, f)),
  );
  assert.ok(real > worstNoise * 5, `真变化 ${real.toFixed(3)} 应比最坏抖动 ${worstNoise.toFixed(4)} 大得多`);
});

test('③ 整体亮度变化（技能闪光）不判刷新：距离按"去均值结构"算', () => {
  const baseline = [fp(makeCardBmp('a'))];
  for (const brightness of [-20, -8, 8, 20]) {
    const f = fp(makeCardBmp('a', { brightness }));
    assert.ok(
      fingerprintDistance(baseline[0]!, f) < AUGMENT_REROLL_THRESHOLD,
      `整体亮度 ${brightness >= 0 ? '+' : ''}${brightness} 不该判成刷新`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* 覆盖窗自己画的标签不参与指纹（否则每次开面板都会假刷新一次）              */
/* ------------------------------------------------------------------ */

test('覆盖窗画在卡底的强度标签**不**影响指纹（取样区刻意避开标签带）', () => {
  const noLabel = fp(makeCardBmp('a', { label: 'none' }));
  const withLabel = fp(makeCardBmp('a', { label: 'S' }));
  assert.equal(fingerprintDistance(noLabel, withLabel), 0, '标签画在卡底，指纹区不该看到它');
  assert.deepEqual(rerolledCardIndices({ baseline: [noLabel], current: [withLabel] }), []);
  // 而"标签换了个字母"（S → A）同理
  const labelA = fp(makeCardBmp('a', { label: 'S' }));
  assert.deepEqual(rerolledCardIndices({ baseline: [withLabel], current: [labelA] }), []);
});

/* ------------------------------------------------------------------ */
/* 动画中间帧（空白/未成形）与"画面已稳定"确认                            */
/* ------------------------------------------------------------------ */

test('未成形的中间帧（纯色/发白）不判定，等下一帧', () => {
  const blank: Bitmap = {
    width: FRAME.width,
    height: FRAME.height,
    data: new Uint8ClampedArray(FRAME.width * FRAME.height * 4),
  };
  fill(blank, CARD, 200); // 整块纯色（卡片翻转的中间帧）
  const flat = fp(blank);
  assert.equal(fingerprintIsFlat(flat), true, '纯色 → std 0 → 未成形');
  assert.ok(flat.std < AUGMENT_FINGERPRINT_MIN_STD);
  const baseline = [fp(makeCardBmp('a'))];
  assert.equal(isCardRerolled(baseline[0]!, flat), false, '未成形的帧不下判定');
  assert.deepEqual(rerolledCardIndices({ baseline, current: [flat] }), []);
});

test('给 `previous` 时要求画面已稳定：还在变的中间帧不判，稳定后（连续两帧一致）才判', () => {
  const baseline = [fp(makeCardBmp('a'))];
  // 动画中间帧：卡片翻转中（两张卡面各半）—— 与基线差异很大，**也与最终帧不同**
  const mid = fp(avgBmp(makeCardBmp('a'), makeCardBmp('b')));
  assert.ok(
    fingerprintDistance(baseline[0]!, mid) >= AUGMENT_REROLL_THRESHOLD,
    '中间帧相对基线确实已经变了',
  );
  assert.deepEqual(
    rerolledCardIndices({ baseline, current: [mid], previous: baseline }),
    [],
    '还在变的中间帧不该触发重识别（白跑 OCR，还会先清掉标签）',
  );
  // 新卡成形、但上一帧还是中间帧 → 再多等一帧（"连续两帧一致"才算稳定）
  const settled = fp(makeCardBmp('b'));
  assert.deepEqual(rerolledCardIndices({ baseline, current: [settled], previous: [mid] }), []);
  // 下一帧：与上一帧一致 → 判刷新
  assert.deepEqual(rerolledCardIndices({ baseline, current: [settled], previous: [settled] }), [0]);
  // 没给 previous 时只看基线（老行为：立即判定）
  assert.deepEqual(rerolledCardIndices({ baseline, current: [mid] }), [0]);
});

/* ------------------------------------------------------------------ */
/* ④ 边界                                                              */
/* ------------------------------------------------------------------ */

test('④ 边界：没有基线 / 指纹缺失 / 网格不符 / 尺寸非法都不误报也不炸', () => {
  const a = fp(makeCardBmp('a'));
  const b = fp(makeCardBmp('b'));
  // 没有基线 → 不判（基线必须来自"画上去的那一帧"）
  assert.deepEqual(rerolledCardIndices({ baseline: null, current: [b] }), []);
  assert.deepEqual(rerolledCardIndices({ baseline: [], current: [b] }), []);
  assert.deepEqual(rerolledCardIndices({ baseline: [a], current: null }), []);
  // 某张卡这一帧取不到指纹 → 该卡不判，但不影响别的卡
  assert.deepEqual(rerolledCardIndices({ baseline: [a, a], current: [null, b] }), [1]);
  assert.equal(isCardRerolled(null, b), false);
  assert.equal(isCardRerolled(a, null), false);
  // 不可比 → 距离取 1（但 isCardRerolled 只在两侧都有时才算）
  const otherGrid = augmentCardFingerprint(makeCardBmp('a'), CARD, {
    zones: [{ name: 'body', zone: AUGMENT_FINGERPRINT_ZONE, grid: 8 }],
  });
  assert.ok(otherGrid);
  assert.equal(fingerprintDistance(a, otherGrid), 1, '取样区数/网格不同 → 不可比');
  assert.equal(fingerprintDistance(null, otherGrid), 1);
  // 卡数不一致：只比较公共前缀
  assert.deepEqual(rerolledCardIndices({ baseline: [a, a, a], current: [b, b] }), [0, 1]);
  // 非法卡片（零尺寸/越界）→ 指纹算不出来（不抛异常）
  assert.equal(augmentCardFingerprint(makeCardBmp('a'), { x: 0.5, y: 0.5, w: 0, h: 0 }), null);
  assert.equal(augmentCardFingerprint(makeCardBmp('a'), { x: 0.99, y: 0.99, w: 0.2, h: 0.2 }), null);
  assert.equal(augmentCardFingerprint(makeCardBmp('a'), { x: -0.1, y: 0.2, w: 0.2, h: 0.2 }), null);
  assert.equal(fingerprintIsFlat(null), true, '没有指纹视为"未成形"');
  // 先验：阈值本身要落在两个量级之间
  assert.ok(AUGMENT_REROLL_THRESHOLD > 0.02 && AUGMENT_REROLL_THRESHOLD < 0.12);
});

/* ------------------------------------------------------------------ */
/* 合并：只换变化的那张卡，认不出就清掉它                                 */
/* ------------------------------------------------------------------ */

test('mergeRefreshedCards：只替换变化的那张，其余原样；认不出 → 该卡 augmentId 置 null', () => {
  const prev: RerollCardState[] = [
    { rect: CARD, augmentId: 1373, name: '缩小引擎' },
    { rect: CARD, augmentId: 1326, name: '夜狩' },
    { rect: CARD, augmentId: 1136, name: '威能之追求' },
  ];
  // 卡2 重认成另一颗 → 只有它变；卡1/卡3 原对象不动
  const merged = mergeRefreshedCards(prev, [1], [{ rect: CARD, augmentId: 2116, name: '坦克引擎' }]);
  assert.equal(merged.length, 3);
  assert.equal(merged[0], prev[0]);
  assert.equal(merged[2], prev[2]);
  assert.equal(merged[1]!.augmentId, 2116);
  // 认不出（null 或 augmentId=null）→ 该卡被清空，其余两张不受影响
  for (const dropped of [mergeRefreshedCards(prev, [1], [null]), mergeRefreshedCards(prev, [1], [{ rect: CARD, augmentId: null, name: null }])]) {
    assert.equal(dropped[1]!.augmentId, null, '查不到/认不出必须清掉该卡标签，绝不留旧字母');
    assert.equal(dropped[1]!.name, null);
    assert.equal(dropped[0]!.augmentId, 1373);
    assert.equal(dropped[2]!.augmentId, 1136);
  }
  // 多张一起 + 越界序号忽略 + 不修改入参
  const two = mergeRefreshedCards(
    prev,
    [0, 2, 9, -1],
    [{ rect: CARD, augmentId: 1001 }, null],
  );
  assert.equal(two[0]!.augmentId, 1001);
  assert.equal(two[2]!.augmentId, null);
  assert.equal(two[1]!.augmentId, 1326);
  assert.equal(prev[0]!.augmentId, 1373, '入参不能被改');
  assert.deepEqual(mergeRefreshedCards([], [0], [{ rect: CARD, augmentId: 1 }]), []);
});

test('端到端（纯函数层）：刷新后查不到强度 → **只有那张卡**的标签消失，其余两张照旧', () => {
  // 该英雄的强度表：只有卡1/卡3 在表里（模拟"新卡是该英雄表外的那 37 颗之一"）
  const tiers = new Map<number, string>([
    [1373, 'S'],
    [1136, 'B'],
  ]);
  const prev: RerollCardState[] = [
    { rect: CARD, augmentId: 1373, name: '缩小引擎' },
    { rect: CARD, augmentId: 1326, name: '夜狩' },
    { rect: CARD, augmentId: 1136, name: '威能之追求' },
  ];
  // 刷新前：三张都有档位（1326 在这份假表里也有，先补上）
  const withMiddle = new Map(tiers).set(1326, 'A');
  const before = augmentTierLabels(prev, withMiddle);
  assert.deepEqual(before.map((l) => l.text), ['S', 'A', 'B']);
  // 刷新卡2：认出的新卡不在该英雄表里 → 合并后那一张的标签必须消失
  const merged = mergeRefreshedCards(prev, [1], [{ rect: CARD, augmentId: 2116, name: '不在表里' }]);
  const after = augmentTierLabels(merged, withMiddle, { pickRates: new Map([[1373, 0.12]]) });
  assert.deepEqual(after.map((l) => l.text), ['S', 'B'], '只有卡2 的标签消失');
  assert.deepEqual(after.map((l) => l.augmentId), [1373, 1136]);
  // 认不出（null）同样清掉那一张，其余两张不受影响
  const dropped = augmentTierLabels(mergeRefreshedCards(prev, [1], [null]), withMiddle);
  assert.deepEqual(dropped.map((l) => l.augmentId), [1373, 1136]);
  // 刷新后档位换了 → 那一张的字母跟着换（这才是"标签跟着更新"）
  const swapped = augmentTierLabels(
    mergeRefreshedCards(prev, [1], [{ rect: CARD, augmentId: 1373, name: '缩小引擎' }]),
    withMiddle,
  );
  assert.deepEqual(swapped.map((l) => l.text), ['S', 'S', 'B']);
});

/* ------------------------------------------------------------------ */
/* 底线：真实刷新后"认不出"与"查不到强度"都必须让那张卡的标签消失           */
/* ------------------------------------------------------------------ */

test('底线：真实刷新后**认不出**（OCR null）→ 那张卡标签消失，其余两张不动', () => {
  const tiers = new Map<number, string>([
    [1373, 'S'],
    [1326, 'A'],
    [1136, 'B'],
  ]);
  const prev: RerollCardState[] = [
    { rect: CARD, augmentId: 1373, name: '缩小引擎' },
    { rect: CARD, augmentId: 1326, name: '夜狩' },
    { rect: CARD, augmentId: 1136, name: '威能之追求' },
  ];
  assert.equal(augmentTierLabels(prev, tiers).length, 3);
  // 卡2 被刷新，新卡**认不出**（渲染端 `readAugmentName` 返回 null）
  const merged = mergeRefreshedCards(prev, [1], [null]);
  assert.equal(merged[1]!.augmentId, null);
  const after = augmentTierLabels(merged, tiers);
  assert.deepEqual(after.map((l) => l.augmentId), [1373, 1136], '只少了卡2');
  assert.deepEqual(after.map((l) => l.text), ['S', 'B']);
  // 位置不动（行基准锁的输入没变）：其余两张的 rect 与刷新前逐位相同
  assert.deepEqual(after[0]!.rect, augmentTierLabels(prev, tiers)[0]!.rect);
});

test('底线：真实刷新后**认得出但该英雄表里查不到** → 那张卡标签同样消失', () => {
  // 官方每个英雄只有 95~162 条强度，37 颗海克斯在任何英雄表里都没有 tier
  const tiers = new Map<number, string>([
    [1373, 'S'],
    [1326, 'A'],
    [1136, 'B'],
  ]);
  const prev: RerollCardState[] = [
    { rect: CARD, augmentId: 1373, name: '缩小引擎' },
    { rect: CARD, augmentId: 1326, name: '夜狩' },
    { rect: CARD, augmentId: 1136, name: '威能之追求' },
  ];
  // 认出来了（augmentId 有值、名字也有），但不在该英雄的表里 → 不画
  const merged = mergeRefreshedCards(prev, [2], [{ rect: CARD, augmentId: 2116, name: '该英雄没有的' }]);
  assert.equal(merged[2]!.augmentId, 2116, '识别结果本身保留（产物里能查）');
  const after = augmentTierLabels(merged, tiers);
  assert.deepEqual(after.map((l) => l.augmentId), [1373, 1326], '卡3 的标签消失');
  // 与"认不出"区分开：这两条路径的**识别结果**不同（一个 null、一个有 id），
  // 所以日志/产物能分清是"识别问题"还是"数据覆盖问题"。
  assert.equal(mergeRefreshedCards(prev, [2], [null])[2]!.augmentId, null);
});

/* ------------------------------------------------------------------ */
/* 「可比指纹」的跳过保护（两个入口共用；以前只靠读代码保证）               */
/* ------------------------------------------------------------------ */

test('augmentWatchFingerprints：未识别过 / 面板未认定 / 卡片数不符 → **空数组**（跳过该帧）', () => {
  const bmp = makeCardBmp('a');
  const frozen: Rect[] = [CARD, { ...CARD, x: 0.45 }, { ...CARD, x: 0.7 }];
  const cards3 = frozen.map((rect) => ({ rect }));
  // ① 还没识别过（冻结矩形为空/null）→ 没有可比基线，别报
  assert.deepEqual(augmentWatchFingerprints(bmp, null, { found: true, cards: cards3 }), []);
  assert.deepEqual(augmentWatchFingerprints(bmp, [], { found: true, cards: cards3 }), []);
  // ② 本帧没认定面板（正在关闭/被挡住）→ 按旧矩形取样会拿到别的画面 = 假刷新
  assert.deepEqual(augmentWatchFingerprints(bmp, frozen, { found: false, cards: [] }), []);
  assert.deepEqual(augmentWatchFingerprints(bmp, frozen, { found: false, cards: cards3 }), []);
  // ③ 卡片数抖动（本帧只重建出 2 张）→ 索引会错位，整帧跳过
  assert.deepEqual(
    augmentWatchFingerprints(bmp, frozen, { found: true, cards: cards3.slice(0, 2) }),
    [],
  );
  // ④ 三个条件都满足 → 按**冻结矩形**逐卡算指纹（与主进程基线同一组矩形）
  const ok = augmentWatchFingerprints(bmp, frozen, { found: true, cards: cards3 });
  assert.equal(ok.length, 3);
  for (const f of ok) assert.ok(f, '冻结矩形下的指纹应当算得出来');
  assert.deepEqual(fingerprintDistance(ok[0], ok[0]), 0);
});

/* ------------------------------------------------------------------ */
/* 阈值**标定锁**：真机帧实测数字（改阈值必须同时改这里与标定脚本）        */
/* ------------------------------------------------------------------ */

/**
 * 真机数字（**来源**：`scripts/diag-augment-reroll.mts` 的输出 +
 * `debug/shots/inprogress-1525{09,15}-raw.png` 这一对真机帧 +
 * `debug/augment/report.json` 的一局真机录制）：
 *
 * | 组 | 样本 | 距离 |
 * |---|---|---|
 * | **同内容跨帧**（同一面板、同一颗海克斯、相隔 6 秒；**冻结矩形**）| 卡1 / 卡2 | **0.0006 / 0.0001** |
 * | 同内容跨帧（把另一帧的卡贴过来，含重采样）| 卡1 / 卡2 | 0.0006 / 0.0069 |
 * | 同内容 + 合成噪声/压缩/量化/亮度（噪声组上界）| 27 个 | ≤ **0.0130** |
 * | **真实单卡刷新**（一局真机：三张卡各刷新一次，`report.json` 的 reroll.events）| 3 个 | **0.0537 / 0.0582 / 0.0891** |
 * | 换另一张真机卡（真变化下界，合成）| 6 个 | ≥ **0.0657** |
 * | 跨帧**真变化**（卡3 被换过）| 1 个 | 0.1382（冻结矩形取样 0.0681 / 反向 0.1054）|
 * | ⚠️ 取样矩形 ±2px 抖动（**局内已冻结矩形，不会出现**）| 18 个 | ≤ 0.0311 |
 *
 * 这组断言是**标定锁**：阈值必须夹在"真机噪声上界"与"真机真变化下界"之间，
 * 且两边都留够余量。要动 `AUGMENT_REROLL_THRESHOLD` 就必须先用真机帧重跑
 * `scripts/diag-augment-reroll.mts`（它退出码非 0 = 两个分布没分开），
 * 再把这里的新数字一起改 —— 不允许"凭感觉调阈值"。
 */
test('阈值标定锁：真机噪声上界 < 阈值 < 真机真变化下界，两边余量都够', () => {
  /** 同内容跨帧（真机两帧、冻结矩形）的实测上界 —— 待机/静态画面就是这一组。 */
  const REAL_STATIC_MAX = 0.0069;
  /** 合成噪声组（含压缩/量化/亮度）实测上界。 */
  const REAL_NOISE_MAX = 0.013;
  /** 一局真机里三次真实单卡刷新的实测下界。 */
  const REAL_REROLL_MIN = 0.0537;
  /** 合成"换另一张真机卡"的实测下界。 */
  const REAL_CHANGE_MIN = 0.0657;
  /** 取样矩形抖动（局内不会出现；它正是"必须冻结矩形"的原因）。 */
  const RECT_JITTER_MAX = 0.0311;

  // ① 静态画面（待机）必须远低于阈值 —— 这是"待机动画不会误判成刷新"的数字依据
  assert.ok(
    REAL_STATIC_MAX < AUGMENT_REROLL_THRESHOLD / 4,
    `静态跨帧 ${REAL_STATIC_MAX} 必须远低于阈值 ${AUGMENT_REROLL_THRESHOLD}`,
  );
  // ② 噪声上界与阈值之间至少 2 倍余量
  assert.ok(
    REAL_NOISE_MAX * 2 <= AUGMENT_REROLL_THRESHOLD,
    `噪声上界 ${REAL_NOISE_MAX} × 2 必须 ≤ 阈值 ${AUGMENT_REROLL_THRESHOLD}`,
  );
  // ③ 真机真刷新下界与阈值之间至少 1.7 倍余量（漏判 = 贴着错字母）
  assert.ok(
    REAL_REROLL_MIN >= AUGMENT_REROLL_THRESHOLD * 1.7,
    `真刷新下界 ${REAL_REROLL_MIN} 必须 ≥ 阈值 ${AUGMENT_REROLL_THRESHOLD} × 1.7`,
  );
  assert.ok(REAL_CHANGE_MIN > REAL_REROLL_MIN);
  // ④ 抖动矩形那一项**高于**阈值 —— 锁住"为什么必须冻结取样矩形"
  assert.ok(
    RECT_JITTER_MAX >= AUGMENT_REROLL_THRESHOLD,
    '矩形抖动项若低于阈值，冻结矩形这条设计就失去理由（标定表要重写）',
  );
  // ⑤ 两组分布不许重叠（标定脚本的退出码判据）
  assert.ok(REAL_STATIC_MAX < REAL_NOISE_MAX && REAL_NOISE_MAX < REAL_REROLL_MIN);
});
