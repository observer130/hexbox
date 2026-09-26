/**
 * ocr 测试：名字区二值化、指纹相似度与匹配
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  extractNameStrip,
  fingerprintSimilarity,
  matchName,
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

test('extractNameStrip：白字提取为二值位图', () => {
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
  // 前 2 行应全 0
  for (let x = 0; x < 16; x++) {
    assert.equal(strip.bits[x], 0);
    assert.equal(strip.bits[16 + x], 0);
  }
  // 第 3 行 x=2..9 应为 1
  let on = 0;
  for (let x = 0; x < 16; x++) if (strip.bits[2 * 16 + x] === 1) on++;
  assert.ok(on >= 6, `亮行应检出文字像素,实际 ${on}`);
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
