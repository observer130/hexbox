/**
 * **全屏透明标签画布**（S2 选人标签与局内海克斯标签**共用同一份窗口代码**）
 *
 * 为什么要抽出来：S5.4c 要把「海克斯强度评级」画到局内屏幕上，而 S2 阶段
 * （`main/index.ts`）已经有一块铺满显示器、点击穿透、绝不抢焦点的透明画布，
 * 渲染端（`renderer/overlay-canvas.ts`）按主进程推送的标签绝对定位绘制。
 * 再写一份"平行的窗口代码"必然与它漂移（`__dirname` 口径、DPI、显示器定位
 * 每个都是踩过的坑），所以改成**一处创建、两处使用**：
 *
 *   · 选人阶段：`main/index.ts` 的 `createOverlayWindow()`；
 *   · 局内海克斯：`debug-augment.ts` 的录制工具（用户真机验证这条链路）。
 *
 * ⚠️ `__dirname` 口径（真机踩过两次，勿改）：同一个模块会被打进两个入口，
 * `__dirname` 因此不同 ——
 *   · `dist/main/index.cjs`    → preload/renderer 在**上一级**
 *   · `dist/debug-augment.cjs` → preload/renderer 在**同级**
 * 所以 preload 与 overlay.html 都按**存在性探测**，不依赖目录假设
 * （与 `augment-stream.ts` 的 resolveWorkerHtml 同一个坑）。
 *
 * 绘制约定（渲染端）：选人标签 = 深色圆角底 + 强调色文字；局内强度标签
 * （`style: 'tier'`）= **居中大号描边字母 + 两侧尖括号 + 一行「选取率 x%」**、
 * 没有色块底。两者都只把 `@hexbox/vision` 的 `labelBoxPlan()` 算好的计划喂给
 * canvas —— 这份文件只负责窗口/通道，不碰任何样式。
 *
 * ---------------------------------------------------------------------------
 * ⚠️「画了但屏幕上什么都没有」的修法（2026-10-05 真机，S5.4c）
 *
 * 真机现象：`report.json` 里 `drawn: true`、屏幕坐标也在屏内，但游戏里一个字母
 * 都看不到。**窗口参数与已验证可用的 S2 选人标签完全一致**（就是这份文件），
 * 所以差异不在创建参数，而在**时序与环境**：
 *
 *   1. S2 选人标签每 1.5 秒推一次，且画在**客户端窗口**上面；局内标签是
 *      **一局只推一次**（面板开边沿），而且必须盖在**游戏窗口**（无边框全屏）上：
 *      游戏会不断把自己抢回 z 序顶端，一旦这一次推送的帧没被合成，就**永远不会**
 *      再有机会显示 —— 表现正是"画了但看不见"。
 *   2. Chromium 会把"被遮挡/不可见"窗口的**合成与定时器**降频（`backgroundThrottling`），
 *      被游戏盖住的画布可能一直不出帧（渲染端 `draw` 日志有、屏幕没有）。
 *
 * 因此这里做三件事（都不动几何）：
 *   · `raiseLabelOverlay()`：每次推送后**重申置顶**（`screen-saver` 层）+ `moveTop()`；
 *   · **心跳**：标签在屏期间每 1 秒重申置顶并**重推一次内容**（重绘 = 必须合成），
 *     `clearLabelOverlay()` / `active:false` 时停掉；
 *   · `backgroundThrottling: false`：被遮挡也不降频（与 `augment-stream.ts` 的
 *     worker 窗口同一个坑）。
 *
 * 窗口可见性**不需要游戏**就能自测：`HEXBOX_LABEL_OVERLAY_TEST=1`（见
 * `main/label-selftest.ts` 与 `apps/overlay/README.md`）。
 */

import { BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { toWindowRelativeLabels } from '@hexbox/vision';
import type { LabelStyle } from '@hexbox/vision';

/** preload 绝对路径（按存在性探测，兼容两个打包入口）。 */
export function resolvePreloadPath(): string {
  const candidates = [
    join(__dirname, 'preload', 'index.cjs'),
    join(__dirname, '..', 'preload', 'index.cjs'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

/** 渲染端画布页面（同一个坑：两个入口的 `__dirname` 不同）。 */
function resolveOverlayHtml(): string {
  const candidates = [
    join(__dirname, 'renderer', 'overlay.html'),
    join(__dirname, '..', 'renderer', 'overlay.html'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

/** 一条待绘制标签（屏幕逻辑坐标 DIP；与渲染端 `overlay-canvas.ts` 对齐）。 */
export interface LabelOverlayLabel {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** 主文本（选人 = 胜率；局内强度 = 档位字母）。 */
  readonly text: string;
  /**
   * 辅助文本（选人 = 英雄名，画在右下角；局内强度 = 字母下面那一行
   * 「选取率 12.1%」，**居中**；空串 = 不画那一行）。
   */
  readonly sub: string;
  /** 是否有官方统计（没有配色时的绿/灰依据）。 */
  readonly hasData: boolean;
  /** 对应卡片 ID（选人用；海克斯标签没有，可省）。 */
  readonly championId?: number;
  /** 强调色（描边 + 文字）；缺省时按 `hasData` 取绿/灰。 */
  readonly color?: string;
  /**
   * 主文本字号 / 框高。局内强度标签按预设带上（见 `@hexbox/vision` 的
   * `AugmentBadgePreset.fontScale`）；缺省时渲染端按框高走默认规则
   * （矮框 0.62、普通框 0.52 —— 选人标签用）。
   */
  readonly textScale?: number;
  /**
   * 绘制样式（缺省 `label` = 选人标签的深色圆角底）。
   *
   * 局内强度标签传 `'tier'`：**大号描边彩色字母 + 两侧尖括号 + 选取率行**，
   * 没有色块底 —— 具体几何/颜色不由这里决定，仍全部来自
   * `@hexbox/vision` 的 `labelBoxPlan()`（渲染端与离线预览共用）。
   */
  readonly style?: LabelStyle;
}

/** 推送给画布的消息（渲染端只读）。 */
export interface LabelOverlayMsg {
  /** false = 清空画布（透明）。 */
  readonly active: boolean;
  readonly labels: readonly LabelOverlayLabel[];
  /** 诊断信息（进主进程日志）。 */
  readonly diag?: string;
}

export interface CreateLabelOverlayOptions {
  /** 画布铺在哪块显示器上（**游戏所在**的那块，不是主显示器）。 */
  readonly display: Electron.Display;
  /** preload 路径；缺省按存在性探测（两个入口都能用）。 */
  readonly preload?: string;
}

/**
 * 创建全屏透明画布（**不显示**，由 `pushLabelOverlay` 在首次推送时显示）。
 *
 * 与侧边悬浮窗的区别：它铺满整个显示器的工作区，内容按屏幕逻辑坐标绝对定位。
 */
export function createLabelOverlay(options: CreateLabelOverlayOptions): BrowserWindow {
  const { display } = options;
  const win = new BrowserWindow({
    x: display.workArea.x,
    y: display.workArea.y,
    width: display.workArea.width,
    height: display.workArea.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false, // 不抢焦点，否则游戏丢输入
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: options.preload ?? resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // ⚠️ 局内画布会被游戏窗口盖住：被遮挡时 Chromium 会降频合成/定时器，
      // 那会让"画了但看不见"变成常态（与 augment-stream 的 worker 窗口同一个坑）。
      backgroundThrottling: false,
    },
  });
  // screen-saver 层：全屏游戏之上仍可见
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 画布永远穿透 —— 它只展示，不接受任何输入
  win.setIgnoreMouseEvents(true, { forward: true });
  void win.loadFile(resolveOverlayHtml());
  return win;
}

/**
 * 把画布渲染端的 console / 加载错误转发到主进程终端。
 *
 * 渲染端的错误（preload 失败、JS 异常）默认不可见 —— 这层转发是
 * "画布空白"类问题的**唯一观察窗口**（S2 真机教训）。选人标签与局内
 * 海克斯标签都用它，前缀区分来源。
 */
export function attachLabelOverlayDiagnostics(win: BrowserWindow, tag = 'label-overlay'): void {
  const fwd = (label: string, text: string): void => {
    if (text.includes('Electron Security Warning')) return; // 噪音过滤
    console.log(`[${tag}] ${label}: ${text}`);
  };
  win.webContents.on('console-message', (_e, _level, message) => fwd('console', message));
  win.webContents.on('preload-error', (_e, path, err) => fwd('preload-error', `${path}: ${err}`));
  win.webContents.on('did-fail-load', (_e, code, desc) => fwd('did-fail-load', `${code} ${desc}`));
  win.webContents.on('render-process-gone', (_e, details) =>
    fwd('render-process-gone', details.reason),
  );
}

/** 把画布移动/缩放到指定显示器（游戏换屏时同步）。 */
export function positionLabelOverlay(win: BrowserWindow, display: Electron.Display): void {
  if (win.isDestroyed()) return;
  const target = {
    x: display.workArea.x,
    y: display.workArea.y,
    width: display.workArea.width,
    height: display.workArea.height,
  };
  const cur = win.getBounds();
  if (
    cur.x !== target.x ||
    cur.y !== target.y ||
    cur.width !== target.width ||
    cur.height !== target.height
  ) {
    win.setBounds(target);
  }
  // 提示渲染端"该重设画布尺寸了"（渲染端只把它当提示：自己量 window.innerWidth，
  // 不信任这里的宽高 —— 见 renderer/overlay-canvas.ts 的 syncCanvasSize）。
  win.webContents.send('overlay:resize', { width: target.width, height: target.height });
}

/**
 * 显示画布并推送标签（每次推送都同步一次显示器位置）。
 *
 * ⚠️ **坐标系换算只在这里做一次**（2026-10-05）：
 *   调用方给的是**屏幕绝对**逻辑坐标（`cardLabelFor` / `slotLabelFor` /
 *   `toScreenTierLabels` 都是屏幕 DIP），而渲染端按**窗口内**坐标绘制 ——
 *   画布铺满显示器工作区，所以两者只差一个 `workArea` 原点。
 *   游戏在主显示器时原点恰是 0,0，两边"碰巧相等"，所以这个错位一路藏着；
 *   换到副屏（原点非 0）标签就会整体平移出去。
 *   放在这里（唯一推送口）而不是让每个调用方各自减一次：自测就是因为
 *   "只有自测减了、局内没减"才暴露出来的（同一个 bug 两种口径）。
 */
export function pushLabelOverlay(
  win: BrowserWindow,
  display: Electron.Display,
  msg: LabelOverlayMsg,
): void {
  if (win.isDestroyed()) return;
  // 屏幕绝对坐标 → 窗口内坐标（心跳重推的也必须是这一份，否则每次心跳标签都会跳）
  const local: LabelOverlayMsg = {
    ...msg,
    labels: toWindowRelativeLabels(msg.labels, display.workArea),
  };
  lastMsg = local;
  positionLabelOverlay(win, display);
  raiseLabelOverlay(win);
  win.webContents.send('overlay:vision', local);
  logStateChange(win, msg.active ? '显示画布' : '清空画布');
  if (!msg.active) {
    stopHeartbeat();
    return;
  }
  // showInactive 之后仍不可见 = 覆盖窗根本没能显示（真机事故的唯一硬信号）
  if (!win.isVisible()) {
    console.warn(
      '[label-overlay] ⚠ showInactive() 之后窗口仍不可见 —— 覆盖窗显示失败。\n' +
        '              请先跑自测定位：HEXBOX_LABEL_OVERLAY_TEST=1（见 apps/overlay/README.md）',
    );
  }
  startHeartbeat(win);
}

/**
 * **重申置顶**（每次推送与心跳都调）。
 *
 * 为什么不能只在创建时设一次：游戏（无边框全屏）会不断把自己抢回 z 序顶端，
 * 而这张画布**永不激活**（`focusable: false`，绝不抢游戏输入），
 * 所以它一旦被压下去就没有任何机会自己回来。`moveTop()` + 重申 `alwaysOnTop`
 * 都不改变焦点，只是把画布重新放回最上层。
 */
export function raiseLabelOverlay(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (!win.isVisible()) win.showInactive();
  win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop();
}

/**
 * **清空**画布内容（面板关闭边沿 / 收工）。
 *
 * 刻意**不**调用 `showInactive`：清空不该把一块透明窗口"弹"出来
 * （虽然它点击穿透且透明，但没有理由去动窗口的显隐状态）。
 */
export function clearLabelOverlay(win: BrowserWindow | null, diag = '清空'): void {
  if (!win || win.isDestroyed()) return;
  stopHeartbeat();
  lastMsg = { active: false, labels: [], diag };
  win.webContents.send('overlay:vision', lastMsg);
}

/* ------------------------------------------------------------------ */
/* 心跳：标签在屏期间重申置顶 + 重推内容                                 */
/* ------------------------------------------------------------------ */

/** 最近一次推送（心跳重推它 —— 重绘会强制走一次合成）。 */
let lastMsg: LabelOverlayMsg | null = null;
/** 心跳目标窗口（一个进程只有一块画布，见文件顶部说明）。 */
let heartbeatWin: BrowserWindow | null = null;
let heartbeat: NodeJS.Timeout | null = null;
/** 上一次打印过的窗口状态（只在变化时打日志，避免刷屏）。 */
let lastLoggedState = '';

/** 心跳间隔：1 秒。开销是一次 IPC + 一次小画布重绘，只在标签在屏时跑。 */
export const LABEL_OVERLAY_HEARTBEAT_MS = 1000;

function startHeartbeat(win: BrowserWindow): void {
  heartbeatWin = win;
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    const w = heartbeatWin;
    if (!w || w.isDestroyed()) {
      stopHeartbeat();
      return;
    }
    raiseLabelOverlay(w);
    if (lastMsg && lastMsg.active) w.webContents.send('overlay:vision', lastMsg);
  }, LABEL_OVERLAY_HEARTBEAT_MS);
  // 心跳不该让进程"活着退不出去"
  heartbeat.unref?.();
}

function stopHeartbeat(): void {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  heartbeatWin = null;
}

/** 窗口状态一行（可见/置顶/尺寸）—— 真机排查"看不见"的第一手证据。 */
export function describeLabelOverlay(win: BrowserWindow | null): string {
  if (!win || win.isDestroyed()) return '窗口已销毁';
  const b = win.getBounds();
  return (
    `bounds=${b.width}x${b.height}@${b.x},${b.y}` +
    ` visible=${win.isVisible()} alwaysOnTop=${win.isAlwaysOnTop()}` +
    ` opacity=${win.getOpacity()}`
  );
}

function logStateChange(win: BrowserWindow, tag: string): void {
  const state = `${tag} ${describeLabelOverlay(win)}`;
  if (state === lastLoggedState) return;
  lastLoggedState = state;
  console.log(`[label-overlay] ${state}`);
}
