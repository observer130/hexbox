/**
 * **录制 ⇄ 回放 往返**测试（不需要游戏 / Electron / 管理员；CI 可跑）
 *
 * 这一条锁的是整套基建最容易悄悄坏掉的地方：**会话目录格式**。
 * 录制器写出来的目录必须能被回放加载器原样读回来（帧索引/2999 采样/边沿/阶段，
 * 以及"四类产物共用同一个零点"这条时间约定）——格式一旦漂移，表现是
 * "回放跑起来了但什么都没发生"，很难定位。
 *
 * 之所以放在 `apps/overlay` 而不是 `packages/vision`：录制器依赖 fs（写目录），
 * 而 vision 是纯函数包。`pnpm test` 会跑这个包（package.json 里有 test 脚本）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { decodePng, type Rect } from '@hexbox/vision';

import { createSessionRecorder, recordEnabled, redactRecorderEnv } from './session-recorder.ts';
import { appendLineSafely } from './session-recorder.ts';
import { loadSession } from '../replay/session-replay.ts';

const REGION: Rect = { x: 0.12, y: 0.1, w: 0.76, h: 0.66 };

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'hexbox-session-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 造一帧灰度（左上亮、其余暗；只要尺寸对，内容无所谓）。 */
function gray(width: number, height: number, v = 30): Uint8Array {
  return new Uint8Array(width * height).fill(v);
}

test('recordEnabled：只有 1/true/on 才算开（默认关，避免误录）', () => {
  const before = process.env['HEXBOX_AUGMENT_RECORD'];
  try {
    for (const v of ['', '0', 'off', 'false', 'yes', ' ']) {
      process.env['HEXBOX_AUGMENT_RECORD'] = v;
      assert.equal(recordEnabled(), false, `值 ${JSON.stringify(v)} 不该开录制`);
    }
    for (const v of ['1', 'true', 'on', 'TRUE', ' On ']) {
      process.env['HEXBOX_AUGMENT_RECORD'] = v;
      assert.equal(recordEnabled(), true, `值 ${JSON.stringify(v)} 应当开录制`);
    }
  } finally {
    if (before === undefined) delete process.env['HEXBOX_AUGMENT_RECORD'];
    else process.env['HEXBOX_AUGMENT_RECORD'] = before;
  }
});

test('录制 → 加载：会话目录往返一致（帧/2999/边沿/阶段全部读得回来）', () => {
  withTempDir((root) => {
    const rec = createSessionRecorder({
      rootDir: root,
      suffix: 'unit',
      meta: {
        trigger: 'api',
        gating: { targetScale: 1 / 3, minWidth: 960, width: 960, height: 540 },
        region: REGION,
        altRegion: REGION,
        windowPhysical: { x: 0, y: 0, width: 2560, height: 1440 },
        display: {
          width: 2560,
          height: 1440,
          scaleFactor: 1,
          workArea: { x: 0, y: 0, width: 2560, height: 1400 },
        },
        data: { nameLibraryEntries: 218, tierDataDate: '20261005' },
        champion: { id: 79, source: 'activePlayer-raw', name: '酒桶' },
      },
      env: { HEXBOX_AUGMENT_TRIGGER: 'api' },
      log: () => undefined,
    });

    // 时间基准：第一个事件是 2999 采样（与线上一致：轮询 1s、帧在其后）
    const T0 = 1_000_000;
    rec.api({
      atMs: T0,
      gameTime: 455.8,
      level: 10,
      isDead: true,
      respawnTimer: 8.2,
      capture: true,
      pending: [7, 11, 15],
      reason: '死亡（等级 10，待选 [7, 11, 15]）：开截屏',
    });
    rec.frame({
      atMs: T0 + 250,
      kind: 'gating',
      gray: gray(960, 540, 25),
      width: 960,
      height: 540,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      found: true,
      reason: '3 张卡片：内部暗(25/29/24) 边框亮(127/132/132)',
      cards: [{ rect: { x: 0.298, y: 0.2, w: 0.115, h: 0.36 }, interiorLuma: 25, edgeLuma: 127 }],
    });
    rec.frame({
      atMs: T0 + 500,
      kind: 'native',
      gray: gray(2560, 1440, 40),
      width: 2560,
      height: 1440,
      crop: { x: 0, y: 0, w: 1, h: 1 },
    });
    rec.edge({ atMs: T0 + 300, kind: 'open' });
    rec.edge({ atMs: T0 + 5000, kind: 'close' });
    rec.phase({ atMs: T0 - 500, phase: 'InProgress' });
    // 英雄身份是**事后补写**的（看到第一块面板才认得出来）：
    // 录制器必须能在跑的过程中重写 `session.json`，否则回放组不出强度表
    rec.setMeta({ champion: { id: 79, source: 'activePlayer-raw', name: '酒桶' } });
    rec.close({ counts: { foundFrames: 1, openEdges: 1, closeEdges: 1 } });

    assert.deepEqual(rec.frames, { gating: 1, native: 1 });

    // ── 回放加载器读回来 ──
    const session = loadSession(rec.dir);
    assert.equal(session.notes.length, 0, `加载器不该有告警：${session.notes.join('；')}`);
    assert.equal(session.meta.trigger, 'api');
    assert.equal(session.meta.champion?.id, 79);
    // 事后补写的也要在文件里（而不是只在内存里）
    assert.equal(
      JSON.parse(readFileSync(join(rec.dir, 'session.json'), 'utf8')).champion.name,
      '酒桶',
    );
    assert.deepEqual(session.meta.region, REGION);
    assert.equal(session.meta.gating?.width, 960);

    // 四类产物**共用同一个零点**：2999 采样在 0，帧在 +250，边沿在 +300
    assert.equal(session.api.length, 1);
    assert.equal(session.api[0]!.atMs, 0);
    assert.equal(session.api[0]!.gameTime, 455.8);
    assert.equal(session.api[0]!.isDead, true);
    assert.deepEqual(session.api[0]!.pending, [7, 11, 15]);
    assert.equal(session.frames.length, 2);
    assert.deepEqual(
      session.frames.map((f) => [f.kind, f.atMs]),
      [
        ['gating', 250],
        ['native', 500],
      ],
    );
    assert.deepEqual(session.edges, [
      { atMs: 300, kind: 'open' },
      { atMs: 5000, kind: 'close' },
    ]);
    // 阶段采样在零点之前 → 夹到 0（不许出现负数时刻）
    assert.equal(session.phase.length, 1);
    assert.equal(session.phase[0]!.atMs, 0);

    // 帧图真的落盘了，而且是**灰度 PNG**（能解回来、尺寸一致）
    for (const f of session.frames) {
      const png = decodePng(new Uint8Array(readFileSync(join(rec.dir, f.file))));
      assert.equal(png.width, f.file.includes('native') ? 2560 : 960);
      assert.equal(png.data.length, png.width * png.height * 4);
      // 灰度：三通道相等
      assert.equal(png.data[0], png.data[1]);
      assert.equal(png.data[1], png.data[2]);
    }
    // 录制当时的门控判定也留了档（回放做黄金对照用）
    assert.equal(session.frames[0]!.found, true);
    assert.equal(session.frames[0]!.cards?.length, 1);
    // golden（收工快照）
    assert.equal(
      JSON.parse(readFileSync(join(rec.dir, 'report.json'), 'utf8')).counts.foundFrames,
      1,
    );
  });
});

test('录制：缺 session.json 的老目录也能加载（回放按缺失能力降级并给出告警）', () => {
  withTempDir((root) => {
    const session = loadSession(root);
    assert.equal(session.frames.length, 0);
    assert.equal(session.api.length, 0);
    assert.ok(session.notes.some((n) => n.includes('session.json')));
  });
});

/* ------------------------------------------------------------------ */
/* 隐私：环境变量快照必须脱敏                                           */
/* ------------------------------------------------------------------ */

test('redactRecorderEnv：凭证类键被脱敏，普通开关原样保留，非 HEXBOX_ 丢弃', () => {
  const env = redactRecorderEnv({
    HEXBOX_LCU_CREDENTIALS: '1954:super-secret-token',
    HEXBOX_LCU_CREDENTIALS_FILE: 'C:/Users/me/.hexbox/lcu-credentials',
    HEXBOX_AUGMENT_TRIGGER: 'api',
    HEXBOX_AUGMENT_THUMB_SCALE: '0.25',
    PATH: 'C:/Windows',
    SomeOther: 'x',
  });

  assert.equal(env['HEXBOX_LCU_CREDENTIALS'], '[redacted]', '令牌绝不许落盘');
  assert.equal(env['HEXBOX_LCU_CREDENTIALS_FILE'], '[redacted]');
  assert.equal(env['HEXBOX_AUGMENT_TRIGGER'], 'api', '诊断用的开关必须保留');
  assert.equal(env['HEXBOX_AUGMENT_THUMB_SCALE'], '0.25');
  assert.equal(env['PATH'], undefined, '只收 HEXBOX_ 前缀');
  assert.equal(env['SomeOther'], undefined);
  // 原始值不许以任何形式出现
  assert.equal(JSON.stringify(env).includes('super-secret-token'), false);
});

test('redactRecorderEnv：未设置的键与空值不产生噪声', () => {
  const env = redactRecorderEnv({
    HEXBOX_UNSET: undefined,
    HEXBOX_EMPTY: '',
    HEXBOX_TOKEN: 'abc',
  });
  assert.equal(env['HEXBOX_UNSET'], undefined);
  assert.equal(env['HEXBOX_EMPTY'], '');
  assert.equal(env['HEXBOX_TOKEN'], '[redacted]');
});

test('录制：session.json 里不出现明文 LCU 令牌（真实写入路径）', () => {
  withTempDir((root) => {
    const rec = createSessionRecorder({
      rootDir: root,
      meta: {
        trigger: 'api',
        gating: { intervalMs: 1000 },
        region: REGION,
      } as never,
      // 模拟"提权会话设了 HEXBOX_LCU_CREDENTIALS"
      env: { HEXBOX_LCU_CREDENTIALS: '1954:tok-abc', HEXBOX_AUGMENT_TRIGGER: 'api' },
    });
    const text = readFileSync(join(rec.dir, 'session.json'), 'utf8');
    assert.equal(text.includes('tok-abc'), false, '产物是要发出去排查的，令牌不能跟着走');
    const parsed = JSON.parse(text) as { env: Record<string, string> };
    assert.equal(parsed.env['HEXBOX_LCU_CREDENTIALS'], '[redacted]');
    assert.equal(parsed.env['HEXBOX_AUGMENT_TRIGGER'], 'api');
  });
});

/* ------------------------------------------------------------------ */
/* 录制写盘失败不许杀进程                                               */
/* ------------------------------------------------------------------ */

test('appendLineSafely：目录不存在时返回错误而不抛（IPC 回调里抛=主进程崩）', () => {
  const missing = join(tmpdir(), 'hexbox-no-such-dir-xyz', 'x.jsonl');
  const r = appendLineSafely(missing, 'line\n');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.error.length > 0, '要带上原因，便于日志定位');
});

test('appendLineSafely：正常路径追加成功', () => {
  withTempDir((root) => {
    const path = join(root, 'ok.jsonl');
    assert.equal(appendLineSafely(path, 'a\n').ok, true);
    assert.equal(appendLineSafely(path, 'b\n').ok, true);
    assert.equal(readFileSync(path, 'utf8'), 'a\nb\n');
  });
});
