/**
 * 「会话响应体 → 阶段读数」的测试（`stageSampleFromSession`，纯函数）
 *
 * 锁的是 2026-10-06 真机复盘里那条会**误停链路**的路径：
 * "读到了会话，但 `phase` 字段不可用"必须归为 **`null`（这一轮不知道）**，
 * 绝不能变成 `'None'` —— `'None'` 是"**确定的**不在对局"，连续两次就够
 * `createStageGate` 确认离开 → 停链路 + 清整排标签（而面板可能还开着）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createStageGate, stageSampleFromSession } from './visibility.ts';

test('stageSampleFromSession：正常会话 → 取 phase', () => {
  const r = stageSampleFromSession({ phase: 'InProgress', gameData: {} });
  assert.equal(r.sample, 'InProgress');
  assert.match(r.reason, /InProgress/);
});

test('stageSampleFromSession：读到会话但 phase 缺失/为空/非字符串 → null（**不是** None）', () => {
  for (const body of [{}, { phase: '' }, { phase: '   ' }, { phase: 7 }, { phase: null }, { map: {} }]) {
    const r = stageSampleFromSession(body);
    assert.equal(r.sample, null, `${JSON.stringify(body)} 必须归为"这一轮不知道"`);
    assert.notEqual(r.sample, 'None');
    assert.match(r.reason, /不知道|不可用|没有可用/);
  }
});

test('stageSampleFromSession：非对象响应（null/字符串/数字）→ null', () => {
  for (const body of [null, 'oops', 42, undefined]) {
    assert.equal(stageSampleFromSession(body).sample, null);
  }
});

test('stageSampleFromSession 的 null 结果喂给阶段门 → **保持**上一阶段（不确认离开）', () => {
  const gate = createStageGate({ leaveConfirm: 2 });
  assert.equal(gate.push('InProgress').stage, 'InProgress');
  // 连续 3 轮"读到了但看不懂"，都不该离开对局
  for (let i = 1; i <= 3; i++) {
    const r = gate.push(stageSampleFromSession({ gameData: {} }).sample);
    assert.equal(r.stage, 'InProgress', `第 ${i} 轮必须保持 InProgress`);
    assert.equal(r.held, true);
    assert.equal(r.leaveStreak, 0, '"不知道"不许累计离开计数');
  }
  // 紧接着真读到 None 两次 → 才确认离开
  assert.equal(gate.push('None').stage, 'InProgress', '第 1 次读到 None 还不够');
  const done = gate.push('None');
  assert.equal(done.stage, 'None');
  assert.equal(done.held, false);
  assert.match(done.reason, /确认离开/);
});
