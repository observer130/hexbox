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

test('decideVisible：选人阶段显示侧边窗 + 覆盖层 + 视觉循环', () => {
  assert.deepEqual(decideVisible('ChampSelect', true), {
    showPanel: true,
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

test('decideVisible：连不上客户端时必须显示侧边窗（诊断面板）', () => {
  // 这是回归重点：无论阶段是什么，连不上都要显示，否则用户看到「什么都没有」
  for (const phase of ['None', 'Lobby', 'ChampSelect', 'InProgress', '']) {
    assert.equal(
      decideVisible(phase, false).showPanel,
      true,
      `阶段 ${phase} 未连接时应显示诊断面板`,
    );
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
  const base = decideVisible('InProgress', true);
  assert.equal(sameVisibleState(base, decideVisible('ChampSelect', true)), false); // 进入选人

  // ⚠️ 真实 bug 的场景：阶段完全没变（都停在大厅），只有连接状态翻转。
  // 原实现只比较 phase，因此不会重新应用 → 诊断面板永远不出现。
  const lobby = decideVisible('Lobby', true); // 已连、不在对局 → 隐藏
  const offline = decideVisible('Lobby', false); // 掉线 → 必须显示诊断面板
  assert.equal(lobby.showPanel, false);
  assert.equal(offline.showPanel, true);
  assert.equal(sameVisibleState(lobby, offline), false);

  // 两个都不显示的不同阶段 → 等价，不必重复 show/hide
  assert.equal(sameVisibleState(lobby, decideVisible('ReadyCheck', true)), true);
  assert.equal(sameVisibleState(lobby, decideVisible('None', true)), true);
});
