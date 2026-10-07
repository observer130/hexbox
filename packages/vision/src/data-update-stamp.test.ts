/**
 * 「数据更新时间」口径测试（CI 里 Electron 跑不起来 —— 判据必须在纯函数上锁住）
 *
 * 为什么值得测：
 *   · 托盘菜单那一行是用户判断"我这份数据是哪天的"的唯一依据，
 *     而这个日期会被拿去和官方统计日期对照 —— 显示错一天比显示"未知"更糟；
 *   · `meta.dataDate` 是 `20261005` 这种**没有分隔符**的形态，
 *     切片的边界（月/日各两位）只有测试能守住。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DATA_UPDATE_FALLBACK_NOTE,
  DATA_UPDATE_LABEL_PREFIX,
  DATA_UPDATE_OFFICIAL_NOTE,
  dataUpdateStamp,
  formatLocalDate,
  parseDataDate,
} from './data-update-stamp.ts';

test('parseDataDate：官方统计日期 20261005 → 2026-10-05', () => {
  assert.equal(parseDataDate('20261005'), '2026-10-05');
  assert.equal(parseDataDate('2026-10-05'), null, '带分隔符的形态不是官方口径');
});

test('parseDataDate：非法输入一律 null（宁显示未知，也不显示错位的日期）', () => {
  for (const bad of ['', '   ', '2026', '2026105', '202610051', '20261301', '20261000', 'abc', '２０２６１００５']) {
    assert.equal(parseDataDate(bad), null, `应判为非法：${bad}`);
  }
  assert.equal(parseDataDate(undefined), null);
  assert.equal(parseDataDate(null), null);
});

test('formatLocalDate：本地时区补零（mtime 口径）', () => {
  assert.equal(formatLocalDate(new Date(2026, 9, 6)), '2026-10-06');
  assert.equal(formatLocalDate(new Date(2026, 0, 9)), '2026-01-09');
});

test('dataUpdateStamp：优先官方统计日期（并在文案里标出口径）', () => {
  const s = dataUpdateStamp({ dataDate: '20261005', mtimeMs: Date.UTC(2026, 9, 6, 11, 36) });
  assert.equal(s.source, 'data-date');
  assert.equal(s.date, '2026-10-05');
  assert.equal(s.label, `${DATA_UPDATE_LABEL_PREFIX}2026-10-05（${DATA_UPDATE_OFFICIAL_NOTE}）`);
  assert.match(s.detail, /20261005/);
});

test('dataUpdateStamp：没有官方统计日期 → 退回文件时间，且**必须标成回退口径**', () => {
  const mtimeMs = new Date(2026, 9, 6, 19, 36, 50).getTime();
  const s = dataUpdateStamp({ dataDate: null, mtimeMs });
  assert.equal(s.source, 'file-mtime');
  assert.equal(s.label, `${DATA_UPDATE_LABEL_PREFIX}2026-10-06（${DATA_UPDATE_FALLBACK_NOTE}）`);
  // 回退口径绝不能被误认为官方统计日期（两者含义不同，见模块头注释）
  assert.notEqual(DATA_UPDATE_FALLBACK_NOTE, DATA_UPDATE_OFFICIAL_NOTE);
});

test('dataUpdateStamp：非法 dataDate 不能挡住 mtime 回退', () => {
  const mtimeMs = new Date(2026, 9, 6).getTime();
  const s = dataUpdateStamp({ dataDate: '20261301', mtimeMs });
  assert.equal(s.source, 'file-mtime');
});

test('dataUpdateStamp：两个都没有 → 未知（不抛、不猜）', () => {
  for (const input of [{}, { dataDate: null, mtimeMs: null }, { dataDate: '', mtimeMs: 0 }, { dataDate: '', mtimeMs: NaN }]) {
    const s = dataUpdateStamp(input);
    assert.equal(s.source, 'unknown');
    assert.equal(s.date, '');
    assert.equal(s.label, `${DATA_UPDATE_LABEL_PREFIX}未知`);
  }
});
