/**
 * 档位字母字形数据测试（两个文件都是**生成物**，见
 * `scripts/render-tier-letter-glyphs.ps1`）
 *
 * 这份数据同时喂两个地方：`label-draw.ts` 的**排版度量**（墨迹宽 / 视觉居中 / cap 比）
 * 与离线预览的**真字形轮廓**。数据一旦长了歪（生成脚本改坏、少导一个字母、
 * 度量与轮廓对不上），预览就会与局内分家 —— 那正是用户 2026-10-05 明确要求避免的事。
 * 所以这里锁五件事：
 *   ① 覆盖 A~Z、且只有 A~Z（未知档位走中性灰 + "字母照画"，缺字形会画不出来）；
 *   ② 轮廓数据自洽（点数是偶数、坐标有限、闭合、每个字母都有墨迹）；
 *   ③ 度量与**轮廓本身**一致（声明的墨迹包围盒 = 轮廓的包围盒）；
 *   ④ cap 比 / 设计墨迹宽这类"锚点常量"完全由数据算得出来（不是手抄的）；
 *   ⑤ **两个文件必须同源**（轮廓文件里的字母集合 == 度量文件里的字母集合）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TIER_LETTER_EM_METRICS,
  TIER_LETTERS_CAP_RATIO,
  TIER_LETTERS_DESIGN_INK_ASPECT,
  TIER_LETTERS_EM,
  TIER_LETTERS_FLATTEN,
  TIER_LETTERS_FONT,
  tierLetterEmMetrics,
} from './label-letter.ts';
import { TIER_LETTER_OUTLINES, tierLetterGlyph } from './label-letter-outlines.ts';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

test('覆盖 A~Z（且只有 A~Z）；度量与轮廓两个文件同源、大小写等价、非字母返回 null', () => {
  assert.deepEqual(Object.keys(TIER_LETTER_OUTLINES).sort(), [...LETTERS].sort());
  assert.deepEqual(Object.keys(TIER_LETTER_EM_METRICS).sort(), [...LETTERS].sort(), '度量与轮廓必须一一对应');
  for (const ch of LETTERS) {
    const g = tierLetterGlyph(ch);
    assert.ok(g, `${ch} 应有字形`);
    assert.equal(g!.advance, TIER_LETTER_EM_METRICS[ch]!.advance, `${ch} 字形里的度量来自度量文件`);
    assert.equal(tierLetterGlyph(ch.toLowerCase())!.advance, g!.advance, '小写等价');
    assert.equal(tierLetterEmMetrics(ch.toLowerCase()), TIER_LETTER_EM_METRICS[ch], '小写等价（度量）');
  }
  assert.equal(tierLetterGlyph('中'), null, '非 A~Z 明确返回 null（调用方回退/提示）');
  assert.equal(tierLetterGlyph(''), null);
  assert.equal(tierLetterGlyph(' '), null);
  assert.equal(tierLetterEmMetrics('中'), null);
  assert.equal(tierLetterEmMetrics(''), null);
  assert.equal(TIER_LETTERS_FONT, 'Segoe UI Black');
  assert.ok(TIER_LETTERS_EM > 100 && TIER_LETTERS_FLATTEN > 0, '生成参数应被记录下来');
});

test('轮廓数据自洽：点成对、坐标有限、至少 3 点、首尾不相邻', () => {
  for (const ch of LETTERS) {
    const contours = TIER_LETTER_OUTLINES[ch]!;
    assert.ok(contours.length >= 1, `${ch} 至少一条轮廓`);
    let points = 0;
    for (const [i, c] of contours.entries()) {
      assert.equal(c.length % 2, 0, `${ch} 第 ${i} 条轮廓点数应为偶数（x,y 成对）`);
      assert.ok(c.length >= 6, `${ch} 第 ${i} 条轮廓至少 3 个点`);
      for (const v of c) assert.ok(Number.isFinite(v), `${ch} 第 ${i} 条轮廓坐标必须是有限数`);
      // 生成脚本已去掉"末尾重复首点"
      const n = c.length;
      const dx = c[0]! - c[n - 2]!;
      const dy = c[1]! - c[n - 1]!;
      assert.ok(Math.hypot(dx, dy) > 1e-4, `${ch} 第 ${i} 条轮廓首尾不应重合`);
      points += n / 2;
    }
    assert.ok(points >= 3, `${ch} 墨迹点数太少（${points}）`);
  }
});

test('度量与轮廓一致：声明的墨迹包围盒 == 轮廓包围盒', () => {
  for (const ch of LETTERS) {
    const g = tierLetterGlyph(ch)!;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const c of g.contours) {
      for (let i = 0; i + 1 < c.length; i += 2) {
        minX = Math.min(minX, c[i]!);
        maxX = Math.max(maxX, c[i]!);
        minY = Math.min(minY, c[i + 1]!);
        maxY = Math.max(maxY, c[i + 1]!);
      }
    }
    const tol = 2e-4; // 坐标保留 4 位小数
    assert.ok(Math.abs(g.inkLeft - minX) < tol, `${ch} inkLeft ${g.inkLeft} vs ${minX}`);
    assert.ok(Math.abs(g.inkRight - maxX) < tol, `${ch} inkRight ${g.inkRight} vs ${maxX}`);
    assert.ok(Math.abs(g.inkTop - minY) < tol, `${ch} inkTop ${g.inkTop} vs ${minY}`);
    assert.ok(Math.abs(g.inkBottom - maxY) < tol, `${ch} inkBottom ${g.inkBottom} vs ${maxY}`);
  }
});

test('度量本身合理：前进宽 > 墨迹宽 > 0、cap 顶在基线上方、墨迹不越出前进宽太多', () => {
  for (const ch of LETTERS) {
    const g = TIER_LETTER_EM_METRICS[ch]!;
    const inkW = g.inkRight - g.inkLeft;
    assert.ok(g.advance > 0.2 && g.advance < 1.6, `${ch} 前进宽 ${g.advance} 不合理`);
    assert.ok(inkW > 0.15, `${ch} 墨迹宽 ${inkW} 太小`);
    assert.ok(g.inkTop < -0.5, `${ch} 墨迹应在基线之上`);
    assert.ok(g.inkBottom > -0.05 && g.inkBottom < 0.12, `${ch} 墨迹下沿应贴近基线（overshoot 很小）`);
    assert.ok(g.inkLeft > -0.1 && g.inkRight < g.advance + 0.1, `${ch} 墨迹不应远离前进宽`);
  }
});

test('cap 比 = 平底字母 H 的墨迹高；圆字母（S/C/O）有 overshoot', () => {
  const h = TIER_LETTER_EM_METRICS['H']!;
  assert.ok(Math.abs(h.inkBottom) < 2e-4, 'H 坐在基线上（inkBottom = 0）');
  assert.ok(
    Math.abs(h.inkBottom - h.inkTop - TIER_LETTERS_CAP_RATIO) < 2e-4,
    `H 的墨迹高应等于 cap 比 ${TIER_LETTERS_CAP_RATIO}`,
  );
  assert.ok(TIER_LETTERS_CAP_RATIO > 0.6 && TIER_LETTERS_CAP_RATIO < 0.8);
  for (const ch of ['S', 'C', 'O', 'G']) {
    const g = TIER_LETTER_EM_METRICS[ch]!;
    assert.ok(g.inkTop < h.inkTop - 0.005, `${ch} 应略高于 cap（overshoot）`);
    assert.ok(g.inkBottom > 0.005, `${ch} 应略低于基线（overshoot）`);
  }
  for (const ch of ['E', 'L', 'T', 'X']) {
    assert.ok(Math.abs(TIER_LETTER_EM_METRICS[ch]!.inkBottom) < 2e-4, `${ch} 是平底字母，应正好坐在基线上`);
  }
});

test('设计墨迹宽/cap 高 = S/A/B/C 的实测最大值（未知字母的保守值不是手抄的）', () => {
  const measured = ['S', 'A', 'B', 'C'].map((ch) => {
    const g = TIER_LETTER_EM_METRICS[ch]!;
    return (g.inkRight - g.inkLeft) / TIER_LETTERS_CAP_RATIO;
  });
  assert.ok(
    Math.abs(TIER_LETTERS_DESIGN_INK_ASPECT - Math.max(...measured)) < 1e-3,
    `设计值 ${TIER_LETTERS_DESIGN_INK_ASPECT} 应 = max(S/A/B/C) = ${Math.max(...measured)}`,
  );
  // 这四个字母都比旧的 0.72 固定槽位宽 —— 展示型字体本来就宽，尖括号要按实测排
  for (const [i, ch] of ['S', 'A', 'B', 'C'].entries()) {
    assert.ok(measured[i]! > 0.72, `${ch} 实测墨迹宽 ${measured[i]!.toFixed(3)} 应比 0.72 宽`);
  }
});
