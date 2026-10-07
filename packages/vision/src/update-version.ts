/**
 * 版本号比较（纯函数，可单测）—— 「检查更新」的**判据**
 *
 * ── 为什么必须自己做、而且必须是纯函数 ─────────────────────────────────
 *   · 主进程（Electron）在 CI 里跑不起来，`app.getVersion()` 与 GitHub Release
 *     的 tag 只有在这里比较才能被测试覆盖；
 *   · 判据错了两个方向都很难看：**漏更新**（告诉用户"已是最新"）与
 *     **假更新**（提示一个其实更旧的版本，用户装了旧版）。
 *
 * ── 支持的形态（都是真实会遇到的东西）──────────────────────────────────
 *   · `0.1.0` / `v0.1.0`（发布 tag 惯例带 `v`）
 *   · `1.2` / `1`（位数不齐：缺的位按 0 补，`1.2` == `1.2.0`）
 *   · `1.0.0-beta.1` / `1.0.0-rc.2`（预发布：**比同号正式版小**，按 semver 规则）
 *   · `1.0.0+build.5`（构建元数据：**不参与比较**，semver 明说）
 *   · 非法（`latest` / 空串 / `1.2.3.4`）→ `null`，调用方按"不提示更新"处理
 *     （失败要偏向**不打扰用户**，而不是提示装一个来路不明的版本）
 */

/** 解析结果（`text` 是去掉 `v` 与构建元数据的原文，日志/对比用）。 */
export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** 预发布标识：`1.0.0-beta.1` → `['beta','1']`；没有就是空数组。 */
  readonly prerelease: readonly string[];
  /** 规范化后的三段数字（日志用，例：`1.2.0`）。 */
  readonly text: string;
}

/**
 * 版本号正则：`v?` + 1~3 段数字 + 可选 `-预发布` + 可选 `+构建`。
 *
 * ⚠️ 刻意**不接受 4 段**（`1.2.3.4`）：那不是 semver，GitHub 上出现它基本意味着
 * 发布流程出了问题，宁可判非法（= 不提示更新）也不要瞎比较。
 */
const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** 字符串 → 版本；非法返回 `null`。 */
export function parseVersion(raw: string | null | undefined): ParsedVersion | null {
  const text = (raw ?? '').trim();
  if (text === '') return null;
  const m = VERSION_RE.exec(text);
  if (m === null) return null;
  const major = Number(m[1]);
  const minor = m[2] === undefined ? 0 : Number(m[2]);
  const patch = m[3] === undefined ? 0 : Number(m[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  const pre = m[4];
  return {
    major,
    minor,
    patch,
    prerelease: pre === undefined ? [] : pre.split('.').filter((s) => s !== ''),
    text: `${major}.${minor}.${patch}${pre === undefined ? '' : `-${pre}`}`,
  };
}

/** 预发布标识比较（semver §11）：数字段 < 字母段；逐段比；段少者小。 */
function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  // 有预发布 < 没有预发布（1.0.0-beta < 1.0.0）
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1; // 前缀更短 = 更小（1.0.0-beta < 1.0.0-beta.1）
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
      continue;
    }
    if (xNum) return -1; // 数字段优先于字母段
    if (yNum) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 比较两个版本：`a > b` → `1`，相等 → `0`，`a < b` → `-1`；
 * **任一非法 → `null`**（调用方必须显式处理，不许把 null 当 0）。
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return null;
  for (const [x, y] of [
    [pa.major, pb.major],
    [pa.minor, pb.minor],
    [pa.patch, pb.patch],
  ] as const) {
    if (x !== y) return x < y ? -1 : 1;
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** `candidate` 是否比 `current` 新（非法输入 → `false`：失败偏向不打扰用户）。 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const c = compareVersions(candidate, current);
  return c !== null && c > 0;
}

/** 展示用：确保 `v` 前缀（用户原话是"检测到版本 vx.x.x"）。 */
export function withVPrefix(raw: string): string {
  const text = raw.trim();
  if (text === '') return 'v?';
  return /^v/i.test(text) ? `v${text.slice(1)}` : `v${text}`;
}

/**
 * 用户点名要的那句话（**逐字**）。
 *
 * ⚠️ 单独抽出来是为了让自测能把它打进日志：对话框里的文案没法在 CI 里断言，
 * 而"文案是否逐字符合用户要求"恰恰是这次改动最容易被后续重构改坏的地方。
 */
export function formatUpdatePrompt(latestTag: string): string {
  return `检测到版本 ${withVPrefix(latestTag)}，是否下载更新？`;
}

/** 「没有更新」的反馈文案。 */
export function formatUpToDateText(currentVersion: string): string {
  return `已是最新版本 ${withVPrefix(currentVersion)}`;
}
