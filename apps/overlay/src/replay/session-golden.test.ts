/**
 * **golden 比对**的单测（纯函数，CI 可跑）
 *
 * 这一段以前住在 `scripts/replay-session.mts` 里，`pnpm test` 一行都覆盖不到，
 * 于是读错了字段一整轮都没人发现（2026-10-12 拿真机会话复核时抓到）：
 * 录制器写的是 `report.json.labels = [ { atMs, origin } ]`（**数组**），
 * 而比对代码读的是 `labels.events`（不存在）→ golden 的锚点恒为空数组 →
 * 每次回放都打印"命中 0 / golden 0 条" + "回放多出 N 条边沿"，
 * 而"golden 有、回放没有"这类真问题永远不会被报出来。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareGolden, parseGoldenReport, type GoldenCompareInput } from './session-golden.ts';

/** 真机会话 `20261012-213155-InProgress` 的关键数字（时刻都是会话时基）。 */
const REAL_OPEN_EDGES = [18164, 414613];
const REAL_REROLLS = [21044, 34242, 35444, 417884, 421087];

function realGoldenText(): string {
  return JSON.stringify({
    samples: 515,
    counts: { foundFrames: 63, openEdges: 2, closeEdges: 2 },
    // ⚠️ 录制器真正写出来的形状：数组（不是 `{ events: [...] }`）
    labels: [
      { atMs: 18505, origin: 'open', ok: true },
      { atMs: 21381, origin: 'reroll', ok: true },
      { atMs: 34587, origin: 'reroll', ok: true },
      { atMs: 414942, origin: 'open', ok: true },
      { atMs: 421409, origin: 'reroll', ok: true },
    ],
    reroll: { detected: 5, events: REAL_REROLLS.map((atMs) => ({ atMs, indexes: [2] })) },
  });
}

function alignedReplay(): GoldenCompareInput {
  return {
    edges: [
      { atMs: 18164, kind: 'open' },
      { atMs: 39837, kind: 'close' },
      { atMs: 414613, kind: 'open' },
      { atMs: 423811, kind: 'close' },
    ],
    rerolls: REAL_REROLLS.map((atMs) => ({ atMs, indexes: [2] })),
    recognizeCalls: 7,
    counts: { foundFrames: 63, openEdges: 2, closeEdges: 2 },
  };
}

test('parseGoldenReport：录制器写的是 labels **数组** → 识别锚点必须被读出来', () => {
  const g = parseGoldenReport(realGoldenText(), 'report.json');
  assert.deepEqual(
    g.recognitions.map((r) => r.origin),
    ['open', 'reroll', 'reroll', 'open', 'reroll'],
  );
  assert.equal(g.recognitions.filter((r) => r.origin === 'open').length, 2, '开边沿锚点丢了就是这次踩的坑');
  assert.deepEqual(g.rerolls.map((r) => r.atMs), REAL_REROLLS);
  assert.equal(g.counts.foundFrames, 63);
  assert.equal(g.samples, 515);
});

test('parseGoldenReport：兼容 { events: [...] } 形状、旧产物缺字段不抛', () => {
  const wrapped = parseGoldenReport(
    JSON.stringify({
      counts: { openEdges: 1 },
      labels: { events: [{ atMs: 100, origin: 'open' }] },
      reroll: { events: [{ atMs: 500, indexes: [1] }] },
    }),
    'old.json',
  );
  assert.deepEqual(wrapped.recognitions, [{ atMs: 100, origin: 'open' }]);
  assert.equal(wrapped.rerolls.length, 1);
  assert.equal(wrapped.samples, null);

  const empty = parseGoldenReport('{}', 'empty.json');
  assert.deepEqual(empty.recognitions, []);
  assert.deepEqual(empty.rerolls, []);
  assert.deepEqual(empty.counts, { foundFrames: 0, openEdges: 0, closeEdges: 0 });
});

test('★回归：回放时基被整体平移 6392ms → 单卡刷新必须报"缺"，不许静默全绿', () => {
  const golden = parseGoldenReport(realGoldenText(), 'report.json');

  // 时基没修之前的样子：回放的 `x - startedAt` 字段集体少了 6392ms（真机实测差 6392）
  const shifted = compareGolden(
    {
      ...alignedReplay(),
      rerolls: REAL_REROLLS.map((atMs) => ({ atMs: atMs - 6392, indexes: [2] })),
    },
    golden,
  );
  assert.equal(shifted.rerollMatched, 0);
  assert.equal(shifted.rerollMissing, 5, '5 次重随一条都没配上，必须如实报出来');
  assert.ok(
    shifted.diffs.some((d) => d.includes('单卡刷新') && d.includes('找不到')),
    `差异清单里必须有"golden 有、回放没有"的条目：${JSON.stringify(shifted.diffs)}`,
  );

  // 时基修好之后：逐项一致
  const aligned = compareGolden(alignedReplay(), golden);
  assert.equal(aligned.rerollMatched, 5);
  assert.equal(aligned.rerollMissing, 0);
  assert.equal(aligned.rerollExtra, 0);
  assert.equal(aligned.openEdgeMatched, 2);
  assert.equal(aligned.openEdgeExtra, 0);
  assert.deepEqual(aligned.diffs, [], `对齐后不该有差异：${JSON.stringify(aligned.diffs)}`);
});

test('compareGolden：**双向**配对 —— 回放多出来的边沿/重随也要报（只遍历 golden 是假绿）', () => {
  const golden = parseGoldenReport(realGoldenText(), 'report.json');
  const extra = compareGolden(
    {
      edges: [...alignedReplay().edges, { atMs: 250_000, kind: 'open' }],
      rerolls: [...alignedReplay().rerolls, { atMs: 260_000, indexes: [3] }],
      recognizeCalls: 9,
      counts: { foundFrames: 64, openEdges: 3, closeEdges: 2 },
    },
    golden,
  );
  assert.equal(extra.openEdgeExtra, 1);
  assert.equal(extra.rerollExtra, 1);
  assert.ok(extra.diffs.some((d) => d.includes('回放多出 1 条开边沿')));
  assert.ok(extra.diffs.some((d) => d.includes('回放多出 1 次单卡刷新')));
  // 计数不一致也要说清"为什么允许不一致"（帧库只覆盖录到的那些帧）
  assert.ok(extra.diffs.some((d) => d.includes('面板出现次数不一致')));
  assert.ok(extra.diffs.some((d) => d.includes('认定面板的帧数不一致')));
});

test('compareGolden：golden 缺整批识别锚点（旧产物）→ 只报"配不上"，不误判成回放多开', () => {
  const g = parseGoldenReport(
    JSON.stringify({ counts: { openEdges: 0, closeEdges: 0 }, labels: [] }),
    'labels-only.json',
  );
  const r = compareGolden(
    {
      edges: [{ atMs: 18164, kind: 'open' }],
      rerolls: [],
      recognizeCalls: 1,
      counts: { foundFrames: 3, openEdges: 1, closeEdges: 0 },
    },
    g,
  );
  assert.equal(r.goldenRecognitions, 0);
  assert.equal(r.openEdgeExtra, 1, 'golden 没有锚点可比 → 只能报"回放多出"，不能假装命中');
});

test('compareGolden：识别次数**明显**漂移要报出来（以前只看边沿，这项从不比较）', () => {
  const g = parseGoldenReport(realGoldenText(), 'report.json');
  const replay = { ...alignedReplay(), recognizeCalls: 20 }; // golden 5 条 vs 回放 20 次
  const r = compareGolden(replay, g);

  assert.equal(r.goldenRecognitions, 5);
  assert.equal(r.replayRecognizeCalls, 20);
  assert.ok(
    r.diffs.some((d) => /识别次数明显不一致/.test(d)),
    '差 15 次属于"开边沿判定/重试策略漂移"，必须让回放的人看见',
  );
});

test('compareGolden：识别次数小幅不等（重试噪声）不误报', () => {
  const g = parseGoldenReport(realGoldenText(), 'report.json');
  // golden 5 条 / 回放 7 次 —— 真机上就是这种 ±2 的重试差异
  const r = compareGolden({ ...alignedReplay(), recognizeCalls: 7 }, g);
  assert.equal(
    r.diffs.some((d) => /识别次数/.test(d)),
    false,
    '±2 以内是重试，不该被当成漂移（否则每次真机回放都红）',
  );
});
