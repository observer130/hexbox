/**
 * Preload：向渲染端暴露**最小**且受控的 IPC 接口。
 *
 * 安全原则（contextIsolation = true）：
 *   - 渲染端拿不到 Node / Electron 完整能力
 *   - 只能调用下面白名单里的方法
 *   - 状态由主进程单向推送（overlay:state / overlay:vision），渲染端只读
 *
 * 该脚本同时用于两个窗口（侧边悬浮窗 + S2 全屏覆盖层）,
 * 因此暴露的是两者的并集；各渲染端只使用自己需要的部分。
 */

import { contextBridge, ipcRenderer } from 'electron';

const api = {
  /** 设置鼠标穿透。 */
  setClickThrough: (on: boolean): Promise<boolean> =>
    ipcRenderer.invoke('overlay:set-click-through', on),

  /** 退出。 */
  close: (): Promise<void> => ipcRenderer.invoke('overlay:close'),

  /** 主进程推送的完整状态（每 2s 一次）。 */
  onState: (cb: (s: unknown) => void): void => {
    ipcRenderer.on('overlay:state', (_e, s: unknown) => cb(s));
  },

  /** 穿透状态变化推送。 */
  onClickThrough: (cb: (on: boolean) => void): void => {
    ipcRenderer.on('overlay:click-through', (_e, on: boolean) => cb(on));
  },

  /** S2 覆盖层：视觉循环识别结果（仅覆盖窗口使用）。 */
  onVision: (cb: (m: unknown) => void): void => {
    ipcRenderer.on('overlay:vision', (_e, m: unknown) => cb(m));
  },

  /** S2 覆盖层：覆盖窗口换显示器/尺寸变化。 */
  onResize: (cb: (d: { width: number; height: number }) => void): void => {
    ipcRenderer.on('overlay:resize', (_e, d: { width: number; height: number }) => cb(d));
  },
} as const;

export type OverlayApi = typeof api;

/**
 * 截屏 worker（`src/capture/worker.ts`）专用接口。
 *
 * 单独暴露最小集合而不是复用 overlay api：worker 只该做"取帧 → 检测 → 上报"
 * 这一件事，拿不到窗口显隐/状态推送这些与它无关的能力（contextIsolation 下
 * 这才是真正的边界，而不是靠自觉）。
 */
const augmentWorkerApi = {
  /** 主进程下发/更新配置（搜索区、间隔、画布宽）。 */
  onConfig: (cb: (c: unknown) => void): void => {
    ipcRenderer.on('augment:worker-config', (_e, c: unknown) => cb(c));
  },
  /** 主进程发指令：start（带配置）/ stop / cadence（只改间隔）/ recognize（识别；带 `only` = 只重认那几张卡）/ unwatch（取消冻结的取样矩形）。 */
  onCommand: (
    cb: (cmd: 'start' | 'stop' | 'cadence' | 'recognize' | 'unwatch', cfg?: unknown) => void,
  ): void => {
    ipcRenderer.on(
      'augment:worker-command',
      (_e, cmd: 'start' | 'stop' | 'cadence' | 'recognize' | 'unwatch', cfg?: unknown) => cb(cmd, cfg),
    );
  },
  /** 每帧的检测结果（小 JSON，不含像素）。 */
  report: (frame: unknown): void => {
    ipcRenderer.send('augment:worker-frame', frame);
  },
  /** 状态/错误（终端可见，便于真机排查）。 */
  status: (s: { readonly message: string; readonly error?: boolean }): void => {
    ipcRenderer.send('augment:worker-status', s);
  },
  /**
   * 全分辨率识别结果。
   *
   * 识别在**渲染端**做（从已有的屏幕流取原生分辨率帧），所以像素不过 IPC，
   * 只回传"哪张卡是哪颗海克斯 + 分数"，主进程据此画标签/记日志。
   */
  recognized: (r: unknown): void => {
    ipcRenderer.send('augment:worker-recognized', r);
  },
} as const;

// 覆盖窗口（overlay-canvas.ts）以独立名字访问,避免与侧边窗 renderer.ts
// 的 `overlay` 声明在打包后全局作用域冲突（IIFE 无模块隔离的真实坑）。
contextBridge.exposeInMainWorld('overlay', api);
contextBridge.exposeInMainWorld('visionOverlayApi', api);
contextBridge.exposeInMainWorld('augmentWorkerApi', augmentWorkerApi);
