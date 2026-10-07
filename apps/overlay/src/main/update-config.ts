/**
 * 「检查更新」的**单一来源配置**（要改发布仓库/超时，只改这里）
 *
 * ── 仓库 slug 是从哪里来的（**没有猜**）──────────────────────────────────
 *   `git remote -v` → `git@github.com:observer130/hexbox.git`
 *   → slug = `observer130/hexbox`。
 *
 *   ⚠️ 根 `package.json` 里**没有** `repository` 字段（electron-builder 也不写它），
 *   所以 git remote 是当前唯一可信来源。**不要再从别处推一个 slug**：
 *   猜错的后果是"检查更新永远失败"，而用户只会以为是网络问题。
 *   若将来换了发布仓库，改 `GITHUB_REPO` 这一行即可（没有第二处引用字符串）。
 *
 *   ⚠️ 已核实（匿名调 API，2026-10）：`https://api.github.com/repos/observer130/hexbox`
 *   返回 200 且 `private: false` → 仓库**公开**，不需要 token 就能读 Release；
 *   而 `/releases/latest` 目前返回 **404 = 还没有发布过任何 Release**
 *   （见 update-flow 的 404 分支：会明确告诉用户"这个仓库还没有发布版本"）。
 *
 * ── 为什么允许用环境变量改 API 根 ────────────────────────────────────────
 *   `HEXBOX_UPDATE_API_BASE` 是**自测钩子**：把请求指到本机的桩服务上，
 *   就能在不依赖 GitHub、也不真的下载 77 MB 安装包的前提下，跑通
 *   "检查 → 判定 → 弹窗 → 下载 → 校验"整条链路（见 debug/verify-update.ps1）。
 *   正常用户不会设它，默认值就是 GitHub 官方 API。
 */

/**
 * GitHub 仓库 slug（`owner/name`）。
 *
 * 来源：本仓库的 git remote（见文件头）。**这是唯一一处写死 slug 的地方**。
 */
export const GITHUB_REPO = 'observer130/hexbox';

/** GitHub 官方 API 根（`HEXBOX_UPDATE_API_BASE` 可覆盖，仅自测/排查用）。 */
export function updateApiBase(): string {
  const override = (process.env['HEXBOX_UPDATE_API_BASE'] ?? '').trim().replace(/\/+$/, '');
  return override === '' ? 'https://api.github.com' : override;
}

/** 最新正式发布（GitHub 语义：**不含 draft 与 prerelease**）。 */
export function latestReleaseApiUrl(repo: string = GITHUB_REPO): string {
  return `${updateApiBase()}/repos/${repo}/releases/latest`;
}

/** 发布页（**失败路径里的手动下载链接**；用户点"打开下载页"就到这里）。 */
export function releasesPageUrl(repo: string = GITHUB_REPO): string {
  return `https://github.com/${repo}/releases/latest`;
}

/**
 * 可选的 GitHub token（`HEXBOX_GITHUB_TOKEN`）。
 *
 * 公开仓库**不需要**它；留着是为了两种情况：仓库哪天转私有、或匿名限流
 * （GitHub 匿名 60 次/小时/IP，本项目一次检查只发 1 个请求，正常够用）。
 */
export function githubToken(): string {
  return (process.env['HEXBOX_GITHUB_TOKEN'] ?? '').trim();
}

/**
 * 查版本这一步的超时。
 *
 * ⚠️ 国内网络访问 GitHub 常常很慢甚至完全不通，**必须有上限**：
 * 没有超时的话用户点一下"检查更新"，托盘就永远停在"正在检查更新…"
 * （那比"失败并说清楚"糟得多）。
 */
export const UPDATE_API_TIMEOUT_MS = 15_000;

/** 下载安装包的超时（77 MB，慢网也要给足；但不允许无限挂着）。 */
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
