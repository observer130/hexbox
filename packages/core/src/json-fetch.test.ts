/**
 * `fetchJsonWithRetry` / `MemoryHttpCache` 单测
 *
 * 锁定的契约（Provider 共用这一份实现）：
 *   · 200 解析并保存 ETag/正文；
 *   · 304 **只在有缓存正文时**复用，且第二次请求确实带 `If-None-Match`；
 *   · 4xx（非 429）不重试；5xx 重试一次；外部取消立即冒泡；
 *   · 没有缓存头时不做无意义的缓存。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MemoryHttpCache } from './http-cache.ts';
import { fetchJsonWithRetry } from './json-fetch.ts';

/** 造一个够用的 Response 桩（只实现 json-fetch 用到的字段）。 */
function stubResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  } as unknown as Response;
}

test('fetchJsonWithRetry：200 解析并缓存 ETag + 原始正文', async () => {
  const cache = new MemoryHttpCache();
  let calls = 0;
  const result = await fetchJsonWithRetry<{ a: number }>({
    url: 'https://x.test/a.json',
    label: '测试源',
    cache,
    fetchImpl: (async () => {
      calls++;
      return stubResponse(200, '{"a":1}', { etag: '"v1"' });
    }) as typeof fetch,
  });
  assert.deepEqual(result, { a: 1 });
  assert.equal(calls, 1);
  assert.deepEqual(cache.get('https://x.test/a.json'), { body: '{"a":1}', etag: '"v1"' });
});

test('fetchJsonWithRetry：第二次请求带 If-None-Match，304 复用缓存正文', async () => {
  const cache = new MemoryHttpCache();
  cache.set('https://x.test/a.json', { body: '{"a":2}', etag: '"v1"' });
  let sentIfNoneMatch: string | undefined;
  const result = await fetchJsonWithRetry<{ a: number }>({
    url: 'https://x.test/a.json',
    label: '测试源',
    cache,
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      sentIfNoneMatch = (init?.headers as Record<string, string> | undefined)?.['if-none-match'];
      return stubResponse(304, '');
    }) as typeof fetch,
  });
  assert.deepEqual(result, { a: 2 });
  assert.equal(sentIfNoneMatch, '"v1"');
});

test('fetchJsonWithRetry：304 但没有缓存正文 → 明确报错且不重试', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      fetchJsonWithRetry({
        url: 'https://x.test/a.json',
        label: '测试源',
        retryAttempts: 3,
        retryDelayMs: 1,
        fetchImpl: (async () => {
          calls++;
          return stubResponse(304, '');
        }) as typeof fetch,
      }),
    /304 但没有本地缓存正文/,
  );
  assert.equal(calls, 1, '304 无缓存是不可恢复错误，不许重试');
});

test('fetchJsonWithRetry：4xx 不重试（URL/权限错误重试无意义）', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      fetchJsonWithRetry({
        url: 'https://x.test/a.json',
        label: '测试源',
        retryAttempts: 3,
        retryDelayMs: 1,
        fetchImpl: (async () => {
          calls++;
          return stubResponse(403, 'no');
        }) as typeof fetch,
      }),
    /HTTP 403/,
  );
  assert.equal(calls, 1);
});

test('fetchJsonWithRetry：5xx 重试一次后成功', async () => {
  let calls = 0;
  const result = await fetchJsonWithRetry<number>({
    url: 'https://x.test/a.json',
    label: '测试源',
    retryDelayMs: 1,
    fetchImpl: (async () => {
      calls++;
      return calls === 1 ? stubResponse(503, 'busy') : stubResponse(200, '7');
    }) as typeof fetch,
  });
  assert.equal(result, 7);
  assert.equal(calls, 2);
});

test('fetchJsonWithRetry：重试用尽后抛最后一次错误', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      fetchJsonWithRetry({
        url: 'https://x.test/a.json',
        label: '测试源',
        retryAttempts: 2,
        retryDelayMs: 1,
        fetchImpl: (async () => {
          calls++;
          return stubResponse(500, 'boom');
        }) as typeof fetch,
      }),
    /HTTP 500/,
  );
  assert.equal(calls, 2);
});

test('fetchJsonWithRetry：外部取消立即冒泡，不再重试', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    () =>
      fetchJsonWithRetry({
        url: 'https://x.test/a.json',
        label: '测试源',
        signal: controller.signal,
        retryAttempts: 3,
        retryDelayMs: 1,
        fetchImpl: (async () => {
          calls++;
          controller.abort();
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }) as typeof fetch,
      }),
    /aborted/,
  );
  assert.equal(calls, 1, '外部取消后不许继续重试');
});

test('fetchJsonWithRetry：响应没有 ETag/Last-Modified 时不写缓存', async () => {
  const cache = new MemoryHttpCache();
  await fetchJsonWithRetry({
    url: 'https://x.test/a.json',
    label: '测试源',
    cache,
    fetchImpl: (async () => stubResponse(200, '{}')) as typeof fetch,
  });
  assert.equal(cache.size, 0);
});
