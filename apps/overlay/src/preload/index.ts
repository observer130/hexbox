/**
 * Preload：向渲染端暴露**最小**且受控的 IPC 接口。
 *
 * 安全原则（contextIsolation = true）：
 *   - 渲染端拿不到 Node / Electron 完整能力
 *   - 只能调用下面白名单里的方法
 *   - 状态由主进程单向推送（overlay:state），渲染端只读
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
} as const;

export type OverlayApi = typeof api;

contextBridge.exposeInMainWorld('overlay', api);
