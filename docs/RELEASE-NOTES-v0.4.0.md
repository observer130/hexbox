# hexbox v0.4.0

神经网络 OCR 版：局内海克斯名字识别换成 **PP-OCRv5 mobile 中文模型 + 闭集 CTC**
（模型随安装包内置，运行时**不下载任何内容**）；模板匹配保留为回退路径。
同时修复了真机发现的「卡片刷新后强度标签不更新」。

## 变更

- **神经网络 OCR（默认开启）**：只裁卡面名字带，不跑检测模型；对 239 个官方海克斯名
  逐个算 CTC 对数似然，取最高分并检查与第二名的分差，输出闭集内的 `augmentId`，
  不猜不存在的名字。
  - 真机 24/24 卡位正确；CPU 约 5.5ms/行，首次模型加载约 150ms。
  - 模型 15.9MB + 当前平台 ONNX Runtime 随包（Windows x64 约 64MB，含 DirectML），
    通过 `asarUnpack` 解包到 `resources/app.asar.unpacked/dist/native`。
  - 模型/运行时缺失、或设置 `HEXBOX_OCR=template` 时自动回退模板匹配。
  - `HEXBOX_OCR_EP=cpu|dml` 可选执行后端；Windows 预编译 ONNX Runtime **没有 CUDA**，
    默认 CPU（DirectML 在本负载无显著收益，失败自动回退 CPU）。
- **修复：卡片刷新后标签不更新**（2026-11-15 真机录制复现）：
  - 同一帧换多张卡时，只推进真正重认的卡的基线，被动画稳定性判据跳过的卡保留旧基线；
  - 重随识别完成后不再整排采信回传指纹，避免把未重认卡的新内容覆盖旧基线；
  - 翻牌动画期间卡片判据失效、但面板信号仍在时，继续按冻结矩形算指纹，
    连续两次刷新不会再漏。
- 识别命令串行化，避免神经网络 OCR 异步窗口内并发重入。
- 新增神经网络 OCR 回放支持：`replay-session.mts --neural` 在启动时按原生帧预计算并缓存，
  识别接口保持同步，回放时序与模板路径一致。

## 验证

- 单测 1158（vision 710）；`pnpm check:docs` / `pnpm typecheck` / `pnpm test` / `pnpm build` 全绿。
- 神经网络 OCR：真机 24 卡位 24/24；同会话回放模板 13 次识别、神经网络 11 次，
  唯一差异是模板漏认的「大力」被补上，其余逐条相同。
- 卡片刷新修复：用真机录制 `20261115-144032` 复现；修复后回放能补检出此前漏掉的
  单卡刷新，最终刷新仍需真机按 `docs/VERIFY-P1.md` B4 再验（回放帧库没有按需原生帧）。
- 打包后校验：`app.asar` 无 `node_modules`/`debug`/测试源码；`app.asar.unpacked/dist/native`
  含模型与 ONNX Runtime（81M）；从解包目录直接加载 `ppocrv5-ch-mobile-rec.onnx`
  成功（CPU session，输入 `x`、输出 `fetch_name_0`）。
- 覆盖层 UI、UAC、LCU 凭证仍需真机手动验收（无桌面 CI 不覆盖）。

## 安装

| 资产 | SHA256 |
|---|---|
| `hexbox-setup-0.4.0-x64.exe`（115,058,831 B） | `df10542303e9bd91065e9959eec8a5318555328bfc4bdde807c7494660bb5ba1` |
| `hexbox-portable-0.4.0-x64.exe`（114,823,951 B） | `fd4f78edd513cbd2924370f4e8e8f784d1f1012a77b593ac1da2222c76154ca8` |

**没有代码签名**，首次运行 SmartScreen 会提示"未知发布者"
（文件属性 → 数字签名页为空可自证）。

## 已知问题

- 首次运行必须联网一次下载数据（约 6–10 MB）；断网会失败，可稍后从托盘「更新数据」重试。
- 安装包因内置神经网络模型与 ONNX Runtime 增大约 30–45MB（压缩后）；
  Windows 预编译 ONNX Runtime 不支持 CUDA，只能 CPU / DirectML。
- 便携版不支持自助更新（与以前相同）。
- 数据放在 OneDrive 同步的文档目录时，首次下载会让 OneDrive 上传约 6 MB（正常）。
