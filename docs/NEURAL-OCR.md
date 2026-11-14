# 神经网络 OCR（局内海克斯名字）

> 2026-11-15 上线。替换/兜底关系：**神经网络为主，模板匹配仍是回退路径**。
> 历史算法（二值模板 Jaccard）见 `packages/vision/src/augment-ocr.ts`；本文只讲神经网络这一条。

## 为什么不是"完整 PaddleOCR 流程"

卡面名字的**几何已知**（`augmentNameBandRect` 直接裁名字带），而且名字是**闭集**
（`data/dataset.json` 的 239 个 hextech）。所以：

- 不跑检测/方向分类模型（PP-OCR 的 det/cls）：省 ~5MB 和一次检测抖动；
- 只跑 **PP-OCRv5 mobile 中文 recognizer**（ONNX，15.9MB）；
- 解码不是"识别成字符串再模糊匹配"，而是对 239 个候选名逐个算 **CTC 对数似然**，
  取最高分并检查与第二名的分差（`augment-ocr-neural.ts` 的 `resolveNeuralName`）。
  这样不会输出图鉴里不存在的名字，也天然把结果映射到 `augmentId`。

## 预处理（真机标定的关键）

游戏是**白字深底**，而 PaddleOCR 训练分布以深字浅底为主。直接送固定名字条只能到
21~22/24；改成下面这条后 24/24：

1. 名字带（卡宽 92%、卡高 10%，`augmentNameBandRect`）内按亮度 ≥150 找**文字包围盒**；
2. 横向留白 8%、纵向 35%，裁出；
3. **反相**（白字 → 深字，深底 → 浅底）；
4. 按宽高比缩放到高 48（最近邻，与标定脚本一致）；
5. 归一化到 `[-1, 1]`，复制成 3 通道（模型输入 BGR 语义，灰度三通道等价）。

模型输出是**每帧已 softmax 的概率**（实测每帧 sum≈1），不是 logits；
`ctcLogProbability()` 直接取 log 后做标准 CTC 前向，**不要再 softmax 一次**。

## 实测（2026-11-14 真机录制，24 个 open 卡位 / 2 场会话）

| 方案 | 正确 | 延迟（CPU） |
|---|---|---|
| 现有模板匹配 | 23/24 | ~11.4ms/卡 |
| PP-OCRv5 mobile 直接送固定名字条 | 21~22/24 | ~14ms/行 |
| **紧包围盒 + 反相 + CTC 闭集** | **24/24** | **~5.5ms/行** |

- 模型加载（懒加载）：CPU ~150ms（首次面板出现时一次）；三个卡位约 17ms + 预处理。
- **CUDA**：Windows 预编译 `onnxruntime-node` **没有 CUDA EP**（只有 Linux 预编译
  带 CUDA；Windows 可选 CPU / DirectML / 实验性 WebGPU）。本负载 3 条小文本行用
  CPU 已足够；RTX 4070 上 DirectML 实测平均 5.2ms vs CPU 6.7ms（320 宽 dummy），
  首次还要 ~1s，因此默认 CPU。`HEXBOX_OCR_EP=dml` 可显式启用 DirectML（失败自动回退 CPU）。
- 闭集默认阈值：`minScore=-3.0`、`minMargin=0.8`（真机正确项最低 margin 1.58）。
  低于阈值 → `null` → 回退模板匹配/不画标签（宁漏勿错）。

### 回放对照（同一会话 `debug/sessions/20261114-214754-InProgress`）

| 路径 | 识别调用 | 关键差异 |
|---|---|---|
| 模板匹配 | 13 次 | 第三块面板卡2「大力」识别为 `null` → 控制器重试 3 次；其余与 golden 一致 |
| **神经网络** | **11 次** | 「大力」= **1007**；其余 10 条识别结果与模板路径**逐条相同**；少掉的 2 次是模板失败重试 |

> 这条会话就是最初发现模板 OCR「大力」漏认的录制。神经网络路径把唯一的漏认补上了，
> 且没有改变任何其他卡的识别结果。

## 架构（为什么不是"直接在 worker 里跑模型"）

识别帧在**渲染端 worker**（全分辨率帧只在那里），原生 `onnxruntime-node` 不能加载在
隔离渲染进程。所以：

```
worker：帧 → 几何计划（planOpenRecognition / frozenRects）
        → 裁名字带（几十 KB 灰度）
        → IPC invoke('augment:ocr-names')
主进程：AugmentStream（校验发信方）→ neural-ocr 适配器 → ONNX Runtime（CPU/DML）
        → 返回 augmentId/name/score/margin
worker：recognizeOpen / recognizeReroll 的 nameMatches 注入口 → 画标签
```

- `recognizeOpen` / `recognizeReroll` 仍是**同步纯函数**（回放与单测可复现）；
  神经网络结果经 `nameMatches` 注入，`null`/缺键时回退模板匹配。
- IPC 只传名字带，**不传整帧**；服务端校验 sender，拒绝其他渲染端伪造 OCR 结果。
- 模型/原生运行时由 `build.mjs` 复制到 `dist/native/`；打包版 `asarUnpack` 解包，
  主进程按 `app.asar.unpacked/dist/native` 绝对路径加载（见 `electron-builder.yml`）。
- `HEXBOX_OCR=template|0|off` 整局关闭（回退模板）；模型/运行时缺失时 worker 自动降级。

## 回放

```bash
node --experimental-strip-types scripts/replay-session.mts debug/sessions/<dir> --neural
```

回放的 `recognize()` 是同步接口，神经网络结果在 `createReplayCapture.start()` 里
**按原生帧预计算并缓存**（12 帧 × 3 卡 ≈200ms），识别时只查表 —— 这样控制器
`onRecognized` 的时序与模板匹配完全一致（早期版本在 recognize 里 await，识别调用
从 13 次掉到 7 次、标签错位，已修）。

## 模型与许可

- `apps/overlay/resources/ocr/ppocrv5-ch-mobile-rec.onnx`（15.9MB，Apache-2.0）
- `apps/overlay/resources/ocr/ppocrv5-ch-mobile-dict.txt`
- 来源/校验值见同目录 `NOTICE.md`；模型随安装包内置，运行时**不下载**任何内容。

## 相关文件

| 文件 | 职责 |
|---|---|
| `packages/vision/src/augment-ocr-neural.ts` | 预处理 / 字典 / CTC 闭集 / 阈值（纯函数，有单测） |
| `packages/vision/src/augment-recognize.ts` | `nameMatches` / `full` 注入、`planOpenRecognition` |
| `apps/overlay/src/ocr/neural-ocr.ts` | ONNX Runtime 懒加载、会话、推理（主进程/回放共用） |
| `apps/overlay/src/capture/worker.ts` | 裁名字带、IPC 调用、失败回退 |
| `apps/overlay/src/main/augment-stream.ts` | `augment:ocr-names` IPC 边界校验 |
| `apps/overlay/src/main/index.ts` | 路径解析 / 懒加载 / `HEXBOX_OCR(_EP)` |
| `apps/overlay/build.mjs` | 复制模型 + 当前平台 ORT 到 `dist/native/` |
