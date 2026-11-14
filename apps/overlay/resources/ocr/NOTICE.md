# 神经网络 OCR 模型与许可

本目录的 ONNX 模型用于局内海克斯卡面名字识别（`packages/vision/src/augment-ocr-neural.ts`）。

| 文件 | 说明 | 来源 / 许可 |
|---|---|---|
| `ppocrv5-ch-mobile-rec.onnx` | PaddleOCR **PP-OCRv5 mobile** 中文文本识别模型（仅 recognizer，无检测/方向分类） | [PaddlePaddle/PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)，**Apache-2.0**；ONNX 分发参考 [RapidOCR 模型清单](https://github.com/RapidAI/RapidOCR) / [HuggingFace 镜像](https://huggingface.co/nakamura196/ppocrv5-mobile-web-onnx) |
| `ppocrv5-ch-mobile-dict.txt` | 与模型配套的字符字典（18384 个字符 + blank） | 同上（PaddleOCR 训练产物） |

核对值（`sha256`）：

```text
5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5  ppocrv5-ch-mobile-rec.onnx
d1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b  ppocrv5-ch-mobile-dict.txt
```

该模型只在本地 CPU（或可选的 DirectML）上推理；不上传任何屏幕内容，不访问网络。

模型资产由 `apps/overlay/build.mjs` 复制到 `dist/native/ocr/`，随安装包内置
（`extraResources` / `asarUnpack`），运行时不下载。许可证文本见 PaddleOCR 仓库的
`LICENSE`（Apache-2.0）；本仓库仅做二进制分发，未修改模型。
