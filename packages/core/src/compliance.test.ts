/**
 * 合规闸门测试 —— 这些断言是**行为契约**，不是形式。
 *
 * 与 packages/core/src/compliance.ts 中的 DATA_POLICY 及其说明注释对应：
 * 策略改了这里必须跟着改，反之亦然。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertDataClassAllowed,
  assertDataSourceAllowed,
  ComplianceError,
  DATA_POLICY,
  isDataClassAllowed,
  listForbiddenDataClasses,
  type DataClass,
} from './compliance.ts';

test('官方一方数据类别必须被允许', () => {
  for (const dc of ['official-static', 'official-aggregated'] as const) {
    assert.equal(isDataClassAllowed(dc), true, `${dc} 应被允许`);
    assert.doesNotThrow(() => assertDataClassAllowed(dc));
  }
});

test('第三方爬取数据必须被禁止', () => {
  assert.equal(isDataClassAllowed('third-party-scraped'), false);
  assert.throws(() => assertDataClassAllowed('third-party-scraped'), ComplianceError);
});

test('局内实时数据必须被禁止', () => {
  assert.equal(isDataClassAllowed('live-session'), false);
  assert.throws(() => assertDataClassAllowed('live-session'), ComplianceError);
});

test('手段红线必须被禁止且不可翻转为允许', () => {
  assert.equal(isDataClassAllowed('process-invasive'), false);
  assert.throws(() => assertDataClassAllowed('process-invasive'), ComplianceError);
  const verdict = DATA_POLICY['process-invasive'];
  assert.ok(!verdict.allowed);
  assert.match(verdict.reason, /读内存|注入|封包/);
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
    'official-static',
    'official-aggregated',
    'third-party-scraped',
    'live-session',
    'process-invasive',
  ];
  for (const dc of all) {
    assert.ok(DATA_POLICY[dc], `${dc} 未在策略表中定义`);
  }
  assert.equal(Object.keys(DATA_POLICY).length, all.length);
});

test('ComplianceError 的消息应指向策略说明', () => {
  try {
    assertDataClassAllowed('third-party-scraped');
    assert.fail('应当抛错');
  } catch (e: unknown) {
    assert.ok(e instanceof ComplianceError);
    assert.match(e.message, /DATA_POLICY/);
  }
});

test('assertDataSourceAllowed 与 assertDataClassAllowed 行为一致', () => {
  assert.doesNotThrow(() => assertDataSourceAllowed('official-static'));
  assert.throws(() => assertDataSourceAllowed('live-session'), ComplianceError);
});
