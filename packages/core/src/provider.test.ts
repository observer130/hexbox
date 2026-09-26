/**
 * core 契约测试
 *
 * core 主要是类型定义（编译期），运行时逻辑很少。
 * 这里固化两件**在运行时必须成立**的约定：
 *
 *   1. DataClass 标签集合是显式枚举的，且 `process-invasive` 必须在内 ——
 *      它是本项目唯一的技术红线（不读内存/不注入/不解析封包）。
 *      这个测试的作用是：若有人重新引入「合规闸门」式的语义，
 *      或误删该标签，会被立刻发现。
 *   2. 标签本身只有**描述**用途，不含 allow/deny 语义 ——
 *      即不存在 assert*Allowed 之类的运行时拦截器。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { DataClass } from './provider.ts';

/** 所有数据类别标签（与 provider.ts 的联合类型保持同步）。 */
const ALL_DATA_CLASSES: readonly DataClass[] = [
  'official-static',
  'official-aggregated',
  'third-party-scraped',
  'live-session',
  'process-invasive',
];

test('DataClass：包含全部 5 个标签，且含 process-invasive（技术红线）', () => {
  assert.equal(ALL_DATA_CLASSES.length, 5);
  // 红线标签必须在：它标记「本项目不采用」的手段
  assert.ok(ALL_DATA_CLASSES.includes('process-invasive'));
  // 截屏 + OCR 归入 official-static（官方运行时画面），不是 process-invasive
  assert.ok(ALL_DATA_CLASSES.includes('official-static'));
  assert.ok(ALL_DATA_CLASSES.includes('live-session'));
});

test('DataClass：标签唯一，无重复', () => {
  assert.equal(new Set(ALL_DATA_CLASSES).size, ALL_DATA_CLASSES.length);
});

test('provider.ts：不得重新引入 allow/deny 式闸门', async () => {
  const src = await readFile(
    fileURLToPath(new URL('./provider.ts', import.meta.url)),
    'utf8',
  );

  // 曾经的 assert*Allowed() 闸门已按产品决策移除，不应回归
  assert.equal(
    /assert\w*Allowed/.test(src),
    false,
    'provider.ts 不应出现 assert*Allowed 式的准入闸门',
  );

  // dataClass 是描述性标签，注释中应明确这一点
  assert.match(src, /描述/);
});
