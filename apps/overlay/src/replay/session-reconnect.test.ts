/**
 * 重连判定回放的测试（相位序列 → 线上纯判定）
 *
 * 为什么这个"回放小工具"也必须有单测：它的价值**全在"恢复动作必须为 0"**这一个
 * 断言上 —— 如果它自己把 `armed` 状态位忘了往下传，那么任何真实会话都会算出
 * "0 次恢复"，看起来永远是绿的，而红线其实一次都没被检查过。这正是本仓库
 * 在 `session-golden.ts` 上踩过的坑（判据住在脚本里 → 读错了整整一轮没人发现）。
 *
 * 所以这里两个方向都要测：
 *   · 真实会话那种"只有 InProgress"的序列 → **不许**触发恢复（否则是对局中途误触发）；
 *   · 真机上真会出现的 Reconnect → InProgress → **必须**恰好触发一次，并带上两个恢复动作。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { replayReconnectTimeline } from './session-replay.ts';

const P = (...phases: string[]): { atMs: number; phase: string }[] =>
  phases.map((phase, i) => ({ atMs: i * 1000, phase }));test('★ 真实会话（只录到 InProgress）→ 恢复动作必须为 0', () => {
  const r = replayReconnectTimeline(P('InProgress'));
  assert.equal(r.samples, 1);
  assert.equal(r.unreadable, 0);
  assert.deepEqual(r.observed, ['InProgress']);
  assert.equal(r.gaps, 0);
  assert.equal(r.recoveries, 0, '对局中途误触发恢复会让链路自己重启');
});

test('★ 长会话里反复的 InProgress 采样 → 依然一次都不许恢复', () => {
  const r = replayReconnectTimeline(P('InProgress', 'InProgress', 'InProgress'));
  assert.equal(r.samples, 3);
  assert.equal(r.recoveries, 0);
});

test('★ Reconnect → InProgress → 恰好恢复一次', () => {
  const r = replayReconnectTimeline(P('InProgress', 'Reconnect', 'InProgress'));
  assert.equal(r.gaps, 1, '进过 1 次 Reconnect');
  assert.equal(r.recoveries, 1, '回到对局中恢复一次');
});

test('读不到相位的采样（phase: null）计入 unreadable、不喂给判定', () => {
  // 真实链路里阶段门会保持上一阶段，所以重连判定看到的仍是上一阶段
  const withNull = [
    { atMs: 0, phase: 'InProgress' },
    { atMs: 1000, phase: null },
    { atMs: 2000, phase: 'Reconnect' },
    { atMs: 3000, phase: null },
    { atMs: 4000, phase: 'InProgress' },
  ];
  const r = replayReconnectTimeline(withNull);
  assert.equal(r.samples, 5);
  assert.equal(r.unreadable, 2);
  assert.deepEqual(r.observed, ['InProgress', 'Reconnect']);
  assert.equal(r.gaps, 1);
  assert.equal(r.recoveries, 1, 'null 不该把记账吃掉');
});

test('★ 一次重连只恢复一次：后面继续 InProgress 不再累加', () => {
  const r = replayReconnectTimeline(P('Reconnect', 'InProgress', 'InProgress', 'InProgress'));
  assert.equal(r.recoveries, 1);
  assert.equal(r.gaps, 1);
});

test('回归：选人 → 进局（正常转移）不许被当成重连恢复', () => {
  const r = replayReconnectTimeline(P('ChampSelect', 'InProgress'));
  assert.equal(r.gaps, 0);
  assert.equal(r.recoveries, 0, '正常进局不是重连');
  assert.deepEqual(r.observed, ['ChampSelect', 'InProgress']);
});

test('回归：Reconnect 之后回到选人（不是回到对局）→ 记账被清掉，不恢复', () => {
  const r = replayReconnectTimeline(P('Reconnect', 'ChampSelect', 'InProgress'));
  assert.equal(r.gaps, 1);
  assert.equal(r.recoveries, 0, '回到选人说明这一局结束了，不该做恢复');
});

test('observed 去重且按首次出现顺序；空序列 = 判定不了（samples 0）', () => {
  const r = replayReconnectTimeline(P('InProgress', 'ChampSelect', 'InProgress'));
  assert.deepEqual(r.observed, ['InProgress', 'ChampSelect']);
  const empty = replayReconnectTimeline([]);
  assert.equal(empty.samples, 0);
  assert.equal(empty.recoveries, 0, '0 条采样时 recoveries 也是 0，但调用方必须靠 samples 区分"没跑"');
  assert.deepEqual(empty.observed, []);
});
