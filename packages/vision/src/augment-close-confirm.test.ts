/**
 * 「关闭确认」状态机测试（2026-10-06 真机回归：面板还在却判关闭）
 *
 * 锁三件事：
 *   ① 关闭边沿**不当场**上报（先进复检窗口，期间继续取帧）；
 *   ② 窗口内面板重现 → 那次关闭**作废**（不消耗待选、不关截屏）—— 自愈；
 *   ③ 窗口到期 → 确认关闭，**只报一次**。
 * 另外锁"顺延"与"reset"，它们是长时间真机跑起来的边界。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AUGMENT_CLOSE_CONFIRM_MS, createCloseConfirm } from './augment-close-confirm.ts';
import { createAugmentTrigger } from './augment-trigger.ts';

const RECHECK = AUGMENT_CLOSE_CONFIRM_MS;

test('关闭边沿 → 进复检窗口，且**不当场**上报关闭', () => {
  const m = createCloseConfirm();
  const d = m.push({ edge: 'close', nowMs: 10_000 });
  assert.equal(d.notifyClosed, false, '关闭边沿不许当场上报（否则误判会消耗待选 + 关截屏）');
  assert.equal(d.rechecking, true, '必须进复检窗口（调用方据此继续取帧）');
  assert.equal(m.state.pendingAtMs, 10_000);
  assert.equal(m.state.cancelled, 0);
});

test('复检窗口内面板重现 → 作废这次关闭（自愈：不消耗待选、不停取帧）', () => {
  const m = createCloseConfirm();
  m.push({ edge: 'close', nowMs: 1000 });
  // 真机：翻牌动画约 1.2 秒；这里在窗口内又看到开边沿
  const back = m.push({ edge: 'open', nowMs: 1800 });
  assert.equal(back.notifyClosed, false, '假关闭绝不上报');
  assert.equal(back.rechecking, false, '作废后不再需要复检取帧');
  assert.equal(back.cancelled, 1);
  assert.match(back.reason, /假关闭/);
  // 之后的普通帧也不许把这次关闭补报出来
  const later = m.push({ edge: null, nowMs: 9000 });
  assert.equal(later.notifyClosed, false);
  assert.equal(m.state.pendingAtMs, null);
});

test('复检窗口到期 → 确认关闭，且**只报一次**', () => {
  const m = createCloseConfirm();
  m.push({ edge: 'close', nowMs: 5000 });
  const mid = m.push({ edge: null, nowMs: 5000 + RECHECK - 1 });
  assert.equal(mid.notifyClosed, false, '还没到期不许上报');
  assert.equal(mid.rechecking, true);
  const due = m.push({ edge: null, nowMs: 5000 + RECHECK });
  assert.equal(due.notifyClosed, true, '到期确认上报');
  assert.equal(due.rechecking, false);
  assert.match(due.reason, /确认关闭/);
  const again = m.push({ edge: null, nowMs: 5000 + RECHECK + 400 });
  assert.equal(again.notifyClosed, false, '同一次关闭只能报一次');
});

test('复检窗口内的**新**关闭边沿顺延窗口（不许提前确认）', () => {
  const m = createCloseConfirm();
  m.push({ edge: 'close', nowMs: 0 });
  m.push({ edge: 'close', nowMs: RECHECK - 100 });
  const notYet = m.push({ edge: null, nowMs: RECHECK + 50 });
  assert.equal(notYet.notifyClosed, false, '窗口应按最后一次关闭边沿顺延');
  const due = m.push({ edge: null, nowMs: RECHECK - 100 + RECHECK });
  assert.equal(due.notifyClosed, true);
});

test('开边沿（没有待确认的关闭）不上报任何东西', () => {
  const m = createCloseConfirm();
  const d = m.push({ edge: 'open', nowMs: 42 });
  assert.equal(d.notifyClosed, false);
  assert.equal(d.rechecking, false);
  assert.equal(d.cancelled, 0);
});

test('reset 清空待确认与统计（收工后不该再因为"关闭待确认"取帧）', () => {
  const m = createCloseConfirm();
  m.push({ edge: 'close', nowMs: 100 });
  m.push({ edge: 'open', nowMs: 200 });
  m.push({ edge: 'close', nowMs: 300 });
  assert.equal(m.state.cancelled, 1);
  assert.equal(m.state.rechecking, true);
  m.reset();
  const st = m.state;
  assert.equal(st.pendingAtMs, null);
  assert.equal(st.rechecking, false);
  assert.equal(st.cancelled, 0);
  assert.equal(m.push({ edge: null, nowMs: 99_999 }).notifyClosed, false);
});

test('recheckMs 可注入（离线/单测用短窗口）', () => {
  const m = createCloseConfirm({ recheckMs: 10 });
  m.push({ edge: 'close', nowMs: 0 });
  assert.equal(m.push({ edge: null, nowMs: 9 }).notifyClosed, false);
  assert.equal(m.push({ edge: null, nowMs: 10 }).notifyClosed, true);
});

/* ------------------------------------------------------------------ */
/* 与门控 / API 触发状态机的**组合**（锁"这次回归的完整形状"）             */
/* ------------------------------------------------------------------ */

test('假关闭**不消耗待选、不关截屏**（自愈的代价为零）', () => {
  // 这一条把三块纯函数摆在一起，锁住真机那一刻的因果：
  //   门控（两信号）→ 关闭确认（复检窗口）→ API 触发状态机（待选/开截屏）。
  // 复检窗口内面板重现 → 确认机器给 `notifyClosed=false` → 调用方**不调**
  // `notePanelClosed()` → 待选集合原样保留、截屏仍然开着。
  const trigger = createAugmentTrigger({
    offerLevels: [0, 7],
    armWindowMs: 45_000,
    startWindowSec: 25,
    midGameStartSec: 60,
  });
  const opened = trigger.onSample({ gameTime: 3, level: 1, isDead: false, respawnTimer: 0 }, 1000);
  assert.equal(opened.capture, true, '开局应当开截屏');
  trigger.notePanelOpen(5000);
  const pendingBefore = [...trigger.pending];

  const confirm = createCloseConfirm();
  confirm.push({ edge: 'close', nowMs: 9000 });
  const back = confirm.push({ edge: 'open', nowMs: 9800 });
  assert.equal(back.notifyClosed, false, '复检窗口内重现 → 这次关闭是假的');
  assert.equal(back.cancelled, 1);

  assert.deepEqual(trigger.pending, pendingBefore, '待选必须原样保留（不许被误判消耗）');
  assert.equal(trigger.capture, true, '截屏不许被关（关了就是一帧不取 → 面板再也回不来）');
});

test('对照：**确认**的关闭才上报 → 按原语义消耗一次待选并关截屏', () => {
  const trigger = createAugmentTrigger({
    offerLevels: [0, 7],
    armWindowMs: 45_000,
    startWindowSec: 25,
    midGameStartSec: 60,
  });
  trigger.onSample({ gameTime: 3, level: 1, isDead: false, respawnTimer: 0 }, 1000);
  trigger.notePanelOpen(5000);

  const confirm = createCloseConfirm({ recheckMs: 100 });
  confirm.push({ edge: 'close', nowMs: 9000 });
  const due = confirm.push({ edge: null, nowMs: 9000 + 100 });
  assert.equal(due.notifyClosed, true, '窗口内没见过面板 → 确认关闭');
  const d = trigger.notePanelClosed(9100);
  assert.equal(d.capture, false, '确认关闭后才关截屏（回到常态零取帧）');
  assert.ok(trigger.pending.length < 2, '确认关闭才消耗一次待选');
});

