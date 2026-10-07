/**
 * 「检查更新」的**判据**：GitHub Release 响应 → 用户可见的结论（纯函数，可单测）
 *
 * ── 分工（别把网络逻辑塞进来）──────────────────────────────────────────
 *   · 这里只做三件事：**解析**发布 JSON → **挑出安装包资产** → **判定**要不要提示更新；
 *   · 真正的 HTTP、下载、落盘、弹窗都在 `apps/overlay/src/main/update-flow.ts`
 *     （那部分在 CI 里跑不起来，所以判据必须留在这里）。
 *
 * ── 为什么不用 `electron-updater`（决策，见 docs/RELEASE-WINDOWS.md）────────
 *   我们的发布形态是"NSIS 安装版 + 便携版 + 无代码签名"，而 `electron-updater`
 *   需要 `publish` 配置与每次发布附带的 `latest.yml`，且**便携版无法自助更新**。
 *   所以走 GitHub REST：`/repos/{owner}/{repo}/releases/latest` → 判定 →
 *   下载 `hexbox-setup-*.exe` → 交给用户走安装流程（两种形态都能用，见 update-flow）。
 *
 * ── 资产命名依赖 electron-builder.yml 的 `artifactName` ──────────────────
 *   nsis:     `hexbox-setup-${version}-${arch}.exe`
 *   portable: `hexbox-portable-${version}-${arch}.exe`
 *   更新只认**安装版**（便携版没有可被覆盖的安装目录，装一次反而更简单）。
 */

import { isNewerVersion, parseVersion, withVPrefix } from './update-version.ts';

/** 发布里的一个附件（只保留更新用得到的字段）。 */
export interface ReleaseAsset {
  readonly name: string;
  /** 直接下载地址（`browser_download_url`；GitHub 会 302 到 objects.githubusercontent.com）。 */
  readonly url: string;
  readonly size: number;
  /** GitHub 在 2025 起会带 `sha256:<hex>`；老资产是空串（那时只记大小 + 实测哈希）。 */
  readonly digest: string;
}

/** 解析后的一次发布。 */
export interface ReleaseInfo {
  readonly tag: string;
  readonly name: string;
  readonly htmlUrl: string;
  /** 发布说明（GitHub 的 `body`）。 */
  readonly notes: string;
  readonly prerelease: boolean;
  readonly draft: boolean;
  readonly assets: readonly ReleaseAsset[];
}

/** 安装版资产（更新只下它）。 */
export const INSTALLER_ASSET_RE = /^hexbox-setup-.*\.exe$/i;
/** 优先带 `-x64`（本项目的发布形态只有 x64）。 */
const INSTALLER_X64_RE = /^hexbox-setup-.*-x64\.exe$/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown): boolean {
  return value === true;
}

/**
 * GitHub `/releases/latest` 的响应 → `ReleaseInfo`。
 *
 * 缺 `tag_name` → `null`（**不是**空 tag）：调用方必须能区分
 * "这是一次发布但读不懂" 与 "有一版 v0.2.0"。
 */
export function readReleaseInfo(json: unknown): ReleaseInfo | null {
  const root = asRecord(json);
  if (root === null) return null;
  const tag = asText(root['tag_name']).trim();
  if (tag === '') return null;

  const rawAssets = root['assets'];
  const assets: ReleaseAsset[] = [];
  if (Array.isArray(rawAssets)) {
    for (const item of rawAssets) {
      const a = asRecord(item);
      if (a === null) continue;
      const name = asText(a['name']).trim();
      const url = asText(a['browser_download_url']).trim();
      if (name === '' || url === '') continue;
      const size = typeof a['size'] === 'number' && Number.isFinite(a['size']) ? a['size'] : 0;
      assets.push({ name, url, size, digest: asText(a['digest']).trim() });
    }
  }

  return {
    tag,
    name: asText(root['name']),
    htmlUrl: asText(root['html_url']),
    notes: asText(root['body']),
    prerelease: asBool(root['prerelease']),
    draft: asBool(root['draft']),
    assets,
  };
}

/** 从资产里挑安装版（优先 `-x64`；挑不到 → `null`）。 */
export function pickInstallerAsset(assets: readonly ReleaseAsset[]): ReleaseAsset | null {
  const installers = assets.filter((a) => INSTALLER_ASSET_RE.test(a.name));
  return installers.find((a) => INSTALLER_X64_RE.test(a.name)) ?? installers[0] ?? null;
}

/** 结论为什么会是"错误"（自测/日志要能分辨，不要一句"失败了"）。 */
export type UpdateErrorReason =
  /** 响应不是一次发布 / 没有 tag_name。 */
  | 'release-unreadable'
  /** tag 不是版本号（例如 `nightly`）。 */
  | 'tag-unparseable'
  /** `app.getVersion()` 读出来的不是版本号（打包配置坏了）。 */
  | 'current-unparseable'
  /** 有新版本，但这次发布里没有 `hexbox-setup-*.exe`。 */
  | 'no-installer-asset'
  /** 网络/HTTP 失败（由 update-flow 构造）。 */
  | 'network';

export type UpdateDecision =
  | {
      readonly kind: 'up-to-date';
      readonly current: string;
      readonly latest: string;
      readonly tag: string;
      readonly htmlUrl: string;
    }
  | {
      readonly kind: 'update';
      readonly current: string;
      readonly latest: string;
      readonly tag: string;
      readonly htmlUrl: string;
      readonly notes: string;
      readonly asset: ReleaseAsset;
    }
  | {
      readonly kind: 'error';
      readonly reason: UpdateErrorReason;
      /** 人话（弹窗 detail 直接用；**不抛异常**）。 */
      readonly detail: string;
      /** 手动下载页（拿不到就是空串）。 */
      readonly htmlUrl: string;
    };

/**
 * 核心判定：当前版本 + 发布 JSON → 结论。
 *
 * 不变式（都有单测）：
 *   · 非法的当前版本 / 非法 tag → `error`（**绝不**判成"有更新"）；
 *   · tag 不比当前新 → `up-to-date`；
 *   · 有新版本但没有安装包资产 → `error:no-installer-asset`
 *     （**不是** `update`：让用户点了"确认"才发现下不了，比直接说清楚更糟）。
 */
export function decideUpdate(currentVersion: string, json: unknown): UpdateDecision {
  const current = parseVersion(currentVersion);
  if (current === null) {
    return {
      kind: 'error',
      reason: 'current-unparseable',
      detail: `本程序的版本号读不出来（app.getVersion() = ${JSON.stringify(currentVersion)}），无法比较`,
      htmlUrl: '',
    };
  }

  const release = readReleaseInfo(json);
  if (release === null) {
    return {
      kind: 'error',
      reason: 'release-unreadable',
      detail: 'GitHub 返回的内容不是一次可识别的发布（没有 tag_name）—— 可能不是发布接口的响应',
      htmlUrl: '',
    };
  }

  if (parseVersion(release.tag) === null) {
    return {
      kind: 'error',
      reason: 'tag-unparseable',
      detail: `发布的 tag「${release.tag}」不是版本号，无法比较`,
      htmlUrl: release.htmlUrl,
    };
  }

  if (!isNewerVersion(release.tag, currentVersion)) {
    return {
      kind: 'up-to-date',
      current: current.text,
      latest: parseVersion(release.tag)?.text ?? release.tag,
      tag: release.tag,
      htmlUrl: release.htmlUrl,
    };
  }

  const latest = parseVersion(release.tag)?.text ?? release.tag;
  const asset = pickInstallerAsset(release.assets);
  if (asset === null) {
    return {
      kind: 'error',
      reason: 'no-installer-asset',
      detail:
        `检测到新版本 ${withVPrefix(latest)}，但这次发布里没有安装包` +
        `（${INSTALLER_ASSET_RE.source}）—— 请到发布页手动下载`,
      htmlUrl: release.htmlUrl,
    };
  }

  return {
    kind: 'update',
    current: current.text,
    latest,
    tag: release.tag,
    htmlUrl: release.htmlUrl,
    notes: release.notes,
    asset,
  };
}

/* ------------------------------------------------------------------ */
/* 菜单项与体积文案（同样纯函数：菜单文案漂移必须被测试挡住）                */
/* ------------------------------------------------------------------ */

/**
 * 「检查更新」菜单项的当前阶段。
 *
 * 用户点完之后**必须马上有反馈**（"点了没反应"是最糟的体验），所以这几档直接
 * 写进菜单文案本身 —— 菜单本来就是用户刚点过的地方。
 */
export type UpdatePhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'downloading'; readonly percent: number | null }
  | { readonly kind: 'installing' };

/** 空闲态（唯一可点的阶段）。 */
export const UPDATE_PHASE_IDLE: UpdatePhase = { kind: 'idle' };

/** 阶段 → 菜单项文案。 */
export function updateMenuText(phase: UpdatePhase): string {
  switch (phase.kind) {
    case 'idle':
      return '检查更新';
    case 'checking':
      return '正在检查更新…';
    case 'downloading':
      return phase.percent === null ? '正在下载更新…' : `正在下载更新… ${phase.percent}%`;
    case 'installing':
      return '正在启动安装程序…';
  }
}

/** 只有空闲态能点（避免并发检查/重复下载）。 */
export function updateMenuEnabled(phase: UpdatePhase): boolean {
  return phase.kind === 'idle';
}

/** 字节数 → 人话（`81000263` → `77.2 MB`）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '大小未知';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 截断长文本（发布说明可能几万字，弹窗里只给一段）。 */
export function clipText(text: string, maxChars: number): string {
  const t = text.trim();
  if (maxChars <= 0 || t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}…（完整发布说明见发布页）`;
}

/* ------------------------------------------------------------------ */
/* 自测开关（`--update-check-test <mode>`）的值                          */
/* ------------------------------------------------------------------ */

/**
 * 「检查更新」的自测档位。
 *
 * ⚠️ 为什么值得放在纯函数里：真机上"有更新 / 没更新 / 断网"这三种前提都很难造，
 * 而**非法档位绝不能被静默当成默认档**（那样自测会"跑过了"却什么也没测）。
 *
 *   · `offline`   —— 网络失败路径（请求指向不可达地址）；
 *   · `up-to-date`—— 没有更新（`已是最新版本 vX.Y.Z`）；
 *   · `update`    —— 有更新（弹"检测到版本 vX.Y.Z，是否下载更新？"）；
 *   · `download`  —— 自动确认下载（**不启动安装程序**，用桩资产验证下载/校验）。
 */
export type UpdateSelfTestMode = 'offline' | 'up-to-date' | 'update' | 'download';

/** 解析自测档位（非法/空 → `null`，调用方必须显式报错而不是当成没设）。 */
export function parseUpdateSelfTestMode(raw: string | null | undefined): UpdateSelfTestMode | null {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'offline':
      return 'offline';
    case 'up-to-date':
    case 'uptodate':
      return 'up-to-date';
    case 'update':
      return 'update';
    case 'download':
      return 'download';
    default:
      return null;
  }
}
