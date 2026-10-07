/**
 * 「检查更新」的完整流程：查版本 → 判定 → 弹窗 → 下载 → 交给安装程序
 *
 * ── 交互（**严格照用户要求**，别自作主张加"自动检查/静默更新"）─────────────
 *   ① **只在用户点托盘菜单的「检查更新」时联网**（启动时不联网、不后台轮询）；
 *   ② 点完之后菜单项立刻变成"正在检查更新…"（disable）—— "点了没反应"是最糟的体验；
 *   ③ 没有更新 → 弹窗 `已是最新版本 vX.Y.Z`（明确反馈，不是静默）；
 *   ④ 有更新   → 弹窗 **`检测到版本 vX.Y.Z，是否下载更新？`**（用户原话逐字，
 *      见 `formatUpdatePrompt()` 的单测），按钮 `确认` / `取消`；
 *   ⑤ 点「确认」→ 下载安装包到临时目录（菜单项显示百分比进度 + 气泡），
 *      校验大小/哈希后 `shell.openPath()` 启动安装程序，剩下交给用户走安装流程；
 *   ⑥ 点「取消」/ 直接关掉窗口 → **什么都不做**；
 *   ⑦ 任何失败 → 弹窗给**人话原因 + 手动下载页按钮**（绝不留"点了没反应"）。
 *
 * ── 为什么是"下载安装包 + 启动它"，而不是 `electron-updater` 一键更新 ────────
 *   我们的发布形态是 **NSIS 安装版 + 便携版 + 无代码签名**：
 *     · `electron-updater` 要求每次发布额外带 electron-builder 生成的 `latest.yml`，
 *       并新增依赖 + `publish` 配置；它对 **NSIS 安装版**能做一键下载安装，
 *       但**便携版根本不支持自助更新**（没有可覆盖的安装目录）；
 *     · 自己走 GitHub API 没有任何新依赖，对**两种形态是同一条路**：
 *       下载官方 `hexbox-setup-*.exe` 并启动它（便携版用户装一次即可，行为明确）；
 *       代价是**没有静默/一键体验** —— 用户要自己点两下安装向导。
 *   结论：选**自己走 GitHub API**（理由与代价见 docs/RELEASE-WINDOWS.md §发布与更新）。
 *
 * ── 已知代价（如实写在这里）────────────────────────────────────────────
 *   · **国内网络**：`api.github.com` 与 `objects.githubusercontent.com` 都可能很慢/被墙。
 *     所以① 查版本 15 s、下载 30 min 都有超时；② 失败一定给手动下载页；
 *     ③ 请求走 Electron 的 `net.fetch()`（= Chromium 网络栈，**跟随系统代理**），
 *        用户开着代理时比 Node 的 fetch 更容易通。
 *   · **没有代码签名**：安装包/程序是"未知发布者"，SmartScreen 会拦一次
 *     （见 docs/RELEASE-WINDOWS.md §代码签名）。更新包里我们没有额外的签名可校验，
 *     只能校验**传输完整性**（字节数 + GitHub 提供的 sha256，见下）。
 *   · **管理员权限**：本程序以管理员运行，安装包会由管理员进程启动 →
 *     安装程序会要求关闭正在运行的 hexbox（NSIS 会提示），这一步由用户确认。
 */

import { app, dialog, net, shell } from 'electron';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';

import {
  UPDATE_PHASE_IDLE,
  clipText,
  decideUpdate,
  formatBytes,
  formatUpToDateText,
  formatUpdatePrompt,
  updateMenuText,
  type ReleaseAsset,
  type UpdateDecision,
  type UpdatePhase,
  type UpdateSelfTestMode,
} from '@hexbox/vision';

import {
  GITHUB_REPO,
  UPDATE_API_TIMEOUT_MS,
  UPDATE_DOWNLOAD_TIMEOUT_MS,
  githubToken,
  latestReleaseApiUrl,
  releasesPageUrl,
} from './update-config.ts';

/** 下载目录（临时目录下的固定子目录；每次下载前重写同名文件）。 */
const DOWNLOAD_SUBDIR = 'hexbox-update';

/** 发布说明在弹窗里最多给这么多字（GitHub 的 body 可能几万字）。 */
const NOTES_MAX_CHARS = 400;

export interface UpdateFlowDeps {
  /** 当前版本：`app.getVersion()`（打包后就是 package.json 的 version）。 */
  readonly currentVersion: () => string;
  /** 阶段变化 → 重建托盘菜单（文案里带着"正在检查/正在下载 x%"）。 */
  readonly onPhaseChange: () => void;
  /** 托盘气泡（拿不到托盘时返回 false；**不是**错误）。 */
  readonly notify: (title: string, content: string) => void;
  /** 自测结束时走**唯一**的退出入口（`quitApp`）。 */
  readonly quit: (reason: string) => void;
}

export interface UpdateFlow {
  /** 当前阶段（托盘菜单项文案/可点性读它）。 */
  phase(): UpdatePhase;
  /** 用户点「检查更新」（正式路径；内部自带并发保护）。 */
  check(): void;
  /** 自测：按档位跑一次检查（见 vision 的 `UpdateSelfTestMode`）。 */
  runSelfTest(mode: UpdateSelfTestMode): void;
}

export function createUpdateFlow(deps: UpdateFlowDeps): UpdateFlow {
  let phase: UpdatePhase = UPDATE_PHASE_IDLE;
  /** 并发闸门：一次只允许一个"检查/下载"在进行（菜单在此期间也是 disabled）。 */
  let running = false;

  const setPhase = (next: UpdatePhase): void => {
    phase = next;
    if (next.kind !== 'idle') console.log(`[hexbox] 检查更新：${updateMenuText(next)}`);
    deps.onPhaseChange();
  };

  /** 请求头：GitHub API 要求 User-Agent；token 只发给 api.github.com（不跟去 CDN）。 */
  const headersFor = (url: string): Record<string, string> => {
    const headers: Record<string, string> = {
      'User-Agent': `hexbox/${deps.currentVersion()} (+https://github.com/${GITHUB_REPO})`,
      Accept: 'application/vnd.github+json',
    };
    const token = githubToken();
    if (token !== '' && url.includes('api.github.com')) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  };

  /** 网络失败的人话（国内网络最常见的三种，逐条给出可操作的建议）。 */
  const networkHint = (e: unknown): string => {
    const msg = e instanceof Error ? e.message : String(e);
    const timeout = /abort|timeout/i.test(msg);
    return [
      timeout
        ? `连接 GitHub 超时（>${Math.round(UPDATE_API_TIMEOUT_MS / 1000)} 秒）`
        : `连接 GitHub 失败：${msg}`,
      '常见原因：国内网络访问 GitHub 不稳定 / 系统代理未开启 / 公司网络限制。',
      '可以先在浏览器里打开下面的下载页确认网络是否可达。',
    ].join('\n');
  };

  /** 信息弹窗（"已是最新版本"这类）。 */
  const infoDialog = async (message: string, detail: string): Promise<void> => {
    console.log(`[hexbox] 检查更新：弹窗（信息）「${message}」`);
    await dialog.showMessageBox({
      type: 'info',
      title: 'hexbox 检查更新',
      message,
      detail,
      buttons: ['确定'],
      defaultId: 0,
      noLink: true,
    });
  };

  /** 失败弹窗：**必须带手动下载链接**（用户原话：失败要有明确错误与手动下载链接）。 */
  const errorDialog = async (detail: string, url: string): Promise<void> => {
    const buttons = url === '' ? ['关闭'] : ['打开下载页', '关闭'];
    console.log(`[hexbox] 检查更新：弹窗（失败）\n${detail}\n手动下载页：${url === '' ? '（无）' : url}`);
    const r = await dialog.showMessageBox({
      type: 'warning',
      title: 'hexbox 检查更新',
      message: '检查更新失败',
      detail: url === '' ? detail : `${detail}\n\n手动下载页：${url}`,
      buttons,
      defaultId: buttons.length - 1,
      cancelId: buttons.length - 1,
      noLink: true,
    });
    if (url !== '' && r.response === 0) {
      // ⚠️ Electron 33 的 openExternal 返回 Promise<void>（不是旧版的错误字符串）
      await shell.openExternal(url).catch((e: unknown) => {
        console.warn(`[hexbox] ⚠ 打开下载页失败：${e instanceof Error ? e.message : String(e)}`);
      });
    }
  };

  /** "有更新"的确认弹窗：**按钮就是用户说的 确认 / 取消**，返回是否点了确认。 */
  const confirmDialog = async (d: Extract<UpdateDecision, { kind: 'update' }>): Promise<boolean> => {
    const detail = [
      `当前版本 v${d.current} → 最新版本 v${d.latest}`,
      `安装包：${d.asset.name}（${formatBytes(d.asset.size)}）`,
      d.htmlUrl === '' ? '' : `发布页：${d.htmlUrl}`,
      d.notes.trim() === '' ? '' : `\n发布说明：\n${clipText(d.notes, NOTES_MAX_CHARS)}`,
    ]
      .filter((line) => line !== '')
      .join('\n');
    // ⚠️ message 必须逐字是用户那句（`formatUpdatePrompt` 有单测锁住）
    const message = formatUpdatePrompt(d.tag);
    console.log(`[hexbox] 检查更新：弹窗（确认）「${message}」\n${detail}`);
    const r = await dialog.showMessageBox({
      type: 'question',
      title: 'hexbox 有新版本',
      message,
      detail,
      buttons: ['确认', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    console.log(`[hexbox] 检查更新：用户在确认弹窗里选了「${r.response === 0 ? '确认' : '取消'}」`);
    return r.response === 0;
  };

  /**
   * 下载一个资产到临时目录，边下边算 sha256。
   *
   * 校验（能校验的都校验，但**不假装**校验了签名）：
   *   · 字节数必须与发布里声明的一致（`asset.size > 0` 时）；
   *   · GitHub 若给了 `digest = sha256:<hex>`（2025 之后的发布才有），必须一致；
   *     没给就把实测 sha256 打进日志，供人工比对。
   */
  const downloadAsset = async (
    asset: ReleaseAsset,
    onProgress: (percent: number | null) => void,
    selfTest: boolean,
  ): Promise<string> => {
    const dir = selfTest
      ? join(app.getPath('temp'), DOWNLOAD_SUBDIR, 'selftest')
      : join(app.getPath('temp'), DOWNLOAD_SUBDIR);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, asset.name);
    rmSync(dest, { force: true });

    console.log(
      `[hexbox] 检查更新：开始下载 ${asset.name}（${formatBytes(asset.size)}）\n` +
        `         URL=${asset.url}\n         落盘=${dest}`,
    );
    const res = await net.fetch(asset.url, {
      redirect: 'follow', // GitHub 资产会 302 到 objects.githubusercontent.com
      headers: headersFor(asset.url),
      signal: AbortSignal.timeout(UPDATE_DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}`);
    const body = res.body;
    if (body === null) throw new Error('下载失败：响应没有正文（body=null）');

    const reader = body.getReader();
    const out = createWriteStream(dest);
    const hash = createHash('sha256');
    let received = 0;
    let lastPercent = -1;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        received += value.byteLength;
        hash.update(value);
        if (!out.write(value)) await once(out, 'drain');
        const percent = asset.size > 0 ? Math.min(100, Math.floor((received / asset.size) * 100)) : null;
        if (percent !== null && percent >= lastPercent + 5) {
          lastPercent = percent;
          onProgress(percent);
          console.log(`[hexbox] 检查更新：已下载 ${percent}%（${formatBytes(received)}）`);
        }
      }
    } catch (e) {
      // ⚠️ Windows 上文件被打开时删不掉：先 destroy() 再等 close 事件，最后才删
      out.destroy();
      await new Promise<void>((resolve) => out.once('close', () => resolve()));
      rmSync(dest, { force: true });
      throw e;
    }
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve());
      out.on('error', reject);
    });

    const sha256 = hash.digest('hex');
    if (asset.size > 0 && received !== asset.size) {
      rmSync(dest, { force: true });
      throw new Error(`下载不完整：声明 ${asset.size} 字节，实际 ${received} 字节（已删除残留文件）`);
    }
    if (asset.digest.startsWith('sha256:')) {
      const expected = asset.digest.slice('sha256:'.length).trim().toLowerCase();
      if (expected !== sha256) {
        rmSync(dest, { force: true });
        throw new Error(`校验失败：发布声明的 sha256=${expected}，实际=${sha256}（已删除该文件）`);
      }
      console.log(`[hexbox] 检查更新：sha256 校验通过（${sha256}）`);
    } else {
      console.log(
        `[hexbox] 检查更新：发布未提供 digest → 只校验了字节数（${received}）；` +
          `实测 sha256=${sha256}（可人工比对）`,
      );
    }
    onProgress(100);
    return dest;
  };

  const downloadAndInstall = async (
    d: Extract<UpdateDecision, { kind: 'update' }>,
    selfTest: boolean,
  ): Promise<void> => {
    setPhase({ kind: 'downloading', percent: null });
    deps.notify(
      '正在下载更新',
      `hexbox v${d.latest}（${formatBytes(d.asset.size)}）—— 下载完成后会启动安装程序`,
    );
    const dest = await downloadAsset(
      d.asset,
      (percent) => setPhase({ kind: 'downloading', percent }),
      selfTest,
    );
    console.log(`[hexbox] 检查更新：下载完成 → ${dest}`);

    if (selfTest) {
      // 自测**绝不能**真的启动安装程序（下的是桩资产，且会弹 UAC/改系统）
      console.log('[hexbox] 自测：已跳过「启动安装程序」这一步（正常路径这里会 shell.openPath）');
      return;
    }

    setPhase({ kind: 'installing' });
    const err = await shell.openPath(dest);
    if (err !== '') {
      console.error(`[hexbox] ⚠ 启动安装程序失败：${err}`);
      await errorDialog(
        `安装包已下载到：\n${dest}\n\n但启动它失败了：${err}\n可以手动双击上面这个文件安装。`,
        d.htmlUrl === '' ? releasesPageUrl() : d.htmlUrl,
      );
      return;
    }
    console.log(`[hexbox] 检查更新：已启动安装程序 ${dest}`);
    deps.notify(
      '更新已下载',
      '安装程序已启动，按向导完成安装即可（安装时可能需要关闭正在运行的 hexbox）。',
    );
  };

  const run = async (options: { readonly selfTest: UpdateSelfTestMode | null }): Promise<void> => {
    const selfTest = options.selfTest;
    const current = deps.currentVersion();
    setPhase({ kind: 'checking' });
    try {
      const url = latestReleaseApiUrl();
      console.log(
        `[hexbox] 检查更新：GET ${url}\n` +
          `         当前版本 v${current}${selfTest === null ? '' : `（自测档位 ${selfTest}）`}`,
      );
      let decision: UpdateDecision;
      try {
        const res = await net.fetch(url, {
          redirect: 'follow',
          headers: headersFor(url),
          signal: AbortSignal.timeout(UPDATE_API_TIMEOUT_MS),
        });
        console.log(`[hexbox] 检查更新：HTTP ${res.status} ${res.statusText}`);
        if (res.status === 404) {
          // ⚠️ 两种含义都要说：还没发过 Release，**或**仓库是私有的（匿名读不到）。
          decision = {
            kind: 'error',
            reason: 'release-unreadable',
            detail:
              `读不到 ${GITHUB_REPO} 的最新 Release（HTTP 404）。\n` +
              '可能原因：这个仓库还没有发布过任何 Release，或者它是私有仓库（匿名读不到）。',
            htmlUrl: releasesPageUrl(),
          };
        } else if (!res.ok) {
          decision = {
            kind: 'error',
            reason: 'network',
            detail: `GitHub 返回 HTTP ${res.status} ${res.statusText}。`,
            htmlUrl: releasesPageUrl(),
          };
        } else {
          decision = decideUpdate(current, await res.json());
        }
      } catch (e) {
        decision = { kind: 'error', reason: 'network', detail: networkHint(e), htmlUrl: releasesPageUrl() };
      }

      console.log(`[hexbox] 检查更新：结论 kind=${decision.kind}`);
      if (selfTest !== null) {
        // 自测把"用户会看到什么"原样打进日志：弹窗文案没法在 CI 里断言，
        // 而它恰恰是用户点名要求逐字的部分。
        const preview =
          decision.kind === 'up-to-date'
            ? `弹窗 message = ${formatUpToDateText(decision.current)}`
            : decision.kind === 'update'
              ? `弹窗 message = ${formatUpdatePrompt(decision.tag)}（按钮：确认 / 取消）；安装包 = ${decision.asset.name}（${formatBytes(decision.asset.size)}）`
              : `弹窗 message = 检查更新失败（${decision.reason}）；detail 首行 = ${decision.detail.split('\n')[0] ?? ''}`;
        console.log(`[hexbox] 自测：${preview}`);
      }

      if (decision.kind === 'up-to-date') {
        await infoDialog(
          formatUpToDateText(decision.current),
          `当前版本 v${decision.current}，GitHub 上最新的正式发布是 v${decision.latest}。`,
        );
        return;
      }
      if (decision.kind === 'error') {
        await errorDialog(decision.detail, decision.htmlUrl);
        return;
      }

      const confirmed = selfTest === 'download' ? true : await confirmDialog(decision);
      if (selfTest === 'download') {
        console.log('[hexbox] 自测：自动确认（download 档）→ 跳过确认弹窗，直接走下载');
      }
      if (!confirmed) {
        console.log('[hexbox] 检查更新：用户取消（不做任何事）');
        return;
      }
      await downloadAndInstall(decision, selfTest !== null);
    } catch (e) {
      // 兜底：任何没预料到的异常都要变成人话，绝不让"点了没反应"
      const detail = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
      console.error(`[hexbox] ⚠ 检查更新异常：${detail}`);
      await errorDialog(`检查更新时发生异常：\n${detail}`, releasesPageUrl());
    } finally {
      running = false;
      setPhase(UPDATE_PHASE_IDLE);
    }
  };

  return {
    phase: () => phase,
    check: () => {
      if (running) {
        console.log('[hexbox] 检查更新：已经有一次检查/下载在进行 → 忽略这次点击');
        return;
      }
      running = true;
      void run({ selfTest: null });
    },
    runSelfTest: (mode) => {
      if (running) {
        console.log(`[hexbox] 自测：已有检查/下载在进行 → 跳过（档位 ${mode}）`);
        return;
      }
      running = true;
      void run({ selfTest: mode }).then(
        () => deps.quit(`自测：检查更新（${mode}）结束`),
        (e: unknown) => {
          console.error(`[hexbox] ⚠ 自测（检查更新）异常：${e instanceof Error ? e.message : String(e)}`);
          deps.quit(`自测：检查更新（${mode}）异常结束`);
        },
      );
    },
  };
}
