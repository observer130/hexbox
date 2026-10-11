/**
 * **闭环回放**集成测试（CI 可跑：不需要游戏 / Electron / 管理员 / debug 目录）
 *
 * 这一条锁的是"回放驱动器"本身 —— 它是整套基建里最容易**静默**失效的一环：
 * 第一版驱动器在"当前没有到期任务"时直接 break，于是 `controller.start()` 里那一串
 * await 还没排上定时器就退出了，回放报告是"0 帧采样、0 次识别"，看起来像"回放不工作"。
 * 所以这里断言的是**可观测的链路结果**（虚拟时钟跑完 → 门控边沿 → 节流切换 →
 * 识别被调用），而不是"某个函数被调过"。
 *
 * 帧内容是合成的（三张暗卡 + 亮边框），因为要进 CI 就不能依赖 `debug/` 里的真机帧；
 * 真机帧的判据回归在 `packages/vision/src/augment-panel-fixtures.test.ts`。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  augmentNameStripRect,
  bitmapToGray,
  encodeGrayPng,
  readAugmentNameStrip,
  PANEL_ROW_REGION,
  parseSessionMeta,
  type AugmentNameFingerprint,
  type AugmentSessionFrameRef,
  type Bitmap,
  type Rect,
} from '@hexbox/vision';

import { runReplaySession, type LoadedSession } from './session-replay.ts';

const W = 800;
const H = 450;
/** 实测卡片几何（与 `augment-panel.test.ts` 同源）：三张等宽卡横排，落在搜索区内。 */
const CARD_XS = [0.298, 0.441, 0.584] as const;
const CARD_W = 0.115;
const CARD_Y = 0.2;
const CARD_H = 0.36;

function blank(v: number): Bitmap {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { width: W, height: H, data };
}

function fill(bmp: Bitmap, r: Rect, v: number): void {
  const x0 = Math.round(r.x * W);
  const y0 = Math.round(r.y * H);
  const x1 = Math.round((r.x + r.w) * W);
  const y1 = Math.round((r.y + r.h) * H);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = (y * W + x) * 4;
      bmp.data[i] = v;
      bmp.data[i + 1] = v;
      bmp.data[i + 2] = v;
      bmp.data[i + 3] = 255;
    }
  }
}

/** 面板帧：三张内部暗、边框亮的卡（门控判据要的正是这个）。 */
function panelFrame(): Bitmap {
  const bmp = blank(120);
  for (const x of CARD_XS) {
    const r: Rect = { x, y: CARD_Y, w: CARD_W, h: CARD_H };
    fill(bmp, r, 200);
    fill(
      bmp,
      {
        x: r.x + 6 / W,
        y: r.y + 6 / H,
        w: r.w - 12 / W,
        h: r.h - 12 / H,
      },
      25,
    );
  }
  return bmp;
}

/** 关闭帧：一层中性灰（既无卡片结构也无亮带）。 */
function closedFrame(): Bitmap {
  return blank(128);
}

/** 在卡片的名字带里画一个可区分的白色图案（模拟卡面名字）。 */
function paintName(bmp: Bitmap, card: Rect, pattern: readonly number[]): void {
  const strip = augmentNameStripRect(card);
  const x0 = Math.round(strip.x * W);
  const y0 = Math.round(strip.y * H);
  const sw = Math.round(strip.w * W);
  const sh = Math.round(strip.h * H);
  fill(bmp, { ...strip, x: strip.x - 0.002, w: strip.w + 0.004 }, 20);
  const barW = Math.max(2, Math.round(sw * 0.08));
  for (const p of pattern) {
    const bx = x0 + Math.round(p * (sw - barW));
    fill(bmp, { x: bx / W, y: y0 / H, w: barW / W, h: sh / H }, 255);
  }
}

/** 无英雄留档那条用的图案（与上一条不同即可）。 */
const PATTERNS_FOR_NOCHAMP: readonly (readonly number[])[] = [
  [0.1, 0.4, 0.7],
  [0.2, 0.5, 0.9],
  [0.06, 0.3, 0.6],
];

test('闭环回放：虚拟时钟驱动线上控制器 → 门控边沿 + 节流切换 + 识别被调用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexbox-replay-'));
  try {
    // ── 帧库：0~5.75s 每 250ms 一帧（1.5~3.5s 是面板），之后每 2s 一帧到 26s ──
    //    后段是稀疏的（关闭态内容重复即可）：为的是把"面板消失后仍高频 tailMs(20s)"
    //    这条行为也走一遍 —— 它正是真机日志里"关掉之后还在取帧"的来源。
    const frames: AugmentSessionFrameRef[] = [];
    const panel = panelFrame();
    const closed = closedFrame();
    let seq = 0;
    const times: number[] = [];
    for (let t = 0; t <= 5750; t += 250) times.push(t);
    for (let t = 7750; t <= 26_000; t += 2000) times.push(t);
    for (const t of times) {
      const isPanel = t >= 1500 && t <= 3500;
      const bmp = isPanel ? panel : closed;
      const file = `f${String(seq).padStart(3, '0')}.png`;
      writeFileSync(
        join(dir, file),
        encodeGrayPng({ width: W, height: H, gray: bitmapToGray(bmp) }, 2),
      );
      frames.push({
        seq,
        atMs: t,
        kind: 'gating',
        file,
        crop: { x: 0, y: 0, w: 1, h: 1 },
        found: isPanel,
        reason: isPanel ? '3 张卡片：内部暗(25/25/25) 边框亮(200/200/200)' : '卡片数 0',
      });
      seq++;
    }

    const meta = parseSessionMeta(
      {
        version: 1,
        trigger: 'pixel', // pixel 模式：门控自己定节奏（api 模式常态零取帧，帧库就白录了）
        gating: { targetScale: 1 / 3, minWidth: 960, width: W, height: H },
        frameCrop: { x: 0, y: 0, w: 1, h: 1 },
        region: PANEL_ROW_REGION,
        altRegion: PANEL_ROW_REGION,
        display: { width: W, height: H, scaleFactor: 1, workArea: { x: 0, y: 0, width: W, height: H } },
        windowPhysical: null,
        data: null,
        champion: { id: 79, source: 'activePlayer-raw', name: '酒桶' },
        env: {},
      },
      { region: PANEL_ROW_REGION, altRegion: PANEL_ROW_REGION },
    );

    const session: LoadedSession = {
      dir,
      meta,
      frames,
      api: [],
      edges: [],
      phase: [],
      notes: [],
    };

    const logs: string[] = [];
    const report = await runReplaySession({
      session,
      library: [] as readonly AugmentNameFingerprint[],
      log: (line) => logs.push(line),
    });

    // ── ① 链路真的跑起来了（不是"0 帧采样"那种静默失效）──
    assert.ok(report.frames.length > 0, `门控一帧都没采样：${JSON.stringify(report.snapshot.counts)}`);
    assert.ok(report.snapshot.samples >= report.frames.length);
    assert.equal(report.gaps, 0, '帧库覆盖了每一帧，不该有缺口');
    // ⚠️ 帧库比"面板停留期间的 400ms 轮询"稀疏时必然**重复投递同一帧**：报告必须把它
    //    显式报出来（审查发现：旧版只报"采样 N 帧"，重复投递完全不可见）
    assert.ok(
      report.frameReuses > 0,
      `帧库稀疏（250ms/2s）时应当有重复投递，实际 reuses=${report.frameReuses}`,
    );
    // 投递数 = 被控制器接受的帧 + 被判"过期"丢掉的帧（`atMs` 用帧的真实时刻之后，
    // 控制器的 `STALE_FRAME_MS` 保护在回放里**真的生效**了 —— 审查指出旧版它是死代码）
    assert.equal(
      report.uniqueFrames + report.frameReuses,
      report.frames.length + report.snapshot.counts.droppedStaleFrames,
    );
    assert.ok(
      report.snapshot.counts.droppedStaleFrames > 0,
      '帧库稀疏（尾随段 2s 一帧）时应当有帧因为过期被丢，而不是硬塞给状态机',
    );

    // ── ② 面板开/关各一次，且落在正确的帧内容上 ──
    assert.deepEqual(
      report.edges.map((e) => e.kind),
      ['open', 'close'],
      `边沿异常：${JSON.stringify(report.edges)}`,
    );
    const openedAt = report.edges[0]!.atMs;
    const closedAt = report.edges[1]!.atMs;
    assert.ok(openedAt >= 1500 && openedAt <= 3500, `开边沿不在面板区间内：${openedAt}`);
    assert.ok(closedAt > 3500, `关边沿应当发生在面板消失之后：${closedAt}`);
    assert.equal(report.snapshot.counts.openEdges, 1);
    assert.equal(report.snapshot.counts.closeEdges, 1);

    // ── ③ 节流：常态低频起步 → 命中后升频确认 → 面板在屏被"重随轮询"接管 → 关闭后回常态 ──
    const beforeOpen = report.frames.filter((f) => f.atMs < openedAt);
    assert.equal(beforeOpen[0]!.intervalMs, 1000, '起始必须是常态低频（1000ms）');
    // 首帧命中会先切到 probe(250ms) 确认一次，**只允许这一次**（确认后即进 open）
    assert.ok(
      beforeOpen.filter((f) => f.intervalMs === 250).length <= 1,
      `升频确认不该反复：${beforeOpen.map((f) => f.intervalMs).join('/')}`,
    );
    assert.ok(
      beforeOpen.every((f) => f.intervalMs === 1000 || f.intervalMs === 250),
      `命中前的采样间隔只该是常态低频或升频确认：${beforeOpen.map((f) => f.intervalMs).join('/')}`,
    );
    const openFrames = report.frames.filter((f) => f.state === 'open');
    assert.ok(openFrames.length > 0);
    assert.ok(
      openFrames.every((f) => f.intervalMs === 400),
      `面板在屏时应当用重随轮询间隔：${openFrames.map((f) => f.intervalMs).join('/')}`,
    );
    // ⚠️ 帧行里的 `atMs` 是**帧的采集时刻**（必须如此：重复投递才看得见、控制器的
    //    过期帧保护才有效），而 `intervalMs` 是**这一次投递之后**下发的间隔。
    //    所以"尾随"要按**投递顺序**看，而不是按帧的采集时刻筛。
    const closeIdx = report.frames.findIndex((f) => f.atMs >= closedAt && f.state === 'closed');
    assert.ok(closeIdx > 0, '找不到关闭之后的采样行');
    const afterClose = report.frames.slice(closeIdx);
    const firstIdle = afterClose.findIndex((f) => f.intervalMs === 1000);
    assert.ok(firstIdle > 0, `尾随必须最终回到常态低频：${afterClose.map((f) => f.intervalMs).join('/')}`);
    assert.ok(
      afterClose.slice(0, firstIdle).every((f) => f.intervalMs === 250),
      `尾随期内应当是高频：${afterClose.slice(0, firstIdle).map((f) => f.intervalMs).join('/')}`,
    );
    assert.ok(
      afterClose.slice(firstIdle).every((f) => f.intervalMs === 1000),
      '回到常态之后不许再升频（没有面板）',
    );

    // ── ④ 识别被调用（开边沿整批 + 有界重试），且**诚实**报告"会话没有原生帧" ──
    assert.ok(report.recognizeCalls >= 1, '开边沿必须触发识别');
    assert.equal(
      report.labelsUnavailable,
      report.recognizeCalls,
      '这个会话没有原生帧 → 每次识别都应当如实报"缺原生帧"，而不是假装认不出',
    );
    assert.ok(
      report.snapshot.recognized.every((r) => !r.ok && /原生帧/.test(r.reason)),
      `识别报告不该出现"认不出"这种假象：${JSON.stringify(report.snapshot.recognized.map((r) => r.reason))}`,
    );

    // ── ⑤ 英雄身份来自会话留档（回放没有 LCU/2999）──
    assert.equal(report.snapshot.champion.championId, 79);
    assert.ok(logs.some((l) => l.includes('面板出现')), '控制器日志里应当有"面板出现"那一行');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


/* ------------------------------------------------------------------ */
/* 一路跑到**标签**（审查：这才是回放存在的意义）                                    */
/* ------------------------------------------------------------------ */

/**
 * 合成一个"能画出标签"的会话：原生帧 + 指纹库 + 英雄身份 + 强度表。
 *
 * 为什么这条测试必须存在（2026-10-12 审查）：`runReplaySession` 是 P1 的主体，
 * 而"录制器从不写英雄身份"这个缺陷正是因为只有"录制格式往返"测试而漏掉的：
 * 格式对了但里面没有英雄 → 回放一张标签都画不出来。
 * 这里用**合成**数据（不依赖 `data/`），于是 CI 里也能跑。
 */
test('闭环回放：原生帧 + 英雄留档 + 强度表 → 真的把标签画出来了', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexbox-replay-labels-'));
  try {
    const PATTERNS: readonly (readonly number[])[] = [
      [0.02, 0.3, 0.62],
      [0.12, 0.44, 0.86],
      [0.05, 0.2, 0.5, 0.8],
    ];
    const panel = panelFrame();
    PATTERNS.forEach((p, i) => paintName(panel, { x: CARD_XS[i]!, y: CARD_Y, w: CARD_W, h: CARD_H }, p));

    // 帧库：关闭帧若干 + 面板帧若干（挤在同一个录制窗口里）
    const frames: AugmentSessionFrameRef[] = [];
    const files: Array<{ atMs: number; bmp: Bitmap; kind: 'gating' | 'native' }> = [];
    for (let t = 0; t <= 2000; t += 250) files.push({ atMs: t, bmp: t >= 1000 ? panel : closedFrame(), kind: 'gating' });
    // 原生帧：面板在屏期间各一张（与线上一样：只在识别时存）
    for (const t of [1000, 1250]) files.push({ atMs: t, bmp: panel, kind: 'native' });
    let seq = 0;
    for (const f of files) {
      const file = `f\${String(seq).padStart(3, '0')}.png`;
      writeFileSync(join(dir, file), encodeGrayPng({ width: f.bmp.width, height: f.bmp.height, gray: bitmapToGray(f.bmp) }, 2));
      frames.push({ seq, atMs: f.atMs, kind: f.kind, file, crop: { x: 0, y: 0, w: 1, h: 1 } });
      seq++;
    }

    // 指纹库：用**同一个 `readAugmentNameStrip`** 从原生帧上算（与构建期脚本同规格）
    const library: AugmentNameFingerprint[] = CARD_XS.map((x, i) => {
      const strip = readAugmentNameStrip(panel, { x, y: CARD_Y, w: CARD_W, h: CARD_H });
      assert.ok(strip, `卡\${i + 1} 没读出名字位图`);
      return { augmentId: 100 + i, name: `测试海克斯\${i + 1}`, width: strip.width, height: strip.height, bits: strip.bits };
    });

    const meta = parseSessionMeta(
      {
        version: 1,
        trigger: 'pixel',
        gating: { targetScale: 1 / 3, minWidth: 960, width: W, height: H },
        frameCrop: { x: 0, y: 0, w: 1, h: 1 },
        region: PANEL_ROW_REGION,
        altRegion: PANEL_ROW_REGION,
        display: { width: W, height: H, scaleFactor: 1, workArea: { x: 0, y: 0, width: W, height: H } },
        windowPhysical: null,
        data: { nameLibraryEntries: library.length, tierDataDate: '20261005' },
        // 英雄留档：**录制器必须写这一项**，否则回放一张标签都画不出来
        champion: { id: 79, source: 'activePlayer-raw', name: '酒桶' },
        env: {},
      },
      { region: PANEL_ROW_REGION, altRegion: PANEL_ROW_REGION },
    );

    const report = await runReplaySession({
      session: { dir, meta, frames, api: [], edges: [], phase: [], notes: [] },
      library,
      log: () => undefined,
      // 强度表：合成（不依赖 data/builds.json），三张卡都有档位与选取率
      loadData: async () => ({
        dataset: null,
        builds: {
          meta: { source: 'test', dataDate: '20261005', fetchedAt: '', count: 1 },
          details: [
            {
              championId: 79,
              augments: [0, 1, 2].map((i) => ({
                rank: i + 1,
                augmentId: 100 + i,
                level: 'kGold',
                pickRate: 0.1 + i * 0.05,
                tier: ['S', 'A', 'B'][i]!,
              })),
              build: { start: [], startCombo: [], shoes: [], core: [] },
              skills: [],
              partners: [],
              dataDate: '20261005',
            },
          ],
        },
      }),
    });

    // ① 识别真的跑了（而不是"缺原生帧"）
    assert.equal(report.labelsUnavailable, 0, `不该报缺原生帧：\${JSON.stringify(report.snapshot.recognized.map((r) => r.reason))}`);
    assert.ok(report.recognizeCalls >= 1);
    assert.ok(
      report.snapshot.recognized.some((r) => r.ok && r.cards.some((c) => c.augmentId !== null)),
      '至少一次识别应该认出名字',
    );

    // ② 标签真的推了（三张卡都有档位）—— 这就是"回放能一路跑到标签"的证据
    const pushed = report.labels.filter((l) => l.active);
    assert.ok(pushed.length >= 1, `一次都没推标签：\${JSON.stringify(report.labels)}`);
    assert.deepEqual(pushed[0]!.texts, ['S', 'A', 'B'], `档位不对：\${JSON.stringify(pushed[0])}`);
    assert.ok(
      pushed[0]!.subs.every((s) => s.startsWith('选取率')),
      `选取率行丢了：\${JSON.stringify(pushed[0]!.subs)}`,
    );
    assert.equal(report.snapshot.champion.championId, 79);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('闭环回放：会话**没有**英雄留档 → 一张标签都不画（宁漏勿错，且不得假装成功）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexbox-replay-nochamp-'));
  try {
    const panel = panelFrame();
    PATTERNS_FOR_NOCHAMP.forEach((p, i) => paintName(panel, { x: CARD_XS[i]!, y: CARD_Y, w: CARD_W, h: CARD_H }, p));
    const files: Array<{ atMs: number; bmp: Bitmap; kind: 'gating' | 'native' }> = [];
    for (let t = 0; t <= 1500; t += 250) files.push({ atMs: t, bmp: t >= 1000 ? panel : closedFrame(), kind: 'gating' });
    files.push({ atMs: 1000, bmp: panel, kind: 'native' });
    const frames: AugmentSessionFrameRef[] = files.map((f, i) => {
      const file = `n\${String(i).padStart(3, '0')}.png`;
      writeFileSync(join(dir, file), encodeGrayPng({ width: f.bmp.width, height: f.bmp.height, gray: bitmapToGray(f.bmp) }, 2));
      return { seq: i, atMs: f.atMs, kind: f.kind, file, crop: { x: 0, y: 0, w: 1, h: 1 } };
    });
    const library: AugmentNameFingerprint[] = CARD_XS.map((x, i) => {
      const strip = readAugmentNameStrip(panel, { x, y: CARD_Y, w: CARD_W, h: CARD_H })!;
      return { augmentId: 200 + i, name: `x\${i}`, width: strip.width, height: strip.height, bits: strip.bits };
    });
    const report = await runReplaySession({
      session: {
        dir,
        meta: parseSessionMeta(
          {
            trigger: 'pixel',
            region: PANEL_ROW_REGION,
            altRegion: PANEL_ROW_REGION,
            display: { width: W, height: H, scaleFactor: 1, workArea: { x: 0, y: 0, width: W, height: H } },
            // champion 缺席（字段不存在）
          },
          { region: PANEL_ROW_REGION, altRegion: PANEL_ROW_REGION },
        ),
        frames,
        api: [],
        edges: [],
        phase: [],
        notes: [],
      },
      library,
      log: () => undefined,
      loadData: async () => ({ dataset: null, builds: null }),
    });
    assert.equal(
      report.labels.filter((l) => l.active).length,
      0,
      '没有英雄留档就不许画标签（宁可一张不画，也不能画别人英雄的评级）',
    );
    assert.equal(report.snapshot.champion.championId, 0);
    // 识别该跑还是跑（认得出名字），只是"没有英雄 → 一张标签都不画"
    assert.ok(
      report.snapshot.recognized.some((r) => r.cards.some((c) => c.augmentId !== null)),
      '识别本身应当仍然认出名字（只是不画）',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('闭环回放：没有帧库时不抛异常，并如实报告缺口', async () => {
  const session: LoadedSession = {
    dir: join(tmpdir(), 'hexbox-nonexistent-session'),
    meta: parseSessionMeta({ trigger: 'pixel' }, { region: PANEL_ROW_REGION, altRegion: PANEL_ROW_REGION }),
    frames: [],
    api: [],
    edges: [],
    phase: [],
    notes: ['测试用：空会话'],
  };
  const report = await runReplaySession({ session, library: [], log: () => undefined });
  assert.equal(report.frames.length, 0);
  assert.equal(report.edges.length, 0);
  assert.ok(report.gaps > 0, '一帧都没有时应当报缺口，而不是静默"跑完了"');
  assert.equal(report.snapshot.counts.openEdges, 0);
});
