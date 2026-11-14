/**
 * HTTP 请求的**取消/超时信号**组合（纯工具，本身不发请求）
 *
 * 为什么放在 core：`provider-communitydragon` 与 `provider-tencent` 都要用，
 * 而 core 是两者共同依赖的最底层（不能反向依赖 provider/data-cli）。
 * 这里只做 `AbortSignal` 组合，不引入任何 IO/依赖，CI 可直测。
 *
 * 背景（审查 P1）：Provider 原先直接 `fetch(url,{signal})`，没有**默认超时** ——
 * 上游半开连接（不回 RST）会让 `runDataSync` 永久停在"拉取图鉴"，首启静默
 * 自动同步时用户毫无反馈。现在每个请求 = 外部取消信号 ∪ 单次请求超时。
 */

/** 单次 HTTP 请求的默认超时（15s；CDragon/腾讯 JSON 最大 ~666KB）。 */
export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

/**
 * 把"调用方取消信号"和"单次请求超时"合成一个信号。
 *
 * - `external` 省略 → 只受超时约束；
 * - `timeoutMs <= 0` / 非有限值 → 不设超时（只受 `external` 约束）；
 * - 两者任一触发 → 返回的信号 abort，`fetch` 会随之取消。
 *
 * ⚠️ `AbortSignal.timeout()` 的定时器不会被提前清理（Node 没有对应 API）；
 * 每次请求多一个 15s 定时器，对同步这种短生命周期进程可忽略。
 */
export function httpTimeoutSignal(
  external: AbortSignal | undefined,
  timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS,
): AbortSignal {
  const timeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  if (!external) return timeout ?? new AbortController().signal;
  return timeout ? AbortSignal.any([external, timeout]) : external;
}

/** 简单等待（重试退避用；测试可通过 options.retryDelayMs 调小）。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}
