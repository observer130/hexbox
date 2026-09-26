/**
 * templates 测试：编解码互逆 + 损坏检测 + buildEntry 归一化约定
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { buildEntry, decodePack, encodePack, type TemplatePack } from './templates.ts';

/** 手工构造一个确定的 3×3 模板灰度（有梯度，归一化才有意义）。 */
function gray3(): Uint8Array {
  return Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80, 90]);
}

const SAMPLE: TemplatePack = {
  version: 1,
  size: 3,
  createdAt: '2026-09-27T00:00:00.000Z',
  sourceUrl: 'https://raw.communitydragon.org/latest/plugins',
  count: 1,
  templates: [
    { championId: 1, name: '黑暗之女', alias: 'Annie', size: 3, norm: [0, 0.5, 1, -1, 0, 1, -0.5, 0, 0.5] },
  ],
};

test('encodePack → decodePack：字段互逆', () => {
  const decoded = decodePack(encodePack(SAMPLE));
  assert.equal(decoded.version, 1);
  assert.equal(decoded.size, 3);
  assert.equal(decoded.count, 1);
  assert.equal(decoded.createdAt, SAMPLE.createdAt);
  assert.equal(decoded.sourceUrl, SAMPLE.sourceUrl);
  assert.equal(decoded.templates.length, 1);
  const t = decoded.templates[0]!;
  assert.equal(t.championId, 1);
  assert.equal(t.name, '黑暗之女');
  assert.equal(t.alias, 'Annie');
  assert.equal(t.size, 3);
  assert.equal(t.norm.length, 9);
  assert.ok(Math.abs(t.norm[1]! - 0.5) < 1e-9);
});

test('encodePack 产物是 base64（可写入 JSON 文件）', () => {
  const encoded = encodePack(SAMPLE);
  assert.match(encoded, /^[A-Za-z0-9+/=]+$/);
});

test('decodePack：垃圾输入报错（不静默返回空包）', () => {
  assert.throws(() => decodePack('not-a-pack'), /解压失败|损坏/);
});

test('decodePack：版本不支持时报错', () => {
  const bad = JSON.stringify({ ...SAMPLE, version: 2 });
  const encoded = gzipSync(Buffer.from(bad, 'utf8')).toString('base64');
  assert.throws(() => decodePack(encoded), /版本/);
});

test('decodePack：灰度长度与 size² 不符时报错', () => {
  const bad: TemplatePack = {
    ...SAMPLE,
    templates: [{ ...SAMPLE.templates[0]!, norm: [1, 2, 3] }],
  };
  const encoded = gzipSync(
    Buffer.from(JSON.stringify({ ...bad, version: 1 }), 'utf8'),
  ).toString('base64');
  assert.throws(() => decodePack(encoded), /灰度长度/);
});

test('buildEntry：归一化长度 = size²，均值≈0', () => {
  const e = buildEntry({ id: 1, name: '黑暗之女', alias: 'Annie' }, gray3(), 3);
  assert.equal(e.norm.length, 9);
  const mean = e.norm.reduce((a, b) => a + b, 0) / e.norm.length;
  assert.ok(Math.abs(mean) < 1e-3, `均值应≈0，实际 ${mean}`);
  // 有梯度的输入归一化后必然有负值
  assert.ok(e.norm.some((v) => v < 0));
});

test('buildEntry：灰度长度不符时抛错', () => {
  assert.throws(() => buildEntry({ id: 1, name: 'x', alias: 'x' }, new Uint8Array(4), 3), /长度/);
});
