/**
 * 应用内「更新数据」流程（主进程侧，唯一联网写入口）
 *
 * 职责边界：
 *   · 本文件只管**交互与生命周期**（确认框、阶段、取消、失败提示、写盘目录）；
 *   · 真正的拉取/合并/落盘在 `@hexbox/data-cli` 的 `runDefaultSync()`
 *     —— 与 `pnpm sync` **同一条流水线**，不另写一套；
 *   · 阶段文案与判据在 `@hexbox/vision` 的 `data-update-phase.ts`（纯函数、有单测）。
 *
 * 为什么写用户目录而不是安装目录：
 *   打包版的数据快照在 `…\resources\data`，属于安装包的一部分（升级/卸载会整个删掉）。
 *   更新必须写到 `%LOCALAPPDATA%\hexbox\data` —— `resolveDataDir()` 的优先级里
 *   它本来就高于安装目录快照，所以写完之后重启/重读即可生效，不需要管理员写安装目录。
 *
 * 启动检查（每天最多一次）：
 *   只问上游"现在最新统计日期是哪天"，**不下载数据**；有新日期才弹托盘气泡。
 *   这是用户明确要的折中：不会在后台偷偷拉几百个请求，但也不会永远不知道数据旧了。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  DATA_UPDATE_PHASE_IDLE,
  dataUpdateFailureHint,
  dataUpdatePromptText,
  dataUpdateResultText,
  formatStatDate,
  newDataNoticeText,
  type DataUpdatePhase,
  type DataUpdatePromptText,
} from '@hexbox/vision';
import {
  fetchLatestStatDate,
  isNewerDataDate,
  runDefaultSync,
  shouldCheckNow,
  type StatDateCheck,
  type SyncProgress,
  type SyncReport,
} from '@hexbox/data-cli';

/** 上次检查的落盘形状（坏文件按"没检查过"处理，不阻断启动）。 */
interface CheckState {
  readonly lastCheckAt?: string;
  readonly upstreamDate?: string | null;
}

/** 结果弹窗的载荷（Electron 的 `dialog.showMessageBox` 由调用方拼；本模块不 import electron）。 */
export interface DataUpdateDialogText {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
}

export interface DataUpdateFlowDeps {
  /** 数据写入目录：打包版 = `%LOCALAPPDATA%\hexbox\data`，开发版 = 仓库 `data/`。 */
  readonly dataDir: string;
  /** 检查节流状态的持久化文件（放用户目录，不污染安装目录）。 */
  readonly checkStatePath: string;
  /** 本地是否已经有可用的数据（没有 = 首次运行，要询问是否下载）。 */
  readonly hasLocalData: () => boolean;
  /** 本地当前官方统计日期（`YYYYMMDD`；没有则 null）。 */
  readonly localDate: () => string | null;
  /** 托盘气泡（没有托盘时返回 false，不是错误）。 */
  readonly notify: (title: string, content: string) => void;
  /** 阶段变化 → 重建托盘菜单。 */
  readonly onPhaseChange: () => void;
  /** 同步成功后重新读数据（dataset/rankings/builds + 托盘日期）。 */
  readonly reload: () => Promise<void>;
  /** 确认框（Electron `dialog` 由调用方注入 → 本模块可在 Node 里单测）。 */
  readonly confirmUpdate: (text: DataUpdatePromptText) => Promise<boolean>;
  /** 结果弹窗（成功/失败/取消三种；同样注入）。 */
  readonly showResult: (ok: boolean, text: DataUpdateDialogText) => Promise<void>;
  readonly now?: () => Date;
  /** 自测注入点：默认走 `runDefaultSync`（真实网络）。 */
  readonly runSync?: (options: {
    readonly storeRoot: string;
    readonly signal: AbortSignal;
    readonly onProgress: (progress: SyncProgress) => void;
  }) => Promise<SyncReport>;
  /** 自测注入点：默认走 `fetchLatestStatDate`（真实网络）。 */
  readonly checkUpstream?: () => Promise<StatDateCheck>;
}

export interface DataUpdateFlow {
  /** 当前阶段（托盘菜单文案/可点性读它）。 */
  phase(): DataUpdatePhase;
  /** 启动时调用一次：内部按 24h 节流，只做一次轻量探测。 */
  checkOnStartup(): void;
  /** 托盘点「更新数据」：确认后开始（内部自带并发保护）。 */
  update(): void;
  /** 取消进行中的同步（退出时必须调，否则 245 个请求会拖着进程）。 */
  cancel(reason: string): void;
}

/** 同步阶段 → 用户看得懂的一句话（进度文案的主语）。 */
function stageLabel(progress: SyncProgress): string {
  switch (progress.stage) {
    case 'static':
      return '拉取图鉴';
    case 'rankings':
      return '拉取排行榜';
    case 'details':
      return '单英雄详情';
    case 'templates':
      return '头像模板';
  }
}

/**
 * 阶段 → 菜单/日志用的进度计数。
 *
 * ⚠️ 只把**有意义的**计数往上报：图鉴/榜单是几个 provider，报 `1/2` 没有信息量，
 * 所以只有「详情（173 个英雄）」与「模板（245 个头像）」带 `done/total`。
 */
function progressCounts(
  progress: SyncProgress,
): { readonly done?: number; readonly total?: number } {
  if (progress.stage === 'details' && progress.done !== undefined && progress.total !== undefined) {
    return { done: progress.done, total: progress.total };
  }
  if (progress.stage === 'templates' && progress.done !== undefined && progress.total !== undefined) {
    return { done: progress.done, total: progress.total };
  }
  return {};
}

function stateText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createDataUpdateFlow(deps: DataUpdateFlowDeps): DataUpdateFlow {
  const now = deps.now ?? (() => new Date());
  let phase: DataUpdatePhase = DATA_UPDATE_PHASE_IDLE;
  /** 一次只允许一个同步（菜单在此期间是 disabled，这里再做一次兜底）。 */
  let syncing = false;
  let controller: AbortController | null = null;
  /** 上一次探测到的上游日期（确认框/失败提示里用；null = 没探到）。 */
  let upstreamDate: string | null = null;
  /** 启动检查与手动更新并发时的护栏。 */
  let checking = false;

  const setPhase = (next: DataUpdatePhase): void => {
    phase = next;
    deps.onPhaseChange();
  };

  const log = (line: string): void => console.log(`[hexbox] 数据更新：${line}`);

  /** 读节流状态；任何异常都当作"没检查过"（不能因为一个坏 JSON 就不让程序启动）。 */
  const readState = async (): Promise<CheckState> => {
    try {
      const raw = await readFile(deps.checkStatePath, 'utf8');
      const parsed = JSON.parse(raw) as CheckState;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };

  const writeState = async (state: CheckState): Promise<void> => {
    try {
      await mkdir(dirname(deps.checkStatePath), { recursive: true });
      await writeFile(deps.checkStatePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
      // 写不进去只影响"每天一次"的节流，不影响功能本身
      log(`⚠ 检查状态写不进去（${stateText(err)}）→ 下次启动可能再检查一次`);
    }
  };

  const checkOnStartup = (): void => {
    if (checking) return;
    checking = true;
    void (async () => {
      try {
        // 自测/冒烟模式不联网（否则 CI 与无网机器上的自测都会被网络拖慢）
        if (
          process.env['HEXBOX_SMOKE'] === '1' ||
          (process.env['HEXBOX_TRAY_AUTOTEST_MS'] ?? '0') !== '0'
        ) {
          log('自测/冒烟模式 → 跳过启动检查');
          return;
        }

        const state = await readState();

        // ── 首次运行：本地什么都没有（安装包不再内置数据）──────────────
        // **不弹确认框**：直接后台静默下载（用户 2026-11 要求：启动后自动更新）。
        if (!deps.hasLocalData()) {
          log(`首次运行：没有本地数据 → 后台自动下载到 ${deps.dataDir}`);
          const report = await runSync('auto');
          if (report?.ok) {
            await writeState({
              ...state,
              lastCheckAt: now().toISOString(),
              upstreamDate: report.dataDate,
            });
          }
          return;
        }

        if (process.env['HEXBOX_DATA_CHECK'] === '0') {
          log('启动检查已关闭（HEXBOX_DATA_CHECK=0）');
          return;
        }
        if (!shouldCheckNow(state.lastCheckAt, now())) {
          log(`今天已检查过（上次 ${state.lastCheckAt ?? '未知'}）→ 跳过`);
          upstreamDate = state.upstreamDate ?? null;
          return;
        }

        setPhase({ kind: 'checking' });
        log('开始检查官方统计日期…');
        const result = await (deps.checkUpstream?.() ?? fetchLatestStatDate({ timeoutMs: 8_000 }));
        upstreamDate = result.dataDate;
        // 无论成功失败都记时间：断网时不该每次启动都再打一遍上游
        await writeState({ lastCheckAt: now().toISOString(), upstreamDate: result.dataDate });

        if (result.dataDate === null) {
          log(`没探到上游日期（${result.error ?? '上游维护或无数据'}；试过 ${result.tried.join('/')}）`);
          return;
        }

        const local = deps.localDate();
        if (isNewerDataDate(result.dataDate, local)) {
          log(`发现新数据：上游 ${result.dataDate} / 本地 ${local ?? '未知'} → 后台自动更新`);
          await runSync('auto');
        } else {
          log(`已是最新（上游 ${result.dataDate} / 本地 ${local ?? '未知'}）`);
        }
      } catch (err) {
        log(`启动检查失败（${stateText(err)}）——不影响使用，可手动点「更新数据」`);
      } finally {
        checking = false;
        if (!syncing) setPhase(DATA_UPDATE_PHASE_IDLE);
      }
    })();
  };

  /** 确认框：开始 / 取消。返回用户是否点了开始。 */
  const confirmStart = async (): Promise<boolean> =>
    await deps.confirmUpdate(
      dataUpdatePromptText({
        localDate: deps.localDate(),
        upstreamDate,
        dataDir: deps.dataDir,
      }),
    );

  const runSync = async (mode: 'auto' | 'manual'): Promise<SyncReport | null> => {
    if (syncing) {
      log('已有同步在进行 → 忽略重复点击');
      return null;
    }
    syncing = true;
    controller = new AbortController();
    setPhase({ kind: 'syncing', label: '拉取图鉴' });
    log(`开始同步 → ${deps.dataDir}`);

    let report: SyncReport | null = null;
    let thrown: string | null = null;
    try {
      const run =
        deps.runSync ??
        ((options) =>
          runDefaultSync({
            storeRoot: options.storeRoot,
            signal: options.signal,
            onProgress: options.onProgress,
          }));
      report = await run({
        storeRoot: deps.dataDir,
        signal: controller.signal,
        onProgress: (progress) => {
          setPhase({
            kind: 'syncing',
            label: stageLabel(progress),
            ...progressCounts(progress),
          });
        },
      });
    } catch (err) {
      thrown = stateText(err);
    } finally {
      syncing = false;
      controller = null;
      setPhase(DATA_UPDATE_PHASE_IDLE);
    }

    if (thrown !== null) {
      log(`✗ 同步异常：${thrown}`);
      if (mode === 'auto') {
        deps.notify('hexbox 自动更新失败', '现有数据未被改动；可稍后从托盘「更新数据」重试');
      } else {
        await deps.showResult(false, {
          title: 'hexbox 数据更新',
          message: '更新失败',
          detail: [thrown, '', '现有数据未被改动。可以稍后再试。'].join('\n'),
        });
      }
      return null;
    }
    const r = report!;
    log(
      `结束：wrote=[${r.wrote.join(', ')}] failed=${r.failures.length} skipped=${r.skipped.length} ` +
        `统计日期=${r.dataDate || '未知'}${r.aborted ? '（已取消）' : ''}`,
    );

    if (r.ok) {
      // 先把新数据读进内存，再弹窗 —— 弹窗里说"已生效"必须是真的
      await deps.reload().catch((err: unknown) => {
        log(`⚠ 重新读取数据失败（${stateText(err)}）—— 重启程序后生效`);
      });
    }

    const text = dataUpdateResultText({
      ok: r.ok,
      aborted: r.aborted,
      wrote: r.wrote,
      failures: r.failures.map((f) => ({ label: f.label, message: f.message })),
      dataDate: r.dataDate,
      skipped: r.skipped.map((s) => s.reason),
    });
    // 失败时补一句"上游其实已经有更新"：区分"没数据"与"这次没拉到"
    const detail =
      !r.ok && !r.aborted
        ? `${text.detail}\n\n${dataUpdateFailureHint(deps.localDate(), upstreamDate)}`
        : text.detail;
    if (mode === 'auto') {
      // 后台静默：成功/失败都只用托盘气泡 + 日志，不弹模态框
      if (r.ok && !r.aborted) {
        deps.notify('hexbox 数据已更新', `统计日期 ${formatStatDate(r.dataDate) ?? '未知'}`);
      } else if (!r.aborted) {
        deps.notify('hexbox 自动更新失败', '现有数据未被改动；可稍后从托盘「更新数据」重试');
      }
      // 取消是用户主动行为：只记日志，不弹“失败”
      return r;
    }
    // 取消即使已经写了图鉴，也不是一次完整更新：弹窗按“警告”而不是“信息”展示
    await deps.showResult(r.ok && !r.aborted, {
      title: text.title,
      message: text.message,
      detail,
    });
    return r;
  };

  return {
    phase: () => phase,
    checkOnStartup,
    update: () => {
      if (syncing) {
        log('已有同步在进行 → 忽略重复点击');
        return;
      }
      void (async () => {
        try {
          if (!(await confirmStart())) {
            log('用户取消了更新');
            return;
          }
          await runSync('manual');
        } catch (err) {
          log(`✗ 更新流程异常：${stateText(err)}`);
        }
      })();
    },
    cancel: (reason: string) => {
      if (!syncing || controller === null) return;
      log(`收到取消（${reason}）→ 中止网络请求`);
      controller.abort();
    },
  };
}
