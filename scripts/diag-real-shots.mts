/**
 * 诊断：在**真机截图**上跑真实识别 + 标签布局，并把结果合成回图上
 *
 * 为什么这么做：真机坐标问题曾长期靠"推算 + 目测缩略图"来改，连续改错方向
 * （缩略图会被再次缩放，1.5 倍图当 1:1 读是真实踩过的坑）。本脚本用真机截图
 * 作为输入，走与 vision-loop 完全相同的代码路径，再把标签画回图上，
 * 最后**用像素扫描**判断标签是否落在正确位置。
 *
 * 用法：
 *   1. 把两张真机截图放到 `debug/real/phase1.png`（选人第一阶段）与
 *      `debug/real/phase2.png`（第二阶段，顶栏有头像）。
 *      这两个文件不入库（`debug/` 在 .gitignore 里，且含个人信息）。
 *   2. `node --experimental-strip-types scripts/diag-real-shots.mts`
 *   3. 输出 `debug/real/phase{1,2}-annotated.png`，直接看标签落点。
 *
 * 几何取自真机日志：显示器 2294x960 @1.5、游戏窗口 1706x960（截屏为其 2 倍）。
 * 截图本身是游戏窗口内容（16:9），故 归一化 × 截图尺寸 = 截图像素。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  cardLabelFor,
  countOccupiedSlots,
  decodePng,
  detectCards,
  detectTopBarCandidates,
  encodePng,
  extractGrayRaw,
  extractNameStrip,
  isSlotOccupied,
  makeScreenGeometry,
  matchNameCareful,
  prepareTemplates,
  slotLabelFor,
  topBarSlotRects,
  windowRectToCapture,
  base64ToBits,
  decodePack,
  denormalizeToGray,
  NAME_STRIP,
  type CardLabel,
  type NameFingerprint,
  type PreparedTemplate,
} from '../packages/vision/src/index.ts';

/* ---------- 真机几何（来自日志） ---------- */
const DISPLAY = {
  bounds: { x: 0, y: 0, width: 2294, height: 960 },
  scaleFactor: 1.5,
  workArea: { x: 0, y: 0, width: 2294, height: 912 },
};
const WINDOW = { x: 0, y: 0, width: 1706, height: 960 };

/* ---------- 模板 ---------- */
const pack = decodePack(readFileSync('data/templates.json', 'utf8'));
const portraits: PreparedTemplate[] = prepareTemplates(
  pack.templates
    .filter((t) => t.championId > 0)
    .map((t) => ({ championId: t.championId, size: t.size, gray: denormalizeToGray(t.norm, t.size) })),
);
const nameLibrary: NameFingerprint[] = (pack.names ?? []).map((n) => ({
  championId: n.championId,
  name: n.name,
  width: n.width,
  height: n.height,
  bits: base64ToBits(n.bits, n.width * n.height),
}));
const champions: Record<number, string> = {};
for (const n of nameLibrary) champions[n.championId] = n.name;

function labelOf(id: number, winRate: number, hasData: boolean): { name: string } {
  return { name: champions[id] ?? `#${id}` };
}

/* ---------- 画标注 ---------- */
function annotate(
  src: Uint8ClampedArray,
  W: number,
  H: number,
  labels: CardLabel[],
  toPx: number,
  out: string,
): void {
  const d = new Uint8ClampedArray(src);
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
  for (const l of labels) {
    const x0 = l.x * toPx;
    const y0 = l.y * toPx;
    const x1 = (l.x + l.w) * toPx;
    const y1 = (l.y + l.h) * toPx;
    fill(x0, y0, x1, y1, 10, 14, 24);
    fill(x0, y0, x1, y0 + 3, 74, 222, 128);
    fill(x0, y1 - 3, x1, y1, 74, 222, 128);
    fill(x0, y0, x0 + 3, y1, 74, 222, 128);
    fill(x1 - 3, y0, x1, y1, 74, 222, 128);
  }
  writeFileSync(out, encodePng({ width: W, height: H, data: d }));
  console.log(`  → ${out}`);
}

/* ================= 第一阶段 ================= */
{
  const file = 'debug/real/phase1.png';
  const p = decodePng(new Uint8Array(readFileSync(file)));
  const bmp = { width: p.width, height: p.height, data: p.data };
  const geo = makeScreenGeometry(bmp, WINDOW, DISPLAY).geo;
  // CSS → 截图 px（截图是窗口内容的 1.403 倍）
  const toPx = p.width / geo.windowWidth;
  console.log(`\n===== 第一阶段 ${file} ${p.width}x${p.height} =====`);
  console.log(`geo=${JSON.stringify(geo)}  CSS→px 系数=${toPx.toFixed(4)}`);

  const det = detectCards(bmp);
  console.log(`detectCards: 置信=${det.confident} reason=${det.reason}`);
  const labels: CardLabel[] = [];
  for (const [i, rect] of det.cards.entries()) {
    const stripRect = {
      x: rect.x + (rect.w * (1 - NAME_STRIP.width)) / 2,
      y: rect.y + (rect.h * NAME_STRIP.yCenter - (rect.h * NAME_STRIP.height) / 2),
      w: rect.w * NAME_STRIP.width,
      h: rect.h * NAME_STRIP.height,
    };
    const raw = extractGrayRaw(bmp, stripRect);
    let id = 0;
    let score = 0;
    let margin = 0;
    if (raw) {
      const strip = extractNameStrip(raw.gray, raw.width, raw.height);
      const m = matchNameCareful(strip, nameLibrary);
      if (m) {
        id = m.championId;
        score = m.score;
        margin = m.margin;
      }
    }
    const box = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    console.log(
      `  卡${i + 1} 归一化 x=${box.x.toFixed(3)} y=${box.y.toFixed(3)} w=${box.w.toFixed(3)} h=${box.h.toFixed(3)}` +
        ` (截图 px: x=${Math.round(box.x * p.width)}..${Math.round((box.x + box.w) * p.width)}` +
        ` y=${Math.round(box.y * p.height)}..${Math.round((box.y + box.h) * p.height)})`,
    );
    if (raw) {
      const strip0 = extractNameStrip(raw.gray, raw.width, raw.height);
      const m2 = matchNameCareful(strip0, nameLibrary);
      console.log(
        `       名字区 px: x=${Math.round(stripRect.x * p.width)}..${Math.round((stripRect.x + stripRect.w) * p.width)}` +
          ` y=${Math.round(stripRect.y * p.height)}..${Math.round((stripRect.y + stripRect.h) * p.height)}` +
          ` | 识别=${id > 0 ? champions[id] : '拒绝'} 得分=${score.toFixed(3)} 分差=${margin.toFixed(3)}` +
          (m2 ? '' : ' (被门槛拒绝)'),
      );
    }
    if (id > 0) {
      labels.push(
        cardLabelFor(rect, geo, DISPLAY.workArea, {
          name: champions[id] ?? '',
          winRate: 0.485,
          hasData: true,
          championId: id,
        }),
      );
    }
  }
  console.log(`  出标签 ${labels.length} 个：`);
  for (const l of labels) {
    console.log(
      `    ${l.text} @CSS(${l.x.toFixed(0)},${l.y.toFixed(0)}) ${l.w}x${l.h}` +
        ` → 截图 px(${Math.round(l.x * toPx)},${Math.round(l.y * toPx)})`,
    );
  }
  annotate(p.data, p.width, p.height, labels, toPx, 'debug/real/phase1-annotated.png');
}

/* ================= 第二阶段 ================= */
{
  const file = 'debug/real/phase2.png';
  const p = decodePng(new Uint8Array(readFileSync(file)));
  const bmp = { width: p.width, height: p.height, data: p.data };
  const g = makeScreenGeometry(bmp, WINDOW, DISPLAY);
  const geo = g.geo;
  const toPx = p.width / geo.windowWidth;
  console.log(`\n===== 第二阶段 ${file} ${p.width}x${p.height} =====`);
  console.log(`kind=${g.kind} geo=${JSON.stringify(geo)}  CSS→px 系数=${toPx.toFixed(4)}`);

  const slots = topBarSlotRects().map((r) => windowRectToCapture(r, bmp, WINDOW, DISPLAY));
  const occ = countOccupiedSlots(bmp, slots);
  console.log(`顶栏占用 ${occ} / ${slots.length} 格`);
  for (const [k, s] of slots.entries()) {
    console.log(
      `  格${String(k + 1).padStart(2)} 归一化 x=${s.x.toFixed(4)}..${(s.x + s.w).toFixed(4)}` +
        ` → 截图 px x=${Math.round(s.x * p.width)}..${Math.round((s.x + s.w) * p.width)}` +
        ` y=${Math.round(s.y * p.height)}..${Math.round((s.y + s.h) * p.height)}` +
        ` 占用=${isSlotOccupied(bmp, s) ? '是' : '否'}`,
    );
  }
  const cands = detectTopBarCandidates(bmp, slots, portraits);
  console.log(`识别成功 ${cands.length} 格：`);
  for (const c of cands) {
    console.log(
      `  索引 ${c.slotIndex}（第 ${c.slotIndex + 1} 格）= ${champions[c.championId] ?? c.championId} 得分=${c.score.toFixed(3)}`,
    );
  }
  const labels: CardLabel[] = cands.map((c) =>
    slotLabelFor(slots[c.slotIndex]!, geo, DISPLAY.workArea, {
      name: champions[c.championId] ?? '',
      winRate: 0.411,
      hasData: true,
      championId: c.championId,
    }),
  );
  for (const l of labels) {
    console.log(
      `  标签 ${l.text} @CSS(${l.x.toFixed(0)},${l.y.toFixed(0)}) ${l.w}x${l.h}` +
        ` → 截图 px(${Math.round(l.x * toPx)},${Math.round(l.y * toPx)})`,
    );
  }
  annotate(p.data, p.width, p.height, labels, toPx, 'debug/real/phase2-annotated.png');
}
