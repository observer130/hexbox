/**
 * 门控节流策略测试
 *
 * 锁的是"**升频要快、降频要稳**"这条取舍，以及各模式的间隔与切换时机：
 * 漏掉一次三选一的代价远大于多截几帧，所以单帧命中就该升频；
 * 而降频必须等确认消失 + tail，否则重随/关了再开会被降频错过。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CADENCE_DEFAULTS, createCadencePolicy } from './augment-cadence.ts';
import type { PanelReading } from './augment-panel.ts';

/** 造一份读数（只用到 found / state；面板信号在这条策略里不参与判定）。 */
function reading(found: boolean, state: 'closed' | 'open'): PanelReading {
  return {
    state,
    edge: null,
    found,
    cards: [],
    bands: 0,
    hits: found ? 1 : 0,
    misses: found ? 0 : 1,
    presenceHolds: 0,
    presence: null,
    reason: found ? 'test-hit' : 'test-miss',
  };
}

const HIT_CLOSED = reading(true, 'closed'); // 单帧命中，尚未确认
const HIT_OPEN = reading(true, 'open'); // 已确认
const MISS = reading(false, 'closed');

test('cadence：常态是 idle 间隔', () => {
  const p = createCadencePolicy();
  assert.equal(p.mode, 'idle');
  assert.equal(p.intervalMs, CADENCE_DEFAULTS.idleMs);
  const u = p.onReading(MISS, 0);
  assert.equal(u.mode, 'idle');
  assert.equal(u.changed, false, '一直没命中不该反复下发');
});

test('cadence：单帧命中立刻升频（不去抖 —— 宁可多截几帧也别漏）', () => {
  const p = createCadencePolicy();
  const u = p.onReading(HIT_CLOSED, 1000);
  assert.equal(u.mode, 'probe');
  assert.equal(u.intervalMs, CADENCE_DEFAULTS.activeMs);
  assert.equal(u.changed, true);
});

test('cadence：probe 期间确认打开 → active（持续高频）', () => {
  const p = createCadencePolicy();
  p.onReading(HIT_CLOSED, 1000);
  const u = p.onReading(HIT_OPEN, 1100);
  assert.equal(u.mode, 'active');
  assert.equal(u.intervalMs, CADENCE_DEFAULTS.activeMs);
  assert.equal(u.changed, true, 'probe → active 也要让调用方知道（用于日志/统计）');
});

test('cadence：probe 一无所获 → probeMs 后回 idle（误检的代价有上界）', () => {
  const p = createCadencePolicy({ probeMs: 2000 });
  p.onReading(HIT_CLOSED, 0);
  assert.equal(p.onReading(MISS, 500).mode, 'probe', '还没到 probeMs');
  assert.equal(p.onReading(MISS, 1900).mode, 'probe');
  const u = p.onReading(MISS, 2000);
  assert.equal(u.mode, 'idle');
  assert.equal(u.changed, true);
});

test('cadence：面板停留期间一直高频（命中不断刷新计时）', () => {
  const p = createCadencePolicy({ tailMs: 5000 });
  p.onReading(HIT_CLOSED, 0);
  p.onReading(HIT_OPEN, 100);
  // 模拟面板停留 20 秒：每 250ms 一次命中
  for (let t = 350; t <= 20_000; t += 250) {
    const u = p.onReading(HIT_OPEN, t);
    assert.equal(u.mode, 'active', `t=${t} 不该降频`);
  }
});

test('cadence：确认消失后仍保持 tailMs 高频，之后才降频', () => {
  const p = createCadencePolicy({ probeMs: 1000, tailMs: 5000 });
  p.onReading(HIT_CLOSED, 0);
  p.onReading(HIT_OPEN, 100);
  assert.equal(p.onReading(MISS, 1000).mode, 'active', '刚消失仍高频（玩家可能再打开）');
  assert.equal(p.onReading(MISS, 4900).mode, 'active');
  const u = p.onReading(MISS, 5100);
  assert.equal(u.mode, 'idle');
  assert.equal(u.reason.includes('降频'), true);
});

test('cadence：重随（面板不关、卡面变）不会打断高频', () => {
  const p = createCadencePolicy();
  p.onReading(HIT_CLOSED, 0);
  p.onReading(HIT_OPEN, 100);
  // 重随期间读数仍是 found=open
  assert.equal(p.onReading(HIT_OPEN, 1000).mode, 'active');
  assert.equal(p.onReading(HIT_OPEN, 5000).mode, 'active');
});

test('cadence：idle 下反复未命中不会产生 changed（不刷 IPC）', () => {
  const p = createCadencePolicy();
  for (let t = 0; t < 10_000; t += 1000) {
    assert.equal(p.onReading(MISS, t).changed, false, `t=${t}`);
  }
});

test('cadence：自定义间隔生效（真机可调）', () => {
  const p = createCadencePolicy({ idleMs: 3000, activeMs: 200 });
  assert.equal(p.intervalMs, 3000);
  assert.equal(p.onReading(HIT_CLOSED, 0).intervalMs, 200);
  assert.equal(p.onReading(MISS, 3000).mode, 'probe', 'probe 期间仍高频');
});

test('cadence：reset 回到 idle', () => {
  const p = createCadencePolicy();
  p.onReading(HIT_CLOSED, 0);
  p.onReading(HIT_OPEN, 100);
  p.reset();
  assert.equal(p.mode, 'idle');
  assert.equal(p.intervalMs, CADENCE_DEFAULTS.idleMs);
});
