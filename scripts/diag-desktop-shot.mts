/**
 * 诊断：在"整屏截图（含桌面）"上量出 ①游戏窗口边界 ②覆盖层标签位置
 *
 * 目的：真机日志说标签画在 CSS(469,84)，而用户截图看起来在左上角。
 * 需要把截图像素换算成 CSS 才能对比 —— 整屏截图对应工作区 2294x912。
 */
import { readFileSync } from 'node:fs';
import { decodePng } from '../packages/vision/src/index.ts';

const file = process.argv[2]!;
const p = decodePng(new Uint8Array(readFileSync(file)));
const W = p.width;
const H = p.height;
console.log(`图 ${file} ${W}x${H}  比例=${(W / H).toFixed(3)}`);
// 整屏截图 = 工作区 2294x912 CSS
const k = 2294 / W;
console.log(`px → CSS 系数 = ${k.toFixed(4)}（假设截图覆盖工作区 2294x912）`);

const at = (x: number, y: number): [number, number, number] => {
  const i = (y * W + x) * 4;
  return [p.data[i]!, p.data[i + 1]!, p.data[i + 2]!];
};

/* ① 找绿色标签框（渲染端边框 #4ade80，文字同色） */
const green = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const [r, g, b] = at(x, y);
    if (g > 90 && g - r > 25 && g - b > 25) green[y * W + x] = 1;
  }
}
const seen = new Uint8Array(W * H);
const stack: number[] = [];
const boxes: Array<{ x0: number; y0: number; x1: number; y1: number; n: number }> = [];
for (let s = 0; s < W * H; s++) {
  if (!green[s] || seen[s]) continue;
  stack.length = 0;
  stack.push(s);
  seen[s] = 1;
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  let n = 0;
  while (stack.length) {
    const q = stack.pop()!;
    const x = q % W;
    const y = (q - x) / W;
    n++;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
    if (x > 0 && green[q - 1] && !seen[q - 1]) ((seen[q - 1] = 1), stack.push(q - 1));
    if (x < W - 1 && green[q + 1] && !seen[q + 1]) ((seen[q + 1] = 1), stack.push(q + 1));
    if (y > 0 && green[q - W] && !seen[q - W]) ((seen[q - W] = 1), stack.push(q - W));
    if (y < H - 1 && green[q + W] && !seen[q + W]) ((seen[q + W] = 1), stack.push(q + W));
  }
  if (n >= 100) boxes.push({ x0, y0, x1, y1, n });
}
boxes.sort((a, b) => b.n - a.n);
console.log(`\n绿色连通域 ${boxes.length} 个（最大 5 个）→ px 与换算 CSS：`);
for (const b of boxes.slice(0, 5)) {
  console.log(
    `  px x=${b.x0}..${b.x1} y=${b.y0}..${b.y1} (${b.x1 - b.x0 + 1}x${b.y1 - b.y0 + 1}) n=${b.n}` +
      `  → CSS x=${(b.x0 * k).toFixed(0)}..${(b.x1 * k).toFixed(0)} y=${(b.y0 * k).toFixed(0)}..${(b.y1 * k).toFixed(0)}`,
  );
}

/* ② 找顶栏那一排格子：在候选行带上找等距竖直边缘 */
function edgesInBand(y0: number, y1: number): number[] {
  const lum: number[] = [];
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let y = y0; y <= y1; y++) {
      const i = (y * W + x) * 4;
      s += 0.299 * p.data[i]! + 0.587 * p.data[i + 1]! + 0.114 * p.data[i + 2]!;
    }
    lum.push(s / (y1 - y0 + 1));
  }
  const out: number[] = [];
  for (let x = 1; x < W; x++) {
    if (Math.abs(lum[x]! - lum[x - 1]!) > 8) {
      if (out.length === 0 || x - out[out.length - 1]! > 6) out.push(x);
    }
  }
  return out;
}

// 顶栏在 CSS y≈13..80（归一化 0.0139..0.0837 × 960）→ 预览 px
const topY0 = Math.round((13 / k));
const topY1 = Math.round((80 / k));
console.log(`\n顶栏行带 px y=${topY0}..${topY1}（CSS 13..80）的竖直边缘：`);
const edges = edgesInBand(topY0, Math.min(H - 1, topY1));
console.log('  ' + edges.join(' '));
console.log('  换算 CSS：' + edges.map((e) => Math.round(e * k)).join(' '));

/* ③ 找游戏窗口左边界：在顶栏行带上找"从桌面亮色进入游戏暗色"的突变 */
let gameLeft = -1;
for (let x = 1; x < W; x++) {
  let dark = 0;
  for (let y = topY0; y <= Math.min(H - 1, topY1); y++) {
    const i = (y * W + x) * 4;
    const l = 0.299 * p.data[i]! + 0.587 * p.data[i + 1]! + 0.114 * p.data[i + 2]!;
    if (l < 60) dark++;
  }
  if (dark > (topY1 - topY0) * 0.8) {
    gameLeft = x;
    break;
  }
}
console.log(
  `\n顶栏行带上第一段"持续暗"列 = px ${gameLeft} → CSS ${Math.round(gameLeft * k)}` +
    `（游戏窗口左缘的近似值）`,
);

