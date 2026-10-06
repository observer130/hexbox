/**
 * 常驻截屏流（主进程侧）
 *
 * 为什么不是"每次 `desktopCapturer.getSources`"：真机基准实测每次调用固定
 * 开销 ~0.5~1.0s（`debug/augment/bench.json`：window@16px 仍要 707ms），
 * 与像素量几乎无关；连续跑会把游戏帧率吃掉。所以改成：
 *
 *   1. 用 `setDisplayMediaRequestHandler` 把**屏幕源**交给隐藏渲染窗口；
 *   2. 渲染窗口 `getDisplayMedia` 一次，之后逐帧取图（每帧几毫秒）；
 *   3. 检测在渲染端做（纯函数），主进程只收一个小 JSON 并跑状态机。
 *
 * ⚠️ 隐藏窗口的两个坑（都做了处理，真机若出问题先查这里）：
 *   · **定时器节流**：不可见窗口的 `setInterval` 会被 Chromium 降到 ~1Hz
 *     → 必须 `backgroundThrottling: false`；
 *   · **不合成就不出帧**：窗口完全不可见时视频可能不解码 →
 *     若启动后 4 秒收不到任何帧，就把窗口"显示"出来但 **opacity 0**、
 *     移到工作区角落、鼠标穿透（用户看不见，但合成在跑）。
 *     启动日志会写明用了哪条路（真机排查靠它）。
 */

import { BrowserWindow, desktopCapturer, ipcMain, session } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type {
  AugmentCardFingerprint,
  AugmentNameFingerprint,
  PanelCard,
  PanelPresence,
  Rect,
} from '@hexbox/vision';

import { resolvePreloadPath } from './label-overlay.ts';

/**
 * worker 页面路径 —— 与 preload 完全同一个坑（`__dirname` 随入口不同）。
 *
 * ⚠️ 本地实跑踩到过：写死 `join(__dirname, '..', 'renderer', ...)` 时，
 * 调试入口（`dist/debug-augment.cjs`）解析到不存在的路径，
 * `loadFile` 的 promise **reject**，异常冒到 whenReady 链之外 →
 * 进程**挂在那儿不动**（不报错、不退出、零帧、零产物）。
 * 所以这里同样按存在性探测，并把失败明确抛给调用方。
 */
function resolveWorkerHtml(): string {
  const candidates = [
    join(__dirname, 'renderer', 'capture', 'worker.html'),
    join(__dirname, '..', 'renderer', 'capture', 'worker.html'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

/** 渲染端一帧的检测结果（与 capture/worker.ts 的 FrameReport 对齐）。 */
export interface AugmentFrame {
  readonly found: boolean;
  readonly cards: readonly PanelCard[];
  readonly bands: number;
  readonly reason: string;
  /** 本帧的采集时刻（worker 时钟）——主进程据此丢弃过期帧。 */
  readonly atMs: number;
  readonly detectMs: number;
  readonly grabMs: number;
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  readonly sincePrevMs: number;
  /**
   * 每张卡的**内容指纹**（门控分辨率上算，见 `vision/augment-reroll.ts`）。
   *
   * 主进程拿它和"上次识别时那一帧的指纹"比 → 判断**哪张卡被刷新了**：
   * 面板不会因为刷新而关闭，所以开/关边沿看不到这件事。
   *
   * ⚠️ 渲染端只在"**冻结取样矩形仍对得上**"时报（已识别过 + 本帧认定面板 +
   * 卡片数与冻结矩形数一致）；其余情况是**空数组** = "这一帧没有可比指纹，
   * 别做判定"。旧版渲染端不带这个字段 → `undefined`（同样视为没有指纹）。
   */
  readonly fingerprints?: readonly (AugmentCardFingerprint | null)[];
  /**
   * "面板**仍在**"的独立信号（渲染端只在**卡片判据未命中**的帧上算，见
   * `capture/worker.ts`）；命中帧是 `undefined`。
   *
   * 主进程把它作为 `createPanelTracker().push(detection, presence)` 的第二个信号：
   * 只有"卡片判据 + 这条信号"**都**说不在，连续 3 帧才判关闭
   *（真机回归：翻牌动画让卡片判据失效 1178ms，旧阈值 0.8 秒导致误判关闭）。
   * 旧渲染端不带这个字段 → `undefined` = 按"不在"处理（与接线前行为一致）。
   */
  readonly presence?: PanelPresence;
}

export interface AugmentStreamConfig {
  /** 卡片行搜索区（**截屏归一化**）。 */
  readonly region: Rect;
  /**
   * 备用搜索区（**截屏归一化**）。
   *
   * ⚠️ 为什么要有（2026-10-05 真机事故）：窗口矩形探针**认错窗口**时
   * （游戏其实全屏 2293×960，探针却给出别的 1600×900 窗口），换算出的 `region`
   * 会把外侧卡边框切掉 → 整局 **0 命中**。渲染端在 `region` 未命中时会再搜
   * `altRegion`（成本 2~4ms），于是"探针错"不再等于"瞎"。
   * 传**全屏恒等**区（即 `PANEL_ROW_REGION`）就能覆盖"游戏全屏但探针错"这种情形。
   */
  readonly altRegion?: Rect;
  /**
   * 门控画布占**流原生宽度**的比例（默认 1/3）。
   *
   * ⚠️ 与 DPI/分辨率无关；旧算法（逻辑宽×2×0.25）隐含假设缩放倍率 1.5，
   * 在 4K@250% 上有效分辨率会掉到 1/5，低于标定的 1/4 下限。
   */
  readonly targetScale?: number;
  /** 门控画布最小宽度（默认 960）。 */
  readonly minWidth?: number;
  /**
   * 名字指纹库（主进程读 `data/augment-names.json` 后下发）。
   *
   * 为什么要过 IPC：识别必须在**渲染端**做（全分辨率帧只在那边），
   * 而渲染端没有 fs。库很小（218 条、约 50KB 位串），一次下发即可。
   */
  readonly library?: readonly AugmentNameFingerprint[];
  /** 每帧间隔（ms）。 */
  readonly intervalMs: number;
  /** 门控画布目标宽度（像素）。 */
  readonly targetWidth: number;
}

export interface AugmentStreamDeps {
  readonly config: AugmentStreamConfig;
  readonly onFrame: (frame: AugmentFrame) => void;
  readonly onStatus: (message: string, isError?: boolean) => void;
  /** 全分辨率识别结果（渲染端做完识别后回传；不传则忽略）。 */
  readonly onRecognized?: (r: unknown) => void;
}

const PRELOAD_PATH = resolvePreloadPath();

export class AugmentStream {
  private readonly deps: AugmentStreamDeps;
  private win: BrowserWindow | null = null;
  private display: Electron.Display | null = null;
  private ready = false;
  private started = false;
  private sawAnyFrame = false;
  private frameCount = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private readonly onFrameMsg: (e: Electron.IpcMainEvent, frame: AugmentFrame) => void;
  private readonly onStatusMsg: (e: Electron.IpcMainEvent, s: { message: string; error?: boolean }) => void;
  private readonly onRecognizedMsg: (e: Electron.IpcMainEvent, r: unknown) => void;

  constructor(deps: AugmentStreamDeps) {
    this.deps = deps;
    this.onFrameMsg = (_e, frame) => {
      this.sawAnyFrame = true;
      this.frameCount = frame.frames;
      this.deps.onFrame(frame);
    };
    this.onStatusMsg = (_e, s) => this.deps.onStatus(s.message, s.error === true);
    this.onRecognizedMsg = (_e, r) => this.deps.onRecognized?.(r);
  }

  /** 建立隐藏窗口 + 屏幕流。返回是否成功发出启动指令。 */
  async start(display: Electron.Display): Promise<boolean> {
    this.display = display;
    ipcMain.on('augment:worker-frame', this.onFrameMsg);
    ipcMain.on('augment:worker-status', this.onStatusMsg);
    ipcMain.on('augment:worker-recognized', this.onRecognizedMsg);

    // 屏幕源交给渲染端：只枚举显示器（1 个源），不枚举窗口（真机 14 个，
    // 每次多花约 200ms —— 见 bench.json）
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      void desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: false })
        .then((sources) => {
          const want = this.display ? String(this.display.id) : '';
          const src = sources.find((s) => s.display_id === want) ?? sources[0];
          if (!src) {
            callback({});
            return;
          }
          this.deps.onStatus(`屏幕源 = ${src.name} (display ${src.display_id})`);
          callback({ video: src });
        })
        .catch((e: unknown) => {
          this.deps.onStatus(`枚举屏幕源失败：${e instanceof Error ? e.message : String(e)}`, true);
          callback({});
        });
    });

    // 窗口放在**游戏所在显示器**的角落（多显示器时主显示器是错的；
    // 它虽然不可见，但错屏会让"显示但透明"的兜底落在错误的屏幕上）
    const workArea = display.workArea;
    this.win = new BrowserWindow({
      // 先完全隐藏；若收不到帧再由 watchdog 改成"显示但透明"
      show: false,
      x: workArea.x + workArea.width - 200,
      y: workArea.y + workArea.height - 120,
      width: 200,
      height: 120,
      frame: false,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      movable: false,
      hasShadow: false,
      // ⚠️ 隐藏窗口默认会被节流到 ~1Hz —— 必须关掉
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    this.win.setIgnoreMouseEvents(true, { forward: true });
    this.win.webContents.on('console-message', (_e, _level, message) => {
      this.deps.onStatus(`[worker] ${message}`);
    });
    await this.win.loadFile(resolveWorkerHtml());

    // 窗口就绪后下发配置并启动
    this.ready = true;
    this.win.webContents.send('augment:worker-config', this.deps.config);
    this.win.webContents.send('augment:worker-command', 'start', this.deps.config);
    this.started = true;

    // 4 秒收不到帧 → 退到"显示但完全透明"（保合成，玩家看不见）
    this.watchdog = setTimeout(() => {
      if (this.sawAnyFrame) return;
      this.deps.onStatus('⚠ 4 秒内没有收到任何帧 → 改为"显示但 opacity=0"以解除不合成', true);
      this.showInvisible();
    }, 4000);

    return true;
  }

  /** 把窗口"显示"出来但完全透明（合成继续跑，用户看不见）。 */
  private showInvisible(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.setOpacity(0);
    this.win.showInactive();
  }

  /** 搜索区变化（游戏窗口移动/换分辨率）时热更新。 */
  updateConfig(config: AugmentStreamConfig): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send('augment:worker-config', config);
  }

  /**
   * 只改门控间隔（节流策略在主进程算好，见 `vision/augment-cadence.ts`）。
   *
   * 常态低频、命中后高频 —— 一局海克斯只出现 4 次（开局/7/11/15 级），
   * 没必要一直高频截屏。
   */
  setCadence(intervalMs: number): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send('augment:worker-command', 'cadence', { intervalMs });
  }

  stop(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('augment:worker-command', 'stop');
      this.win.destroy();
    }
    this.win = null;
    this.started = false;
    ipcMain.removeListener('augment:worker-frame', this.onFrameMsg);
    ipcMain.removeListener('augment:worker-status', this.onStatusMsg);
    ipcMain.removeListener('augment:worker-recognized', this.onRecognizedMsg);
  }

  /**
   * 让渲染端抓一张**全分辨率**帧做识别（面板出现时调用一次）。
   *
   * 识别在渲染端完成、只回传小 JSON：既不经 `desktopCapturer`
   * （那条路会让系统光标卡约 1 秒），也不受门控画布分辨率限制
   * （1080p 上门控画布里的名字偏小，识别要按原生分辨率做）。
   *
   * @param opts.only 面板**停留期间**某几张卡被刷新了 → 只重认这几张
   *   （见 `vision/augment-reroll.ts`）：只把这几张卡的区域按原生分辨率取出来，
   *   其余卡的识别结果由主进程原样保留 —— 不要三张一起重算（白跑 OCR）。
   */
  recognize(opts: { readonly only?: readonly number[] } = {}): void {
    if (!this.win || this.win.isDestroyed()) return;
    if (opts.only && opts.only.length > 0) {
      this.win.webContents.send('augment:worker-command', 'recognize', { only: [...opts.only] });
      return;
    }
    this.win.webContents.send('augment:worker-command', 'recognize');
  }

  /**
   * 取消渲染端**冻结的取样矩形**（面板关闭边沿调用）。
   *
   * 指纹取样矩形在面板停留期间必须固定（否则检测抖动的 ±1~2px 会让"没变"的
   * 内容也测出大距离）；而下一块面板可能完全是另外三张卡、在别的位置，
   * 所以关闭边沿必须清掉 —— 绝不能让上一块的矩形/基线跨面板复用。
   */
  unwatch(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send('augment:worker-command', 'unwatch');
  }

  get stats(): { readonly ready: boolean; readonly started: boolean; readonly frames: number } {
    return { ready: this.ready, started: this.started, frames: this.frameCount };
  }
}
