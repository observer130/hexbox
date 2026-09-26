/**
 * S2 覆盖层渲染端：全屏透明画布,按主进程推送的标签绝对定位绘制。
 *
 * 只读 `overlay:vision` 推送,不持有任何状态源 —— 识别与换算全在主进程
 * （vision-loop）与纯函数（vision/card-overlay）里。
 *
 * 绘制约定：
 *   - 标签 = 深色圆角底 + 胜率大字 + 英雄名小字
 *   - hasData=false 灰色（「暂无数据」）,绝不猜一个数字
 *   - inactive 时清空画布（透明）
 */

interface VisionLabel {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  sub: string;
  hasData: boolean;
  championId: number;
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

/** 最近一次推送的消息;resize/画布重设后用它重绘,避免清空后空白。 */
let lastMsg: VisionMsg | null = null;

function resizeCanvas(): void {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  // 画布尺寸变化会清空内容 —— 用最近消息重绘
  if (lastMsg) draw(lastMsg);
}
window.addEventListener('resize', () => {
  resizeCanvas();
});
resizeCanvas();

// 覆盖窗口换显示器时,主进程会推 overlay:resize（setBounds 后 resize 事件
// 顺序不保证,显式同步一次,避免画布尺寸与窗口不符导致内容裁切）
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
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!msg.active) return;

  for (const l of msg.labels) {
    const accent = l.hasData ? '#4ade80' : '#8b96ad';
    // 底
    ctx.fillStyle = 'rgba(10, 14, 24, 0.88)';
    roundRect(ctx, l.x, l.y, l.w, l.h, 6);
    ctx.fill();
    ctx.strokeStyle = l.hasData ? 'rgba(74, 222, 128, 0.5)' : 'rgba(139, 150, 173, 0.4)';
    ctx.lineWidth = 1;
    roundRect(ctx, l.x, l.y, l.w, l.h, 6);
    ctx.stroke();

    // 胜率（大字）
    ctx.fillStyle = accent;
    ctx.font = `700 ${Math.round(l.h * 0.52)}px "Microsoft YaHei", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(l.text, l.x + 10, l.y + l.h * 0.46);

    // 英雄名（小字,右上）
    ctx.fillStyle = '#c8a84e';
    ctx.font = `600 ${Math.round(l.h * 0.3)}px "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText(l.sub, l.x + l.w - 10, l.y + l.h * 0.42);
    ctx.textAlign = 'left';

    // 脚注:数据出处
    ctx.fillStyle = 'rgba(139, 150, 173, 0.75)';
    ctx.font = `400 ${Math.round(l.h * 0.2)}px "Microsoft YaHei", sans-serif`;
    ctx.fillText('101 官方统计', l.x + 10, l.y + l.h * 0.82);
  }
}

api.onVision((m) => draw(m));
