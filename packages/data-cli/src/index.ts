/**
 * `@hexbox/data-cli` 的**库入口**（CLI 本体在 `cli.ts`）
 *
 * 为什么要有这个文件：悬浮窗的「更新数据」要跑**同一条**同步流水线，
 * 但 `cli.ts` 是"带入口保护的脚本"（直接运行时才执行 main）。
 * 让应用去 deep import `@hexbox/data-cli/src/sync.ts` 既难看也会绕过包边界，
 * 所以这里只导出可复用的能力：
 *
 *   · `runDefaultSync` / `runDataSync` —— 同步引擎（可注入、可单测）
 *   · `fetchLatestStatDate` / `shouldCheckNow` —— 启动时的轻量"有没有新数据"
 *   · `fetchTemplates` / `mergeDatasets` —— CLI 与应用共用的纯逻辑
 *
 * 应用侧**不要**从这里拿 provider 列表自己拼（接线只在 `runDefaultSync` 里）。
 */

export * from './sync.ts';
export * from './check-update.ts';
