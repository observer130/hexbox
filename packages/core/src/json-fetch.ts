/**
 * 带**超时 / 有限重试 / 条件缓存**的 JSON 拉取（唯一实现）
 *
 * 审查 P2 要求 Provider 支持 ETag 条件请求，但重试/超时逻辑此前在
 * `provider-communitydragon` 与 `provider-tencent` 各写一份（P1 时拼出来的两套循环）。
 * 这里把三者合成**一份**，由 Provider 共用；以后再改重试策略只改这里。
 *
 * 契约（Provider 单测锁定）：
 *   - 超时：每次尝试 = 外部取消 ∪ `timeoutMs`（默认 15s）；
 *   - 重试：5xx / 429 / 网络错误 / JSON 解析失败重试一次；4xx（除 429）立即失败；
 *   - 取消：外部 signal abort 后立即冒泡，不再等待重试；
 *   - 缓存：有 `cache` 时发 `If-None-Match`/`If-Modified-Since`；304 且缓存正文存在
 *     则直接复用，否则报错（**不许**把 304 当成功却返回空数据）；200 时保存
 *     ETag/Last-Modified + 正文（正文存原始文本，避免二次序列化漂移）。
 */

import { conditionalHeaders, type CachedHttpEntry, type HttpCache } from './http-cache.ts';
import { httpTimeoutSignal, sleep } from './http.ts';

/** 单次请求默认超时（Provider 可覆盖）。 */
export const DEFAULT_JSON_TIMEOUT_MS = 15_000;
/** 默认总尝试次数（首次 + 1 次重试）。 */
export const DEFAULT_JSON_ATTEMPTS = 2;
/** 默认重试等待。 */
export const DEFAULT_JSON_RETRY_DELAY_MS = 250;

export interface JsonFetchOptions {
  readonly url: string;
  /** 错误文案里的数据源名字（如「CommunityDragon 图鉴」「腾讯排行榜」）。 */
  readonly label: string;
  /** 自定义 fetch（测试注入用）。 */
  readonly fetchImpl?: typeof fetch;
  /** 外部取消信号（用户关程序 / 托盘取消）。 */
  readonly signal?: AbortSignal;
  /** 额外请求头（User-Agent 等）。 */
  readonly headers?: Readonly<Record<string, string>>;
  /** 单次请求超时（默认 15s）。 */
  readonly timeoutMs?: number;
  /** 总尝试次数（默认 2）。 */
  readonly retryAttempts?: number;
  /** 重试等待（默认 250ms；测试可调小）。 */
  readonly retryDelayMs?: number;
  /** 条件请求缓存（可选；不传 = 每轮都整包拉）。 */
  readonly cache?: HttpCache;
}

/** 标记"不值得重试"的错误（4xx / 304 无缓存）。 */
function noRetryError(message: string): Error {
  return Object.assign(new Error(message), { noRetry: true as const });
}

/** 从响应里取正文 + 缓存头（兼容只实现 `json()` 的测试桩）。 */
async function readBody(res: Response): Promise<{
  readonly text: string;
  readonly etag: string | undefined;
  readonly lastModified: string | undefined;
}> {
  const maybe = res as unknown as {
    text?: () => Promise<string>;
    json?: () => Promise<unknown>;
    headers?: { get?: (name: string) => string | null };
  };
  const text =
    typeof maybe.text === 'function'
      ? await maybe.text()
      : JSON.stringify(typeof maybe.json === 'function' ? await maybe.json() : null);
  const etag = maybe.headers?.get?.('etag') ?? undefined;
  const lastModified = maybe.headers?.get?.('last-modified') ?? undefined;
  return {
    text,
    etag: etag === null ? undefined : etag,
    lastModified: lastModified === null ? undefined : lastModified,
  };
}

/**
 * 拉一个 JSON（带条件缓存、超时与有限重试）。
 *
 * @throws 4xx（非 429）立即失败；重试用尽后抛最后一次错误；304 但无缓存正文也抛错。
 */
export async function fetchJsonWithRetry<T>(options: JsonFetchOptions): Promise<T> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_JSON_TIMEOUT_MS;
  const attempts = Math.max(1, Math.floor(options.retryAttempts ?? DEFAULT_JSON_ATTEMPTS));
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_JSON_RETRY_DELAY_MS;
  const cached: CachedHttpEntry | undefined = options.cache?.get(options.url);
  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
    ...conditionalHeaders(cached),
  };

  for (let attempt = 1; ; attempt++) {
    try {
      const res = await doFetch(options.url, {
        signal: httpTimeoutSignal(options.signal, timeoutMs),
        headers,
      });

      // 304：上游确认没变 —— 只有本地还有完整正文时才敢复用
      if (res.status === 304) {
        if (cached === undefined || cached.body === '') {
          throw noRetryError(
            `${options.label}: 返回 HTTP 304 但没有本地缓存正文（不要删除缓存检查 304）`,
          );
        }
        return JSON.parse(cached.body) as T;
      }

      if (!res.ok) {
        const err = new Error(`${options.label}: HTTP ${res.status}`);
        // 4xx（除 429）不重试：URL/权限错了，重试只会拖慢失败
        if (res.status < 500 && res.status !== 429) throw noRetryError(err.message);
        throw err;
      }

      const { text, etag, lastModified } = await readBody(res);
      const parsed = JSON.parse(text) as T;
      if (options.cache && (etag !== undefined || lastModified !== undefined)) {
        options.cache.set(options.url, {
          body: text,
          ...(etag !== undefined ? { etag } : {}),
          ...(lastModified !== undefined ? { lastModified } : {}),
        });
      }
      return parsed;
    } catch (err) {
      const noRetry = (err as { noRetry?: boolean }).noRetry === true;
      if (noRetry || options.signal?.aborted === true || attempt >= attempts) throw err;
      await sleep(retryDelayMs);
    }
  }
}
