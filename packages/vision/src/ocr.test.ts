/**
 * ocr 测试：名字区二值化、指纹相似度与匹配
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  extractNameStrip,
  fingerprintSimilarity,
  matchName,
  matchNameCareful,
  type NameFingerprint,
} from './ocr.ts';

/** 构造一个指纹。 */
function fp(id: number, name: string, rows: string[]): NameFingerprint {
  const height = rows.length;
  const width = rows[0]!.length;
  const bits = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      bits[y * width + x] = rows[y]![x] === '#' ? 1 : 0;
    }
  }
  return { championId: id, name, width, height, bits };
}

test('extractNameStrip：白字提取为二值位图（包围盒归一化）', () => {
  // 16x4 灰度：上两行暗(背景)，下两行亮(文字)
  const w = 16;
  const h = 4;
  const gray = new Uint8Array(w * h);
  for (let x = 2; x < 10; x++) {
    gray[2 * w + x] = 220;
    gray[3 * w + x] = 230;
  }
  const strip = extractNameStrip(gray, w, h, { threshold: 150, outWidth: 16, outHeight: 4 });
  assert.equal(strip.width, 16);
  // 包围盒=文字本身 → 拉伸后每行都应有文字像素（无背景留白）
  for (let y = 0; y < 4; y++) {
    let on = 0;
    for (let x = 0; x < 16; x++) if (strip.bits[y * 16 + x] === 1) on++;
    assert.ok(on >= 6, `行 ${y} 应有文字像素,实际 ${on}`);
  }
});

test('extractNameStrip：全暗图返回空位图', () => {
  const strip = extractNameStrip(new Uint8Array(64), 16, 4);
  assert.equal(strip.bits.every((b) => b === 0), true);
});

test('fingerprintSimilarity：相同=1, 不相交=0, 部分重叠介于其间', () => {
  const a = fp(1, 'A', ['#.', '.#']);
  const same = fp(2, 'A', ['#.', '.#']);
  const none = fp(3, 'B', ['..', '..']);
  const part = fp(4, 'C', ['#.', '..']);

  assert.equal(fingerprintSimilarity(a, same), 1);
  assert.equal(fingerprintSimilarity(a, none), 0);
  const p = fingerprintSimilarity(a, part);
  assert.ok(p > 0 && p < 1, `部分重叠应介于 0..1,实际 ${p}`);
});

test('fingerprintSimilarity：尺寸不符返回 0', () => {
  const a = fp(1, 'A', ['#.', '.#']);
  const b = fp(2, 'B', ['..', '..', '..']);
  assert.equal(fingerprintSimilarity(a, b), 0);
});

test('matchName：库中命中正确英雄', () => {
  const lib = [
    fp(1, '刀锋之影', ['#..', '.#.', '..#']),
    fp(2, '解脱者', ['##.', '.#.', '..#']),
  ];
  const res = matchName({ bits: lib[0]!.bits, width: 3, height: 3 }, lib, { minScore: 0.55 });
  assert.ok(res);
  assert.equal(res.championId, 1);
  assert.equal(res.name, '刀锋之影');
  assert.equal(res.score, 1);
});

test('matchName：全库低于阈值返回 null（宁漏勿错）', () => {
  const lib = [fp(1, 'A', ['#..', '.#.', '..#'])];
  // 查询与库完全不相交
  const res = matchName({ bits: new Uint8Array(9), width: 3, height: 3 }, lib, {
    minScore: 0.55,
  });
  assert.equal(res, null);
});

test('matchName：空库返回 null', () => {
  const res = matchName({ bits: new Uint8Array(9), width: 3, height: 3 }, []);
  assert.equal(res, null);
});

/* ------------------------------------------------------------------ */
/* matchNameCareful：区分度                                            
/* ------------------------------------------------------------------ */

/** 与 `SAME` 指纹一致的查询（全 1）。 */
const QUERY = { bits: new Uint8Array(9).fill(1), width: 3, height: 3 };
const SAME = ['###', '###', '###'];

test('matchNameCareful：**同名重复条目不应把真卡判成"区分度不足"**', () => {
  // 真机 bug 复现：指纹库同时收录基础 ID 与 60000+ 变体 ID，
  // 两者是同一英雄、同图同名 → 最高分与次高分相同 → margin 0 → 整张卡被拒。
  // 实测：卡2 top2 = 殇之木乃伊 0.625 / 殇之木乃伊 0.625。
  const lib = [fp(32, '殇之木乃伊', SAME), fp(60032, '殇之木乃伊', SAME)];
  const res = matchNameCareful(QUERY, lib, { minScore: 0.5, minMargin: 0.015 });
  assert.ok(res, '同名重复条目不应导致拒绝');
  assert.equal(res.name, '殇之木乃伊');
  assert.equal(res.score, 1);
  // 次高分应来自**不同英雄**；库里没有别的英雄 → 0
  assert.equal(res.margin, 1);
});

test('matchNameCareful：不同英雄分数接近时仍拒绝（宁漏勿错）', () => {
  // A 与查询几乎一致，B 也相差不多 → 分差不足，不猜
  const lib = [fp(1, 'A', SAME), fp(2, 'B', ['###', '###', '##.'])];
  const res = matchNameCareful(QUERY, lib, { minScore: 0.5, minMargin: 0.5 });
  assert.equal(res, null);
});

test('matchNameCareful：最低分门槛仍然生效', () => {
  const lib = [fp(1, 'A', ['...', '...', '...'])];
  const res = matchNameCareful(QUERY, lib, { minScore: 0.5 });
  assert.equal(res, null);
});

test('matchNameCareful：margin 用不同名次高分计算（回归公式）', () => {
  // A=1.0（最高），B=0.8（不同名次高）→ margin 应为 0.2 而不是 0
  const lib = [fp(1, 'A', SAME), fp(601, 'A', SAME), fp(2, 'B', ['###', '###', '##.'])];
  const res = matchNameCareful(QUERY, lib, { minScore: 0.5, minMargin: 0.015 });
  assert.ok(res);
  assert.equal(res.name, 'A');
  assert.ok(res.margin > 0, `margin 应 > 0（同名条目不该压成 0），实际 ${res.margin}`);
});
