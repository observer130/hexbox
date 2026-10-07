/**
 * 版本比较测试（「检查更新」的判据）
 *
 * 覆盖用户点名的那几条：`0.1.0 < 0.1.1 < 0.2.0 < 1.0.0`、预发布后缀、
 * 非法输入、`v` 前缀、位数不齐（`1.2` vs `1.2.0`），外加"绝不放行假更新"的边界。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compareVersions,
  formatUpToDateText,
  formatUpdatePrompt,
  isNewerVersion,
  parseVersion,
  withVPrefix,
} from './update-version.ts';

test('parseVersion：三段 / 两位数 / v 前缀 / 预发布 / 构建元数据', () => {
  assert.deepEqual(parseVersion('0.1.0')?.text, '0.1.0');
  assert.deepEqual(parseVersion('v0.1.0')?.text, '0.1.0');
  assert.deepEqual(parseVersion('1.2')?.text, '1.2.0');
  assert.deepEqual(parseVersion('1')?.text, '1.0.0');
  assert.deepEqual(parseVersion('  v1.2.3  ')?.text, '1.2.3');
  assert.deepEqual(parseVersion('1.0.0-beta.1')?.prerelease, ['beta', '1']);
  // 构建元数据不参与比较：`1.0.0+a` 与 `1.0.0+b` 相等
  assert.equal(compareVersions('1.0.0+a', '1.0.0+b'), 0);
});

test('parseVersion：非法输入一律 null', () => {
  for (const bad of ['', '   ', 'latest', 'v', 'x.y.z', '1.2.3.4', 'v1.2.3-', '1.2.3 4', 'nightly-2026']) {
    assert.equal(parseVersion(bad), null, `应判为非法：${bad}`);
  }
  assert.equal(parseVersion(null), null);
  assert.equal(parseVersion(undefined), null);
});

test('compareVersions：用户点名的顺序 0.1.0 < 0.1.1 < 0.2.0 < 1.0.0', () => {
  const order = ['0.1.0', '0.1.1', '0.2.0', '1.0.0'];
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) {
      const a = order[i] ?? '';
      const b = order[j] ?? '';
      const expected = i === j ? 0 : i < j ? -1 : 1;
      assert.equal(compareVersions(a, b), expected, `${a} vs ${b}`);
    }
  }
});

test('compareVersions：位数不齐按 0 补（1.2 == 1.2.0 < 1.2.1）', () => {
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('1', '1.0.0'), 0);
  assert.equal(compareVersions('1.2', '1.2.1'), -1);
  assert.equal(compareVersions('v2', '1.9.9'), 1);
});

test('compareVersions：预发布 < 同号正式版（semver），预发布之间按段比', () => {
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta'), 1);
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0-beta.2'), -1);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0-beta.1'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  // 数字段 < 字母段（semver §11.4.3）
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
  // 预发布但主版本更高 → 仍然更新
  assert.equal(compareVersions('1.1.0-beta', '1.0.0'), 1);
});

test('isNewerVersion：合法才比较；非法输入 → false（不提示更新）', () => {
  assert.equal(isNewerVersion('0.1.1', '0.1.0'), true);
  assert.equal(isNewerVersion('v0.2.0', '0.1.0'), true);
  assert.equal(isNewerVersion('0.1.0', '0.1.0'), false);
  assert.equal(isNewerVersion('0.0.9', '0.1.0'), false);
  // 非法 → 绝不放行（宁可漏一次更新，也不能让用户装一个来路不明的版本）
  assert.equal(isNewerVersion('latest', '0.1.0'), false);
  assert.equal(isNewerVersion('0.2.0', '不是版本号'), false);
  assert.equal(isNewerVersion('1.2.3.4', '0.1.0'), false);
});

test('withVPrefix / 两句用户可见文案（逐字）', () => {
  assert.equal(withVPrefix('0.2.0'), 'v0.2.0');
  assert.equal(withVPrefix('v0.2.0'), 'v0.2.0');
  assert.equal(withVPrefix('V0.2.0'), 'v0.2.0');
  // 用户原话，逐字
  assert.equal(formatUpdatePrompt('0.2.0'), '检测到版本 v0.2.0，是否下载更新？');
  assert.equal(formatUpdatePrompt('v0.2.0'), '检测到版本 v0.2.0，是否下载更新？');
  assert.equal(formatUpdatePrompt('v1.0.0-beta.1'), '检测到版本 v1.0.0-beta.1，是否下载更新？');
  assert.equal(formatUpToDateText('0.1.0'), '已是最新版本 v0.1.0');
});
