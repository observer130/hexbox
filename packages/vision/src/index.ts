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
// 开边沿整批识别的两个纯决策（原生重检失败 → 门控矩形兜底；失败后**有界**重试）
export * from './augment-open-recognize.ts';
// 全分辨率识别的**纯函数核心**（渲染端 worker 与离线回放共用同一份）
export * from './augment-recognize.ts';
// 常驻路径的轻量诊断（日志时间偏移 + 采样窗口汇总与裁决；无行为变化）
export * from './augment-log-diag.ts';
// 选人阶段的子阶段解析（pickState）与"这一轮谁出标签"的判定（纯函数）
export * from './champ-select-stage.ts';
// 选人第一阶段**候选卡**的专用几何与检出（真机标定：居中一行，2 或 3 张；
// 与局内海克斯面板的布局无关，勿混用）+ 来源开关
export * from './champ-select-cards.ts';
// 选人阶段**截屏形态**（窗口快照 vs 显示器快照）的两个候选与形态选择：
// 选人截屏来自窗口源（一定是窗口内容），而 snapshotKind 的"三者同比"退化判据是给
// 局内 screen 源标定的 —— 16:9 显示器 + 默认客户端窗口会被判成显示器快照，搜索区与
// 标签几何整体错位（本机真机帧复现）。处置与局内一致：两个形态都试，region 与 geo 成对。
export * from './champ-select-capture-form.ts';
export * from './augment-label.ts';
export * from './augment-tier-label.ts';
// 面板停留在期间的**单卡刷新（reroll）**检测：指纹 / 距离 / 判定 / 合并（纯函数）
export * from './augment-reroll.ts';
// 刷新后的**补救记账**：第一次没查出强度先重认一次；重认回传的基线不许倒退
export * from './augment-reroll-retry.ts';
// 「标签被清空」的原因词表 + 一行日志（每一次清空都必须能回答"为什么"）
export * from './augment-clear.ts';
// 局内链路 ⇄ 标签的**时间轴回放**（纯函数；回归测试与诊断脚本共用，不参与运行时）
export * from './augment-timeline.ts';
// 录制会话（session）：数据模型 + 纯解析 + 裁剪帧坐标映射
export * from './augment-session.ts';
// 会话回放引擎：把会话喂给**线上同一份**纯函数（门控/节流/API 触发），收指标与差异
export * from './augment-session-replay.ts';
// 离线回放用的**虚拟时钟/虚拟定时器**（闭环回放要它：时间只在显式推进时走）
export * from './virtual-clock.ts';
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
// 常驻覆盖层的**用户可见状态文案**（托盘菜单那一行 + tooltip；纯函数）
export * from './overlay-status.ts';
// 托盘菜单「统计日期」的口径（官方 meta.dataDate 优先、文件 mtime 回退）
export * from './data-update-stamp.ts';
// 「更新数据」（应用内同步）的阶段与文案：菜单项 / 确认框 / 结果弹窗（纯函数）
export * from './data-update-phase.ts';
// 数据目录的解析：文档目录优先、旧位置只读回退、写目标永远与安装目录解耦（纯函数）
export * from './data-location.ts';
// 「检查更新」的判据：版本比较 + GitHub Release 解析/资产挑选 + 菜单文案（纯函数）
export * from './update-version.ts';
export * from './update-check.ts';
// 「读不到 LCU 凭证」的**一次性气泡**判定（连续 N 轮才提示、每个连接会话最多一次）
export * from './credential-notice.ts';
// 重连恢复的**纯判定**（动作只在 InProgress 上做、先重置本局熔断、英雄身份优先缓存）
export * from './reconnect-recovery.ts';
// hover 命中测试 + 提示框排版（纯函数；渲染端与将来的离线预览共用同一份）
export * from './label-hover.ts';
// 提示框**文案**（纯函数：统计口径/日期/海克斯"非本局选项"的措辞都在这里）
export * from './label-tip.ts';
// 故障症状 → 原因 → 怎么查（借同类产品**已发货**的反馈分类表；自测与文档同一份）
export * from './failure-taxonomy.ts';
