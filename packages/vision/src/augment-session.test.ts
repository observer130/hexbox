/**
 * 会话解析 + 回放引擎测试（不需要游戏 / Electron / 管理员）
 *
 * 策略：
 *   · **解析**用例只喂文本 —— 包括真机留档里的两种 `api-trigger.csv` 形态
 *     （`pending` 带引号 / **未转义**），后者是真正会被 `split(',')` 悄悄解错的那种；
 *   · **回放**用例喂合成事件序列，断言的是"线上纯函数"的行为（边沿/窗口/消耗/节流），
 *     即"这套回放确实在驱动线上那几份代码"，而不是回放自己的实现。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PanelDetection } from './augment-panel.ts';
import type { PanelPresence } from './augment-presence.ts';
import {
  parseApiTraceCsv,
  parseCsvRows,
  parseFramesIndexJsonl,
  parsePendingList,
  parseSessionMeta,
  parseTimelineCsv,
  rectFromCrop,
  rectToCrop,
  regionsInCrop,
} from './augment-session.ts';
import {
  compareGatingToTimeline,
  replayApiTrigger,
  replayPanelGating,
  sessionSpanMs,
  summarizeSession,
} from './augment-session-replay.ts';

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function det(found: boolean, reason = found ? '3 张卡片：内部暗(30/25/39)' : '卡片数 0'): PanelDetection {
  return {
    found,
    cards: found ? [1, 2, 3].map(() => ({ rect: { x: 0.2, y: 0.2, w: 0.2, h: 0.4 }, interiorLuma: 30, edgeLuma: 120 })) : [],
    bands: found ? 3 : 0,
    reason,
  };
}

function presence(present: boolean): PanelPresence {
  return {
    present,
    topRow: present ? 100 : null,
    bottomRow: present ? 400 : null,
    topFrac: present ? 0.8 : 0,
    bottomFrac: present ? 0.8 : 0,
    topProminence: present ? 60 : 0,
    bottomProminence: present ? 60 : 0,
    reason: present ? '上下缘亮带成立' : '亮带不足',
  };
}

/* ------------------------------------------------------------------ */
/* 解析：CSV                                                           */
/* ------------------------------------------------------------------ */

test('parseCsvRows：双引号内的逗号/引号不再拆列', () => {
  const rows = parseCsvRows('a,b,c\n1,"x,y","he said ""hi"""\n2,,3\n');
  assert.deepEqual(rows[0], ['a', 'b', 'c']);
  assert.deepEqual(rows[1], ['1', 'x,y', 'he said "hi"']);
  assert.deepEqual(rows[2], ['2', '', '3']);
});

test('parseCsvRows：CRLF 与结尾无换行都能吃', () => {
  assert.deepEqual(parseCsvRows('a,b\r\n1,2\r\n'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
  assert.deepEqual(parseCsvRows('a,b\n1,2'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('parsePendingList：三种形态', () => {
  assert.deepEqual(parsePendingList('[0,7,11,15]'), [0, 7, 11, 15]);
  assert.deepEqual(parsePendingList('[]'), []);
  assert.deepEqual(parsePendingList('  [15]  '), [15]);
  assert.deepEqual(parsePendingList(''), []);
});

/* ------------------------------------------------------------------ */
/* 解析：api-trigger.csv（两种历史形态）                                */
/* ------------------------------------------------------------------ */

const API_HEADER = 'ms,gameTime,level,isDead,respawnTimer,capture,pending,reason\n';

test('parseApiTraceCsv：**未转义**的 pending（真机旧留档形态）也能正确解析', () => {
  // 这一行的 pending 含逗号却没加引号 —— 字段数比表头多，天真的 split(',') 会
  // 把 `[0` / `7` / `11` / `15]` 当成四列而不报错（真机 debug/augment/api-trigger.csv 就是它）。
  const text =
    API_HEADER + '2348,0.0,1,0,0.0,1,[0,7,11,15],开局（对局 0s）：开截屏\n' + '3382,1.0,1,0,0.0,0,[],死亡但无待选：不开\n';
  const rows = parseApiTraceCsv(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    atMs: 2348,
    gameTime: 0,
    level: 1,
    isDead: false,
    respawnTimer: 0,
    capture: true,
    pending: [0, 7, 11, 15],
    reason: '开局（对局 0s）：开截屏',
  });
  assert.equal(rows[1]!.capture, false);
  assert.deepEqual(rows[1]!.pending, []);
  assert.equal(rows[1]!.reason, '死亡但无待选：不开');
});

test('parseApiTraceCsv：正确转义的 pending 走标准 CSV 路径', () => {
  const text = API_HEADER + '100,12.5,10,1,7.2,1,"[7,11,15]","死亡（等级 10，待选 [7,11]）：开截屏"\n';
  const rows = parseApiTraceCsv(text);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.pending, [7, 11, 15]);
  assert.equal(rows[0]!.isDead, true);
  assert.equal(rows[0]!.gameTime, 12.5);
  assert.equal(rows[0]!.capture, true);
});

test('parseApiTraceCsv：按列名取，不因新增列而错位', () => {
  const text = 'ms,gameTime,level,isDead,respawnTimer,capture,pending,reason,extra\n' + '5,1,2,0,0,0,[7],等死亡,zzz\n';
  const rows = parseApiTraceCsv(text);
  assert.equal(rows[0]!.level, 2);
  assert.deepEqual(rows[0]!.pending, [7]);
  assert.equal(rows[0]!.reason, '等死亡');
});

test('parseApiTraceCsv：空文件与只有表头都不炸', () => {
  assert.deepEqual(parseApiTraceCsv(''), []);
  assert.deepEqual(parseApiTraceCsv(API_HEADER), []);
});

/* ------------------------------------------------------------------ */
/* 解析：timeline.csv / frames.idx.jsonl / session.json                 */
/* ------------------------------------------------------------------ */

test('parseTimelineCsv：抽出门控边沿（驱动 notePanelOpen/Closed）', () => {
  const text =
    'ms,found,cards,bands,frameLuma,detectMs,grabMs,sincePrevMs,state,edgeEvent,cadence,hits,misses,reason\n' +
    '1000,0,0,13,,8.9,42.6,0.0,closed,,0,1,idle,卡片数 0\n' +
    '2000,1,3,6,30,5.0,17.7,1000.0,open,open,active@250,2,0,3 张卡片\n' +
    '3000,0,0,6,,6.0,18.0,1000.0,closed,close,idle,0,3,两个信号都不在\n';
  const { rows, edges } = parseTimelineCsv(text);
  assert.equal(rows.length, 3);
  assert.deepEqual(edges, [
    { atMs: 2000, kind: 'open' },
    { atMs: 3000, kind: 'close' },
  ]);
  assert.equal(rows[1]!.found, true);
  assert.equal(rows[1]!.state, 'open');
});

test('parseFramesIndexJsonl：坏行跳过并计数，按时间排序', () => {
  const text = [
    '{"seq":2,"atMs":2000,"kind":"gating","file":"g/0002.png"}',
    'not json',
    '{"seq":1,"atMs":1000,"kind":"native","file":"n/0001.png","crop":{"x":0.1,"y":0.1,"w":0.8,"h":0.7}}',
    '{"atMs":"x","kind":"gating","file":"g/bad.png"}',
    '',
  ].join('\n');
  const { frames, skipped } = parseFramesIndexJsonl(text);
  assert.equal(skipped, 2);
  assert.deepEqual(
    frames.map((f) => f.atMs),
    [1000, 2000],
  );
  assert.equal(frames[0]!.kind, 'native');
  assert.equal(frames[1]!.crop.w, 1); // 缺 crop → 整幅
});

test('parseSessionMeta：缺字段降级而不抛（回放按缺失能力降级）', () => {
  const fallback = { region: { x: 0.12, y: 0.1, w: 0.76, h: 0.66 }, altRegion: { x: 0, y: 0, w: 1, h: 1 } };
  const meta = parseSessionMeta({ trigger: 'api', gating: { width: 1147, height: 480 } }, fallback);
  assert.equal(meta.version, 1);
  assert.equal(meta.trigger, 'api');
  assert.equal(meta.gating?.width, 1147);
  assert.equal(meta.gating?.targetScale, 1 / 3);
  assert.deepEqual(meta.frameCrop, { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(meta.region, fallback.region);
  assert.equal(meta.windowPhysical, null);

  const broken = parseSessionMeta(null, fallback);
  assert.equal(broken.trigger, 'pixel');
  assert.equal(broken.gating, null);
  assert.deepEqual(broken.env, {});
});

/* ------------------------------------------------------------------ */
/* 坐标映射                                                            */
/* ------------------------------------------------------------------ */

test('rectToCrop / rectFromCrop：往返一致（裁剪存档的几何不许偏移）', () => {
  const crop = { x: 0.12, y: 0.1, w: 0.76, h: 0.66 };
  const canvas = { x: 0.3, y: 0.2, w: 0.2, h: 0.3 };
  const inCrop = rectToCrop(canvas, crop)!;
  const back = rectFromCrop(inCrop, crop);
  for (const k of ['x', 'y', 'w', 'h'] as const) {
    assert.ok(Math.abs(back[k] - canvas[k]) < 1e-12, `${k}: ${back[k]} vs ${canvas[k]}`);
  }
});

test('rectToCrop：与裁剪区无交集时返回 null（不许硬算）', () => {
  const crop = { x: 0.5, y: 0.5, w: 0.5, h: 0.5 };
  assert.equal(rectToCrop({ x: 0, y: 0, w: 0.2, h: 0.2 }, crop), null);
  assert.equal(rectToCrop({ x: 0.1, y: 0.1, w: 0.4, h: 0.4 }, crop), null);
  // 边界相接（面积为 0）也算没交集
  assert.equal(rectToCrop({ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, crop), null);
});

test('regionsInCrop：裁剪区必须**完整覆盖**两个搜索区（部分覆盖返回 null）', () => {
  const region = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
  const alt = { x: 0.12, y: 0.1, w: 0.76, h: 0.66 };
  const covered = regionsInCrop(region, alt, { x: 0.1, y: 0.05, w: 0.8, h: 0.8 });
  assert.ok(covered !== null);
  assert.ok(Math.abs(covered.region.w - 0.4 / 0.8) < 1e-12);
  // 只覆盖一部分 → 检测范围比线上小（回放会假阴性）→ 明确返回 null，让调用方跳过
  assert.equal(regionsInCrop(region, alt, { x: 0.3, y: 0.3, w: 0.4, h: 0.4 }), null);
  // 整幅存档永远覆盖
  assert.ok(regionsInCrop(region, alt, { x: 0, y: 0, w: 1, h: 1 }) !== null);
});

/* ------------------------------------------------------------------ */
/* 触发状态机回放                                                      */
/* ------------------------------------------------------------------ */

/** 一局最小场景：开局 → 7 级死亡 → 面板出现/选完。 */
const SAMPLE = { gameTime: 0, level: 1, isDead: false, respawnTimer: 0 };

test('replayApiTrigger：开局窗口 → 门控开边沿 → 关边沿消耗开局那次并收工', () => {
  const samples = [
    { atMs: 0, ...SAMPLE },
    { atMs: 1000, ...SAMPLE },
    { atMs: 6000, ...SAMPLE, gameTime: 6 },
  ];
  const edges = [
    { atMs: 3000, kind: 'open' as const },
    { atMs: 4500, kind: 'close' as const },
  ];
  const r = replayApiTrigger({ samples, edges });

  assert.equal(r.metrics.windows, 1);
  assert.equal(r.metrics.firstOpenAtMs, 0);
  // 面板关边沿消耗了"开局（0 级）"这一次
  assert.deepEqual(
    r.metrics.consumed.map((c) => c.level),
    [0],
  );
  assert.deepEqual(r.metrics.unconsumed, [7, 11, 15]);
  // ⚠️ 1 级时 7/11/15 都**不够格**（`eligible()` 要求 lv ≤ 当前等级）→ 不留窗
  assert.equal(r.steps[r.steps.length - 1]!.capture, false);
  assert.equal(r.windows[0]!.closeAtMs, 4500);
  assert.equal(r.metrics.armedMs, 4500);
});

test('replayApiTrigger：连选 —— 高等级下消耗一次后仍有够格未选 → 保持开着', () => {
  // 第一帧就在 12 级（工具中途启动）：0 级按"已选"处理，且 12 级跨过了 7/11 →
  // "升级定向开窗"立刻开一窗（2026-10-12 的行为，这里锁住它）。
  const samples = [
    { atMs: 0, gameTime: 300, level: 12, isDead: false, respawnTimer: 0 },
    { atMs: 1000, gameTime: 301, level: 12, isDead: false, respawnTimer: 0 },
  ];
  const edges = [
    { atMs: 3000, kind: 'open' as const },
    { atMs: 4500, kind: 'close' as const },
  ];
  const r = replayApiTrigger({ samples, edges });
  assert.equal(r.metrics.windows, 1);
  assert.match(r.windows[0]!.openReason, /升级到待选等级/);
  // ⚠️ 中途启动丢弃的开局那次**不算"选完"**（两条移除路径必须分开记）
  assert.deepEqual(r.metrics.initDropped, [{ level: 0, atMs: 0 }]);
  // 消耗 7 之后 11 仍够格 → 保持开截屏等连选
  assert.deepEqual(
    r.metrics.consumed.map((c) => c.level),
    [7],
  );
  assert.equal(r.steps.at(-1)!.capture, true);
  assert.equal(r.windows[0]!.closeAtMs, null);
  assert.deepEqual(r.metrics.unconsumed, [11, 15]);
});

test('replayApiTrigger：死亡瞬间按等级开窗，超时未见面板自动关闭且**保留** pending', () => {
  const samples = [
    // 中途启动（gameTime > midGameStartSec）：开局那次按已选处理。
    // ⚠️ 等级必须**与前一帧相同**才不触发"升级定向开窗" —— 首帧的 prevLevel 是 0，
    //    所以首帧就报 7 级会被判成"升级跨过 7"。这里让首帧是 0 级、下一帧在死亡中升到 7。
    { atMs: 0, gameTime: 300, level: 0, isDead: false, respawnTimer: 0 },
    { atMs: 1000, gameTime: 305, level: 7, isDead: true, respawnTimer: 8 },
    { atMs: 2000, gameTime: 306, level: 7, isDead: true, respawnTimer: 7 },
    // 窗口 45s 到期后的一次采样
    { atMs: 50_000, gameTime: 350, level: 9, isDead: false, respawnTimer: 0 },
  ];
  const r = replayApiTrigger({ samples });
  assert.equal(r.metrics.windows, 1);
  const w = r.windows[0]!;
  assert.equal(w.openAtMs, 1000);
  assert.equal(w.closeAtMs, 50_000);
  assert.match(w.openReason, /死亡/);
  assert.match(w.closeReason ?? '', /超时/);
  // 没见到面板 → pending 一个都没消耗（7 级那次留着，下次死亡再试）
  assert.deepEqual(r.metrics.consumed, []);
  assert.deepEqual(r.metrics.unconsumed, [7, 11, 15]);
});

test('replayApiTrigger：与录制判定不一致的采样被列成差异（行为差异报告）', () => {
  const samples = [
    { atMs: 0, gameTime: 0, level: 1, isDead: false, respawnTimer: 0, capture: false },
    { atMs: 1000, gameTime: 1, level: 1, isDead: false, respawnTimer: 0, capture: true },
  ];
  const r = replayApiTrigger({ samples });
  assert.equal(r.metrics.mismatchCount, 1);
  assert.deepEqual(r.metrics.mismatches[0], { atMs: 0, recorded: false, replayed: true });
});

test('replayApiTrigger：边沿先于同刻采样处理（与线上"关边沿 → 下一次轮询看到新 pending"一致）', () => {
  const samples = [
    { atMs: 0, gameTime: 0, level: 1, isDead: false, respawnTimer: 0 },
    { atMs: 2000, gameTime: 2, level: 1, isDead: false, respawnTimer: 0 },
  ];
  const edges = [
    { atMs: 1000, kind: 'open' as const },
    { atMs: 2000, kind: 'close' as const },
  ];
  const r = replayApiTrigger({ samples, edges });
  // 同一毫秒里"关边沿"先被处理：那一刻 pending 已经少了一个
  const at2000 = r.steps.filter((s) => s.atMs === 2000);
  assert.deepEqual(
    at2000.map((s) => s.kind),
    ['close', 'sample'],
  );
  assert.deepEqual(r.metrics.consumed.at(-1), { level: 0, atMs: 2000 });
});

test('replayApiTrigger：空输入不炸', () => {
  const r = replayApiTrigger({ samples: [] });
  assert.equal(r.steps.length, 0);
  assert.equal(r.metrics.windows, 0);
  assert.equal(r.metrics.armedMs, 0);
  assert.equal(r.metrics.firstOpenAtMs, null);
});

/* ------------------------------------------------------------------ */
/* 门控帧序列回放                                                      */
/* ------------------------------------------------------------------ */

test('replayPanelGating：连续 2 帧命中才开，连续 3 帧"两个信号都不在"才关', () => {
  const frames = [
    { atMs: 0, detection: det(false), presence: presence(false) },
    { atMs: 1000, detection: det(true) },
    { atMs: 1200, detection: det(true) },
    { atMs: 1400, detection: det(false), presence: presence(false) },
    { atMs: 1800, detection: det(false), presence: presence(false) },
    { atMs: 2200, detection: det(false), presence: presence(false) },
  ];
  const r = replayPanelGating(frames, { rerollPollMs: 400 });
  assert.deepEqual(r.edges, [
    { atMs: 1200, kind: 'open' },
    { atMs: 2200, kind: 'close' },
  ]);
  assert.equal(r.metrics.openFrames, 3);
  // 面板在屏时下发的间隔一律是重随轮询值（覆盖节流策略）
  for (const s of r.steps.filter((x) => x.state === 'open')) assert.equal(s.intervalMs, 400);
});

test('replayPanelGating：翻牌（卡片判据失效但面板信号仍在）**不判关闭**', () => {
  const frames = [
    { atMs: 0, detection: det(true) },
    { atMs: 400, detection: det(true) },
    // 翻牌动画：卡片判据连丢 3 帧，但"面板仍在"信号成立
    { atMs: 800, detection: det(false), presence: presence(true) },
    { atMs: 1200, detection: det(false), presence: presence(true) },
    { atMs: 1600, detection: det(false), presence: presence(true) },
    { atMs: 2000, detection: det(true) },
  ];
  const r = replayPanelGating(frames);
  assert.deepEqual(r.edges, [{ atMs: 400, kind: 'open' }]);
  assert.equal(r.steps.at(-1)!.state, 'open');
  const held = r.steps.find((s) => s.atMs === 800)!;
  assert.equal(held.presenceHolds, 1);
  assert.equal(r.metrics.closeEdges, 0);
});

test('replayPanelGating：与录制 timeline 的逐帧黄金对照（就近配对 + 容差）', () => {
  const frames = [
    { atMs: 1000, detection: det(false) },
    { atMs: 2000, detection: det(true) },
    { atMs: 3000, detection: det(true) },
  ];
  const r = replayPanelGating(frames, { rerollPollMs: 400 });
  const diffs = compareGatingToTimeline(r.steps, [
    { atMs: 1010, found: false, cards: 0, state: 'closed', edge: null, reason: '' },
    // 录制在 2010 就认定 open（真机第二帧才到），回放在 2000 还是 closed（命中 1/2）
    { atMs: 2010, found: true, cards: 3, state: 'open', edge: null, reason: '' },
    { atMs: 3010, found: true, cards: 3, state: 'open', edge: 'open', reason: '' },
  ], 50);
  assert.deepEqual(diffs, [
    { atMs: 2010, field: 'state', recorded: 'open', replayed: 'closed' },
  ]);
  // 容差外不配对 → 不判（宁可少报，不造假红）
  assert.deepEqual(compareGatingToTimeline(r.steps, [
    { atMs: 9999, found: true, cards: 3, state: 'open', edge: 'open', reason: '' },
  ], 50), []);
});

/* ------------------------------------------------------------------ */
/* 摘要                                                                */
/* ------------------------------------------------------------------ */

test('summarizeSession / sessionSpanMs：摘要口径', () => {
  const session = {
    meta: { version: 1, trigger: 'api' },
    frames: [
      { kind: 'gating' as const, atMs: 1000 },
      { kind: 'gating' as const, atMs: 2000 },
      { kind: 'native' as const, atMs: 2500 },
    ],
    api: [{ atMs: 0 }],
    edges: [{ atMs: 2600 }],
    phase: [{}, {}],
    rerolls: [{}],
  };
  const s = summarizeSession(session);
  assert.deepEqual(s.frames, { gating: 2, native: 1 });
  assert.equal(s.apiSamples, 1);
  assert.equal(s.edges, 1);
  assert.equal(s.phaseSamples, 2);
  assert.equal(s.rerolls, 1);
  assert.equal(s.spanMs, 2600);
  assert.deepEqual(s.offerLevels, [0, 7, 11, 15]);
  assert.equal(sessionSpanMs([], [], []), 0);
});
