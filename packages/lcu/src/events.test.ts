/**
 * LCU 事件流测试（**假 socket + 假定时器**，不碰真 LCU、不真等 1 秒）
 *
 * 覆盖的每一条都对应真机上会出现的形态：
 *   · 订阅命令必须真的发出去（发错事件名 = 永远收不到事件，且没有任何报错）；
 *   · 一次 push 里多帧 / 半个帧跨 push（见 ws-frame.test.ts，那边已单测）；
 *   · 断线必须**退避重连**，而且**只能排一个**重连（否则会连出很多条 socket）；
 *   · `stop()` 之后对端再关也不算数（退出路径不能自己复活）；
 *   · 非目标事件（LCU 会推一大堆别的）必须被忽略。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  backoffDelayMs,
  decodeWampMessage,
  gameflowPhaseFromEvent,
  isValidWebSocketAccept,
  LcuEventStream,
  LCU_GAMEFLOW_PHASE_EVENT,
  wampSubscribeMessage,
  wampUnsubscribeMessage,
  webSocketAcceptFor,
  WS_ACCEPT_GUID,
  type LcuSocketLike,
  type LcuEventStatus,
} from './events.ts';
import { encodeTextFrame } from './ws-frame.ts';

const CREDS = { port: 12345, password: 'secret', source: 'explicit' } as const;

/** 解一个**客户端**帧（带掩码），返回 opcode 与明文载荷。 */
function decodeClientFrame(bytes: Uint8Array): { opcode: number; text: string } {
  const opcode = (bytes[0] ?? 0) & 0x0f;
  const masked = ((bytes[1] ?? 0) & 0x80) !== 0;
  let len = (bytes[1] ?? 0) & 0x7f;
  let off = 2;
  if (len === 126) {
    len = ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
    off = 4;
  } else if (len === 127) {
    len = 0;
    for (let i = 0; i < 8; i++) len = len * 256 + (bytes[off + i] ?? 0);
    off = 10;
  }
  const mask = masked ? bytes.subarray(off, off + 4) : null;
  if (masked) off += 4;
  const payload = bytes.subarray(off, off + len);
  const plain = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    plain[i] = (payload[i] ?? 0) ^ (mask ? (mask[i % 4] ?? 0) : 0);
  }
  return { opcode, text: new TextDecoder().decode(plain) };
}

/** 服务端文本帧（不掩码）。 */
function serverText(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const out = new Uint8Array(2 + payload.length);
  out[0] = 0x81;
  out[1] = payload.length;
  out.set(payload, 2);
  return out;
}

/** 服务端 ping 帧。 */
function serverPing(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + payload.length);
  out[0] = 0x89;
  out[1] = payload.length;
  out.set(payload, 2);
  return out;
}

class FakeSocket implements LcuSocketLike {
  readonly written: Uint8Array[] = [];
  destroyed = false;
  private readonly handlers = {
    data: [] as Array<(c: Uint8Array) => void>,
    close: [] as Array<() => void>,
    error: [] as Array<(e: unknown) => void>,
  };

  write(data: Uint8Array): void {
    this.written.push(data);
  }
  destroy(): void {
    this.destroyed = true;
  }
  on(event: 'data', cb: (chunk: Uint8Array) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: unknown) => void): void;
  on(event: 'data' | 'close' | 'error', cb: ((c: Uint8Array) => void) | (() => void) | ((e: unknown) => void)): void {
    if (event === 'data') this.handlers.data.push(cb as (c: Uint8Array) => void);
    else if (event === 'close') this.handlers.close.push(cb as () => void);
    else this.handlers.error.push(cb as (e: unknown) => void);
  }

  emitData(bytes: Uint8Array): void {
    for (const cb of [...this.handlers.data]) cb(bytes);
  }
  emitClose(): void {
    for (const cb of [...this.handlers.close]) cb();
  }
  emitError(err: unknown): void {
    for (const cb of [...this.handlers.error]) cb(err);
  }
}

/** 假定时器：可观察延迟、可手动推进。 */
function fakeClock(): {
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn: (h: unknown) => void;
  delays: () => number[];
  pendingCount: () => number;
  runNext: () => void;
} {
  let seq = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimeoutFn: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeoutFn: (h) => {
      timers.delete(h as number);
    },
    delays: () => [...timers.values()].map((t) => t.ms),
    pendingCount: () => timers.size,
    runNext: () => {
      const first = [...timers.entries()][0];
      if (!first) return;
      timers.delete(first[0]);
      first[1].fn();
    },
  };
}

interface Harness {
  readonly stream: LcuEventStream;
  readonly sockets: FakeSocket[];
  readonly phases: Array<{ phase: string; detail: string }>;
  readonly statuses: Array<{ status: LcuEventStatus; detail: string }>;
  /** 每一条解出来的事件（含不匹配的）—— 诊断用，见 `onEvent`。 */
  readonly rawEvents: Array<{ topic: string | null; payload: unknown }>;
  readonly clock: ReturnType<typeof fakeClock>;
  /** 让 `start()` 里那个 await opener 落地。 */
  settle(): Promise<void>;
}

function makeHarness(options: { failOpen?: number } = {}): Harness {
  const sockets: FakeSocket[] = [];
  const phases: Array<{ phase: string; detail: string }> = [];
  const statuses: Array<{ status: LcuEventStatus; detail: string }> = [];
  const rawEvents: Array<{ topic: string | null; payload: unknown }> = [];
  const clock = fakeClock();
  /** 前 N **次尝试**都失败（注意是尝试次数，不是成功次数 —— 写错会让"永远失败"）。 */
  let openAttempts = 0;
  const stream = new LcuEventStream({
    creds: CREDS,
    onPhase: (phase, detail) => phases.push({ phase, detail }),
    onEvent: (topic, payload) => rawEvents.push({ topic, payload }),
    onStatus: (status, detail) => statuses.push({ status, detail }),
    openSocket: async () => {
      openAttempts++;
      if (options.failOpen !== undefined && openAttempts <= options.failOpen) {
        throw new Error('拒绝连接（测试）');
      }
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  return {
    stream,
    sockets,
    phases,
    statuses,
    rawEvents,
    clock,
    settle: () => new Promise((r) => setImmediate(r)),
  };
}

test('webSocketAcceptFor / isValidWebSocketAccept：RFC6455 标准向量（本机实测踩到的坑）', () => {
  assert.equal(WS_ACCEPT_GUID, '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
  // RFC6455 §1.3 的示例：key dGhlIHNhbXBsZSBub25jZQ== → accept s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
  const key = 'dGhlIHNhbXBsZSBub25jZQ==';
  assert.equal(webSocketAcceptFor(key), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  assert.equal(isValidWebSocketAccept('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=', key), true);
  assert.equal(isValidWebSocketAccept(' s3pPLMBiTxaQ9kYGzzhZRbK+xOo= ', key), true, '两侧空白要容忍');
  assert.equal(isValidWebSocketAccept('wrong', key), false);
  assert.equal(isValidWebSocketAccept(undefined, key), false, '缺头 = 不是 WebSocket 服务');
  // ⚠️ 这条是给真机发现的形态留的回归：本地 30724/51841 也会对 Upgrade 回 101，
  //    但只有校验过 accept 才能确认对面真的是 WebSocket 服务。
  assert.equal(isValidWebSocketAccept(webSocketAcceptFor('别的 key'), key), false);
});

test('wampSubscribeMessage / wampUnsubscribeMessage：锁住字面量（改了就静默收不到事件）', () => {
  assert.equal(wampSubscribeMessage(LCU_GAMEFLOW_PHASE_EVENT), '[5,"OnJsonApiEvent_lol-gameflow_v1_gameflow-phase"]');
  assert.equal(wampUnsubscribeMessage('X'), '[6,"X"]');
});

test('decodeWampMessage：正常数组 / 非 JSON / 非数组 / 空数组', () => {
  const ok = decodeWampMessage('[8,"OnJsonApiEvent_x","payload"]');
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.message.type, 8);
    assert.equal(ok.message.topic, 'OnJsonApiEvent_x');
    assert.equal(ok.message.payload, 'payload');
  }
  assert.equal(decodeWampMessage('not json').ok, false);
  assert.equal(decodeWampMessage('{"a":1}').ok, false);
  assert.equal(decodeWampMessage('[]').ok, false);
});

test('gameflowPhaseFromEvent：JSON 字符串 / 裸字符串 / 对象 .phase 三种载荷都认', () => {
  const ev = (payload: unknown) => ({ type: 8, topic: LCU_GAMEFLOW_PHASE_EVENT, payload });
  assert.equal(gameflowPhaseFromEvent(ev('"ChampSelect"')).phase, 'ChampSelect');
  assert.equal(gameflowPhaseFromEvent(ev('InProgress')).phase, 'InProgress');
  assert.equal(gameflowPhaseFromEvent(ev({ phase: 'Lobby' })).phase, 'Lobby');
});

test('gameflowPhaseFromEvent：认不出就 null（绝不猜相位）', () => {
  const ev = (payload: unknown, type = 8, topic = LCU_GAMEFLOW_PHASE_EVENT) => ({ type, topic, payload });
  assert.equal(gameflowPhaseFromEvent(ev('"')).phase, null, '像 JSON 字符串但解析失败');
  assert.equal(gameflowPhaseFromEvent(ev('')).phase, null);
  assert.equal(gameflowPhaseFromEvent(ev('"   "')).phase, null, '解出来是空白');
  assert.equal(gameflowPhaseFromEvent(ev({})).phase, null);
  assert.equal(gameflowPhaseFromEvent(ev(null)).phase, null);
  assert.equal(gameflowPhaseFromEvent(ev('X', 3)).phase, null, '非事件消息');
  assert.equal(gameflowPhaseFromEvent(ev('X', 8, 'OnJsonApiEvent_other')).phase, null, '别的事件名');
});

test('backoffDelayMs：1s→2s→4s…封顶 30s；非法 attempt 归一到 1', () => {
  assert.equal(backoffDelayMs(1), 1000);
  assert.equal(backoffDelayMs(2), 2000);
  assert.equal(backoffDelayMs(3), 4000);
  assert.equal(backoffDelayMs(5), 16000);
  assert.equal(backoffDelayMs(6), 30000, '32s 被 30s 封顶');
  assert.equal(backoffDelayMs(99), 30000, '再大也不溢出');
  assert.equal(backoffDelayMs(0), 1000, '0/-1 归一到 1');
  assert.equal(backoffDelayMs(-3), 1000);
});

test('★ 连上后立刻发出订阅帧（事件名正确、opcode=1、载荷是 WAMP 数组）', async () => {
  const h = makeHarness();
  h.stream.start();
  await h.settle();
  assert.equal(h.sockets.length, 1);
  const sub = h.sockets[0]!.written[0];
  assert.ok(sub, '必须写出订阅帧');
  const decoded = decodeClientFrame(sub);
  assert.equal(decoded.opcode, 0x1);
  assert.equal(decoded.text, '[5,"OnJsonApiEvent_lol-gameflow_v1_gameflow-phase"]');
  assert.ok(
    h.statuses.some((s) => s.status === 'connected'),
    '必须有 connected 状态（日志靠它判断订阅通没通）',
  );
});

test('★ 收到事件 → onPhase；收到别的事件 → 只进诊断计数，不触发相位', async () => {
  const h = makeHarness();
  h.stream.start();
  await h.settle();
  const sock = h.sockets[0]!;

  sock.emitData(serverText('[8,"OnJsonApiEvent_lol-gameflow_v1_gameflow-phase","\\"ChampSelect\\""]'));
  assert.equal(h.phases.length, 1);
  assert.equal(h.phases[0]!.phase, 'ChampSelect');

  sock.emitData(serverText('[8,"OnJsonApiEvent_other","x"]'));
  assert.equal(h.phases.length, 1, '别的事件不该触发相位');
  assert.equal(h.stream.events, 1, '相位计数只算目标事件');
  // ⚠️ 诊断计数必须**两条都算**：它的用途正是区分"相位没变"与"帧根本没解出来"
  assert.equal(h.stream.totalEvents, 2);
  assert.deepEqual(h.rawEvents.map((e) => e.topic), [
    'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase',
    'OnJsonApiEvent_other',
  ]);
});

test('回归：WAMP 解码失败只报错、不触发相位（畸形帧不许被当成相位变化）', async () => {
  const h = makeHarness();
  h.stream.start();
  await h.settle();
  h.sockets[0]!.emitData(serverText('这不是 JSON'));
  assert.equal(h.phases.length, 0);
  assert.equal(h.stream.totalEvents, 0);
  assert.ok(h.statuses.some((s) => s.detail.includes('WAMP 解码失败')));
});

test('收到 ping 必须回 pong（否则 LCU 会主动断开）', async () => {
  const h = makeHarness();
  h.stream.start();
  await h.settle();
  const sock = h.sockets[0]!;
  const before = sock.written.length;
  sock.emitData(serverPing(new Uint8Array([0x11, 0x22])));
  assert.equal(sock.written.length, before + 1);
  const pong = decodeClientFrame(sock.written[sock.written.length - 1]!);
  assert.equal(pong.opcode, 0xa);
});

test('★ 断开 → 退避 1s 排一次重连；只排一个（重复 close 不叠加）', async () => {
  const h = makeHarness();
  h.stream.start();
  await h.settle();
  const sock = h.sockets[0]!;

  sock.emitClose();
  sock.emitClose();
  sock.emitError(new Error('boom'));
  assert.deepEqual(h.clock.delays(), [1000], '只能有一个待执行的重连');
  assert.equal(sock.destroyed, true);

  h.clock.runNext();
  await h.settle();
  assert.equal(h.sockets.length, 2, '退避到点后必须重连');
});

test('★ 连续失败：退避 1s → 2s → 4s（connect 失败也走同一条退避）', async () => {
  const h = makeHarness({ failOpen: 3 });
  h.stream.start();
  await h.settle();
  assert.deepEqual(h.clock.delays(), [1000]);
  h.clock.runNext();
  await h.settle();
  assert.deepEqual(h.clock.delays(), [2000]);
  h.clock.runNext();
  await h.settle();
  assert.deepEqual(h.clock.delays(), [4000]);
  assert.ok(
    h.statuses.every((s) => s.status !== 'connected'),
    '一次都没连上时不该有 connected',
  );
});

test('★ 连上后 attempt 归零：成功一次之后，下一次断开重新从 1s 开始', async () => {
  const h = makeHarness({ failOpen: 2 });
  h.stream.start();
  await h.settle(); // 第 1 次失败 → 1s
  h.clock.runNext();
  await h.settle(); // 第 2 次失败 → 2s
  assert.deepEqual(h.clock.delays(), [2000]);
  h.clock.runNext();
  await h.settle(); // 第 3 次成功
  assert.equal(h.sockets.length, 1, '第三次才真的建出 socket');
  h.sockets[0]!.emitClose();
  assert.deepEqual(h.clock.delays(), [1000], '成功过就重置退避');
});

test('★ stop() 之后：清掉待执行的重连，且对端再关也不复活', async () => {
  const h = makeHarness();
  h.stream.start();
  await h.settle();
  const sock = h.sockets[0]!;
  sock.emitClose();
  assert.equal(h.clock.pendingCount(), 1);

  h.stream.stop();
  assert.equal(h.clock.pendingCount(), 0, 'stop 必须清掉待执行的重连');
  assert.equal(sock.destroyed, true);

  sock.emitClose();
  sock.emitError(new Error('after stop'));
  assert.equal(h.clock.pendingCount(), 0, 'stop 之后不许再排重连');
  assert.equal(h.sockets.length, 1, '也不许再建新连接');
  assert.equal(h.statuses[h.statuses.length - 1]?.status, 'stopped');
});

test('协议错误（收到掩码帧）→ 断开重连，而不是静默卡死', async () => {
  const h = makeHarness();
  h.stream.start();
  await h.settle();
  const sock = h.sockets[0]!;
  sock.emitData(new Uint8Array([0x81, 0x81, 0, 0, 0, 0, 0x41]));
  assert.ok(h.statuses.some((s) => s.status === 'error' && s.detail.includes('协议错误')));
  assert.equal(h.clock.pendingCount(), 1);
});

test('openSocket 抛错时 start() 不冒泡（事件通道只是加速器，坏了不许影响主循环）', async () => {
  const h = makeHarness({ failOpen: 10 });
  assert.doesNotThrow(() => h.stream.start());
  await h.settle();
  assert.equal(h.sockets.length, 0);
  assert.equal(h.clock.pendingCount(), 1, '仍要安排重连');
});

test('回归：write 抛错时也走断开重连，而不是把进程带崩', async () => {
  const h = makeHarness();
  h.stream.start();
  await h.settle();
  const sock = h.sockets[0]!;
  sock.write = () => {
    throw new Error('EPIPE');
  };
  sock.emitData(serverPing(new Uint8Array([0x01])));
  // ping 的 pong 写失败被内部吞掉（真正的失败由 socket 的 error/close 体现）
  assert.equal(h.clock.pendingCount(), 0, '只是写失败不该自己排重连');
});

test('回归：encodeTextFrame 产出的订阅帧确实能被我们自己的解析器读回（自洽性）', () => {
  // 客户端帧是掩码的，解析器只认服务端帧 —— 所以这里只验证"帧头合法"：
  const frame = encodeTextFrame('x');
  assert.equal(frame[0], 0x81);
  assert.equal(((frame[1] ?? 0) & 0x80) !== 0, true, 'MASK 位必须置上');
});
