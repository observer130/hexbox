/**
 * `requestInsecure` / HTTPS 传输层测试
 *
 * 重点验证"per-connection 关校验"实现里最容易挂住的两条路径：
 *   · 对端不可达（连接被拒）→ 明确 reject，不吞错；
 *   · 对端接受 TCP 但 TLS 握手不完成 → 必须按超时 reject（不能无限挂起）。
 *
 * 这里**不校验**"自签证书被放行"本身（需要测试证书）；真正的
 * `rejectUnauthorized: false` 由代码审查 + 真机 LCU 验证兜底。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';

import { requestInsecure } from './https.ts';

/** 拿一个当前没人监听的端口（先 listen 再 close）。 */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

test('requestInsecure：连接被拒时 reject（不吞错）', async () => {
  const port = await freePort();
  await assert.rejects(() => requestInsecure(`https://127.0.0.1:${port}/x`, { timeoutMs: 500 }));
});

test('requestInsecure：TLS 握手不完成时按超时 reject（不能无限挂起）', async () => {
  // 只接受 TCP、从不回应 ClientHello：模拟"端口通但服务不响应"
  const sockets = new Set<import('node:net').Socket>();
  const srv = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    /* 故意什么都不写 */
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  try {
    await assert.rejects(
      () => requestInsecure(`https://127.0.0.1:${port}/x`, { timeoutMs: 120 }),
      /超时/,
    );
  } finally {
    // 客户端被 destroy 后 socket 可能还没被服务端回收：主动断开，避免 close() 挂住
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test('requestInsecure：已取消的 signal 立即 reject（AbortError，不发请求）', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => requestInsecure('https://127.0.0.1:1/x', { signal: controller.signal, timeoutMs: 500 }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as Error).name, 'AbortError');
      return true;
    },
  );
});
