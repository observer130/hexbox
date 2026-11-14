/**
 * Preload：向渲染端暴露**最小**且受控的 IPC 接口。
 *
 * 安全原则（contextIsolation = true）：
 *   - 渲染端拿不到 Node / Electron 完整能力
 *   - 只能调用下面白名单里的方法
 *   - 状态由主进程单向推送（overlay:vision），渲染端只读
 *
 * 该脚本用于 S2 全屏标签画布（`renderer/overlay-canvas.ts`）与截屏 worker；
 * 侧边悬浮窗已在 2026-11 整体移除，不再有第二个用 `overlay` 名字的渲染端。
 * 画布只需要「接收推送 + 尺寸变化」，因此这里只暴露这两个只读接口。
 */

import { contextBridge, ipcRenderer } from 'electron';

import type { AugmentSessionFramePayload } from '@hexbox/vision';

const api = {
  /** S2 覆盖层：视觉循环识别结果（仅覆盖窗口使用）。 */
  onVision: (cb: (m: unknown) => void): void => {
    ipcRenderer.on('overlay:vision', (_e, m: unknown) => cb(m));
  },

  /** S2 覆盖层：覆盖窗口换显示器/尺寸变化。 */
  onResize: (cb: (d: { width: number; height: number }) => void): void => {
    ipcRenderer.on('overlay:resize', (_e, d: { width: number; height: number }) => cb(d));
  },
} as const;

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
  /**
   * 神经网络 OCR：把裁好的名字带（小灰度图）交给主进程推理。
   *
   * 为什么走主进程：原生 onnxruntime-node 不能加载在隔离的渲染端；这里只传
   * 3 个名字带（每个几十 KB），不传整帧。失败/未启用时返回 `{ok:false}`，
   * worker 会回退到本地模板匹配。
   */
  recognizeNames: (bands: unknown): Promise<unknown> =>
    ipcRenderer.invoke('augment:ocr-names', bands),
  /**
   * **会话录制**：把这一帧的灰度像素交给主进程落盘（`HEXBOX_AUGMENT_RECORD=1` 时才有）。
   *
   * 像素只在渲染端拿得到（屏幕流在那儿），而写文件在主进程 —— 所以这一条是**唯一**
   * 会把像素送过 IPC 的通道，且只在录制开关打开时走（默认完全不走，零开销）。
   */
  recordFrame: (f: AugmentSessionFramePayload): void => {
    ipcRenderer.send('augment:worker-record', f);
  },
} as const;

// 覆盖窗口（overlay-canvas.ts）以独立名字访问。
contextBridge.exposeInMainWorld('visionOverlayApi', api);
contextBridge.exposeInMainWorld('augmentWorkerApi', augmentWorkerApi);
