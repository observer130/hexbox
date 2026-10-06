/**
 * 「刷新后第一次没查出强度 → 先重试一次」的测试
 *
 * 锁两件事，缺一不可：
 *   ① 第一次失败**不许立刻清**那张卡的标签（真机：标签闪一下又回来）；
 *   ② 第二次仍然失败**必须清**（底线：真刷新后确实查不到强度 → 绝不能留着旧字母）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decideRerollRetry, shouldAdoptReportedBaseline } from './augment-reroll-retry.ts';
import {
  fingerprintDistance,
  mergeRefreshedCards,
  type AugmentCardFingerprint,
  type RerollCardState,
} from './augment-reroll.ts';

/**
 * 两个**结构不同**的指纹（注意距离是"去均值"后的逐格差：常数偏移测不出差异，
 * 所以这里必须是逐格形状不同，而不是整体亮一点）。
 */
const PATTERN_A = [10, 30, 60, 90, 120, 150, 180, 200, 12, 44, 88, 130, 170, 190, 210, 40];
const PATTERN_B = [200, 190, 30, 12, 170, 60, 210, 88, 130, 10, 44, 150, 180, 120, 90, 40];

/** 造一张卡的指纹（同 pattern → 距离 0；A/B → 距离 > 0）。 */
function fp(pattern: readonly number[]): AugmentCardFingerprint {
  const size = 4;
  const cells = Uint8Array.from(pattern);
  let mean = 0;
  for (const v of cells) mean += v;
  mean /= cells.length;
  return {
    parts: [{ name: 'body', size, cells, mean, std: 10 }],
    size,
    cells,
    mean,
    std: 10,
  };
}

test('decideRerollRetry：第一次失败 → 重试（不清）', () => {
  const d = decideRerollRetry({ refreshed: [1], wouldDrop: [1], retried: [] });
  assert.deepEqual(d.retry, [1]);
  assert.deepEqual(d.drop, []);
});

test('decideRerollRetry：已经重试过一次仍失败 → 必须清（底线）', () => {
  const d = decideRerollRetry({ refreshed: [1], wouldDrop: [1], retried: [1] });
  assert.deepEqual(d.drop, [1], '两次都失败就必须清那张卡的标签');
  assert.deepEqual(d.retry, []);
});

test('decideRerollRetry：认得出的卡不参与（照常更新标签）', () => {
  // 卡 0 认出来了、卡 2 第一次失败 → 只有卡 2 排队重试
  const d = decideRerollRetry({ refreshed: [0, 2], wouldDrop: [2], retried: [] });
  assert.deepEqual(d.retry, [2]);
  assert.deepEqual(d.drop, []);
});

test('decideRerollRetry：多卡混合（一张第二次失败、一张第一次失败）', () => {
  const d = decideRerollRetry({ refreshed: [0, 1, 2], wouldDrop: [0, 1, 2], retried: [1] });
  assert.deepEqual(d.retry, [0, 2]);
  assert.deepEqual(d.drop, [1]);
});

test('decideRerollRetry：坏数据（越界/重复/非整数）忽略，不许影响别的卡', () => {
  const d = decideRerollRetry({ refreshed: [0], wouldDrop: [0, 0, -1, 1.5], retried: [] });
  assert.deepEqual(d.retry, [0]);
  assert.deepEqual(d.drop, []);
});

test('组合底线：drop 的那张卡经 mergeRefreshedCards 后 augmentId 必为 null（标签必然消失）', () => {
  const before: readonly RerollCardState[] = [
    { rect: { x: 0, y: 0, w: 1, h: 1 }, augmentId: 1415, name: '双生火焰' },
    { rect: { x: 1, y: 0, w: 1, h: 1 }, augmentId: 1206, name: '魔法转物理' },
  ];
  // 第二次失败：渲染端这次认不出（augmentId=null）
  const next: readonly (RerollCardState | null)[] = [
    { rect: { x: 1, y: 0, w: 1, h: 1 }, augmentId: null, name: null },
  ];
  const decision = decideRerollRetry({ refreshed: [1], wouldDrop: [1], retried: [1] });
  assert.deepEqual(decision.drop, [1]);
  const merged = mergeRefreshedCards(before, decision.drop, next);
  assert.equal(merged[1]!.augmentId, null, '确认清掉时 augmentId 必须是 null（标签必然消失）');
  assert.equal(merged[0]!.augmentId, 1415, '别的卡不受影响');
});

test('组合底线：retry 的那张卡**保留上一帧的值**（重认期间不闪）', () => {
  const before: readonly RerollCardState[] = [
    { rect: { x: 0, y: 0, w: 1, h: 1 }, augmentId: 1415, name: '双生火焰' },
  ];
  const next: readonly (RerollCardState | null)[] = [
    { rect: { x: 0, y: 0, w: 1, h: 1 }, augmentId: null, name: null },
  ];
  const decision = decideRerollRetry({ refreshed: [0], wouldDrop: [0], retried: [] });
  assert.deepEqual(decision.retry, [0]);
  const merged = mergeRefreshedCards(before, decision.drop, next);
  // 调用方在 retry 的那些序号上会显式保留 before 的值（这就是"不闪"的机制）
  const applied = merged.map((c, i) => (decision.retry.includes(i) ? before[i]! : c));
  assert.equal(applied[0]!.augmentId, 1415);
});

/* ------------------------------------------------------------------ */
/* 基线单调保护：同一内容连续采样只应触发一次重认                          */
/* ------------------------------------------------------------------ */

test('shouldAdoptReportedBaseline：回传的就是检测帧那一帧 → 采信（基线停在新内容）', () => {
  const old = [fp(PATTERN_A)];
  const fresh = [fp(PATTERN_B)];
  assert.equal(
    shouldAdoptReportedBaseline({ previous: old, detection: fresh, reported: fresh }),
    true,
  );
});

test('shouldAdoptReportedBaseline：回传的是**变化之前**的那一帧 → 拒绝（基线不许被倒回）', () => {
  const old = [fp(PATTERN_A)];
  const fresh = [fp(PATTERN_B)];
  const backwards = shouldAdoptReportedBaseline({ previous: old, detection: fresh, reported: old });
  assert.equal(backwards, false, '倒回旧内容 = 同一次刷新会被重复检出一次');
  // 说明这个拒绝为什么关键：采信它之后，下一帧与"新基线"的距离会与这一次**完全相同**
  //（真机日志里同一个 0.0735 出现两次的形状）
  const detection = [fp(PATTERN_B)];
  const staleDistance = fingerprintDistance(old[0]!, detection[0]!);
  const ifAdopted = fingerprintDistance(old[0]!, detection[0]!);
  assert.equal(staleDistance, ifAdopted);
  assert.ok(staleDistance > 0, '两个不同结构的指纹距离必须 > 0');
});

test('shouldAdoptReportedBaseline：缺数据时按老行为采信（绝不因为缺指纹把基线卡住）', () => {
  const fresh = [fp(PATTERN_B)];
  assert.equal(shouldAdoptReportedBaseline({ previous: null, detection: fresh, reported: fresh }), true);
  assert.equal(shouldAdoptReportedBaseline({ previous: [], detection: fresh, reported: fresh }), true);
  assert.equal(shouldAdoptReportedBaseline({ previous: [fp(PATTERN_A)], detection: null, reported: fresh }), true);
  // 回传为空 = 这一帧没指纹（旧渲染端）→ 不采信也不动基线（调用方保持原值）
  assert.equal(shouldAdoptReportedBaseline({ previous: [fp(PATTERN_A)], detection: fresh, reported: [] }), false);
  assert.equal(
    shouldAdoptReportedBaseline({ previous: [fp(PATTERN_A)], detection: fresh, reported: undefined }),
    false,
  );
});
