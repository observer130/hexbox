/**
 * 开边沿整批识别两个决策的测试（2026-10-11 真机回归）
 *
 * 锁三件事：
 *   ① 原生重检说"不"时**不许**把门控已经验过的面板丢掉（真机：门控 39 命中 / 原生 40 失败）；
 *   ② 一块面板识别失败后**有界重试**，但只在门控判据命中的稳定帧上（翻牌动画帧上重试没有意义）；
 *   ③ 已经有名字、面板已关、次数/预算用尽 → 一律不重试（不许退化成"常态重复截屏"）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  OPEN_RECOGNIZE_RETRY_DEFAULTS,
  decideOpenRecognitionRetry,
  resolveOpenRecognizeCards,
} from './augment-open-recognize.ts';
import type { PanelCard } from './augment-panel.ts';

const card = (x: number, interiorLuma = 28): PanelCard => ({
  rect: { x, y: 0.19, w: 0.115, h: 0.463 },
  interiorLuma,
  edgeLuma: 140,
});

const gating3 = [card(0.298), card(0.441), card(0.583)];

test('原生重检通过 → 用原生矩形（精度优先，行为不变）', () => {
  const r = resolveOpenRecognizeCards({
    native: { found: true, cards: gating3, reason: '3 张卡片：内部暗(28/28/28)' },
    gating: gating3,
  });
  assert.equal(r.source, 'native');
  assert.equal(r.cards.length, 3);
  assert.equal(r.reason, '3 张卡片：内部暗(28/28/28)');
});

test('★ 原生重检未通过但门控刚验过 → 用门控矩形兜底（真机：39 命中 / 原生 40 失败）', () => {
  const r = resolveOpenRecognizeCards({
    native: { found: false, cards: [card(0.298, 40)], reason: '卡片内部不够暗(40 ≥ 40)' },
    gating: gating3,
  });
  assert.equal(r.source, 'gating', '门控是"面板在屏"的权威（开边沿由它给出），不许整批丢掉');
  assert.equal(r.cards.length, 3);
  assert.match(r.reason, /卡片内部不够暗\(40 ≥ 40\)/, '原因必须带上原生那边的原话，便于复盘');
  assert.match(r.reason, /兜底/);
});

test('原生只认出 1 张（不足 minCards）→ 同样回退到门控', () => {
  const r = resolveOpenRecognizeCards({
    native: { found: true, cards: [card(0.298)], reason: '1 张' },
    gating: gating3,
  });
  assert.equal(r.source, 'gating');
});

test('原生未通过、门控也没有可用矩形 → none（调用方按"未命中"处理）', () => {
  const r = resolveOpenRecognizeCards({
    native: { found: false, cards: [], reason: '卡片数 0' },
    gating: [],
  });
  assert.equal(r.source, 'none');
  assert.equal(r.cards.length, 0);
});

test('minCards 可覆盖（单卡面板判定的边界）', () => {
  const r = resolveOpenRecognizeCards({
    native: { found: false, cards: [], reason: 'x' },
    gating: [card(0.298)],
    minCards: 1,
  });
  assert.equal(r.source, 'gating');
});

/* ------------------------------------------------------------------ */

/** 默认的重试输入：面板开着、本帧是稳定帧、三张卡一张都没认出名字、已识别 1 次。 */
const retryBase = {
  panelOpen: true,
  settledFrame: true,
  namedCards: 0,
  expectedCards: 3,
  attempts: 1,
  pending: false,
  openEdgeAtMs: 1000,
  lastAttemptAtMs: 1000,
  nowMs: 1000 + OPEN_RECOGNIZE_RETRY_DEFAULTS.minGapMs,
} as const;

test('开边沿识别没拿到名字 + 稳定帧 + 预算内 → 重试一次', () => {
  const d = decideOpenRecognitionRetry({ ...retryBase });
  assert.equal(d.retry, true);
  assert.match(d.reason, /第 2\/3 次重试/);
});

test('面板已关 → 不重试（关闭边沿之后内容已经无关）', () => {
  assert.equal(decideOpenRecognitionRetry({ ...retryBase, panelOpen: false }).retry, false);
});

test('★ 本帧不是稳定帧（翻牌动画中间帧）→ 不重试，等下一帧', () => {
  const d = decideOpenRecognitionRetry({ ...retryBase, settledFrame: false });
  assert.equal(d.retry, false, '真机：两次"认不准"都落在动画帧上，再试一次只会再失败');
  assert.match(d.reason, /稳定帧/);
});

test('三张卡都认出名字 → 不重试（不白跑 OCR）', () => {
  const d = decideOpenRecognitionRetry({ ...retryBase, namedCards: 3 });
  assert.equal(d.retry, false);
  assert.match(d.reason, /3\/3/);
});

test('部分认出（1/3）→ 仍重试（补回没认出的那两张）', () => {
  assert.equal(decideOpenRecognitionRetry({ ...retryBase, namedCards: 1 }).retry, true);
});

test('上一次识别还在飞行中 → 不重试（避免并发重入）', () => {
  assert.equal(decideOpenRecognitionRetry({ ...retryBase, pending: true }).retry, false);
});

test('次数用尽 / 超出预算 / 距上次太近 → 都不重试（有界，不退化成常态截屏）', () => {
  const maxed = decideOpenRecognitionRetry({ ...retryBase, attempts: 3 });
  assert.equal(maxed.retry, false);
  assert.match(maxed.reason, /上限 3/);

  const late = decideOpenRecognitionRetry({
    ...retryBase,
    nowMs: retryBase.openEdgeAtMs + OPEN_RECOGNIZE_RETRY_DEFAULTS.budgetMs + 1,
    lastAttemptAtMs: retryBase.openEdgeAtMs + 5000,
  });
  assert.equal(late.retry, false);
  assert.match(late.reason, /预算/);

  const tooSoon = decideOpenRecognitionRetry({ ...retryBase, nowMs: 1200, lastAttemptAtMs: 1000 });
  assert.equal(tooSoon.retry, false);
  assert.match(tooSoon.reason, /下一帧/);
});

test('门控没给出卡片数 → 不重试（没有目标）', () => {
  assert.equal(decideOpenRecognitionRetry({ ...retryBase, expectedCards: 0 }).retry, false);
});

test('预算与次数可覆盖（调用方/env 调参）', () => {
  const d = decideOpenRecognitionRetry({ ...retryBase, attempts: 1, maxAttempts: 1 });
  assert.equal(d.retry, false);
  const e = decideOpenRecognitionRetry({ ...retryBase, minGapMs: 50, nowMs: 1050 });
  assert.equal(e.retry, true);
});
