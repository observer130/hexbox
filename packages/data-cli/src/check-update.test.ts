/**
 * 「有没有新数据」的轻量检查测试（假 fetch，不联网）
 *
 * 重点：
 *   · 统计滞后一天是常态 → 要往前回退找第一个有数据的日期；
 *   · 拿不到日期必须与"已是最新"区分（`dataDate: null` + error）；
 *   · 24h 节流（失败也记时间，避免断网时每次启动都打上游）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DATA_CHECK_INTERVAL_MS,
  fetchLatestStatDate,
  isNewerDataDate,
  shouldCheckNow,
} from './check-update.ts';

/** 最小 Response 形状（只实现本模块用到的字段）。 */
function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

/** 上游 `_fieldValues` 形状（值为双重 JSON 字符串，与线上一致）。 */
function upstreamPayload(dtstatdate: string): unknown {
  return {
    code: 0,
    data: { _fieldValues: { R15381: JSON.stringify({ dtstatdate, list: 'x' }) } },
  };
}

const NOW = new Date('2026-10-06T20:00:00+08:00');

test('fetchLatestStatDate：当天数据还没出 → 回退到前一天并返回其日期', async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    // 20261005 无数据（滞后/维护），20261004 有
    return url.includes('dtstatdate=20261005')
      ? jsonResponse({ code: 0, data: { _fieldValues: {} } })
      : jsonResponse(upstreamPayload('20261004'));
  }) as unknown as typeof fetch;

  const r = await fetchLatestStatDate({ fetchImpl, now: () => NOW });
  assert.equal(r.dataDate, '20261004');
  assert.deepEqual(r.tried, ['20261005', '20261004']);
  assert.equal(seen.length, 2);
  assert.equal(r.error, undefined);
});

test('fetchLatestStatDate：第一次就有数据 → 只请求一次', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return jsonResponse(upstreamPayload('20261005'));
  }) as unknown as typeof fetch;

  const r = await fetchLatestStatDate({ fetchImpl, now: () => NOW });
  assert.equal(r.dataDate, '20261005');
  assert.equal(calls, 1);
});

test('fetchLatestStatDate：候选日期按**北京时间**算，不随宿主机时区漂（审查 P2 回归）', async () => {
  // 北京 2026-10-07 01:30 = UTC 2026-10-06 17:30。
  // 本地时区实现（getFullYear/getMonth/getDate）在 UTC 机器上会算成 T-1=10-05，
  // 固定 +8 口径必须是 10-06 —— CI（windows-latest）跑在 UTC，能抓住这个回归。
  const beijingEarly = new Date('2026-10-06T17:30:00Z');
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    return jsonResponse({}, 503);
  }) as unknown as typeof fetch;

  const r = await fetchLatestStatDate({
    fetchImpl,
    now: () => beijingEarly,
    maxLookbackDays: 2,
  });
  assert.equal(r.dataDate, null);
  assert.equal(seen[0]?.includes('dtstatdate=20261006'), true, `首个候选日应为 20261006，实际 ${seen[0]}`);
  assert.equal(seen[1]?.includes('dtstatdate=20261005'), true);
});

test('fetchLatestStatDate：全部失败 → null + 错误摘要（不是"已是最新"）', async () => {
  const fetchImpl = (async () => jsonResponse({}, 503)) as unknown as typeof fetch;
  const r = await fetchLatestStatDate({ fetchImpl, now: () => NOW, maxLookbackDays: 2 });
  assert.equal(r.dataDate, null);
  assert.equal(r.tried.length, 2);
  assert.match(r.error ?? '', /503/);
});

test('fetchLatestStatDate：网络异常也不抛（只回报错误）', async () => {
  const fetchImpl = (async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  }) as unknown as typeof fetch;
  const r = await fetchLatestStatDate({ fetchImpl, now: () => NOW, maxLookbackDays: 1 });
  assert.equal(r.dataDate, null);
  assert.match(r.error ?? '', /ENOTFOUND/);
});

test('isNewerDataDate：严格大于才算新；本地为空视为有更新', () => {
  assert.equal(isNewerDataDate('20261005', '20261004'), true);
  assert.equal(isNewerDataDate('20261004', '20261005'), false);
  assert.equal(isNewerDataDate('20261005', '20261005'), false);
  assert.equal(isNewerDataDate('20261005', null), true);
  assert.equal(isNewerDataDate('20261005', ''), true);
  assert.equal(isNewerDataDate(null, '20261005'), false);
  assert.equal(isNewerDataDate('2026-10-05', '20261004'), false, '非 8 位格式不参与比较');
});

test('shouldCheckNow：没有记录/坏记录 → 检查；24h 内 → 跳过', () => {
  assert.equal(shouldCheckNow(null, NOW), true);
  assert.equal(shouldCheckNow(undefined, NOW), true);
  assert.equal(shouldCheckNow('不是日期', NOW), true);
  assert.equal(
    shouldCheckNow(new Date(NOW.getTime() - 23 * 3600_000).toISOString(), NOW),
    false,
  );
  assert.equal(
    shouldCheckNow(new Date(NOW.getTime() - DATA_CHECK_INTERVAL_MS).toISOString(), NOW),
    true,
  );
});
