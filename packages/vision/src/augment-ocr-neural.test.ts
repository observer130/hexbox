/**
 * 神经网络 OCR 纯函数测试
 *
 * 模型本身在 CI 里不跑（16MB ONNX + 原生运行时都不入库），所以这里锁的是
 * **预处理、闭集 CTC 打分、拒绝阈值**这三块 —— 它们错了，模型再准也会把
 * 错误名字/错误强度画到卡上。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  augmentNameBandRect,
  buildNameLexicon,
  ctcLogProbability,
  NEURAL_NAME_HEIGHT,
  parsePpOcrDict,
  prepareNeuralName,
  resolveNeuralName,
  type NameLexiconEntry,
} from './augment-ocr-neural.ts';

/* ------------------------------------------------------------------ */
/* 字典与词表                                                          */
/* ------------------------------------------------------------------ */

test('parsePpOcrDict：行号映射为类别（blank 是 0，第一行是 1）', () => {
  const map = parsePpOcrDict('一\n二\n三\n');
  assert.equal(map.get('一'), 1);
  assert.equal(map.get('二'), 2);
  assert.equal(map.get('三'), 3);
});

test('buildNameLexicon：去掉名字里的空格、跳过字典没有的字符', () => {
  const dict = parsePpOcrDict('纯\n粹\n主\n义\n者\n-\n术\n师');
  const { entries, skipped } = buildNameLexicon(
    [
      { augmentId: 1, name: '纯粹主义者 - 术师' },
      { augmentId: 2, name: '纯 粹' },
      { augmentId: 3, name: '术师' },
      { augmentId: 4, name: '未知字符' }, // 未/知/字/符 不在字典
    ],
    dict,
  );
  assert.deepEqual(entries.map((e) => e.augmentId), [1, 2, 3]);
  assert.deepEqual(entries[0]!.classes, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(entries[1]!.classes, [1, 2]);
  assert.deepEqual(skipped, ['未知字符']);
});

/* ------------------------------------------------------------------ */
/* 预处理                                                              */
/* ------------------------------------------------------------------ */

function bandWithBlock(): { width: number; height: number; gray: Uint8Array } {
  const width = 200;
  const height = 60;
  const gray = new Uint8Array(width * height).fill(20);
  for (let y = 20; y < 40; y++) {
    for (let x = 50; x < 150; x++) gray[y * width + x] = 240;
  }
  return { width, height, gray };
}

test('prepareNeuralName：紧包围盒 + 反相 + 高度 48', () => {
  const out = prepareNeuralName(bandWithBlock());
  assert.ok(out !== null);
  assert.equal(out.height, NEURAL_NAME_HEIGHT);
  // 包围盒 100×20 + 留白后的宽高比 → 约 164 宽（只断言下界与三通道长度）
  assert.ok(out.width > 100, `宽度应保留文字比例，实得 ${out.width}`);
  assert.equal(out.data.length, 3 * out.width * out.height);
  const px = (c: number, x: number, y: number): number => out.data[c * out.width * out.height + y * out.width + x]!;
  // 文字（原图白块）反相后应变深；四周底色反相后应变浅
  assert.ok(px(0, Math.floor(out.width / 2), Math.floor(out.height / 2)) < -0.8);
  assert.ok(px(0, 0, 0) > 0.8);
});

test('prepareNeuralName：没有文字 → null（动画帧/空白带不画）', () => {
  const width = 120;
  const height = 40;
  const gray = new Uint8Array(width * height).fill(20);
  assert.equal(prepareNeuralName({ width, height, gray }), null);
  assert.equal(prepareNeuralName({ width: 0, height: 0, gray: new Uint8Array() }), null);
});

/* ------------------------------------------------------------------ */
/* CTC 闭集解码                                                         */
/* ------------------------------------------------------------------ */

/** 造一个 [T][C] 概率矩阵：沿给定路径给 0.9，其余均分。 */
function probsForPath(steps: number, classes: number, path: readonly number[]): Float32Array {
  const probs = new Float32Array(steps * classes);
  for (let t = 0; t < steps; t++) {
    const want = path[t] ?? 0;
    let rest = 0.1 / (classes - 1);
    for (let c = 0; c < classes; c++) probs[t * classes + c] = c === want ? 0.9 : rest;
  }
  return probs;
}

test('ctcLogProbability：沿正确路径的概率高于错误路径', () => {
  const steps = 5;
  const classes = 3; // blank=0, 类别 1/2
  const good = probsForPath(steps, classes, [0, 1, 0, 2, 0]);
  const bad = probsForPath(steps, classes, [0, 2, 0, 1, 0]);
  const score12 = ctcLogProbability(good, steps, classes, [1, 2]);
  const score21 = ctcLogProbability(good, steps, classes, [2, 1]);
  assert.ok(score12 > score21, `正确路径应更高：${score12} vs ${score21}`);
  assert.ok(Number.isFinite(score12));
  assert.equal(ctcLogProbability(good, 0, classes, [1, 2]), Number.NEGATIVE_INFINITY);
  assert.equal(ctcLogProbability(good, steps, classes, []), Number.NEGATIVE_INFINITY);
});

test('resolveNeuralName：闭集打分选最高名字，并返回分差', () => {
  const steps = 5;
  const classes = 3;
  const lexicon: NameLexiconEntry[] = [
    { augmentId: 1, name: '甲乙', classes: [1, 2] },
    { augmentId: 2, name: '乙甲', classes: [2, 1] },
  ];
  const probs = probsForPath(steps, classes, [0, 1, 0, 2, 0]);
  const m = resolveNeuralName(probs, steps, classes, lexicon);
  assert.ok(m !== null);
  assert.equal(m.augmentId, 1);
  assert.ok(m.margin > 0);
});

test('resolveNeuralName：分差/绝对分不够 → null（宁漏勿错）', () => {
  const steps = 4;
  const classes = 3;
  const lexicon: NameLexiconEntry[] = [
    { augmentId: 1, name: '甲乙', classes: [1, 2] },
    { augmentId: 2, name: '乙甲', classes: [2, 1] },
  ];
  const probs = probsForPath(steps, classes, [0, 1, 2, 0]);
  assert.equal(resolveNeuralName(probs, steps, classes, lexicon, { minScore: 100 }), null);
  assert.equal(resolveNeuralName(probs, steps, classes, lexicon, { minMargin: 100 }), null);
  assert.equal(resolveNeuralName(probs, steps, classes, []), null);
});

test('resolveNeuralName：模型输出全均分 → 分差 0 → null', () => {
  const steps = 4;
  const classes = 3;
  const probs = new Float32Array(steps * classes).fill(1 / classes);
  const lexicon: NameLexiconEntry[] = [
    { augmentId: 1, name: '甲乙', classes: [1, 2] },
    { augmentId: 2, name: '乙甲', classes: [2, 1] },
  ];
  assert.equal(resolveNeuralName(probs, steps, classes, lexicon), null);
});

test('augmentNameBandRect：名字带落在卡片内、覆盖卡片宽度大部分', () => {
  const card = { x: 0.3, y: 0.2, w: 0.1, h: 0.4 };
  const band = augmentNameBandRect(card);
  assert.ok(band.x >= card.x && band.y >= card.y);
  assert.ok(band.x + band.w <= card.x + card.w + 1e-9);
  assert.ok(band.y + band.h <= card.y + card.h + 1e-9);
  assert.ok(band.w > card.w * 0.9);
  // 纵向中心应在卡高的 47% 附近（真机名字带标定）
  assert.ok(Math.abs(band.y + band.h / 2 - (card.y + card.h * 0.47)) < 1e-9);
});
