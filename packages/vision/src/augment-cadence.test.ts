/**
 * 门控节流策略测试
 *
 * 锁的是"**升频要快、降频要稳**"这条取舍，以及各模式的间隔与切换时机：
 * 漏掉一次三选一的代价远大于多截几帧，所以单帧命中就该升频；
 * 而降频必须等确认消失 + tail，否则重随/关了再开会被降频错过。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  API_CADENCE_DEFAULTS,
  CADENCE_DEFAULTS,
  apiCaptureInterval,
  createCadencePolicy,
} from './augment-cadence.ts';
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

/* ------------------------------------------------------------------ */
/* api 模式间隔决策（面板状态优先于触发状态机）                          */
/* ------------------------------------------------------------------ */

/** 造一份 api 决策输入（默认：什么都"不在"）。 */
function apiInput(over: Partial<Parameters<typeof apiCaptureInterval>[0]> = {}) {
  return {
    panelOpen: false,
    capture: false,
    rechecking: false,
    lastConfirmedCloseAtMs: null,
    nowMs: 0,
    ...over,
  };
}

test('api 间隔：面板在屏时**即使 capture=false** 也必须 >0（面板状态优先）', () => {
  const d = apiCaptureInterval(apiInput({ panelOpen: true, capture: false }));
  assert.equal(d.intervalMs, API_CADENCE_DEFAULTS.rerollPollMs);
  assert.ok(d.intervalMs > 0);
  assert.equal(d.healProbe, false);
});

test('api 间隔：面板在屏优先于 capture（两者都为真也走重随轮询）', () => {
  const d = apiCaptureInterval(apiInput({ panelOpen: true, capture: true }));
  assert.equal(d.intervalMs, API_CADENCE_DEFAULTS.rerollPollMs);
});

test('api 间隔：capture=true（面板还没出现/等连选）→ ACTIVE_MS', () => {
  const d = apiCaptureInterval(apiInput({ capture: true }));
  assert.equal(d.intervalMs, API_CADENCE_DEFAULTS.activeMs);
});

test('api 间隔：关闭待确认的复检窗口 → ACTIVE_MS（必须有帧才可能自愈）', () => {
  const d = apiCaptureInterval(apiInput({ rechecking: true }));
  assert.equal(d.intervalMs, API_CADENCE_DEFAULTS.activeMs);
});

test('api 间隔：常态（严格零取帧）= 0', () => {
  const d = apiCaptureInterval(apiInput());
  assert.equal(d.intervalMs, 0);
  // 确认关闭之后**也**是 0 —— 这就是用户 2026-10-11 的裁决
  const afterClose = apiCaptureInterval(apiInput({ lastConfirmedCloseAtMs: 1000, nowMs: 2000 }));
  assert.equal(afterClose.intervalMs, 0, '默认关闭自愈探针 → 误判后间隔仍回 0');
  assert.equal(afterClose.healProbe, false);
});

test('api 间隔：自愈探针（开关打开时）—— 20s 内 = PROBE_MS，20s 后 = 0', () => {
  const opts = { healProbe: true };
  const closedAt = 100_000;
  const at = (dt: number) =>
    apiCaptureInterval(apiInput({ lastConfirmedCloseAtMs: closedAt, nowMs: closedAt + dt }), opts);
  assert.equal(at(0).intervalMs, API_CADENCE_DEFAULTS.probeMs);
  assert.equal(at(0).healProbe, true);
  assert.equal(at(19_999).intervalMs, API_CADENCE_DEFAULTS.probeMs);
  assert.equal(at(20_000).intervalMs, API_CADENCE_DEFAULTS.probeMs, '窗口边界仍算窗口内');
  assert.equal(at(20_001).intervalMs, 0, '窗口一过必须回到严格零取帧');
  assert.equal(at(60_000).healProbe, false);
  // 面板状态依然优先于探针
  const open = apiCaptureInterval(
    apiInput({ panelOpen: true, lastConfirmedCloseAtMs: closedAt, nowMs: closedAt + 1000 }),
    opts,
  );
  assert.equal(open.intervalMs, API_CADENCE_DEFAULTS.rerollPollMs);
  // 反方向的时钟抖动（nowMs 比关闭时刻还早）不许进探针分支
  const backwards = apiCaptureInterval(
    apiInput({ lastConfirmedCloseAtMs: closedAt, nowMs: closedAt - 5 }),
    opts,
  );
  assert.equal(backwards.intervalMs, 0);
});

test('api 间隔：常量表就是默认值（回退点只有一个）', () => {
  assert.equal(API_CADENCE_DEFAULTS.healProbe, false, '用户裁决：严格零取帧 → 探针默认关闭');
  assert.equal(API_CADENCE_DEFAULTS.rerollPollMs, 400);
  assert.equal(API_CADENCE_DEFAULTS.activeMs, 250);
  assert.equal(API_CADENCE_DEFAULTS.probeMs, 6000);
  assert.equal(API_CADENCE_DEFAULTS.healWindowMs, 20_000);
});
