/**
 * 对**本机自签证书**服务的 HTTPS 请求（per-connection 关闭校验）
 *
 * 为什么需要它（审查 P1）：原来的 `withInsecureTls()` 通过 `NODE_TLS_REJECT_UNAUTHORIZED=0`
 * 实现"临时关闭校验"——那是**进程级**开关，豁免窗口内**所有并发 HTTPS**（数据同步、
 * 更新检查、CDragon/腾讯）都会一起失去证书校验；与 AGENTS 的硬规则直接冲突。
 *
 * 现在改为：每个请求在 `https.request` 上单独给 `rejectUnauthorized: false`，
 * 只影响**这一条连接**，不碰任何进程级环境变量。2999（`live-data.ts`）与
 * WebSocket（`events.ts`）本来就是这个姿势，这里把 LCU REST 也统一过来。
 *
 * 适用范围：**只连本机**（`127.0.0.1` 上的 LCU/2999）。不要拿它请求公网地址。
 */

import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http';

/** 默认单请求超时（LCU 是本机服务，5s 已经非常宽松）。 */
export const INSECURE_REQUEST_TIMEOUT_MS = 5_000;

/** 最小响应投影（调用方只需要状态码 + 正文）。 */
export interface InsecureResponse {
  readonly status: number;
  readonly ok: boolean;
  /** 响应正文（UTF-8；LCU/2999 都是 JSON）。 */
  text(): string;
}

export interface InsecureRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly headers?: OutgoingHttpHeaders;
  readonly body?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** 请求函数签名（`LcuClient` 允许注入，便于单测 401/404/204 语义）。 */
export type InsecureRequestFn = (
  url: string,
  options?: InsecureRequestOptions,
) => Promise<InsecureResponse>;

/** 发一个只对本连接关闭证书校验的 HTTPS 请求。 */
export const requestInsecure: InsecureRequestFn = async (url, options = {}) => {
  const timeoutMs = options.timeoutMs ?? INSECURE_REQUEST_TIMEOUT_MS;
  return await new Promise<InsecureResponse>((resolve, reject) => {
    const requestOptions: RequestOptions = {
      method: options.method ?? 'GET',
      ...(options.headers ? { headers: options.headers } : {}),
      // ⚠️ 只影响这一条连接；绝不用 NODE_TLS_REJECT_UNAUTHORIZED（进程级副作用会
      //    让同期所有 HTTPS 一起失校验，并发时先结束的一方还会把豁免撤掉）。
      rejectUnauthorized: false,
    };
    const req = httpsRequest(url, requestOptions, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        cleanup();
        const status = res.statusCode ?? 0;
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status,
          ok: status >= 200 && status < 300,
          text: () => body,
        });
      });
      res.on('error', (err: Error) => {
        cleanup();
        reject(err);
      });
    });
    const timer = setTimeout(() => {
      req.destroy(new Error(`HTTPS 请求超时（${timeoutMs}ms）：${url}`));
    }, timeoutMs);
    const signal = options.signal;
    const onAbort = (): void => {
      const err = new Error('请求已取消');
      err.name = 'AbortError';
      req.destroy(err);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('error', (err: Error) => {
      cleanup();
      reject(err);
    });
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
};
