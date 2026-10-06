/**
 * 「读不到 LCU 凭证」一次性气泡的判定测试
 *
 * 这一组的实质是**两个相反的要求同时成立**：
 *   ① 双击之后长时间什么都看不到 = 用户以为程序坏了 → 必须主动提示一次；
 *   ② 游戏内常驻程序 → **绝不能反复弹**（抖动、每局都弹都是打扰）。
 * 所以这里逐条锁住阈值行为与"重新武装"的边界。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CREDENTIAL_NOTICE_AFTER_FAILURES,
  CREDENTIAL_NOTICE_REARM_AFTER_SUCCESSES,
  DEFAULT_CREDENTIAL_NOTICE_THRESHOLDS,
  INITIAL_CREDENTIAL_NOTICE_STATE,
  credentialNoticeText,
  decideCredentialNotice,
  type CredentialNoticeState,
} from './credential-notice.ts';

/** 连续喂若干轮同样的读数，返回每一轮的判定。 */
function feed(
  n: number,
  credsAvailable: boolean,
  state: CredentialNoticeState = INITIAL_CREDENTIAL_NOTICE_STATE,
  clientRunning = false,
): { readonly shows: boolean[]; readonly state: CredentialNoticeState } {
  const shows: boolean[] = [];
  let cur = state;
  for (let i = 0; i < n; i++) {
    const d = decideCredentialNotice(cur, { credsAvailable, clientRunning });
    shows.push(d.show);
    cur = d.state;
  }
  return { shows, state: cur };
}

test('默认阈值 = 3 轮失败 / 6 轮成功（与 2 秒轮询节奏对齐）', () => {
  assert.equal(CREDENTIAL_NOTICE_AFTER_FAILURES, 3);
  assert.equal(CREDENTIAL_NOTICE_REARM_AFTER_SUCCESSES, 6);
  assert.deepEqual(DEFAULT_CREDENTIAL_NOTICE_THRESHOLDS, {
    noticeAfterFailures: 3,
    rearmAfterSuccesses: 6,
  });
});

test('★ 连续读不到凭证：第 3 轮提示**一次**，之后一直不再提示', () => {
  const { shows } = feed(10, false);
  assert.deepEqual(shows, [false, false, true, false, false, false, false, false, false, false]);
  assert.equal(shows.filter(Boolean).length, 1);
});

test('读到凭证就归零（抖动不算"连上过"）', () => {
  const first = feed(2, false); // 2 轮失败（未到阈值）
  assert.equal(first.shows.some(Boolean), false);
  const afterSuccess = feed(1, true, first.state);
  assert.equal(afterSuccess.state.failStreak, 0);
  // 再失败 2 轮仍不该提示（计数已经归零，需要重新攒满 3 轮）
  const again = feed(2, false, afterSuccess.state);
  assert.deepEqual(again.shows, [false, false]);
});

test('★ 短暂抖动**不会**重新武装（成功少于 6 轮 → 不再弹第二次）', () => {
  const warnOnce = feed(3, false); // 第一次提示
  assert.equal(warnOnce.shows[2], true);
  const flaky = feed(1, true, warnOnce.state); // 只成功 1 轮
  assert.equal(flaky.state.shown, true, '成功 1 轮不足以重新武装');
  const failAgain = feed(5, false, flaky.state);
  assert.equal(failAgain.shows.some(Boolean), false, '抖动后不该再弹');
});

test('★ 稳定连上 6 轮后重新武装：客户端又消失时可以再提示一次（且只一次）', () => {
  const warnOnce = feed(3, false);
  const recovered = feed(CREDENTIAL_NOTICE_REARM_AFTER_SUCCESSES, true, warnOnce.state);
  assert.equal(recovered.state.shown, false, '稳定连接后应重新武装');
  // 重新武装那一轮本身不许弹
  assert.equal(recovered.shows.some(Boolean), false);

  const failAgain = feed(6, false, recovered.state);
  assert.equal(failAgain.shows.filter(Boolean).length, 1, '每个连接会话最多一次');
  assert.equal(failAgain.shows[2], true);
});

test('重新武装只在"已经提示过"时才算事件（没提示过就没有可重新武装的）', () => {
  const { state } = feed(CREDENTIAL_NOTICE_REARM_AFTER_SUCCESSES, true);
  assert.equal(state.shown, false);
  const d = decideCredentialNotice(state, { credsAvailable: true, clientRunning: true });
  assert.equal(d.rearmed, false);
});

test('阈值可覆盖（测试/调参用），非法值被夹到 ≥1', () => {
  const tight = { noticeAfterFailures: 1, rearmAfterSuccesses: 1 };
  const d1 = decideCredentialNotice(INITIAL_CREDENTIAL_NOTICE_STATE, {
    credsAvailable: false,
    clientRunning: false,
  }, tight);
  assert.equal(d1.show, true);

  const zero = { noticeAfterFailures: 0, rearmAfterSuccesses: 0 };
  const d0 = decideCredentialNotice(INITIAL_CREDENTIAL_NOTICE_STATE, {
    credsAvailable: false,
    clientRunning: false,
  }, zero);
  assert.equal(d0.show, true, '阈值 0 应被夹成 1，而不是"永远不提示"');
});

test('每次判定都给出人读原因（日志里必须能回答"为什么弹/为什么不弹"）', () => {
  const d1 = decideCredentialNotice(INITIAL_CREDENTIAL_NOTICE_STATE, {
    credsAvailable: false,
    clientRunning: false,
  });
  assert.match(d1.reason, /未到 3 轮/);
  const d2 = decideCredentialNotice(d1.state, { credsAvailable: false, clientRunning: false });
  const d3 = decideCredentialNotice(d2.state, { credsAvailable: false, clientRunning: false });
  assert.equal(d3.show, true);
  assert.match(d3.reason, /只提示这一次/);
  const d4 = decideCredentialNotice(d3.state, { credsAvailable: false, clientRunning: false });
  assert.match(d4.reason, /不再打扰/);
});

test('纯函数：不改入参状态（主进程是把返回值存回去，不是就地改）', () => {
  const state: CredentialNoticeState = { failStreak: 2, successStreak: 0, shown: false };
  decideCredentialNotice(state, { credsAvailable: false, clientRunning: true });
  assert.deepEqual(state, { failStreak: 2, successStreak: 0, shown: false });
});

test('气泡文案：两种情形都说清"为什么"且给出可操作步骤', () => {
  const noClient = credentialNoticeText(false);
  assert.match(noClient.title, /凭证/);
  assert.match(noClient.content, /未检测到英雄联盟客户端/);
  assert.match(noClient.content, /管理员/);
  assert.match(noClient.content, /已启动/);
  assert.match(noClient.content, /标签/);

  const hasClient = credentialNoticeText(true);
  assert.match(hasClient.content, /检测到客户端，但读不到 LCU 凭证/);
  assert.equal(hasClient.title, noClient.title);
  // 两段文案都必须指向可操作的去处（托盘菜单里的日志）
  assert.match(hasClient.content, /打开日志/);
});
