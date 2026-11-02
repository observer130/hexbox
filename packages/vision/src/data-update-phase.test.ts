/**
 * 「更新数据」文案测试（纯函数）
 *
 * 这些文案是用户唯一能看到的"这次更新到底做了什么"，所以逐条钉死：
 *   · 日期口径（`YYYYMMDD` → `YYYY-MM-DD`，非法就显示"未知"而不是猜）；
 *   · 运行中菜单项必须带上阶段/进度（"点了没反应"是最糟的体验）；
 *   · 成功/失败/取消三种结果都必须说清"现有数据有没有被动过"。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DATA_UPDATE_MENU_PREFIX,
  DATA_UPDATE_PHASE_IDLE,
  dataUpdateFailureHint,
  dataUpdateMenuEnabled,
  dataUpdateMenuText,
  dataUpdatePromptText,
  dataUpdateResultText,
  formatStatDate,
  newDataNoticeText,
} from './data-update-phase.ts';

test('dataUpdateMenuText：空闲就是「更新数据」，运行中带阶段与进度', () => {
  assert.equal(dataUpdateMenuText(DATA_UPDATE_PHASE_IDLE), DATA_UPDATE_MENU_PREFIX);
  assert.equal(dataUpdateMenuText({ kind: 'checking' }), '正在检查新数据…');
  assert.equal(
    dataUpdateMenuText({ kind: 'syncing', label: '拉取图鉴' }),
    '正在更新数据…（拉取图鉴）· 点此取消',
  );
  assert.equal(
    dataUpdateMenuText({ kind: 'syncing', label: '单英雄详情', done: 42, total: 173 }),
    '正在更新数据…（单英雄详情 42/173）· 点此取消',
  );
  assert.equal(
    dataUpdateMenuText({ kind: 'syncing', label: '头像模板', done: 0, total: 0 }),
    '正在更新数据…（头像模板）· 点此取消',
    '0/0 不应显示成无意义的计数',
  );
});

test('dataUpdateMenuEnabled：空闲可开始、运行中可取消、探日期时不可点', () => {
  assert.equal(dataUpdateMenuEnabled(DATA_UPDATE_PHASE_IDLE), true);
  assert.equal(dataUpdateMenuEnabled({ kind: 'checking' }), false);
  assert.equal(dataUpdateMenuEnabled({ kind: 'syncing', label: 'x' }), true);
});

test('formatStatDate：合法 8 位 → 带横线；非法 → null（不猜）', () => {
  assert.equal(formatStatDate('20261005'), '2026-10-05');
  assert.equal(formatStatDate(' 20261005 '), '2026-10-05');
  assert.equal(formatStatDate('20261305'), null, '月份越界');
  assert.equal(formatStatDate('20261032'), null, '日期越界');
  assert.equal(formatStatDate('2026105'), null);
  assert.equal(formatStatDate(''), null);
  assert.equal(formatStatDate(null), null);
});

test('dataUpdatePromptText：确认框要说清日期、写入位置与"失败保留旧数据"', () => {
  const text = dataUpdatePromptText({
    localDate: '20261004',
    upstreamDate: '20261005',
    dataDir: 'C:\\Users\\me\\AppData\\Local\\hexbox\\data',
  });
  assert.equal(text.message, '要更新本地数据吗？');
  assert.match(text.detail, /官方统计已更新到 2026-10-05/);
  assert.match(text.detail, /本地是 2026-10-04/);
  assert.match(text.detail, /C:\\Users\\me\\AppData\\Local\\hexbox\\data/);
  assert.match(text.detail, /失败时保留现有数据/);
  assert.match(text.detail, /取消/);
});

test('dataUpdatePromptText：没探到上游日期时不假装"有新版"', () => {
  const text = dataUpdatePromptText({
    localDate: '20261004',
    upstreamDate: null,
    dataDir: '/data',
  });
  assert.match(text.detail, /当前本地数据的官方统计日期是 2026-10-04/);
  assert.doesNotMatch(text.detail, /已更新到/);
});

test('newDataNoticeText：气泡里给日期与操作路径', () => {
  const text = newDataNoticeText('20261004', '20261005');
  assert.match(text, /2026-10-05/);
  assert.match(text, /本地 2026-10-04/);
  assert.match(text, /右键托盘 →「更新数据」/);
  assert.match(newDataNoticeText(null, '20261005'), /右键托盘 →「更新数据」/);
  // 没有上游日期时也不许编一个日期出来
  assert.doesNotMatch(newDataNoticeText(null, null), /\d{4}-\d{2}-\d{2}/);
});

test('dataUpdateResultText：成功时列出写了哪些文件与统计日期', () => {
  const text = dataUpdateResultText({
    ok: true,
    aborted: false,
    wrote: ['dataset', 'rankings', 'builds'],
    failures: [],
    dataDate: '20261005',
    skipped: ['英雄集合未变'],
  });
  assert.match(text.message, /数据已更新（官方统计 2026-10-05）/);
  assert.match(text.detail, /图鉴、排行榜、单英雄详情/);
  assert.match(text.detail, /跳过：英雄集合未变/);
});

test('dataUpdateResultText：失败时列原因并明确"现有数据未被改动"', () => {
  const text = dataUpdateResultText({
    ok: false,
    aborted: false,
    wrote: [],
    failures: [{ label: '腾讯 101 数据站', message: 'HTTP 503' }],
    dataDate: '',
    skipped: [],
  });
  assert.equal(text.message, '更新失败');
  assert.match(text.detail, /腾讯 101 数据站：HTTP 503/);
  assert.match(text.detail, /现有数据未被改动/);
});

test('dataUpdateResultText：取消优先于"成功"（写了一半也不冒充更新完成）', () => {
  const text = dataUpdateResultText({
    ok: true, // 图鉴确实写成了，但详情没跑完
    aborted: true,
    wrote: ['dataset'],
    failures: [],
    dataDate: '20261005',
    skipped: [],
  });
  assert.equal(text.message, '已取消更新');
  assert.doesNotMatch(text.message, /数据已更新/);
  assert.match(text.detail, /取消前已写入：图鉴/);
});

test('dataUpdateResultText：取消时区分"写了一半"与"什么都没写"', () => {
  const half = dataUpdateResultText({
    ok: false,
    aborted: true,
    wrote: ['dataset'],
    failures: [],
    dataDate: '',
    skipped: [],
  });
  assert.equal(half.message, '已取消更新');
  assert.match(half.detail, /取消前已写入：图鉴/);
  assert.match(half.detail, /保留原有内容/);

  const none = dataUpdateResultText({
    ok: false,
    aborted: true,
    wrote: [],
    failures: [],
    dataDate: '',
    skipped: [],
  });
  assert.match(none.detail, /没有写入任何文件/);
});

test('dataUpdateFailureHint：区分"上游已有新版"与"根本没探到"', () => {
  assert.match(dataUpdateFailureHint('20261004', '20261005'), /上游已有 2026-10-05/);
  assert.match(dataUpdateFailureHint(null, '20261005'), /上游已有 2026-10-05/);
  assert.match(dataUpdateFailureHint('20261004', null), /没有探测到上游统计日期/);
});
