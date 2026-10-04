/**
 * 验证：用【真实客户端窗口矩形】算出的标签，是否落在真机截图的卡片/槽位上
 *
 * 几何来源（三方吻合的实测结论）：选人界面由客户端窗口绘制，
 * 其矩形为 1600x900 @ 346,6（CSS），由整屏截图反推 + 窗口枚举共同确认。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  cardLabelFor,
  decodePng,
  encodePng,
  slotLabelFor,
  topBarSlotRects,
  type CardLabel,
} from '../packages/vision/src/index.ts';

/** 工作区（整屏截图覆盖它）。 */
const WORK = { x: 0, y: 0, width: 2294, height: 912 };
/** ⭐ 真实客户端窗口矩形（旧代码错当成 1707x960@0,0）。 */
const WIN = { x: 346, y: 6, width: 1600, height: 900 };
/** 与 makeScreenGeometry 的「窗口快照」形态一致：截屏=窗口内容，无偏移。 */
const GEO = {
  captureWidth: 3413,
  captureHeight: 1920,
  windowX: WIN.x,
  windowY: WIN.y,
  windowWidth: WIN.width,
  windowHeight: WIN.height,
};

/** vision-loop 真机日志里报出的卡片归一化矩形。 */
const CARDS_SHOT1 = [
  { x: 0.341, y: 0.249, w: 0.146, h: 0.413 },
  { x: 0.510, y: 0.249, w: 0.147, h: 0.413 },
];

function annotate(file: string, labels: CardLabel[], out: string): void {
  const p = decodePng(new Uint8Array(readFileSync(file)));
  const W = p.width;
  const H = p.height;
  const k = W / WORK.width; // CSS → 截图像素
  const d = new Uint8ClampedArray(p.data);
  const fill = (x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number): void => {
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(H, Math.round(y1)); y++) {
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(W, Math.round(x1)); x++) {
        const i = (y * W + x) * 4;
        d[i] = r;
        d[i + 1] = g;
        d[i + 2] = b;
        d[i + 3] = 255;
      }
    }
  };
  console.log(`\n${file} → ${out}  (CSS→px ${k.toFixed(3)})`);
  for (const l of labels) {
    const x0 = l.x * k;
    const y0 = l.y * k;
    const x1 = (l.x + l.w) * k;
    const y1 = (l.y + l.h) * k;
    fill(x0, y0, x1, y1, 10, 14, 24);
    fill(x0, y0, x1, y0 + 3, 74, 222, 128);
    fill(x0, y1 - 3, x1, y1, 74, 222, 128);
    fill(x0, y0, x0 + 3, y1, 74, 222, 128);
    fill(x1 - 3, y0, x1, y1, 74, 222, 128);
    console.log(
      `  标签 CSS x=${l.x.toFixed(0)}..${(l.x + l.w).toFixed(0)} y=${l.y.toFixed(0)}..${(l.y + l.h).toFixed(0)}`,
    );
  }
  writeFileSync(out, encodePng({ width: W, height: H, data: d }));
}

/* ── 第一阶段：卡片标签 ── */
{
  const labels = CARDS_SHOT1.map((r, i) =>
    cardLabelFor(r, GEO, WORK, {
      name: i === 0 ? '傲之追猎者' : '狂野女猎手',
      winRate: 0.486,
      hasData: true,
      championId: i === 0 ? 107 : 76,
    }),
  );
  // 与真机实测的卡片位置对照
  const card0 = { x: GEO.windowX + 0.341 * GEO.windowWidth, w: 0.146 * GEO.windowWidth };
  console.log('对照：卡片真机实测 CSS x=893..1127（宽 234）');
  console.log(`      代码算出卡片 CSS x=${card0.x.toFixed(0)}..${(card0.x + card0.w).toFixed(0)}（宽 ${card0.w.toFixed(0)}）`);
  annotate('debug/real/shot1.png', labels, 'debug/real/verify1.png');
}

/* ── 第二阶段：顶栏槽位标签 ── */
{
  const slots = topBarSlotRects();
  console.log('\n对照：顶栏槽位1 真机实测 CSS x=786..847');
  console.log(
    `      代码算出槽位1 CSS x=${(GEO.windowX + slots[0]!.x * GEO.windowWidth).toFixed(0)}` +
      `..${(GEO.windowX + (slots[0]!.x + slots[0]!.w) * GEO.windowWidth).toFixed(0)}`,
  );
  const labels = [
    slotLabelFor(slots[0]!, GEO, WORK, {
      name: '傲之追猎者',
      winRate: 0.486,
      hasData: true,
      championId: 107,
    }),
  ];
  annotate('debug/real/shot2.png', labels, 'debug/real/verify2.png');
}
