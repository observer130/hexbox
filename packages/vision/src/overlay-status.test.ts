/**
 * 托盘状态文案测试（CI 里 Electron 跑不起来，文案与判据必须在纯函数上锁住）
 *
 * 为什么值得测：托盘是常驻覆盖层**唯一**的交互入口（本体没有可见窗口），
 * 而这行状态是用户判断"它到底在干什么"的唯一现场依据 ——
 * 阶段词汇一旦与 `visibility.ts` 漂移，用户看到的就是错的状态。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TRAY_STATUS_WAITING_CLIENT,
  TRAY_TOOLTIP_HINT,
  trayStatus,
  trayTooltipText,
} from './overlay-status.ts';

test('trayStatus：连不上客户端 → 等待客户端（用户点名的口径）', () => {
  const s = trayStatus({ connected: false, phase: 'None' });
  assert.equal(s.code, 'waiting-client');
  assert.equal(s.text, TRAY_STATUS_WAITING_CLIENT);
});

test('trayStatus：**没连上时不许拿过期阶段当状态**（局内旧读数只进括号）', () => {
  // 中途掉凭证时阶段门会保持上一轮读数；此时状态词仍必须是"等待客户端"，
  // 否则用户会看到"局内"却一个标签都没有（更难排查）。
  const s = trayStatus({ connected: false, phase: 'InProgress' });
  assert.equal(s.text, TRAY_STATUS_WAITING_CLIENT);
  assert.match(s.detail, /InProgress/);
});

test('trayStatus：选人中 / 局内 两种口径', () => {
  assert.equal(trayStatus({ connected: true, phase: 'ChampSelect' }).text, '选人中');
  assert.equal(trayStatus({ connected: true, phase: 'InProgress' }).text, '局内');
  // 重连（局内阶段之一，见 AUGMENT_CHAIN_PHASES）同样算局内
  assert.equal(trayStatus({ connected: true, phase: 'Reconnect' }).text, '局内');
});

test('trayStatus：局内带上"面板开/未开"（局内为什么没标签的第一个分叉）', () => {
  const open = trayStatus({ connected: true, phase: 'InProgress', panel: 'open' });
  const closed = trayStatus({ connected: true, phase: 'InProgress', panel: 'closed' });
  assert.match(open.detail, /面板已开/);
  assert.match(closed.detail, /面板未开/);
  // 面板状态未知时也要有话说（不能空着）
  assert.match(trayStatus({ connected: true, phase: 'InProgress' }).detail, /面板未知/);
});

test('trayStatus：其它阶段给人话（大厅/匹配/结算），未知阶段回落到阶段原文', () => {
  assert.equal(trayStatus({ connected: true, phase: 'Lobby' }).text, '大厅');
  assert.equal(trayStatus({ connected: true, phase: 'Matchmaking' }).text, '匹配中');
  assert.equal(trayStatus({ connected: true, phase: 'WaitingForStats' }).text, '结算中');
  const weird = trayStatus({ connected: true, phase: 'SomeNewPhase' });
  assert.equal(weird.code, 'other');
  assert.match(weird.text, /SomeNewPhase/);
  // 空阶段也不能崩、不能是空字符串（菜单项会显示这一行）
  assert.notEqual(trayStatus({ connected: true, phase: '' }).text, '');
});

test('trayTooltipText：任何状态都必须写清"退出请右键托盘图标"', () => {
  const phases = ['None', 'ChampSelect', 'InProgress', 'Lobby', 'Whatever'];
  for (const connected of [true, false]) {
    for (const phase of phases) {
      const tip = trayTooltipText(trayStatus({ connected, phase }));
      assert.ok(
        tip.includes(TRAY_TOOLTIP_HINT),
        `tooltip 缺少退出说明: ${tip}`,
      );
      // 单行（Windows 的托盘提示是单行文本，换行不可靠）
      assert.ok(!tip.includes('\n'), `tooltip 不该有换行: ${JSON.stringify(tip)}`);
    }
  }
});

test('trayStatus：纯函数（同输入同输出，不改入参）', () => {
  const input = { connected: true, phase: 'InProgress', panel: 'open' } as const;
  const a = trayStatus(input);
  const b = trayStatus(input);
  assert.deepEqual(a, b);
  assert.deepEqual(input, { connected: true, phase: 'InProgress', panel: 'open' });
});
