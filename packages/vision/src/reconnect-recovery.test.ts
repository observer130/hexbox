/**
 * 重连恢复判定测试
 *
 * 一条真机路径就能说明为什么这些断言值得写：
 *   选人 → 进局（正常，不能恢复）→ 掉线（`Reconnect`，只记账）→ 回到 `InProgress`
 *   （**恢复恰好一次**：重置熔断 + 补英雄身份）→ 之后每 2 秒轮询都**不再**恢复。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decideReconnectChainAction, reconnectStep, RECONNECT_PHASE } from './reconnect-recovery.ts';

test('正常进入对局：不是重连，不做任何恢复', () => {
  const step = reconnectStep({
    armed: false,
    phase: 'InProgress',
    chainState: 'running',
    championKnown: true,
  });
  assert.equal(step.recover, false);
  assert.equal(step.stage, 'normal');
  assert.equal(step.armed, false);
});

test('★ 进入 Reconnect 只记账，不恢复（重连期间不做任何动作）', () => {
  const step = reconnectStep({
    armed: false,
    phase: RECONNECT_PHASE,
    chainState: 'failed',
    championKnown: false,
  });
  assert.equal(step.armed, true);
  assert.equal(step.recover, false, 'Reconnect 本身不许触发恢复动作');
  assert.equal(step.stage, 'gap');
});

test('★ 重连后回到 InProgress：恢复一次，并重置本局熔断', () => {
  const step = reconnectStep({
    armed: true,
    phase: 'InProgress',
    chainState: 'failed',
    championKnown: false,
  });
  assert.equal(step.recover, true);
  assert.equal(step.resetChainFuse, true, 'failed = 本局放弃过，必须重置');
  assert.equal(step.heroFromCache, false, '英雄未知 → 要走 2999 兜底');
  assert.equal(step.armed, false, '必须消费掉记账');
  assert.equal(step.stage, 'recovered');
  assert.ok(step.reason.includes('重置熔断'), '原因要能直接进日志');
});

test('重连后回到 InProgress：链路正常时**不**重置熔断（不该无谓地打断在跑的会话）', () => {
  for (const state of ['idle', 'starting', 'running'] as const) {
    const step = reconnectStep({
      armed: true,
      phase: 'InProgress',
      chainState: state,
      championKnown: true,
    });
    assert.equal(step.recover, true, `${state}: 仍要恢复（英雄/标签仍可能要补）`);
    assert.equal(step.resetChainFuse, false, `${state}: 只有 failed 才重置`);
    assert.equal(step.heroFromCache, true);
  }
});

test('★ 一次重连只恢复一次：记账被消费后，后续每轮都是 normal', () => {
  let armed = false;
  // 掉线
  let step = reconnectStep({ armed, phase: RECONNECT_PHASE, chainState: 'failed', championKnown: false });
  armed = step.armed;
  assert.equal(armed, true);

  // 回到对局：恢复一次
  step = reconnectStep({ armed, phase: 'InProgress', chainState: 'failed', championKnown: false });
  armed = step.armed;
  assert.equal(step.recover, true);

  // 之后连续三轮（模拟 2 秒轮询）：**一次都不许再恢复**
  for (let i = 0; i < 3; i++) {
    step = reconnectStep({ armed, phase: 'InProgress', chainState: 'running', championKnown: true });
    armed = step.armed;
    assert.equal(step.recover, false, `第 ${i + 1} 轮不该重复恢复`);
    assert.equal(step.stage, 'normal');
  }
});

test('★ 选人相位把记账清掉：避免"选人 → 进局"被误判成重连恢复', () => {
  // 掉线记账
  let armed = reconnectStep({ armed: false, phase: RECONNECT_PHASE, chainState: 'idle', championKnown: true }).armed;
  assert.equal(armed, true);

  // 回到选人（真机上重连后可能先回大厅/选人）
  const cleared = reconnectStep({ armed, phase: 'ChampSelect', chainState: 'idle', championKnown: true });
  assert.equal(cleared.armed, false, '记账必须被清掉');
  assert.equal(cleared.recover, false);
  assert.equal(cleared.stage, 'idle');
  assert.ok(cleared.reason.includes('不属于重连恢复时机'));

  // 随后正常进局：**不许**恢复
  const then = reconnectStep({
    armed: cleared.armed,
    phase: 'InProgress',
    chainState: 'idle',
    championKnown: true,
  });
  assert.equal(then.recover, false);
  assert.equal(then.stage, 'normal');
});

test('终局/离开相位一律复位（含 None/WaitingForStats/PreEndOfGame/EndOfGame/GameStart）', () => {
  for (const phase of ['None', 'Lobby', 'Matchmaking', 'ReadyCheck', 'GameStart', 'WaitingForStats', 'PreEndOfGame', 'EndOfGame']) {
    const step = reconnectStep({ armed: true, phase, chainState: 'idle', championKnown: true });
    assert.equal(step.armed, false, `${phase}: 必须复位`);
    assert.equal(step.recover, false, `${phase}: 不许恢复`);
    assert.equal(step.stage, 'idle');
  }
});

test('相位名大小写敏感：不认识的字符串按"离开对局"处理（宁可复位，不可误恢复）', () => {
  const step = reconnectStep({ armed: true, phase: 'inprogress', chainState: 'failed', championKnown: false });
  assert.equal(step.recover, false);
  assert.equal(step.armed, false);
});

/* ------------------------------------------------------------------ */
/* 恢复时对链路做什么                                                   */
/* ------------------------------------------------------------------ */

test('★ failed → 重置熔断（本局曾被放弃；进程中断后那个结论不再可信）', () => {
  const a = decideReconnectChainAction({ chainState: 'failed', captureState: 'unavailable' });
  assert.equal(a.resetFuse, true);
  assert.equal(a.restartSession, false, '二者必须互斥（上游状态机不可能同时成立）');
  assert.ok(a.reason.includes('重置熔断'));
});

test('★ running + 抓帧不可用（僵尸会话）→ 停掉这一代重建，而不是只重置状态', () => {
  const a = decideReconnectChainAction({ chainState: 'running', captureState: 'unavailable' });
  assert.equal(a.restartSession, true);
  assert.equal(a.resetFuse, false);
  assert.ok(a.reason.includes('僵尸会话'));
});

test('running + 抓帧可用 → 什么都不动（重连不代表链路坏了）', () => {
  const a = decideReconnectChainAction({ chainState: 'running', captureState: 'stream' });
  assert.equal(a.resetFuse, false);
  assert.equal(a.restartSession, false);
  assert.ok(a.reason.includes('什么都不动'));
});

test('running + captureState=idle（启动途中的瞬态）→ 不动，避免抖动期反复重建', () => {
  const a = decideReconnectChainAction({ chainState: 'running', captureState: 'idle' });
  assert.equal(a.restartSession, false);
});

test('idle / starting → 一律不动（那是上游状态机自己的事）', () => {
  for (const chainState of ['idle', 'starting'] as const) {
    const a = decideReconnectChainAction({ chainState, captureState: 'unavailable' });
    assert.equal(a.resetFuse, false);
    assert.equal(a.restartSession, false);
    assert.ok(a.reason.includes(chainState));
  }
});

test('不变量：任何输入下 resetFuse 与 restartSession 都不许同时为真', () => {
  for (const chainState of ['idle', 'starting', 'running', 'failed'] as const) {
    for (const captureState of ['idle', 'stream', 'unavailable'] as const) {
      const a = decideReconnectChainAction({ chainState, captureState });
      assert.equal(
        a.resetFuse && a.restartSession,
        false,
        `${chainState}/${captureState} 同时给了两个动作`,
      );
    }
  }
});
