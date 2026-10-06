/**
 * S2 覆盖层渲染端：全屏透明画布,按主进程推送的标签绝对定位绘制。
 *
 * 只读 `overlay:vision` 推送,不持有任何状态源 —— 识别与换算全在主进程
 * （vision-loop）与纯函数（vision/card-overlay、vision/augment-tier-label）里。
 *
 * 两块用途共用本文件（同一条 IPC 通道、同一块画布，窗口在 main/label-overlay.ts）：
 *   · 选人阶段：卡片/顶栏胜率标签（深色圆角底 + 胜率大字 + 英雄名小字）；
 *   · 局内海克斯：卡**底部居中**的强度评级 —— **大号描边彩色字母 + 两侧尖括号
 *     `‹ S ›` + 下面一行「选取率 12.1%」**，没有色块底（`style: 'tier'`）。
 *
 * 绘制约定（**全部来自纯函数 `labelBoxPlan()`**，见 @hexbox/vision/label-draw.ts）：
 *   - `label` 样式 = 深色圆角底 + 大字 + 小字；有 `color` 用它（局内档位配色），
 *     否则按 hasData 取绿/灰（hasData=false 灰色「暂无数据」,绝不猜一个数字）
 *   - `tier` 样式 = 发光层 + 深色描边 + 字母本体 + 尖括号折线 + 选取率行，
 *     几何/颜色/字号全部由 `plan.tier` 给（含尖括号的**折线点**，与离线预览逐点一致）
 *   - inactive 时清空画布（透明）
 *   - 坐标 = **窗口内**逻辑 DIP（主进程在推送时已把屏幕绝对坐标平移过来，
 *     见 main/label-overlay.ts）；画布位图尺寸 = 窗口内尺寸 × DPR
 *
 * ⚠️ 圆角/描边/字号/配色/尖括号**不要**再写死在这里：离线预览
 * （`scripts/preview-augment-labels.mts`）跑在纯 Node 里、没有 canvas，
 * 它按同一份 `labelBoxPlan()` 用软件光栅化画图 —— 这里另写一套就会
 * "预览好看、局内不一样"（用户 2026-10-05 明确要求两边一致）。
 */

import { canvasBitmapSize, labelBoxPlan, rgbaCss } from '@hexbox/vision/browser';
import type { LabelBoxPlan, LabelStyle, TierTagPlan } from '@hexbox/vision/browser';

interface VisionLabel {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  sub: string;
  hasData: boolean;
  championId: number;
  /** 强调色（描边 + 文字）。局内海克斯档位配色用它；选人标签不传。 */
  color?: string;
  /**
   * 主文本字号 / 框高。局内档位标签由主进程按标签预设算好带下来
   * （`ScreenAugmentTierLabel.fontScale`）——**不要**在这里按框高猜比例：
   * 标签的框比选人标签矮得多，猜出来的字号会与离线预览不一致。
   */
  textScale?: number;
  /** 绘制样式：缺省 = 选人标签（深色底）；`tier` = 局内强度评级（大字母 + 尖括号）。 */
  style?: LabelStyle;
}

interface VisionMsg {
  active: boolean;
  labels: VisionLabel[];
  diag?: string;
}

/** preload 暴露的接口（见 preload/index.ts）。本文件不与 renderer.ts 共存于同一页面。 */
declare const visionOverlayApi: {
  onVision: (cb: (m: unknown) => void) => void;
  onResize: (cb: (d: { width: number; height: number }) => void) => void;
};

const api = {
  onVision: (cb: (m: VisionMsg) => void): void => {
    visionOverlayApi.onVision((m) => cb(m as VisionMsg));
  },
  onResize: (cb: (d: { width: number; height: number }) => void): void => {
    visionOverlayApi.onResize(cb);
  },
};

const canvas = document.getElementById('vision') as HTMLCanvasElement;

/**
 * `willReadFrequently`：自测（`HEXBOX_LABEL_OVERLAY_TEST=1`）与真机排查会**频繁**
 * 用 `getImageData` 读回像素；不设它 Chromium 会把画布放在 GPU 侧，每次读回都要
 * 拷回内存（自测日志里就会打印那条 "Multiple readback operations…" 提示）。
 */
const ctx = canvas.getContext('2d', { willReadFrequently: true });

/** 最近一次推送的消息;resize/画布重设后用它重绘,避免清空后空白。 */
let lastMsg: VisionMsg | null = null;

/**
 * **画布位图尺寸 = 窗口内尺寸 × DPR**（纯计算见 `@hexbox/vision/browser`
 * 的 `canvasBitmapSize`，有单测）。
 *
 * ⚠️⚠️ 尺寸**只取决于窗口自身**，绝不绑定任何一条主进程消息（真机事故 2026-10-05）：
 *   局内海克斯标签一局只推一次（面板开边沿），`overlay:resize` 更是换显示器才有
 *   —— 一旦"只在收到某条消息时才设尺寸"，自测与局内路径就永远停在 HTML 默认的
 *   `300×150`，而标签坐标是按 2294×912 算出来的：全部落在画布之外，
 *   表现正是"日志里说画了、屏幕上一个字都没有"。
 *   所以：**加载时 + `window.resize` 时 + 每次绘制前**都同步一次（下面 draw 里）。
 *
 * 返回值：尺寸是否真的变了（变了要重新建变换矩阵，位图重设会重置它）。
 */
function syncCanvasSize(): boolean {
  const dpr = window.devicePixelRatio || 1;
  const size = canvasBitmapSize(window.innerWidth, window.innerHeight, dpr);
  if (canvas.width === size.width && canvas.height === size.height) return false;
  canvas.width = size.width;
  canvas.height = size.height;
  // CSS 尺寸保持**逻辑值**（画布只占满窗口，不参与布局放大 —— 位图尺寸才是 DPR 后的）
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  return true;
}

/**
 * 按 DPR 建立逻辑坐标系（绘制代码一律用逻辑 DIP，无需感知 DPR）。
 *
 * `setTransform` 是**覆盖**而非叠加，所以重复调用安全（不会双重缩放）；
 * 但 `canvas.width/height` 赋值会**重置**变换矩阵，故尺寸一变必须重设。
 */
function applyDprTransform(): void {
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function resizeCanvas(): void {
  syncCanvasSize();
  applyDprTransform();
  // 画布尺寸变化会清空内容 —— 用最近消息重绘
  if (lastMsg) draw(lastMsg);
}
window.addEventListener('resize', () => {
  resizeCanvas();
});
resizeCanvas();

// 覆盖窗口换显示器时,主进程会推 overlay:resize（setBounds 后 resize 事件
// 顺序不保证,显式同步一次,避免画布尺寸与窗口不符导致内容裁切）。
// 注意：这里**不信任**消息里的宽高（渲染端自己量 window.innerWidth 最准），
// 消息只当"该重设了"的提示。
api.onResize(() => setTimeout(resizeCanvas, 50));

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function draw(msg: VisionMsg): void {
  lastMsg = msg; // 供 resize 重绘
  // ⚠️ **每次绘制前**对齐画布尺寸：这是"尺寸只取决于窗口"的最后一道保险 ——
  //    窗口尺寸/DPR 变了却没收到 resize 事件（换显示器、被系统改大小、
  //    消息先于事件到达）时，尺寸与坐标仍然一致。
  if (syncCanvasSize()) applyDprTransform();
  if (!ctx) return;
  // DPR 变换后 clearRect 也要覆盖整窗（用逻辑尺寸）
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  if (!msg.active) return;

  console.log(
    `[overlay-canvas] draw labels=${msg.labels.length} ` +
      `canvas=${canvas.width}x${canvas.height} ` +
      `window=${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio || 1}`,
  );

  for (const l of msg.labels) {
    // ⚠️ 底色/描边/圆角/字体/字号/锚点/尖括号**全部来自纯函数** `labelBoxPlan()`
    //    （@hexbox/vision/label-draw.ts）—— 离线预览
    //    （scripts/preview-augment-labels.mts）用的是同一份计划，
    //    所以"预览里多大，局内就多大"，不存在预览好看、局内不一样。
    const plan = labelBoxPlan(
      { x: l.x, y: l.y, w: l.w, h: l.h },
      { color: l.color, hasData: l.hasData, textScale: l.textScale, style: l.style, text: l.text },
    );

    // 底（深色圆角）+ 描边：**只有 `label` 样式画**（局内强度评级没有色块底）
    if (plan.boxVisible) {
      ctx.fillStyle = plan.fill;
      roundRect(ctx, plan.x, plan.y, plan.w, plan.h, plan.radius);
      ctx.fill();
      // 描边（局内档位标签 = 档位色；选人标签 = 半透明绿/灰）
      ctx.strokeStyle = plan.strokeColor;
      ctx.lineWidth = plan.strokeWidth;
      roundRect(ctx, plan.x, plan.y, plan.w, plan.h, plan.radius);
      ctx.stroke();
    }

    if (plan.tier) {
      drawTierTag(ctx, plan.tier, l.text, l.sub);
      continue;
    }

    // 选人标签：胜率大字（单行垂直居中 + 水平居中）
    ctx.fillStyle = plan.accentColor;
    ctx.textBaseline = plan.textBaseline;
    ctx.textAlign = 'center';
    ctx.font = plan.font;
    ctx.fillText(l.text, plan.textX, plan.textY);
    ctx.textAlign = 'left';

    if (!plan.compact) {
      // 英雄名（右侧小字）
      ctx.fillStyle = plan.subColor;
      ctx.font = plan.subFont;
      ctx.textAlign = 'right';
      ctx.fillText(l.sub, plan.subX, plan.subY, plan.subMaxWidth);
      ctx.textAlign = 'left';

      // ⚠️ 曾在此画左下角脚注「101 官方统计」。用户 2026-10-04 明确要求去掉
      // （标签已与卡片同宽，脚注显得杂；数据出处不需要每张标签都重复）。
      // 出处仍在侧边窗与数据站展示（见 docs/OVERLAY-STAGES.md 的来源标注要求）。
    }
  }
}

/**
 * 画局内强度评级：**发光 → 深色描边 → 字母本体 → 两侧尖括号 → 选取率行**。
 *
 * 与 `scripts/preview-augment-labels.mts` 的 `drawTierTag()` **同序同参**
 * （唯一差别是 canvas 画矢量字形、预览画内置字形/点阵）：
 *   · 发光/描边的"外扩量"由 `plan.glow.layers[].reach` 与 `letter.outlineWidth` 给，
 *     canvas 一律用 `lineWidth = 2 × reach`（居中描边 → 向外扩 reach）；
 *   · 尖括号是计划里的**折线点**，逐点 `lineTo` —— 两边形状逐点一致。
 */
function drawTierTag(
  ctx: CanvasRenderingContext2D,
  tag: TierTagPlan,
  text: string,
  sub: string,
): void {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = tag.letter.font;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // ① 发光：由宽到窄多层加宽描边（计划里已按内亮外淡排好序）
  for (const layer of [...tag.glow.layers].reverse()) {
    ctx.lineWidth = layer.reach * 2;
    ctx.strokeStyle = rgbaCss(layer.rgba);
    ctx.strokeText(text, tag.letter.textX, tag.letter.textY);
  }
  // ② 深色描边：给彩色字母定形（否则在亮背景上会糊）
  ctx.lineWidth = tag.letter.outlineWidth;
  ctx.strokeStyle = tag.letter.outlineColor;
  ctx.strokeText(text, tag.letter.textX, tag.letter.textY);
  // ③ 字母本体
  ctx.fillStyle = tag.letter.fillColor;
  ctx.fillText(text, tag.letter.textX, tag.letter.textY);

  // ④ 两侧尖括号（折线；颜色/线宽/点位全部来自计划）
  ctx.strokeStyle = tag.bracketColor;
  for (const bracket of tag.brackets) {
    const first = bracket.points[0];
    if (!first) continue;
    ctx.beginPath();
    ctx.moveTo(first[0], first[1]);
    for (const p of bracket.points.slice(1)) ctx.lineTo(p[0], p[1]);
    ctx.lineWidth = bracket.width;
    ctx.stroke();
  }

  // ⑤ 选取率那一行（空串 = 查不到/为 0 → 不画；字母位置不受影响）
  if (sub !== '') {
    ctx.fillStyle = tag.rate.color;
    ctx.font = tag.rate.font;
    ctx.fillText(sub, tag.rate.textX, tag.rate.textY);
  }
  ctx.restore();
}

api.onVision((m) => draw(m));
