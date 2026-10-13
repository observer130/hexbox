/**
 * 极简 RFC6455 帧编解码 —— **只够 LCU 事件订阅用**（纯函数 + 单测）
 *
 * ── 为什么自己写（而不是引 `ws` / 用全局 `WebSocket`）────────────────────────
 *
 * 1. 本仓库**没有** `ws` 依赖，`node_modules` 里也不存在（连 pnpm store 都没有），
 *    为一条只连 `127.0.0.1` 的事件通道去装新依赖不值得；
 * 2. Node 的全局 `WebSocket` 在 **Electron 33（Node 20.18）上默认不可用**
 *    （Node 20 需要 `--experimental-websocket`，22 才默认开），而覆盖层跑在
 *    Electron 主进程里；
 * 3. LCU 的 WAMP 通道**只需要**：客户端发文本帧（订阅命令）、收文本帧（事件）、
 *    回 pong、以及识别 close —— 不需要扩展、不需要压缩、不需要二进制消息。
 *
 * 所以这里只实现"够用且可证明正确"的那一小块：**编解码是纯函数**，
 * 有按字节向量写的单测（见 `ws-frame.test.ts`），不依赖任何 socket。
 *
 * 坐标系：所有长度都是**字节**；文本一律 UTF-8，且**先按字节重组分片、
 * 再整体解码**（否则多字节字符会被分片切断成乱码）。
 */

import { randomBytes } from 'node:crypto';

/** 一个已解码的帧或消息。 */
export type WsFrame =
  /** 一条**完整**的文本消息（分片已重组）。 */
  | { readonly kind: 'text'; readonly text: string }
  /**
   * 未归类的二进制消息（LCU 不用，但必须能识别出来并显式报错，
   * 而不是当文本硬解 —— 那会得到乱码事件）。
   */
  | { readonly kind: 'binary'; readonly payload: Uint8Array }
  | { readonly kind: 'ping'; readonly payload: Uint8Array }
  | { readonly kind: 'pong'; readonly payload: Uint8Array }
  | { readonly kind: 'close'; readonly code: number | null; readonly reason: string }
  /** 协议错误：此后连接**不可继续使用**（调用方应断开并重连）。 */
  | { readonly kind: 'error'; readonly reason: string };

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/**
 * 单帧载荷上限（保护性）：LCU 事件都是几 KB 的 JSON。
 * 超过就判协议错误，绝不为一条畸形帧去申请几百 MB。
 */
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** 客户端 MUST 掩码；掩码键 4 字节。测试用注入的固定键，生产用随机键。 */
function freshMaskKey(): Uint8Array {
  return new Uint8Array(randomBytes(4));
}

/** 编一个**客户端**帧（opcode + 载荷），FIN=1、MASK=1。 */
export function encodeFrame(
  opcode: number,
  payload: Uint8Array,
  maskKey?: Uint8Array,
): Uint8Array {
  const mask = maskKey ?? freshMaskKey();
  if (mask.length !== 4) throw new Error(`掩码键必须是 4 字节，收到 ${mask.length}`);
  const len = payload.length;
  // 头长：2 基本 + （126 → 2 字节扩展 / 127 → 8 字节扩展）+ 4 掩码键
  const extended = len < 126 ? 0 : len <= 0xffff ? 2 : 8;
  const headerLen = 2 + extended + 4;
  const out = new Uint8Array(headerLen + len);

  out[0] = 0x80 | (opcode & 0x0f);
  if (extended === 0) {
    out[1] = 0x80 | len;
  } else if (extended === 2) {
    out[1] = 0x80 | 126;
    out[2] = (len >>> 8) & 0xff;
    out[3] = len & 0xff;
  } else {
    out[1] = 0x80 | 127;
    // JS 数字安全区间内按 64 位大端写（高 4 字节必为 0）
    let v = len;
    for (let i = 9; i >= 2; i--) {
      out[i] = v & 0xff;
      v = Math.floor(v / 256);
    }
  }

  for (let i = 0; i < 4; i++) out[2 + extended + i] = mask[i] ?? 0;
  for (let i = 0; i < len; i++) {
    out[headerLen + i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
  }
  return out;
}

/** 文本帧（订阅命令走这条）。 */
export function encodeTextFrame(text: string, maskKey?: Uint8Array): Uint8Array {
  return encodeFrame(OP_TEXT, new TextEncoder().encode(text), maskKey);
}

/** pong 帧（收到 ping 必须回，否则 LCU 会断开）。 */
export function encodePongFrame(payload: Uint8Array, maskKey?: Uint8Array): Uint8Array {
  return encodeFrame(OP_PONG, payload, maskKey);
}

/** close 帧。 */
export function encodeCloseFrame(
  code: number = 1000,
  reason = '',
  maskKey?: Uint8Array,
): Uint8Array {
  const r = new TextEncoder().encode(reason);
  const payload = new Uint8Array(2 + r.length);
  payload[0] = (code >>> 8) & 0xff;
  payload[1] = code & 0xff;
  payload.set(r, 2);
  return encodeFrame(OP_CLOSE, payload, maskKey);
}

/** close 帧载荷 → 状态码 + 原因（空载荷合法，表示"无状态码"）。 */
export function parseClosePayload(payload: Uint8Array): { code: number | null; reason: string } {
  if (payload.length === 0) return { code: null, reason: '' };
  if (payload.length === 1) return { code: null, reason: '（close 载荷只有 1 字节，属畸形）' };
  const code = ((payload[0] ?? 0) << 8) | (payload[1] ?? 0);
  const reason = new TextDecoder().decode(payload.subarray(2));
  return { code, reason };
}

/** 增量帧解析器：喂字节，出帧/消息。 */
export interface FrameParser {
  /**
   * 喂入一段**任意长度**的字节（可能只含半个帧）。
   * 返回本次能解出的所有帧/消息，按到达顺序。
   */
  push(chunk: Uint8Array): WsFrame[];
}

/**
 * 创建一个增量解析器。
 *
 * 关键点（都有单测）：
 *   · 一个 `push` 里可能含**多个**帧（TCP 不保证边界）；
 *   · 一个帧可能**跨多次** `push`（半个头 / 半个载荷）；
 *   · 文本消息可**分片**（FIN=0 起、opcode=0 续、FIN=1 止），必须按字节重组后
 *     再整体 UTF-8 解码；
 *   · 控制帧（ping/pong/close）**不许分片**，且可插在分片消息中间；
 *   · 解析器**只在协议真正无法继续时**吐 `error`（客户端收到掩码帧、载荷超限、
 *     未知 opcode、控制帧被分片）。
 */
export function createFrameParser(): FrameParser {
  let buf = new Uint8Array(0);
  let fragOpcode: number | null = null;
  let fragChunks: Uint8Array[] = [];

  const reset = (): void => {
    buf = new Uint8Array(0);
    fragOpcode = null;
    fragChunks = [];
  };

  const finishMessage = (opcode: number, payload: Uint8Array, out: WsFrame[]): void => {
    if (opcode === OP_TEXT) {
      out.push({ kind: 'text', text: new TextDecoder().decode(payload) });
    } else {
      out.push({ kind: 'binary', payload });
    }
  };

  const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
    let total = 0;
    for (const c of chunks) total += c.length;
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    return merged;
  };

  return {
    push(chunk: Uint8Array): WsFrame[] {
      if (chunk.length > 0) {
        const merged = new Uint8Array(buf.length + chunk.length);
        merged.set(buf, 0);
        merged.set(chunk, buf.length);
        buf = merged;
      }

      const out: WsFrame[] = [];
      let off = 0;

      while (true) {
        // ── 至少要 2 字节头 ────────────────────────────────────────────
        if (buf.length - off < 2) break;
        const b0 = buf[off] ?? 0;
        const b1 = buf[off + 1] ?? 0;
        const fin = (b0 & 0x80) !== 0;
        const rsv = b0 & 0x70;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        const len7 = b1 & 0x7f;

        if (rsv !== 0) {
          reset();
          out.push({ kind: 'error', reason: `RSV 位非零（0x${rsv.toString(16)}），本实现不支持扩展` });
          break;
        }
        // 服务端 → 客户端**不许**掩码（RFC6455 §5.1）
        if (masked) {
          reset();
          out.push({ kind: 'error', reason: '收到被掩码的帧（服务端帧不许掩码）' });
          break;
        }

        // ── 扩展长度 ───────────────────────────────────────────────────
        let headerLen = 2;
        let payloadLen = len7;
        if (len7 === 126) {
          if (buf.length - off < 4) break;
          payloadLen = ((buf[off + 2] ?? 0) << 8) | (buf[off + 3] ?? 0);
          headerLen = 4;
        } else if (len7 === 127) {
          if (buf.length - off < 10) break;
          let v = 0;
          for (let i = 0; i < 8; i++) v = v * 256 + (buf[off + 2 + i] ?? 0);
          payloadLen = v;
          headerLen = 10;
        }

        if (payloadLen > MAX_PAYLOAD_BYTES) {
          reset();
          out.push({
            kind: 'error',
            reason: `载荷 ${payloadLen} 字节超过上限 ${MAX_PAYLOAD_BYTES}`,
          });
          break;
        }
        if (buf.length - off < headerLen + payloadLen) break; // 载荷还没收全

        const payload = buf.subarray(off + headerLen, off + headerLen + payloadLen);
        // 复制一份：下面的 buf 会被替换，subarray 是视图不是拷贝
        const payloadCopy = new Uint8Array(payload);

        const isControl = opcode === OP_CLOSE || opcode === OP_PING || opcode === OP_PONG;
        if (isControl) {
          if (!fin) {
            reset();
            out.push({ kind: 'error', reason: `控制帧 opcode=${opcode} 被分片（RFC 禁止）` });
            break;
          }
          if (opcode === OP_PING) out.push({ kind: 'ping', payload: payloadCopy });
          else if (opcode === OP_PONG) out.push({ kind: 'pong', payload: payloadCopy });
          else {
            const { code, reason } = parseClosePayload(payloadCopy);
            out.push({ kind: 'close', code, reason });
          }
          off += headerLen + payloadLen;
          continue;
        }

        // ── 数据帧（文本/二进制/续帧）─────────────────────────────────
        if (opcode === OP_TEXT || opcode === OP_BINARY) {
          if (fragOpcode !== null) {
            // 上一段分片消息还没结束，就又来了一个新的数据帧
            reset();
            out.push({ kind: 'error', reason: '分片消息未结束就又收到新的数据帧' });
            break;
          }
          if (fin) {
            finishMessage(opcode, payloadCopy, out);
          } else {
            fragOpcode = opcode;
            fragChunks = [payloadCopy];
          }
          off += headerLen + payloadLen;
          continue;
        }

        if (opcode === OP_CONT) {
          if (fragOpcode === null) {
            reset();
            out.push({ kind: 'error', reason: '收到续帧但当前没有未完成的分片消息' });
            break;
          }
          fragChunks.push(payloadCopy);
          if (fin) {
            const merged = concat(fragChunks);
            const started = fragOpcode;
            fragOpcode = null;
            fragChunks = [];
            finishMessage(started, merged, out);
          }
          off += headerLen + payloadLen;
          continue;
        }

        reset();
        out.push({ kind: 'error', reason: `未知 opcode 0x${opcode.toString(16)}` });
        break;
      }

      // 只保留没解析完的尾巴，避免缓冲区无限增长
      if (off > 0) buf = buf.slice(off);
      return out;
    },
  };
}
