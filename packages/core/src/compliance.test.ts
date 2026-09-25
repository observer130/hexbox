/**
 * 合规闸门测试 —— 这些断言是**行为契约**，不是形式。
 *
 * 如果有人（包括未来的我）把海克斯胜率接进来，这些测试会失败。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertDataClassAllowed,
  ComplianceError,
  DATA_POLICY,
  isDataClassAllowed,
  listForbiddenDataClasses,
  type DataClass,
} from './compliance.ts';

test('静态数据类别必须被允许', () => {
  for (const dc of ['static-definition', 'static-numeric', 'pregame-visible'] as const) {
    assert.equal(isDataClassAllowed(dc), true, `${dc} 应被允许`);
    assert.doesNotThrow(() => assertDataClassAllowed(dc));
  }
});

test('海克斯胜率类数据必须被禁止', () => {
  assert.equal(isDataClassAllowed('augment-performance'), false);
  assert.throws(() => assertDataClassAllowed('augment-performance'), ComplianceError);
});

test('局内实时数据必须被禁止', () => {
  assert.equal(isDataClassAllowed('live-session'), false);
  assert.throws(() => assertDataClassAllowed('live-session'), ComplianceError);
});

test('模式级统计默认关闭（属解释空间，需人工确认）', () => {
  assert.equal(isDataClassAllowed('mode-performance'), false);
});

test('被禁止的类别必须附带原因说明', () => {
  const forbidden = listForbiddenDataClasses();
  assert.ok(forbidden.length >= 3, '至少应有 3 个被禁止的类别');
  for (const dc of forbidden) {
    const v = DATA_POLICY[dc];
    assert.equal(v.allowed, false);
    if (!v.allowed) {
      assert.ok(v.reason.length > 20, `${dc} 的原因说明过短，不足以指导决策`);
    }
  }
});

test('策略表覆盖全部 DataClass（无遗漏）', () => {
  const all: DataClass[] = [
    'static-definition',
    'static-numeric',
    'pregame-visible',
    'live-session',
    'augment-performance',
    'mode-performance',
  ];
  for (const dc of all) {
    assert.ok(DATA_POLICY[dc], `${dc} 未在策略表中定义`);
  }
});

test('ComplianceError 的消息应指向文档', () => {
  try {
    assertDataClassAllowed('augment-performance');
    assert.fail('应当抛错');
  } catch (e: unknown) {
    assert.ok(e instanceof ComplianceError);
    assert.match(e.message, /COMPLIANCE\.md/);
  }
});
