/**
 * 常驻截屏源的**真实实现**（Electron 侧装配；`AugmentStream` 的工厂）
 *
 * 为什么单独一个文件（2026-10-12）：`AugmentController` 要能被**纯 Node 离线回放**
 * （`scripts/replay-session.mts`），所以它自己不能 `import` 任何 Electron 模块 ——
 * 包括这个建隐藏窗口的 `AugmentStream`。装配留在 Electron 侧入口，控制器只收接口
 * （`AugmentCaptureSource`，见 `augment-controller.ts`）。
 *
 * ⚠️ 配置口径与接线前**逐字相同**（每一条都有真机教训）：
 *   · `altRegion` = 全屏恒等：窗口探针认错窗口时主区会切掉外侧卡边框 → 整局 0 命中
 *     （2026-10-05 真机事故），渲染端会用备用区再搜一次（2~4ms）；
 *   · 门控画布按**流原生宽度的 1/3、且不小于 960px**：旧算法（逻辑宽×2×0.25）
 *     隐含假设缩放倍率 1.5，4K@250% 上会掉到 1/5，低于标定的 1/4 下限；
 *   · `intervalMs`：pixel 用常态低频，api 用 **0（一帧不取）**。
 */

import { AugmentStream } from './augment-stream.ts';
import type { AugmentCaptureFactoryInput, AugmentCaptureSource } from './augment-controller.ts';

export function augmentStreamCapture(input: AugmentCaptureFactoryInput): AugmentCaptureSource {
  const { geometry } = input;
  return new AugmentStream({
    config: {
      region: geometry.region,
      altRegion: geometry.altRegion,
      targetScale: 1 / 3,
      minWidth: 960,
      // 名字指纹库随配置下发（渲染端做识别，读文件在主进程）
      library: input.deps.loadLibrary(),
      intervalMs: input.startIntervalMs,
      targetWidth: geometry.targetWidth,
      // 会话录制（默认关）：渲染端把灰度帧交过来，见 main/session-recorder.ts
      record: input.deps.record,
    },
    onFrame: input.deps.onFrame,
    onStatus: input.deps.onStatus,
    onRecognized: input.deps.onRecognized,
    onRecordFrame: input.deps.onRecordFrame,
  });
}
