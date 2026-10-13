/**
 * LCU **事件订阅**（WAMP over WebSocket）—— 只用它把相位变化的**延迟**从
 * 一个轮询周期压到一次本地往返（思路来自对同类工具的工程做法调研）。
 *
 * ── 设计取舍：事件**不是**第二个真相来源，只负责"叫醒轮询" ──────────────────
 *
 * 真机教训（`apps/overlay/src/main/index.ts` 的 `stageGate`）告诉我们：
 * 相位判断只能有**一条**通路，否则「读失败保持上一阶段」「离开要连续 N 次」
 * 这些规则会各自为政，表现就是"标签一会儿没了一会儿又回来"。
 *
 * 所以这里的 `onPhase` **不给主循环直接写相位**，只让它立刻跑一次原有的
 * `pollOnce()`（那一轮照样走 `/lol-gameflow/v1/session` + 阶段门）。
 * 好处：
 *   · 阶段门/去抖/确认离开的规则**一行都不用改**；
 *   · 事件通道挂了、或 LCU 不推事件时，2 秒轮询照旧兜底（不是二选一）；
 *   · 事件里没有 queueId/gameMode/我的英雄 —— 那些本来就要读会话。
 *
 * ── 这个文件为什么能被单测 ────────────────────────────────────────────────
 *
 * socket 与定时器**全部可注入**（`openSocket` / `setTimeoutFn` / `clearTimeoutFn`），
 * 于是"连上→订阅→收事件→回 pong→断开→退避重连→stop 后不再重连"整条序列
 * 都能用一个假 socket 确定性地跑完，不需要真的 LCU，也不需要真等 1 秒。
 */

import { createHash } from 'node:crypto';
import { request } from 'node:https';

import { basicAuthHeader, type LcuCredentials } from './detect.ts';
import { createFrameParser, encodePongFrame, encodeTextFrame, type WsFrame } from './ws-frame.ts';

/** LCU 的 WAMP 订阅命令 opcode（Riot 的本地事件通道用的是标准 WAMP 子协议号）。 */
export const WAMP_SUBSCRIBE = 5;
/** 取消订阅。 */
export const WAMP_UNSUBSCRIBE = 6;
/** WAMP 事件消息类型号。 */
export const WAMP_EVENT = 8;

/**
 * 游戏流相位事件名（`OnJsonApiEvent_` + 端点路径把 `/` 换成 `_`）。
 *
 * 对应 `GET /lol-gameflow/v1/gameflow-phase`；单测里锁住字面量，
 * 改了就等于改了订阅目标（会静默收不到事件）。
 */
export const LCU_GAMEFLOW_PHASE_EVENT = 'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase';

/** 订阅一条事件（作为 WebSocket 文本帧发送）。 */
export function wampSubscribeMessage(eventName: string): string {
  return JSON.stringify([WAMP_SUBSCRIBE, eventName]);
}

/** 取消订阅一条事件。 */
export function wampUnsubscribeMessage(eventName: string): string {
  return JSON.stringify([WAMP_UNSUBSCRIBE, eventName]);
}

/** 一条 WAMP 消息（LCU 用 JSON 数组：`[type, ...]`）。 */
export interface WampMessage {
  readonly type: number;
  /** 事件类消息的第 2 个元素（事件名）。 */
  readonly topic: string | null;
  /** 事件类消息的第 3 个元素（载荷，未解释）。 */
  readonly payload: unknown;
}

/** 解一条 WAMP 文本消息。 */
export function decodeWampMessage(
  text: string,
): { readonly ok: true; readonly message: WampMessage } | { readonly ok: false; readonly reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: `不是 JSON（前 60 字符：${text.slice(0, 60)}）` };
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== 'number') {
    return { ok: false, reason: '不是 [type, ...] 形状的数组' };
  }
  const topic = typeof parsed[1] === 'string' ? parsed[1] : null;
  return {
    ok: true,
    message: { type: parsed[0], topic, payload: parsed.length > 2 ? parsed[2] : null },
  };
}

/**
 * 从一条事件消息里取出相位字符串。
 *
 * LCU 的事件载荷是**被 JSON 编码过的字符串**（`"ChampSelect"`，含引号），
 * 但不同版本/不同端点也出现过直接给字符串或对象的情况，所以三种都认，
 * 认不出就返回 `null`（**绝不猜**：相位猜错会清掉整排标签）。
 */
export function gameflowPhaseFromEvent(
  message: WampMessage,
  eventName: string = LCU_GAMEFLOW_PHASE_EVENT,
): { readonly phase: string | null; readonly reason: string } {
  if (message.type !== WAMP_EVENT) {
    return { phase: null, reason: `不是事件消息（type=${message.type}）` };
  }
  if (message.topic !== eventName) {
    return { phase: null, reason: `事件名不匹配（${message.topic ?? 'null'}）` };
  }
  const payload = message.payload;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (trimmed === '') return { phase: null, reason: '载荷是空字符串' };
    if (trimmed.startsWith('"')) {
      try {
        const decoded = JSON.parse(trimmed) as unknown;
        if (typeof decoded === 'string' && decoded.trim() !== '') {
          return { phase: decoded.trim(), reason: `JSON 字符串载荷 → ${decoded.trim()}` };
        }
        return { phase: null, reason: `JSON 字符串载荷解出来不是非空字符串（${trimmed.slice(0, 40)}）` };
      } catch {
        return { phase: null, reason: `载荷像 JSON 字符串但解析失败（${trimmed.slice(0, 40)}）` };
      }
    }
    return { phase: trimmed, reason: `裸字符串载荷 → ${trimmed}` };
  }
  if (payload !== null && typeof payload === 'object') {
    const p = (payload as { phase?: unknown }).phase;
    if (typeof p === 'string' && p.trim() !== '') {
      return { phase: p.trim(), reason: `对象载荷 .phase → ${p.trim()}` };
    }
    return { phase: null, reason: '对象载荷里没有可用的 phase 字段' };
  }
  return { phase: null, reason: `载荷类型不可用（${payload === null ? 'null' : typeof payload}）` };
}

/** 重连退避：1s → 2s → 4s → 8s → 16s，封顶 30s（确定性，便于单测）。 */
export function backoffDelayMs(attempt: number, baseMs = 1000, maxMs = 30_000): number {
  const n = Math.max(1, Math.floor(attempt));
  const raw = baseMs * 2 ** (n - 1);
  return Math.min(raw > 0 && Number.isFinite(raw) ? raw : maxMs, maxMs);
}

/** RFC6455 §1.3 的固定 GUID（用于校验 `Sec-WebSocket-Accept`）。 */
export const WS_ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 由客户端 key 算出服务端**必须**回的 `Sec-WebSocket-Accept`。 */
export function webSocketAcceptFor(key: string): string {
  return createHash('sha1').update(key + WS_ACCEPT_GUID).digest('base64');
}

/**
 * 校验服务端的 `Sec-WebSocket-Accept`。
 *
 * 为什么值得单独一个纯函数 + 单测：本机实测过 —— **不是 LCU 的本地端口也能
 * "升级成功"**（30724 / 51841 这类 Riot 内部端口对 `Upgrade` 会回 101）。
 * 所以"连上了"本身**不能**当作"订到了 LCU 事件"；只有按 RFC 校验过 accept，
 * 才能确定对面真的是个 WebSocket 服务，而不是随便一个接受连接的监听者。
 * （端口本身来自 `detect.ts` 的 REST 401 验证，这里是第二道。）
 */
export function isValidWebSocketAccept(header: string | undefined, key: string): boolean {
  if (typeof header !== 'string') return false;
  return header.trim() === webSocketAcceptFor(key);
}

/** 连接状态（只用于日志/诊断，不参与任何判定）。 */
export type LcuEventStatus = 'connecting' | 'connected' | 'disconnected' | 'error' | 'stopped';

/** 一个够用的 socket 视图（Node 的 `net.Socket` 满足它）。 */
export interface LcuSocketLike {
  write(data: Uint8Array): void;
  destroy(): void;
  on(event: 'data', cb: (chunk: Uint8Array) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: unknown) => void): void;
}

/** 建立一次升级后的连接（测试注入假实现）。 */
export type LcuSocketOpener = (creds: LcuCredentials) => Promise<LcuSocketLike>;

export interface LcuEventStreamOptions {
  readonly creds: LcuCredentials;
  /** 收到匹配事件（且能解出相位）时调用。**只用来叫醒轮询**。 */
  readonly onPhase: (phase: string, detail: string) => void;
  /**
   * **每一条**解出来的 LCU 事件都会调它（不限于我们订阅的那条）。
   *
   * 只用于诊断：`scripts/diag-lcu-events.mts` 靠它证明"真实 LCU 推来的帧我们的
   * 解析器读得懂"——否则"没收到相位事件"既可能是相位没变，也可能是帧根本没解出来，
   * 两者在日志上无法区分。
   */
  readonly onEvent?: (topic: string | null, payload: unknown) => void;
  readonly onStatus?: (status: LcuEventStatus, detail: string) => void;
  /** 事件名，默认游戏流相位；测试用别的名字。 */
  readonly eventName?: string;
  readonly openSocket?: LcuSocketOpener;
  readonly setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

/**
 * LCU 事件流：连上 → 订阅 → 转发事件 → 断了就退避重连，直到 `stop()`。
 *
 * 它**永远不抛**：所有失败都走 `onStatus('error'|'disconnected', 原因)` + 重连，
 * 因为事件通道只是"加速器"，坏了不该影响主循环（2 秒轮询仍在兜底）。
 */
export class LcuEventStream {
  private readonly opts: LcuEventStreamOptions;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  private socket: LcuSocketLike | null = null;
  private parser = createFrameParser();
  private stopped = false;
  private attempt = 0;
  private timer: unknown = null;
  private reconnectScheduled = false;
  private phaseCount = 0;
  private eventCount = 0;

  constructor(options: LcuEventStreamOptions) {
    this.opts = options;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** 已转发的**相位**事件条数（用于日志判断"订阅到底通没通"）。 */
  get events(): number {
    return this.phaseCount;
  }

  /** 已解出的**全部**事件条数（含不匹配的；诊断用）。 */
  get totalEvents(): number {
    return this.eventCount;
  }

  start(): void {
    if (this.stopped) return;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    this.reconnectScheduled = false;
    const s = this.socket;
    this.socket = null;
    if (s) {
      try {
        s.destroy();
      } catch {
        // 已经断了就算了 —— 收工路径上不值得抛
      }
    }
    this.status('stopped', '已停止（不再重连）');
  }

  private status(status: LcuEventStatus, detail: string): void {
    this.opts.onStatus?.(status, detail);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const opener = this.opts.openSocket ?? openLcuSocket;
    this.status('connecting', `第 ${this.attempt + 1} 次尝试`);
    let socket: LcuSocketLike;
    try {
      socket = await opener(this.opts.creds);
    } catch (err) {
      this.status('error', `连接失败：${err instanceof Error ? err.message : String(err)}`);
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) {
      try {
        socket.destroy();
      } catch {
        // 同上
      }
      return;
    }

    this.socket = socket;
    this.parser = createFrameParser();
    this.attempt = 0;
    this.phaseCount = 0;
    this.reconnectScheduled = false;

    // 订阅：LCU 用 WAMP over WebSocket，订阅命令就是一条文本帧
    const eventName = this.opts.eventName ?? LCU_GAMEFLOW_PHASE_EVENT;
    try {
      socket.write(encodeTextFrame(wampSubscribeMessage(eventName)));
    } catch (err) {
      this.status('error', `订阅写入失败：${err instanceof Error ? err.message : String(err)}`);
      this.teardownAndReconnect(socket);
      return;
    }
    this.status('connected', `已订阅 ${eventName}`);

    socket.on('data', (chunk) => {
      if (this.socket !== socket) return; // 上一代的尾巴，丢弃
      this.onData(chunk);
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.status('disconnected', '连接被对端关闭');
      this.teardownAndReconnect(socket);
    });
    socket.on('error', (err) => {
      if (this.socket !== socket) return;
      this.status('error', `socket 错误：${err instanceof Error ? err.message : String(err)}`);
      this.teardownAndReconnect(socket);
    });
  }

  private onData(chunk: Uint8Array): void {
    for (const frame of this.parser.push(chunk)) {
      this.onFrame(frame);
    }
  }

  private onFrame(frame: WsFrame): void {
    switch (frame.kind) {
      case 'ping': {
        // 必须回 pong，否则 LCU 会主动断开
        try {
          this.socket?.write(encodePongFrame(frame.payload));
        } catch {
          // 写失败会在 socket 的 error/close 上体现，这里不重复处理
        }
        return;
      }
      case 'text': {
        const decoded = decodeWampMessage(frame.text);
        if (!decoded.ok) {
          this.status('error', `WAMP 解码失败：${decoded.reason}`);
          return;
        }
        // 每一条事件都记一次（诊断用：证明"真实帧读得懂"，见 onEvent 的注释）
        if (decoded.message.type === WAMP_EVENT) {
          this.eventCount++;
          this.opts.onEvent?.(decoded.message.topic, decoded.message.payload);
        }
        const got = gameflowPhaseFromEvent(
          decoded.message,
          this.opts.eventName ?? LCU_GAMEFLOW_PHASE_EVENT,
        );
        if (got.phase === null) return; // 不是我们订阅的那条（LCU 会推别的事件）
        this.phaseCount++;
        this.opts.onPhase(got.phase, got.reason);
        return;
      }
      case 'close': {
        this.status(
          'disconnected',
          `对端 close（code=${frame.code ?? 'null'}${frame.reason ? `, ${frame.reason}` : ''}）`,
        );
        const s = this.socket;
        if (s) this.teardownAndReconnect(s);
        return;
      }
      case 'error': {
        // 协议错误：这条连接已经不可用了，直接断开重连
        this.status('error', `协议错误：${frame.reason}`);
        const s = this.socket;
        if (s) this.teardownAndReconnect(s);
        return;
      }
      default:
        return; // binary/pong：LCU 用不到，忽略
    }
  }

  private teardownAndReconnect(socket: LcuSocketLike): void {
    if (this.socket === socket) this.socket = null;
    try {
      socket.destroy();
    } catch {
      // 忽略
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectScheduled) return;
    this.reconnectScheduled = true;
    // ⚠️ 用 `attempt + 1` 算延迟再自增：第一次失败必须是 1s（attempt 从 0 起，
    //    直接用 attempt 会让第 1、2 次都是 1s —— 单测锁住了这条）。
    const delay = backoffDelayMs(this.attempt + 1, this.opts.baseBackoffMs, this.opts.maxBackoffMs);
    this.attempt++;
    this.status('disconnected', `${delay}ms 后重连（第 ${this.attempt} 次退避）`);
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      this.reconnectScheduled = false;
      void this.connect();
    }, delay);
  }
}

/**
 * 默认连接器：`https.request` 的 **Upgrade** 通道（零依赖）。
 *
 * 为什么不用 `new WebSocket()`：Electron 33 是 Node 20.18，全局 `WebSocket`
 * 需要 `--experimental-websocket` 才存在；而 `ws` 在本仓库没有依赖。
 * `https.request` 直接支持 `Connection: Upgrade` + `upgrade` 事件，
 * 拿到的是**裸 socket**，正好喂给 `ws-frame.ts` 的解析器。
 *
 * ⚠️ TLS：LCU 是自签证书，这里按 `rejectUnauthorized: false` 关校验 ——
 * 与 `LcuClient` 走 `withInsecureTls()` 是同一件事，只是 WebSocket 没有
 * fetch 那种"临时环境变量"的余地，只能在连接参数上关。
 * **只连 127.0.0.1**，这个取舍与仓库既有做法一致。
 */
export async function openLcuSocket(creds: LcuCredentials): Promise<LcuSocketLike> {
  const key = Buffer.from(
    Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)),
  ).toString('base64');

  return await new Promise<LcuSocketLike>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: creds.port,
      path: '/',
      method: 'GET',
      rejectUnauthorized: false, // LCU 自签证书（只连本机）
      agent: false, // 升级后的 socket 归我们所有，不要走 keep-alive 池
      headers: {
        Authorization: basicAuthHeader(creds.password),
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    });

    req.on('upgrade', (res, socket) => {
      // 第二道校验：对面必须按 RFC6455 回正确的 accept —— 见 isValidWebSocketAccept
      const accept = res.headers['sec-websocket-accept'];
      if (!isValidWebSocketAccept(typeof accept === 'string' ? accept : undefined, key)) {
        socket.destroy();
        reject(new Error(`Upgrade 响应缺少正确的 Sec-WebSocket-Accept（HTTP ${res.statusCode}）`));
        return;
      }
      resolve(socket as unknown as LcuSocketLike);
    });
    req.on('response', (res) => {
      // 没升级成功（401/404 等）：把状态码带出去，便于日志定位
      req.destroy();
      reject(new Error(`未升级为 WebSocket（HTTP ${res.statusCode}）`));
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
}
