export * from './types.ts';
export * from './geometry.ts';
export * from './grid.ts';
export * from './match.ts';
export * from './png.ts';
export * from './templates.ts';
export * from './win-geometry.ts';
export * from './ocr.ts';
export * from './card-overlay.ts';
export * from './confirmed.ts';
export * from './label-memory.ts';
export * from './visibility.ts';
export * from './panel-geometry.ts';
export * from './augment-panel.ts';
export * from './augment-cadence.ts';
export * from './augment-ocr.ts';
export * from './augment-trigger.ts';
export * from './augment-label.ts';
export * from './augment-tier-label.ts';
// 面板停留在期间的**单卡刷新（reroll）**检测：指纹 / 距离 / 判定 / 合并（纯函数）
export * from './augment-reroll.ts';
// 「标签被清空」的原因词表 + 一行日志（每一次清空都必须能回答"为什么"）
export * from './augment-clear.ts';
// 局内链路 ⇄ 标签的**时间轴回放**（纯函数；回归测试与诊断脚本共用，不参与运行时）
export * from './augment-timeline.ts';
export * from './label-draw.ts';
// 离线预览用的软件光栅化与字形（不需要 Electron；渲染端不用它们）
export * from './label-raster.ts';
export * from './label-glyph.ts';
export * from './label-cjk.ts';
// 档位字母的真字体数据（都是生成物）：
//   · `label-letter.ts` = **度量**（小；`label-draw.ts` 引用它 → 渲染端也会带进去）
//   · `label-letter-outlines.ts` = **轮廓**（几十 KB，只有离线预览用，别在渲染端导入）
export * from './label-letter.ts';
export * from './label-letter-outlines.ts';
export * from './augment-region.ts';
export * from './label-selftest.ts';
export * from './label-overlay-coords.ts';
// 「面板**仍在**」的独立廉价信号（与卡片判据并列的第二条信号；渲染端算、主进程读）
export * from './augment-presence.ts';
// 关闭边沿 → **确认**之后才让 API 触发状态机处理（复检窗口 + 假关闭作废/自愈）
export * from './augment-close-confirm.ts';
