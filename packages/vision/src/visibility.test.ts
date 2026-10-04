/**
 * 可见性判定测试
 *
 * 重点回归「连不上客户端时诊断面板不再出现」的真实 bug：
 * 原实现只在**阶段变化**时更新窗口，因此中途掉线（阶段没变、
 * 仅连接状态变化）不会重新显示窗口。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decideVisible, sameVisibleState } from './visibility.ts';

test('decideVisible：选人阶段**只**显示覆盖层，不弹侧边窗', () => {
  // 2026-10-04 用户决策：选人阶段的信息由覆盖层画在游戏画面内
  // （卡片下方 / 顶栏逐格），侧边窗与它重复且会叠在英雄立绘上抢地方。
  assert.deepEqual(decideVisible('ChampSelect', true), {
    showPanel: false,
    showVision: true,
    visionActive: true,
  });
});

test('decideVisible：对局中只显示侧边窗（卡片已不存在，不截屏）', () => {
  assert.deepEqual(decideVisible('InProgress', true), {
    showPanel: true,
    showVision: false,
    visionActive: false,
  });
});

test('decideVisible：大厅等非对局阶段隐藏侧边窗（已连上，不是故障）', () => {
  for (const phase of ['None', 'Lobby', 'Matchmaking', 'ReadyCheck', 'EndOfGame']) {
    assert.deepEqual(
      decideVisible(phase, true),
      { showPanel: false, showVision: false, visionActive: false },
      `阶段 ${phase} 不该显示侧边窗`,
    );
  }
});

test('decideVisible：连不上客户端也不再弹窗（用户选择"只写日志"）', () => {
  // 回归：此处曾是「未连接必须显示诊断面板」。用户 2026-10-04 明确改为
  // 不弹窗、只写日志 —— 排查信息在终端输出与 overlay-live.log 里。
  for (const phase of ['None', 'Lobby', 'ChampSelect', '', 'InProgress']) {
    const v = decideVisible(phase, false);
    assert.equal(v.showPanel, phase === 'InProgress', `阶段 ${phase} 的侧边窗显隐`);
  }
});

test('decideVisible：未连接时不启动视觉循环（没有客户端就没有选人）', () => {
  const v = decideVisible('None', false);
  assert.equal(v.visionActive, false);
  assert.equal(v.showVision, false);
});

test('sameVisibleState：null 与任何状态都不等价（首轮必须应用一次）', () => {
  assert.equal(sameVisibleState(null, decideVisible('None', true)), false);
});

test('sameVisibleState：内容相同的两个对象等价（避免每轮 show/hide 闪烁）', () => {
  const a = decideVisible('InProgress', true);
  const b = decideVisible('InProgress', true);
  assert.equal(sameVisibleState(a, b), true);
  assert.notEqual(a, b); // 确实是两个对象，等价性来自字段比较
});

test('sameVisibleState：任一字段变化都要重新应用', () => {
  // 进/出选人：showVision 与 visionActive 都要翻转
  const lobby = decideVisible('Lobby', true);
  assert.equal(sameVisibleState(lobby, decideVisible('ChampSelect', true)), false);
  // 进出对局：showPanel 翻转
  assert.equal(sameVisibleState(lobby, decideVisible('InProgress', true)), false);
  // 同阶段重复：等价，不必重复 show/hide
  assert.equal(sameVisibleState(lobby, decideVisible('ReadyCheck', true)), true);
  assert.equal(sameVisibleState(lobby, decideVisible('None', true)), true);
});

test('sameVisibleState：连接状态翻转**不**改变可见性（用户要求不再弹窗）', () => {
  // 2026-10-04 起"连不上"不再影响窗口显隐，因此这两份判定等价；
  // 保留用例是为了锁住这个语义（曾经它会翻转，并引出"诊断面板不出现"的 bug）。
  for (const phase of ['None', 'Lobby', 'ChampSelect', 'InProgress']) {
    assert.equal(
      sameVisibleState(decideVisible(phase, true), decideVisible(phase, false)),
      true,
      `阶段 ${phase}：连接状态不该改变可见性`,
    );
  }
});
