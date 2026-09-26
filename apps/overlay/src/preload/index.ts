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
} as const;

export type OverlayApi = typeof api;

// 覆盖窗口（overlay-canvas.ts）以独立名字访问,避免与侧边窗 renderer.ts
// 的 `overlay` 声明在打包后全局作用域冲突（IIFE 无模块隔离的真实坑）。
contextBridge.exposeInMainWorld('overlay', api);
contextBridge.exposeInMainWorld('visionOverlayApi', api);
