/**
 * RFC6455 帧编解码测试（按**字节向量**断言，不涉及 socket）
 *
 * 这些向量的意义：LCU 事件通道一旦解错帧，表现是"事件永远不来"或"来了乱码"，
 * 而且在真机上极难区分（没有报错，只是标签慢/不更新）。所以编解码必须能离线证明。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createFrameParser,
  encodeCloseFrame,
  encodeFrame,
  encodePongFrame,
  encodeTextFrame,
  parseClosePayload,
  type WsFrame,
} from './ws-frame.ts';

const MASK = new Uint8Array([0x01, 0x02, 0x03, 0x04]);

/** 服务端帧（**不掩码**）构造器，测试用。 */
function serverFrame(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
  const len = payload.length;
  const headerLen = len < 126 ? 2 : len <= 0xffff ? 4 : 10;
  const out = new Uint8Array(headerLen + len);
  out[0] = (fin ? 0x80 : 0x00) | opcode;
  if (len < 126) out[1] = len;
  else if (len <= 0xffff) {
    out[1] = 126;
    out[2] = (len >>> 8) & 0xff;
    out[3] = len & 0xff;
  } else {
    out[1] = 127;
    let v = len;
    for (let i = 9; i >= 2; i--) {
      out[i] = v & 0xff;
      v = Math.floor(v / 256);
    }
  }
  out.set(payload, headerLen);
  return out;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

test('encodeTextFrame：客户端帧必须掩码，且载荷按掩码键异或（定长向量）', () => {
  // 'hi' → 0x68 0x69；掩码 01 02 03 04 → 0x68^1=0x69, 0x69^2=0x6b
  const frame = encodeTextFrame('hi', MASK);
  assert.deepEqual([...frame], [0x81, 0x82, 0x01, 0x02, 0x03, 0x04, 0x69, 0x6b]);
});

test('encodePongFrame：opcode 0x8a + FIN，同样掩码', () => {
  const frame = encodePongFrame(new Uint8Array([0xaa]), MASK);
  assert.equal(frame[0], 0x8a);
  assert.equal(frame[1], 0x81, '长度 1 + MASK 位');
  assert.equal(frame[6], 0xaa ^ 0x01);
});

test('encodeCloseFrame：状态码按大端写进载荷前两字节', () => {
  const frame = encodeCloseFrame(1000, 'bye', MASK);
  assert.equal(frame[0], 0x88);
  // 2 头 + 4 掩码 = 6，掩码后载荷需解回
  const parser = createFrameParser();
  // 解析器只认服务端帧（不掩码），所以这里改为手工核对：载荷长度 = 2 + 3
  assert.equal(frame[1]! & 0x7f, 5);
  assert.deepEqual([...frame.subarray(6)].map((b, i) => b ^ (MASK[i % 4] ?? 0)), [0x03, 0xe8, 0x62, 0x79, 0x65]);
  assert.equal(parser.push(new Uint8Array(0)).length, 0);
});

test('encodeFrame：126 与 127 两种扩展长度各写一次（并回读一致）', () => {
  const medium = encodeFrame(0x1, new Uint8Array(200), MASK);
  assert.equal(medium[1]! & 0x7f, 126);
  assert.equal((medium[2]! << 8) | medium[3]!, 200);

  const large = encodeFrame(0x1, new Uint8Array(0x10000), MASK);
  assert.equal(large[1]! & 0x7f, 127);
  assert.equal(large.length, 10 + 4 + 0x10000);
});

test('parseClosePayload：空 / 正常 / 畸形', () => {
  assert.deepEqual(parseClosePayload(new Uint8Array([])), { code: null, reason: '' });
  assert.deepEqual(
    parseClosePayload(new Uint8Array([0x03, 0xe8, 0x6f, 0x6b])),
    { code: 1000, reason: 'ok' },
  );
  assert.equal(parseClosePayload(new Uint8Array([0x03])).code, null, '单字节载荷是畸形');
});

test('解析器：一条完整文本帧', () => {
  const p = createFrameParser();
  const frames = p.push(serverFrame(0x1, utf8('["OnJsonApiEvent_x","A"]')));
  assert.deepEqual(frames, [{ kind: 'text', text: '["OnJsonApiEvent_x","A"]' }]);
});

test('解析器：一次 push 里含多帧（TCP 不保证帧边界）', () => {
  const a = serverFrame(0x1, utf8('one'));
  const b = serverFrame(0x1, utf8('two'));
  const both = new Uint8Array([...a, ...b]);
  const frames = createFrameParser().push(both);
  assert.deepEqual(frames, [
    { kind: 'text', text: 'one' },
    { kind: 'text', text: 'two' },
  ]);
});

test('解析器：帧跨多次 push（半个头、半个载荷）', () => {
  const frame = serverFrame(0x1, utf8('hello'));
  const p = createFrameParser();
  assert.deepEqual(p.push(frame.subarray(0, 1)), [], '只有 1 字节头 → 什么都解不出');
  assert.deepEqual(p.push(frame.subarray(1, 4)), [], '载荷没收全 → 继续等');
  assert.deepEqual(p.push(frame.subarray(4)), [{ kind: 'text', text: 'hello' }]);
});

test('★ 解析器：文本分片按**字节**重组后再解码（多字节字符被切断也不能乱码）', () => {
  const p = createFrameParser();
  const full = utf8('海克斯');           // 9 字节，每字 3 字节
  const first = full.subarray(0, 4);     // 故意切在第 2 个字中间
  const rest = full.subarray(4);
  const out: WsFrame[] = [];
  out.push(...p.push(serverFrame(0x1, first, false)));
  out.push(...p.push(serverFrame(0x0, rest, true)));
  assert.deepEqual(out, [{ kind: 'text', text: '海克斯' }]);
});

test('解析器：ping → pong，且 ping 允许插在分片消息中间', () => {
  const p = createFrameParser();
  const full = utf8('ab');
  const frames: WsFrame[] = [];
  frames.push(...p.push(serverFrame(0x1, full.subarray(0, 1), false)));
  frames.push(...p.push(serverFrame(0x9, new Uint8Array([0x7f]))));
  frames.push(...p.push(serverFrame(0x0, full.subarray(1), true)));
  assert.deepEqual(frames, [
    { kind: 'ping', payload: new Uint8Array([0x7f]) },
    { kind: 'text', text: 'ab' },
  ]);
});

test('解析器：close 帧带状态码与原因', () => {
  const payload = new Uint8Array([0x03, 0xe8, 0x62, 0x79, 0x65]);
  assert.deepEqual(createFrameParser().push(serverFrame(0x8, payload)), [
    { kind: 'close', code: 1000, reason: 'bye' },
  ]);
});

test('解析器：二进制帧显式归类（绝不当文本硬解）', () => {
  assert.deepEqual(createFrameParser().push(serverFrame(0x2, new Uint8Array([1, 2]))), [
    { kind: 'binary', payload: new Uint8Array([1, 2]) },
  ]);
});

test('解析器：协议错误逐个报出（掩码帧 / 未知 opcode / 控制帧分片 / 孤立续帧）', () => {
  const masked: WsFrame[] = createFrameParser().push(
    new Uint8Array([0x81, 0x81, 0x00, 0x00, 0x00, 0x00, 0x41]),
  );
  assert.equal(masked[0]?.kind, 'error');

  const unknown = createFrameParser().push(serverFrame(0x3, new Uint8Array([1])));
  assert.equal(unknown[0]?.kind, 'error');

  const fragControl = createFrameParser().push(serverFrame(0x9, new Uint8Array([1]), false));
  assert.equal(fragControl[0]?.kind, 'error');

  const orphan = createFrameParser().push(serverFrame(0x0, utf8('x'), true));
  assert.equal(orphan[0]?.kind, 'error');
});

test('解析器：RSV 位非零（协商了扩展但我们不支持）也算协议错误', () => {
  const frame = serverFrame(0x1, utf8('x'));
  frame[0] = (frame[0] ?? 0) | 0x40; // RSV1
  assert.equal(createFrameParser().push(frame)[0]?.kind, 'error');
});

test('解析器：载荷超上限直接判错，不申请大内存', () => {
  // 必须给**完整**的 10 字节头，否则解析器只会"等更多字节"（那是正确行为，不是报错）
  const frame = new Uint8Array(10);
  frame[0] = 0x81;
  frame[1] = 127;
  let v = 9_999_999;
  for (let i = 9; i >= 2; i--) {
    frame[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  assert.equal(createFrameParser().push(frame)[0]?.kind, 'error');
});

test('解析器：头没收全时**不**报错（只等更多字节）—— 与上面那条互为正反面', () => {
  const truncated = new Uint8Array([0x81, 127, 0x00, 0x00]);
  assert.deepEqual(createFrameParser().push(truncated), []);
});
