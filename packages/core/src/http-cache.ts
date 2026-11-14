/**
 * HTTP 条件请求缓存（`ETag` / `Last-Modified`）—— 接口 + 内存实现
 *
 * 审查 P2：Provider 每次同步都整包重拉（CommunityDragon 的 items.json 约 666KB、
 * 图鉴/榜单也各几百 KB），而大多数时候上游**根本没变**。这里只定义最小接口：
 *
 * - `get(url)`：上次成功响应的缓存条目（含 ETag / Last-Modified / 原始正文）；
 * - `set(url, entry)`：200 成功后更新。
 *
 * 持久化实现放在 `@hexbox/data-store`（它已经负责 fs 与原子写），
 * core 保持纯内存、零 Node 依赖 —— 这样浏览器侧也能 import 类型。
 *
 * 304 语义由调用方（`json-fetch.ts`）处理：只在**有缓存正文**时才认 304，
 * 否则宁可报错也不要返回空数据。
 */

/** 一条缓存（正文必须是原始 JSON 文本，304 时直接复用）。 */
export interface CachedHttpEntry {
  /** 强/弱 ETag（原样保存，含引号）。 */
  readonly etag?: string;
  /** `Last-Modified` 原样（HTTP 日期）。 */
  readonly lastModified?: string;
  /** 成功响应的完整正文（用于 304 时跳过下载，不再发请求体）。 */
  readonly body: string;
}

/** 条件请求缓存的最小接口（生产用文件缓存，测试用内存实现）。 */
export interface HttpCache {
  get(url: string): CachedHttpEntry | undefined;
  set(url: string, entry: CachedHttpEntry): void;
}

/** 纯内存缓存（单次进程内复用；不会持久化）。 */
export class MemoryHttpCache implements HttpCache {
  private readonly entries = new Map<string, CachedHttpEntry>();

  get(url: string): CachedHttpEntry | undefined {
    return this.entries.get(url);
  }

  set(url: string, entry: CachedHttpEntry): void {
    this.entries.set(url, entry);
  }

  /** 当前条目数（诊断/测试用）。 */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * 条件请求头：有 ETag 优先 `If-None-Match`，否则用 `Last-Modified`。
 *
 * 两者都发是合法的（RFC 9110 允许），但没必要 —— 上游只要一个能命中就够；
 * 优先 ETag 是因为它比时间戳更精确。
 */
export function conditionalHeaders(
  cached: CachedHttpEntry | undefined,
): Record<string, string> {
  if (!cached) return {};
  if (cached.etag !== undefined && cached.etag !== '') {
    return { 'if-none-match': cached.etag };
  }
  if (cached.lastModified !== undefined && cached.lastModified !== '') {
    return { 'if-modified-since': cached.lastModified };
  }
  return {};
}
