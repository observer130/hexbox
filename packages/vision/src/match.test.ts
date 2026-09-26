/**
 * match 测试
 *
 * 用合成头像验证匹配逻辑。重点在**安全性**：
 * 阈值与区分度校验必须能挡住误判 —— 显示错误的英雄胜率
 * 比不显示更糟。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Bitmap } from './types.ts';
import {
  extractGray,
  makeTemplate,
  matchChampion,
  matchChampionCareful,
  normalizeGray,
  prepareTemplates,
  similarity,
} from './match.ts';

/* ------------------------------------------------------------------ */
/* 合成头像工具                                                        */
/* ------------------------------------------------------------------ */

/**
 * 生成带可辨识图案的灰度头像。
 *
 * ⚠️ 图案必须有**真正的结构差异**，不能只差一个整体亮度 ——
 * 归一化会消掉亮度偏移（那是它的设计目的），
 * 于是「只差亮度」的图会被判为完全相同（本用例最初就踩了这个坑）。
 * 因此这里用 seed 直接改变**图案本身**（条纹相位 + 块状分布）。
 */
function patternGray(size: number, seed: number): Uint8Array {
  const g = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 每个 seed 用不同的图案规则，保证结构层面就不同
      let v: number;
      switch (seed % 4) {
        case 0:
          v = (x >> 1) % 2 === 0 ? 220 : 30; // 竖向粗条纹
          break;
        case 1:
          v = (y >> 1) % 2 === 0 ? 200 : 50; // 横向粗条纹
          break;
        case 2:
          v = x > y ? 210 : 40; // 对角分割
          break;
        default:
          v = (x + y) % 5 < 2 ? 190 : 60; // 斜向细纹
          break;
      }
      g[y * size + x] = v;
    }
  }
  return g;
}

/** 把灰度数组画进位图（灰度转 RGB）。 */
function grayToBitmap(gray: Uint8Array, size: number): Bitmap {
  const bmp: Bitmap = {
    width: size,
    height: size,
    data: new Uint8ClampedArray(size * size * 4),
  };
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i]!;
    bmp.data[i * 4] = v;
    bmp.data[i * 4 + 1] = v;
    bmp.data[i * 4 + 2] = v;
    bmp.data[i * 4 + 3] = 255;
  }
  return bmp;
}

/** 整体调亮/调暗（模拟游戏内亮度差异）。 */
function shiftGray(gray: Uint8Array, delta: number): Uint8Array {
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    out[i] = Math.max(0, Math.min(255, gray[i]! + delta));
  }
  return out;
}

const SIZE = 16;

/* ------------------------------------------------------------------ */
/* extractGray                                                         */
/* ------------------------------------------------------------------ */

test('extractGray：取整个位图并降采样到目标尺寸', () => {
  const gray = patternGray(SIZE, 1);
  const bmp = grayToBitmap(gray, SIZE);
  const got = extractGray(bmp, { x: 0, y: 0, w: 1, h: 1 }, 8);
  assert.ok(got);
  assert.equal(got!.length, 8 * 8);
});

test('extractGray：取子区域', () => {
  const gray = patternGray(SIZE, 1);
  const bmp = grayToBitmap(gray, SIZE);
  const got = extractGray(bmp, { x: 0, y: 0, w: 0.5, h: 0.5 }, 4);
  assert.ok(got);
  assert.equal(got!.length, 16);
});

test('extractGray：越界或零尺寸返回 null（不抛错）', () => {
  const bmp = grayToBitmap(patternGray(SIZE, 1), SIZE);
  assert.equal(extractGray(bmp, { x: 0, y: 0, w: 0, h: 0 }, 8), null);
  assert.equal(extractGray(bmp, { x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 8), null);
  assert.equal(extractGray(bmp, { x: -0.5, y: 0, w: 0.5, h: 0.5 }, 8), null);
});

/* ------------------------------------------------------------------ */
/* normalizeGray                                                       */
/* ------------------------------------------------------------------ */

test('normalizeGray：结果均值≈0、标准差≈1', () => {
  const norm = normalizeGray(patternGray(SIZE, 2));
  let mean = 0;
  for (const v of norm) mean += v;
  mean /= norm.length;
  assert.ok(Math.abs(mean) < 1e-4, `均值应≈0，实际 ${mean}`);

  let varSum = 0;
  for (const v of norm) varSum += v * v;
  const std = Math.sqrt(varSum / norm.length);
  assert.ok(Math.abs(std - 1) < 1e-3, `标准差应≈1，实际 ${std}`);
});

test('normalizeGray：纯色图（无结构）返回全零，不产生 NaN', () => {
  const flat = new Uint8Array(SIZE * SIZE).fill(128);
  const norm = normalizeGray(flat);
  assert.ok(norm.every((v) => v === 0));
  assert.ok(norm.every((v) => Number.isFinite(v)));
});

test('normalizeGray：空输入安全', () => {
  assert.equal(normalizeGray(new Uint8Array(0)).length, 0);
});

/* ------------------------------------------------------------------ */
/* similarity                                                          */
/* ------------------------------------------------------------------ */

test('similarity：同一图 → 1', () => {
  const a = normalizeGray(patternGray(SIZE, 3));
  assert.ok(Math.abs(similarity(a, a) - 1) < 1e-5);
});

test('similarity：不同图得分明显更低', () => {
  const a = normalizeGray(patternGray(SIZE, 1));
  const b = normalizeGray(patternGray(SIZE, 2));
  const same = similarity(a, a);
  const diff = similarity(a, b);
  assert.ok(diff < same, '不同图案的相似度应低于自身');
});

test('similarity：长度不一致返回 0（不抛错）', () => {
  const a = normalizeGray(patternGray(SIZE, 1));
  const b = normalizeGray(patternGray(8, 1));
  assert.equal(similarity(a, b), 0);
  assert.equal(similarity(new Float32Array(0), new Float32Array(0)), 0);
});

/* ------------------------------------------------------------------ */
/* makeTemplate                                                        */
/* ------------------------------------------------------------------ */

test('makeTemplate：尺寸不符时抛错（构造期错误要早暴露）', () => {
  assert.throws(() => makeTemplate(1, new Uint8Array(10), 4), /不符/);
});

test('makeTemplate：正常构造', () => {
  const t = makeTemplate(266, patternGray(SIZE, 1), SIZE);
  assert.equal(t.championId, 266);
  assert.equal(t.size, SIZE);
  assert.equal(t.gray.length, SIZE * SIZE);
});

/* ------------------------------------------------------------------ */
/* matchChampion                                                       */
/* ------------------------------------------------------------------ */

const TEMPLATES = prepareTemplates([
  makeTemplate(266, patternGray(SIZE, 1), SIZE),
  makeTemplate(1, patternGray(SIZE, 2), SIZE),
  makeTemplate(902, patternGray(SIZE, 3), SIZE),
]);

test('matchChampion：认出正确的英雄', () => {
  const query = patternGray(SIZE, 2);
  const m = matchChampion(query, TEMPLATES);
  assert.ok(m);
  assert.equal(m!.championId, 1);
  assert.ok(m!.score > 0.9, `同图应高度相似，实际 ${m!.score}`);
});

test('matchChampion：**亮度整体偏移后仍能认出**（归一化的意义）', () => {
  const query = shiftGray(patternGray(SIZE, 3), 40); // 整体调亮
  const m = matchChampion(query, TEMPLATES);
  assert.ok(m, '亮度变化不应导致识别失败');
  assert.equal(m!.championId, 902);
});

test('matchChampion：模板库为空返回 null', () => {
  assert.equal(matchChampion(patternGray(SIZE, 1), []), null);
});

test('matchChampion：纯色图（无信息）返回 null，不硬猜', () => {
  const flat = new Uint8Array(SIZE * SIZE).fill(100);
  assert.equal(matchChampion(flat, TEMPLATES), null);
});

test('matchChampion：尺寸不符的模板被跳过', () => {
  const wrongSize = prepareTemplates([makeTemplate(5, patternGray(8, 1), 8)]);
  assert.equal(matchChampion(patternGray(SIZE, 1), wrongSize), null);
});

test('matchChampion：minScore 是**下限**，低于它才拒绝', () => {
  const query = patternGray(SIZE, 1);
  // 同图得分 = 1.0，任何 ≤1 的阈值都应通过
  assert.ok(matchChampion(query, TEMPLATES, { minScore: 0.99 }));
  // 阈值设为 >1 时才拒绝（下限高于任何可能得分）
  assert.equal(matchChampion(query, TEMPLATES, { minScore: 1.01 }), null);
});

test('matchChampion：无结构图在保守默认阈值下被拒绝', () => {
  // 纯色图无信息，默认 minScore(0.62) 应挡住它
  const flat = new Uint8Array(SIZE * SIZE).fill(77);
  assert.equal(matchChampion(flat, TEMPLATES), null);
});

/* ------------------------------------------------------------------ */
/* matchChampionCareful                                                */
/* ------------------------------------------------------------------ */

test('matchChampionCareful：区分度高时正常返回', () => {
  const m = matchChampionCareful(patternGray(SIZE, 1), TEMPLATES);
  assert.ok(m);
  assert.equal(m!.championId, 266);
});

test('matchChampionCareful：**区分度不足时拒绝**（防误判的关键防线）', () => {
  // 纯色图对所有模板的相似度都相同 → 区分度 0 → 应拒绝
  const flat = new Uint8Array(SIZE * SIZE).fill(120);
  assert.equal(matchChampionCareful(flat, TEMPLATES), null);
});

test('matchChampionCareful：模板库为空返回 null', () => {
  assert.equal(matchChampionCareful(patternGray(SIZE, 1), []), null);
});

test('matchChampionCareful：单个模板时不做区分度校验（无第二名可比）', () => {
  const one = prepareTemplates([makeTemplate(266, patternGray(SIZE, 1), SIZE)]);
  const m = matchChampionCareful(patternGray(SIZE, 1), one);
  assert.ok(m);
  assert.equal(m!.championId, 266);
});
