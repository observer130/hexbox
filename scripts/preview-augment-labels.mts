/**
 * 离线预览：海克斯强度标签的三档预设 —— **不用开游戏、不用进对局**
 *
 * 用途：真机上觉得"标签太大/太小/不好看"时，不必再花一局去试。这里拿**真实面板帧**
 * 当底图，用**线上同一份代码**算标签、按**渲染端同一份绘制计划**画上去，一张图给出
 * 「小 / 中 / 大」三档（分别用 S / A / B 三个档位字母，正好覆盖参考图里的三种档位色），
 * 挑完再进对局确认。
 *
 * 2026-10-06（用户："S/A/B/C 的字体太难看了，优化一下"）之后：
 *   · 档位字母用**与局内同一套真字体**（字体栈首项 Segoe UI Black，900）的
 *     **轮廓数据**（`packages/vision/src/label-letter-outlines.ts`）画 —— 不再是内置单线字形，
 *     所以"预览里看到的字母形状"就是"局内看到的形状"（只差 hinting）；
 *   · 默认一次画**两套候选风格**（`--style a|b|both`，见 `TIER_TREATMENTS`），
 *     上下两行同图对照，用户挑一个，改 `label-draw.ts` 的 `TIER_TREATMENT` 一行即可。
 *
 * 数据链路（每一步都是线上代码，脚本里没有第二份几何/配色/文案）：
 *
 *   decodePng(真机帧)                        → Bitmap
 *   detectAugmentPanel(bmp)                  → 三张卡矩形（判据与局内完全相同）
 *   augmentTierLabels(cards, 表, { preset })  → 标签矩形 + 档位色 + 字号比例 + 文案
 *                                              （字母 + 「选取率 12.1%」都由它给）
 *   labelBoxPlan(rect, { style:'tier', text, treatment })
 *                                            → 渲染端同一份绘制计划
 *                                              （字体/描边/发光分层/尖括号折线/选取率行/
 *                                                视觉居中偏移）
 *   drawTierLetter / label-raster / label-glyph / label-cjk
 *                                            → 软件光栅化（Node 里没有 canvas）
 *   encodePng                                 → debug/label-preview.png
 *
 * 与局内的关系（**必须一致**，用户 2026-10-05 明确要求）：
 *   · 几何与字号：同一份 `AUGMENT_BADGE_PRESETS` + `augmentLabelRect` + `labelBoxPlan`；
 *   · 配色：同一份 `AUGMENT_TIER_COLORS`（S 金 / A 红 / B 青蓝 / C 灰）；
 *   · 排版：同一份 `tierTagPlan()`（视觉居中、发光分层、尖括号折线点、选取率行的字号与基线）；
 *   · 字形：同一套字体（`label-letter-outlines.ts` 的轮廓 = 字体栈首项的字形）；
 *   · 差别只剩"hinting/网格拟合"与"描边/发光用距离场代替 strokeText"这两条实现层面的事，
 *     位置、字号、颜色、居中完全一致。
 *
 * 单位换算（真机实测，见 docs/AUGMENT-PANEL.md §十三）：
 *   帧 4587×1920 ← 显示器 3440×1440 物理像素（×4/3）← 1.5 倍缩放 → 2293×960 DIP
 *   所以 帧像素 = 2 × DIP、= 4/3 × 屏幕物理像素。`--display` / `--scale` 可改。
 *
 * 用法：
 *   node --experimental-strip-types scripts/preview-augment-labels.mts
 *   node --experimental-strip-types scripts/preview-augment-labels.mts <帧.png> [更多帧…]
 *   … --full          不裁剪（整帧；默认裁到卡片行附近）
 *   … --out <path>    输出路径（默认 debug/label-preview.png）
 *   … --preset <档>   三张卡都用这一档（small|medium|large）——看"上线那一档"的实际观感
 *   … --style a|b|both  只画某套描边/发光风格（默认 both：两套上下对照）
 *   … --display 3440x1440 --scale 1.5   真机显示器与缩放（只影响打印的像素/字号换算）
 *
 * 合规：只读本地 PNG 像素。不联网、不开游戏、不注入、不读内存。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  ASCII_GLYPH_H,
  asciiTextWidth,
  augmentTierLabels,
  augmentTierLabelsLocked,
  cropBitmap,
  decodePng,
  detectAugmentPanel,
  drawAsciiText,
  drawGlowGlyph,
  drawRateLine,
  drawTierLetter,
  drawVectorGlyph,
  encodePng,
  fillRect,
  labelBoxPlan,
  labelFontSize,
  normalizedRectToScreen,
  outlineStrokeRatio,
  strokePolyline,
  strokeRoundedRect,
  tierLetterEmMetrics,
  tierTagBounds,
  AUGMENT_BADGE_DEFAULT,
  AUGMENT_BADGE_PRESETS,
  TIER_TREATMENT,
  TIER_TREATMENTS,
  alignRowLabels,
  augmentBadgeZone,
  augmentLabelRect,
  type AugmentBadgeSize,
  type AugmentTierLabel,
  type Bitmap,
  type LabelBoxPlan,
  type Rect,
  type TierTreatmentName,
  type TierTagPlan,
} from '../packages/vision/src/index.ts';

/* ------------------------------------------------------------------ */
/* 命令行                                                              */
/* ------------------------------------------------------------------ */

interface Cli {
  readonly frames: readonly string[];
  readonly out: string;
  readonly full: boolean;
  readonly preset: AugmentBadgeSize | null;
  readonly displayW: number;
  readonly displayH: number;
  readonly scale: number;
  /** 要对照的风格（默认两套都画；顺序 = 图上从上到下的顺序）。 */
  readonly treatments: readonly TierTreatmentName[];
}

/** 默认底图：真机面板帧（3 张卡，正好一档一张）。 */
const DEFAULT_FRAME = join('debug', 'shots', 'inprogress-152515-raw.png');

function parseArgs(argv: readonly string[]): Cli {
  const frames: string[] = [];
  let out = join('debug', 'label-preview.png');
  let full = false;
  let preset: AugmentBadgeSize | null = null;
  let displayW = 3440;
  let displayH = 1440;
  let scale = 1.5;
  let treatments: readonly TierTreatmentName[] = ['a', 'b'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--full') full = true;
    else if (a === '--out') out = argv[++i] ?? out;
    else if (a === '--preset') {
      const v = (argv[++i] ?? '').trim().toLowerCase();
      if (v === 'small' || v === 'medium' || v === 'large') preset = v;
      else console.warn(`⚠ 不认识的 --preset「${v}」→ 忽略（仍按三档各画一张）`);
    } else if (a === '--style') {
      const v = (argv[++i] ?? '').trim().toLowerCase();
      if (v === 'a' || v === 'b') treatments = [v];
      else if (v === 'both') treatments = ['a', 'b'];
      else console.warn(`⚠ 不认识的 --style「${v}」→ 忽略（仍按两套对照画）`);
    } else if (a === '--display') {
      const m = /^(\d+)x(\d+)$/i.exec(argv[++i] ?? '');
      if (m) {
        displayW = Number(m[1]);
        displayH = Number(m[2]);
      }
    } else if (a === '--scale') {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v > 0) scale = v;
    } else if (!a.startsWith('--')) frames.push(a);
  }
  return { frames: frames.length > 0 ? frames : [DEFAULT_FRAME], out, full, preset, displayW, displayH, scale, treatments };
}

const cli = parseArgs(process.argv.slice(2));

/* ------------------------------------------------------------------ */
/* 三个候选大小 × 三个字母（S 金 / A 红 / B 青蓝 = 参考图的三种档位色）    */
/* ------------------------------------------------------------------ */

interface PreviewRow {
  /** 候选序号（1/2/3）—— 用户就是按这个挑"上线哪一档"。 */
  readonly candidate: number;
  readonly size: AugmentBadgeSize;
  readonly tier: string;
  /** 假的选取率（0..1）——真机上来自该英雄的 `augments[].pickRate`。 */
  readonly pickRate: number;
}

/**
 * 预览用的三档 = **三个候选大小**（正好覆盖参考图里的三种档位色；C 是中性灰，见 §十三）。
 *
 * 2026-10-06 用户："S/A/B/C 字母太大了，应该小一些" → 三档整体缩小后，
 * 这里把它们当"候选 1/2/3"同图并列，并标注各自的 **cap 高占卡高比**，
 * 一次就能挑定默认档（`AUGMENT_BADGE_DEFAULT`）。
 */
/** 档 → 候选号（同图对照时用；`--preset` 时也按它标，免得"候选 1 却写着 large"）。 */
const CANDIDATE_OF: Readonly<Record<AugmentBadgeSize, number>> = { small: 1, medium: 2, large: 3 };

const PREVIEW_ROWS: readonly PreviewRow[] = [
  { candidate: CANDIDATE_OF.small, size: 'small', tier: 'S', pickRate: 0.1993 },
  { candidate: CANDIDATE_OF.medium, size: 'medium', tier: 'A', pickRate: 0.1214 },
  { candidate: CANDIDATE_OF.large, size: 'large', tier: 'B', pickRate: 0.0731 },
];

/** 假强度表用的 augmentId（真实档位以英雄为准，这里只为配色/文字/选取率）。 */
const PREVIEW_ID = 900001;

/* ------------------------------------------------------------------ */
/* 位图小工具                                                          */
/* ------------------------------------------------------------------ */

/** 一组归一化纵向坐标的极差（乘 `scale` 换成目标单位）。 */
function spread(values: readonly number[], scale: number): number {
  return (Math.max(...values) - Math.min(...values)) * scale;
}

/** 若干矩形的并集（归一化坐标，同一坐标系）。 */function unionRect(rects: readonly Rect[]): Rect {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 卡片行外扩一圈（默认 4.5%）——裁掉与标签无关的画面，让标签看得清。 */
function paddedCrop(row: Rect, pad: number): Rect {
  const x = Math.max(0, row.x - pad);
  const y = Math.max(0, row.y - pad * 0.9);
  return {
    x,
    y,
    w: Math.min(1 - x, row.w + pad * 2),
    h: Math.min(1 - y, row.h + pad * 1.8),
  };
}

/** 位图深拷贝（两套风格要在**同一帧**上各画一遍，不能互相污染）。 */
function cloneBitmap(bmp: Bitmap): Bitmap {
  return { width: bmp.width, height: bmp.height, data: new Uint8ClampedArray(bmp.data) };
}

/** 纵向拼接（宽度必须一致；不同宽度的帧按最小宽度裁齐）。 */
function stackVertically(images: readonly Bitmap[]): Bitmap {
  const width = Math.min(...images.map((i) => i.width));
  const height = images.reduce((n, i) => n + i.height, 0);
  const data = new Uint8ClampedArray(width * height * 4);
  let y = 0;
  for (const img of images) {
    for (let row = 0; row < img.height; row++) {
      const src = row * img.width * 4;
      data.set(img.data.subarray(src, src + width * 4), (y + row) * width * 4);
    }
    y += img.height;
  }
  return { width, height, data };
}

/**
 * 在图上方贴一条**深色标题带**（用内置 5×7 点阵，所以只能是 ASCII）。
 *
 * 两套风格上下叠在一张图里，没有标题带就分不清哪行是哪套。
 */
function withHeader(bmp: Bitmap, lines: readonly string[]): Bitmap {
  const scale = 3;
  const lineH = (ASCII_GLYPH_H + 2) * scale;
  const headH = lineH * lines.length + 14;
  const out: Bitmap = {
    width: bmp.width,
    height: bmp.height + headH,
    data: new Uint8ClampedArray(bmp.width * (bmp.height + headH) * 4),
  };
  fillRect(out, { x: 0, y: 0, w: out.width, h: headH }, { r: 10, g: 12, b: 18, a: 1 });
  lines.forEach((t, i) => {
    drawAsciiText(out, t, 16, 8 + i * lineH, scale, { r: 236, g: 240, b: 248, a: 1 });
  });
  for (let y = 0; y < bmp.height; y++) {
    const src = y * bmp.width * 4;
    out.data.set(bmp.data.subarray(src, src + bmp.width * 4), (headH + y) * bmp.width * 4);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 画一条标签（= 渲染端那一套，只是把 canvas 换成软件光栅化）              */
/* ------------------------------------------------------------------ */

interface DrawnRow {
  readonly candidate: number;
  readonly size: AugmentBadgeSize;
  readonly tier: string;
  readonly pickRate: number;
  /** 标签矩形（截屏归一化）。 */
  readonly rect: Rect;
  /** 标签框顶（帧像素）—— 行对齐核对就是比这个（以及基线）。 */
  readonly yFrame: number;
  readonly baselineFrame: number;
  /** 帧像素尺寸 / 局内 DIP 尺寸 / 屏幕物理像素尺寸。 */
  readonly frameW: number;
  readonly frameH: number;
  readonly dipW: number;
  readonly dipH: number;
  readonly screenW: number;
  readonly screenH: number;
  /** 字母 cap 高（三套单位）。 */
  readonly capFrame: number;
  readonly capDip: number;
  readonly capScreen: number;
  /** 字母 cap 高 / 卡高（挑尺寸看的就是它；目标 0.065~0.075）。 */
  readonly capOfCard: number;
  /** 字号：帧像素（软件光栅化用）/ DIP（局内 canvas 用）/ 屏幕物理像素。 */
  readonly fontFramePx: number;
  readonly fontDip: number;
  readonly fontScreenPx: number;
  /** canvas 的 `font` 串（字体族 + 字重 + 字号，打印出来核对用）。 */
  readonly font: string;
  /** 整条内容宽（帧像素 / 卡宽占比）——核对"尖括号不越出卡宽"。 */
  readonly contentFrameW: number;
  readonly contentShareOfCard: number;
  /** 选取率那一行的字号（DIP）。 */
  readonly rateDip: number;
  /** 选取率那一行的文案（空 = 没数据 → 那一行不画）。 */
  readonly subText: string;
  /** 深色描边线宽（帧像素 / DIP）与发光总半径、各层半径（帧像素）。 */
  readonly outlineFrame: number;
  readonly outlineDip: number;
  readonly glowFrame: number;
  readonly glowDip: number;
  readonly glowLayers: readonly number[];
  /** 发光外廓下沿 ↔ 选取率墨迹上沿（DIP；正 = 有间隙，负 = 重叠）—— 走 `tierTagBounds()`。 */
  readonly clearanceDip: number;
  /** 视觉居中偏移（帧像素；正 = 字母向右挪，展示型字体常见的修正）。 */
  readonly centerOffsetFrame: number;
  /** 有没有用真字体轮廓（false = 回退到内置单线字形）。 */
  readonly realGlyph: boolean;
}

/** 卡片下沿之外的两行 ASCII 标注（默认按候选号/尺寸生成，行对齐那一段自己给）。 */
interface Anno {
  readonly head: string;
  readonly note: string;
}

/**
 * 画一条标签：`label` **必须由线上代码算好**（`augmentTierLabels()` —— 它同时
 * 负责"认不准/查不到不画"的过滤与**整排纵向对齐**），本函数只做绘制与量尺寸。
 *
 * ⚠️ 绘制序列与 `apps/overlay/src/renderer/overlay-canvas.ts` 的 `drawTierTag()`
 * **一一对应**：发光（宽→窄）→ 深色描边 → 字母本体 → 尖括号折线 → 选取率行。
 * 所有参数（含尖括号的折线点、发光每层的半径与 alpha）都取自 `labelBoxPlan()`。
 */
function drawLabel(
  bmp: Bitmap,
  card: Rect,
  label: AugmentTierLabel,
  row: PreviewRow,
  pxPerDip: number,
  frameToScreen: number,
  treatment: TierTreatmentName,
  anno?: Anno,
): DrawnRow {
  // 截屏归一化 → **帧像素**：复用局内那条换算桥（局内是归一化 → 屏幕 DIP，
  // 这里把"窗口"当成这一帧，所以 `windowX/Y=0`、宽高 = 帧宽高）。
  const frameRect = normalizedRectToScreen(label.rect, {
    captureWidth: bmp.width,
    captureHeight: bmp.height,
    windowX: 0,
    windowY: 0,
    windowWidth: bmp.width,
    windowHeight: bmp.height,
  });

  const plan: LabelBoxPlan = labelBoxPlan(frameRect, {
    color: label.color,
    hasData: true,
    textScale: label.fontScale,
    style: 'tier',
    // `text` 只用于取**该字母的排版度量**（墨迹宽 / 视觉居中偏移）
    text: label.text,
    treatment,
    // 帧像素 / DIP：只有"绝对长度"常量（圆角/描边/文本边距）要按它放大；
    // `tier` 样式的几何全部由字号派生，所以不受影响（见 label-draw.ts 的说明）
    pxPerDip,
  });
  const tag: TierTagPlan = plan.tier!;
  const letterCy = tag.letter.textY - tag.capHeight / 2;
  // 纵向边界（发光外廓 ↔ 选取率墨迹）走**线上同一个纯函数** —— 预览与局内不可能漂
  const bounds = tierTagBounds(tag, tierLetterEmMetrics(label.text) ?? undefined);

  // ① 发光（宽 → 窄，计划里已排好序）② 深色描边 ③ 字母本体 —— 与渲染端同序同参。
  // 真字体轮廓：外扩由"到墨迹的距离场"做（与 canvas `strokeText` 同语义）。
  const realGlyph = drawTierLetter(bmp, label.text, tag.letter.fontSize, tag.letter.textX, tag.letter.textY, {
    glow: tag.glow.layers,
    outlineWidth: tag.letter.outlineWidth,
    outline: tag.letter.outlineRgba,
    fill: tag.letter.fillRgba,
  });
  if (!realGlyph) {
    // 兜底（字母不在 A~Z 时才会走到）：内置单线字形，仍按同序同参画
    drawGlowGlyph(bmp, label.text, tag.letter.fontSize, tag.letter.textX, letterCy, tag.glow.layers);
    drawVectorGlyph(bmp, label.text, tag.letter.fontSize, tag.letter.textX, letterCy, tag.letter.outlineRgba, {
      strokeRatio: outlineStrokeRatio(tag.letter.fontSize, tag.letter.outlineWidth),
    });
    const drew = drawVectorGlyph(bmp, label.text, tag.letter.fontSize, tag.letter.textX, letterCy, tag.letter.fillRgba);
    if (!drew) {
      // 内置字形也没有这个字母时，画一个空心框提示（不至于静默漏画）
      strokeRoundedRect(bmp, plan, plan.radius, Math.max(2, plan.strokeWidth * 2), plan.accentRgba);
      console.warn(`  ⚠ 字母「${label.text}」没有字形数据（A~Z 之外）——已画提示框`);
    }
  }
  // ④ 两侧尖括号（折线点由计划给 —— 两边逐点一致）
  for (const bracket of tag.brackets) {
    strokePolyline(bmp, bracket.points, bracket.width, tag.bracketRgba);
  }
  // ⑤ 选取率那一行（空串 = 查不到/为 0 → 不画，字母位置不变）
  if (label.subText !== '') {
    drawRateLine(bmp, label.subText, tag.rate.fontSize, tag.rate.inkHeight, tag.rate.textX, tag.rate.textY, tag.rate.rgba);
  }

  // 标注：**候选号 + 档名 + 尺寸 + 字号 + 字母 cap 高占卡高比**（画在卡片下沿之外的
  // 留白里：标签现在占着卡内底部那一带，标注压在它上面就没法看观感了）
  const frameW = plan.w;
  const frameH = plan.h;
  const screenW = frameW * frameToScreen;
  const screenH = frameH * frameToScreen;
  const dipW = frameW / pxPerDip;
  const dipH = frameH / pxPerDip;
  const fontDip = labelFontSize(dipH, label.fontScale);
  const fontFramePx = tag.letter.fontSize;
  const capDip = tag.capHeight / pxPerDip;
  const cardDipH = (card.h * bmp.height) / pxPerDip;
  /** 字母 cap 高 / 卡高 —— 用户挑尺寸看的就是这个数（目标 0.065~0.075）。 */
  const capOfCard = capDip / cardDipH;
  const contentShare = (tag.contentWidth / (card.w * bmp.width)) * 100;
  // 局内字号是在 DIP 里取整后再乘 DPR 变物理像素的（渲染端那一步）
  const fontScreenPx = fontDip * (screenW / dipW);

  const head =
    anno?.head ??
    `CAND ${row.candidate} ${row.size.toUpperCase()} CAP ${(capOfCard * 100).toFixed(1)}% OF CARD` +
      (row.size === AUGMENT_BADGE_DEFAULT ? ' [DEFAULT]' : '');
  const note =
    anno?.note ??
    `${Math.round(screenW)}x${Math.round(screenH)}px FONT ${fontDip} CAP ${capDip.toFixed(0)} DIP W ${contentShare.toFixed(0)}%`;
  annotateCard(bmp, card, [head, note]);

  return {
    candidate: row.candidate,
    size: row.size,
    tier: row.tier,
    pickRate: row.pickRate,
    rect: label.rect,
    yFrame: label.rect.y * bmp.height,
    baselineFrame: tag.letter.textY,
    frameW,
    frameH,
    dipW,
    dipH,
    screenW,
    screenH,
    capFrame: tag.capHeight,
    capDip,
    capScreen: tag.capHeight * (screenW / frameW),
    fontFramePx,
    fontDip,
    fontScreenPx,
    font: tag.letter.font,
    contentFrameW: tag.contentWidth,
    contentShareOfCard: tag.contentWidth / (card.w * bmp.width),
    capOfCard,
    rateDip: tag.rate.fontSize / pxPerDip,
    subText: label.subText,
    outlineFrame: tag.letter.outlineWidth,
    outlineDip: tag.letter.outlineWidth / pxPerDip,
    glowFrame: tag.glow.reach,
    glowDip: tag.glow.reach / pxPerDip,
    glowLayers: tag.glow.layers.map((l) => l.reach),
    clearanceDip: bounds.clearance / pxPerDip,
    centerOffsetFrame: tag.letter.textX - (frameRect.x + frameRect.w / 2),
    realGlyph,
  };
}

/** 在卡片下沿之外贴两行 ASCII 标注（横向居中于卡片）。 */
function annotateCard(bmp: Bitmap, card: Rect, lines: readonly string[]): void {
  const textScale = 2;
  const width = Math.max(...lines.map((l) => asciiTextWidth(l, textScale)));
  const tx = Math.round(card.x * bmp.width + (card.w * bmp.width - width) / 2);
  const ty = Math.round((card.y + card.h) * bmp.height + 14);
  lines.forEach((line, i) => {
    drawAsciiText(bmp, line, tx, ty + i * (ASCII_GLYPH_H + 2) * textScale, textScale, {
      r: i === 0 ? 226 : 170,
      g: i === 0 ? 232 : 186,
      b: i === 0 ? 242 : 206,
      a: 1,
    });
  });
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/** 一帧底图（解码 + 面板判据只做一次，两套风格在同一份底图上各画一遍）。 */
interface Frame {
  readonly file: string;
  readonly bmp: Bitmap;
  readonly pxPerDip: number;
  readonly frameToScreen: number;
  readonly cards: readonly Rect[];
}

console.log(
  `\n海克斯强度标签 · 离线预览（居中大字母 + 尖括号 + 选取率行，无色块底）\n` +
    `  底图 ${cli.frames.length} 帧；真机显示器 ${cli.displayW}×${cli.displayH} @${cli.scale}x` +
    `（= ${Math.round(cli.displayW / cli.scale)}×${Math.round(cli.displayH / cli.scale)} DIP）\n` +
    `  风格 ${cli.treatments.map((t) => t.toUpperCase()).join(' / ')}` +
    `（上线的是 ${TIER_TREATMENT.toUpperCase()}：${TIER_TREATMENTS[TIER_TREATMENT].name}）\n` +
    (cli.preset ? `  三张卡统一用「${AUGMENT_BADGE_PRESETS[cli.preset].name}」档\n` : ''),
);

const frames: Frame[] = [];
for (const file of cli.frames) {
  let bmp: Bitmap;
  try {
    const img = decodePng(new Uint8Array(readFileSync(file)));
    bmp = { width: img.width, height: img.height, data: img.data };
  } catch (e) {
    console.error(`✗ ${file}：读不出 PNG（${e instanceof Error ? e.message : String(e)}）`);
    continue;
  }
  // 帧像素 / DIP = 帧宽 ÷（显示器逻辑宽）
  const pxPerDip = bmp.width / (cli.displayW / cli.scale);
  const frameToScreenPx = cli.displayW / bmp.width;
  const det = detectAugmentPanel(bmp);
  console.log(
    `=== ${file}  ${bmp.width}×${bmp.height}  帧像素/DIP=${pxPerDip.toFixed(3)}  ` +
      `${det.found ? '✅ 认定面板' : '⚠ 未认定面板'}：${det.reason}`,
  );
  if (det.cards.length === 0) {
    console.error('  没有检测到卡片 —— 换一张面板帧，或先跑 scripts/diag-augment-frames.mts 核对');
    continue;
  }
  if (det.cards.length < PREVIEW_ROWS.length) {
    console.warn(
      `  ⚠ 只检测到 ${det.cards.length} 张卡（想一档一张需要 3 张）——` +
        `本帧只画前 ${det.cards.length} 档；可再传一张帧作第二行`,
    );
  }
  frames.push({
    file,
    bmp,
    pxPerDip,
    frameToScreen: frameToScreenPx,
    cards: det.cards.map((c) => c.rect),
  });
}

if (frames.length === 0) {
  console.error('✗ 没有任何帧可用，未产出预览图');
  process.exit(1);
}

const drawnFrames: Bitmap[] = [];
/** 每套风格的每档几何（打印用；以第一帧的卡片尺寸为准）。 */
const rowsByTreatment = new Map<TierTreatmentName, DrawnRow[]>();
/** 行对齐那一段的三条标签几何（打印"三个标签各自 y"用；以第一帧为准）。 */
const rowAlignedRows: DrawnRow[] = [];

/**
 * 行对齐那一段用的档位/选取率（三张卡依次 S/A/B，正好覆盖三种档位色）。
 *
 * 与候选对照那一段的关键区别：**三张卡共用同一个预设**，而且三条标签是
 * **一次 `augmentTierLabels()` 调用**算出来的 —— 也就是局内真实走的那条路
 * （`resolveAugmentTiers` → `alignRowLabels`，整排共用一个纵向基准）。
 */
const ROW_TIERS: readonly string[] = ['S', 'A', 'B'];
const ROW_PICKS: readonly number[] = [0.1214, 0.0731, 0.1993];

for (const name of cli.treatments) {
  const treatment = TIER_TREATMENTS[name];
  const rowsOut: DrawnRow[] = [];
  for (const [fi, frame] of frames.entries()) {
    const bmp = cloneBitmap(frame.bmp);
    for (const [i, rowIn] of PREVIEW_ROWS.entries()) {
      const card = frame.cards[i];
      if (!card) continue;
      // `--preset` 时三张卡都用同一档（看上线那一档的实际观感）；候选号跟着档走
      const row: PreviewRow = cli.preset
        ? { ...rowIn, size: cli.preset, candidate: CANDIDATE_OF[cli.preset] }
        : rowIn;
      // 线上代码：卡片矩形 + 预设 → 标签矩形 + 档位色 + 字号比例 + 文案
      //（"认不准/查不到不画"的过滤也在这里）
      const preset = AUGMENT_BADGE_PRESETS[row.size];
      const label = augmentTierLabels(
        [{ rect: card, augmentId: PREVIEW_ID }],
        new Map([[PREVIEW_ID, row.tier]]),
        { preset, pickRates: new Map([[PREVIEW_ID, row.pickRate]]) },
      )[0]!;
      const drawn = drawLabel(bmp, card, label, row, frame.pxPerDip, frame.frameToScreen, name);
      if (fi === 0) rowsOut.push(drawn);
    }
    const rowRect = unionRect(frame.cards);
    const want: Rect = cli.full ? { x: 0, y: 0, w: 1, h: 1 } : paddedCrop(rowRect, 0.045);
    const cropped = cropBitmap(bmp, want) ?? bmp;
    drawnFrames.push(
      withHeader(cropped, [
        `STYLE ${treatment.name}${name === TIER_TREATMENT ? '   [ONLINE DEFAULT]' : ''}`,
        `TIER FONT: Segoe UI Black 900 (Arial Black / Impact / MS YaHei UI fallback)  ` +
          `OUTLINE ${(treatment.outline * 100).toFixed(1)}% CAP   GLOW ${(treatment.glow * 100).toFixed(0)}% CAP  ` +
          `LAYERS [${treatment.glowAlphas.join(' ')}]`,
      ]),
    );
  }
  rowsByTreatment.set(name, rowsOut);

  /* ---------------------------------------------------------------- */
  /* 行对齐那一段：**三张卡同一个预设、一次调用**（= 局内真实路径）        */
  /* ---------------------------------------------------------------- */
  const preset = AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT];
  const tierMap = new Map<number, string>();
  const pickMap = new Map<number, number>();
  for (const [i] of PREVIEW_ROWS.entries()) {
    tierMap.set(PREVIEW_ID + i, ROW_TIERS[i] ?? 'C');
    pickMap.set(PREVIEW_ID + i, ROW_PICKS[i] ?? 0);
  }
  for (const [fi, frame] of frames.entries()) {
    const bmp = cloneBitmap(frame.bmp);
    // ⚠️ **一次**调用算出整排标签 —— 局内的行对齐就在这里面（`alignRowLabels`）
    const labels = augmentTierLabels(
      frame.cards.map((c, i) => ({ rect: c, augmentId: PREVIEW_ID + i })),
      tierMap,
      { preset, pickRates: pickMap },
    );
    for (const [i, card] of frame.cards.entries()) {
      const label = labels[i];
      if (!label) continue;
      const yFrame = Math.round(label.rect.y * bmp.height);
      const drawn = drawLabel(
        bmp,
        card,
        label,
        { candidate: CANDIDATE_OF[AUGMENT_BADGE_DEFAULT], size: AUGMENT_BADGE_DEFAULT, tier: label.text, pickRate: label.pickRate ?? 0 },
        frame.pxPerDip,
        frame.frameToScreen,
        name,
        {
          head: `IN GAME  ${label.text}  y=${yFrame}px`,
          note: `ROW ALIGNED  BASELINE SAME  PRESET ${AUGMENT_BADGE_DEFAULT.toUpperCase()}`,
        },
      );
      if (fi === 0 && name === cli.treatments[0]) rowAlignedRows.push(drawn);
    }
    const rowRect = unionRect(frame.cards);
    const want: Rect = cli.full ? { x: 0, y: 0, w: 1, h: 1 } : paddedCrop(rowRect, 0.045);
    const cropped = cropBitmap(bmp, want) ?? bmp;
    drawnFrames.push(
      withHeader(cropped, [
        `IN GAME: 3 CARDS, ONE PRESET (${AUGMENT_BADGE_DEFAULT.toUpperCase()} ${preset.width}x${preset.height})  [ROW ALIGNED]`,
        `ONE augmentTierLabels() CALL -> alignRowLabels(): ALL 3 LABEL Y EQUAL (see terminal)`,
      ]),
    );
  }
}

const out = drawnFrames.length === 1 ? drawnFrames[0]! : stackVertically(drawnFrames);
mkdirSync(dirname(cli.out), { recursive: true });
writeFileSync(cli.out, encodePng(out));

/* ------------------------------------------------------------------ */
/* 终端汇总：每档的字体/字号/描边/发光（挑档与核对参数看这里）              */
/* ------------------------------------------------------------------ */

for (const name of cli.treatments) {
  const t = TIER_TREATMENTS[name];
  const rows = rowsByTreatment.get(name) ?? [];
  console.log(
    `\n风格 ${name.toUpperCase()}（${t.name}）${name === TIER_TREATMENT ? ' ← 当前上线' : ''}` +
      `\n  深色描边 ${(t.outline * 100).toFixed(1)}% cap（canvas lineWidth → 向外扩一半）` +
      `  发光 ${(t.glow * 100).toFixed(0)}% cap，${t.glowAlphas.length} 层 alpha [${t.glowAlphas.join(', ')}]`,
  );
  for (const r of rows) {
    const p = AUGMENT_BADGE_PRESETS[r.size];
    console.log(
      `  候选 ${r.candidate}（${p.name} ${r.size}）字母 ${r.tier}${r.realGlyph ? '' : '（⚠ 内置单线兜底）'}` +
        `  「${r.subText || '（无选取率）'}」  帧 ${r.frameW.toFixed(0)}×${r.frameH.toFixed(0)}` +
        ` = ${r.dipW.toFixed(0)}×${r.dipH.toFixed(0)} DIP`,
    );
    console.log(
      `      字体 ${r.font}`,
    );
    console.log(
      `      字号 ${r.fontFramePx} 帧 = ${r.fontDip} DIP（${Math.round(r.fontScreenPx)} 物理）` +
        `  字母 cap ${r.capFrame.toFixed(0)} 帧 = ${r.capDip.toFixed(1)} DIP` +
        `（= **卡高 ${(r.capOfCard * 100).toFixed(1)}%**）  选取率行 ${r.rateDip.toFixed(1)} DIP`,
    );
    console.log(
      `      深色描边 ${r.outlineFrame.toFixed(1)} 帧 = ${r.outlineDip.toFixed(1)} DIP` +
        `  发光 ${r.glowFrame.toFixed(1)} 帧 = ${r.glowDip.toFixed(1)} DIP，层 [${r.glowLayers.map((v) => v.toFixed(1)).join(', ')}] 帧` +
        `  视觉居中偏移 ${r.centerOffsetFrame >= 0 ? '+' : ''}${r.centerOffsetFrame.toFixed(1)} 帧`,
    );
    console.log(
      `      **发光外廓下沿 ↔ 选取率墨迹上沿** ${r.clearanceDip >= 0 ? '+' : ''}${r.clearanceDip.toFixed(2)} DIP` +
        `${r.clearanceDip > 0 ? '（有间隙）' : '（**重叠** —— 用户 2026-10-06 反馈的就是它）'}｜` +
        `内容（字母 + 两侧尖括号）宽 ${r.contentFrameW.toFixed(0)} 帧 = 卡宽 ${(r.contentShareOfCard * 100).toFixed(0)}%` +
        `（要求 ≤ 60%）；距卡底 ${p.marginY} 卡高、水平居中`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* 行对齐核对：三张卡各自的标签 y（改前 vs 改后）                          */
/* ------------------------------------------------------------------ */

/** 每档几何一览用的第一条（以第一帧的卡片尺寸为准）。 */
const first = (rowsByTreatment.get(cli.treatments[0]!) ?? [])[0];

/**
 * 真机 `debug/augment/report.json`（atMs=23221，**单卡重随**那一帧）反推出来的卡片
 * 矩形 —— **这是唯一定量过"三个标签不在一个高度"的真机数据**（真机面板帧本身
 * 三张卡矩形是一致的，差值 0.00 px，所以放不出这个现象）。
 * 前两张是面板开启时冻结的矩形，第三张是重随那一刻重新识别的（翻牌动画里）。
 */
const REROLL_CARDS_FRAME: readonly Rect[] = [
  { x: 0.29735271614384085, y: 0.1917050736842105, w: 0.12501912777352715, h: 0.460610379679144 },
  { x: 0.43981637337413926, y: 0.1917050736842105, w: 0.12501912777352715, h: 0.460610379679144 },
  { x: 0.5812921053812845, y: 0.17287065943116413, w: 0.12637597349980165, h: 0.4976025273475413 },
];

if (rowAlignedRows.length > 0 && first) {
  const zone = augmentBadgeZone(AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT]);
  console.log('\n行对齐核对（用户："同一排三个标签明显不在一个高度上"）');
  console.log(
    `  本帧 ${frames[0]!.file}（线上检测器给出的三张卡矩形本来就一致）：`,
  );
  const liveBefore = frames[0]!.cards.map((c) => augmentLabelRect(c, zone));
  const liveAfter = rowAlignedRows.map((r) => r.rect);
  const pct = (v: number): string => v.toFixed(1);
  console.log(
    `    改前（各自卡片） 框顶 y = [${liveBefore.map((r) => pct(r.y * frames[0]!.bmp.height)).join(', ')}] 帧像素` +
      `  极差 ${pct(spread(liveBefore.map((r) => r.y), frames[0]!.bmp.height))} 帧像素`,
  );
  console.log(
    `    改后（整行基准） 框顶 y = [${liveAfter.map((r) => pct(r.y * frames[0]!.bmp.height)).join(', ')}] 帧像素` +
      `  极差 ${pct(spread(liveAfter.map((r) => r.y), frames[0]!.bmp.height))} 帧像素`,
  );
  console.log(
    `    改后基线（字母 cap 下沿）= [${rowAlignedRows.map((r) => pct(r.baselineFrame)).join(', ')}] 帧像素` +
      `  极差 ${pct(Math.max(...rowAlignedRows.map((r) => r.baselineFrame)) - Math.min(...rowAlignedRows.map((r) => r.baselineFrame)))} 帧像素`,
  );
  console.log('  真机"单卡重随"帧回放（卡片矩形确有差异 —— 这才是现象本身）：');
  const before = REROLL_CARDS_FRAME.map((c) => augmentLabelRect(c, zone));
  const after = alignRowLabels(REROLL_CARDS_FRAME, zone);
  // 归一化 → 屏幕物理像素（真机 3440×1440 @1.5×，帧像素 = 物理像素 ×4/3）
  const screenPx = (v: number): number => v * cli.displayH;
  console.log(
    `    改前 三个标签 y = [${before.map((r) => pct(screenPx(r.y))).join(', ')}] 屏幕物理像素` +
      `  → 极差 **${pct(Math.max(...before.map((r) => screenPx(r.y))) - Math.min(...before.map((r) => screenPx(r.y))))} px**` +
      `（字母大小也不同：h = [${before.map((r) => pct(screenPx(r.h))).join(', ')}]）`,
  );
  console.log(
    `    改后 三个标签 y = [${after.map((r) => pct(screenPx(r.y))).join(', ')}] 屏幕物理像素` +
      `  → 极差 **${pct(Math.max(...after.map((r) => screenPx(r.y))) - Math.min(...after.map((r) => screenPx(r.y))))} px**（完全相等）`,
  );
  console.log(
    `    横向没改：三条标签仍各自居中于自己的卡片（x = [${after.map((r) => pct(r.x * cli.displayW)).join(', ')}] 物理像素）`,
  );

  /* ---------------------------------------------------------------- */
  /* 刷新前 vs 刷新后：**行基准锁**（局内真实路径）                       */
  /*                                                                  */
  /* 用户二次验收："某次单卡刷新后，三个标签**整体下移了一点**"。根因：基准  */
  /* 原来每帧按卡片矩形的中位数重算，而重随那一帧被刷新那张卡的矩形是**翻牌  */
  /* 动画中间帧** —— 三张里两张一变，中位数就跟着挪。修法：开边沿锁定，之后  */
  /* 复用同一条（`lockLabelRowBand()` / `augmentTierLabelsLocked()`）。   */
  /* 完整回放（含真机 report.json 逐帧）见 scripts/diag-augment-row-band.mts */
  /* ---------------------------------------------------------------- */
  const lockTiers = new Map<number, string>([
    [9001, 'S'],
    [9002, 'A'],
    [9003, 'B'],
  ]);
  const frozenRow: readonly Rect[] = REROLL_CARDS_FRAME.map((c) => ({
    ...c,
    y: REROLL_CARDS_FRAME[0]!.y,
    h: REROLL_CARDS_FRAME[0]!.h,
  }));
  // "重随那一刻检测到的矩形"= 翻牌动画中间帧（第三张那组数字），三张卡各自一份
  const animatedRow: readonly Rect[] = REROLL_CARDS_FRAME.map((c) => ({
    ...c,
    y: REROLL_CARDS_FRAME[2]!.y,
    h: REROLL_CARDS_FRAME[2]!.h,
  }));
  const steps: ReadonlyArray<{ readonly label: string; readonly cards: readonly Rect[] }> = [
    { label: '刷新前（开边沿：三张冻结矩形 → 锁定基准）', cards: frozenRow },
    { label: '卡3 刷新（本帧检测矩形 = 翻牌动画帧）    ', cards: [frozenRow[0]!, frozenRow[1]!, animatedRow[2]!] },
    { label: '卡2 也刷新（三张里两张已是动画帧）      ', cards: [frozenRow[0]!, animatedRow[1]!, animatedRow[2]!] },
  ];
  console.log('  刷新前 vs 刷新后（**线上路径** = augmentTierLabelsLocked() 的行基准锁）：');
  const lockPreset = AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT];
  let rowLock = null;
  let refY: readonly number[] | null = null;
  for (const step of steps) {
    const row = augmentTierLabelsLocked(
      rowLock,
      step.cards.map((c, i) => ({ rect: c, augmentId: 9001 + i })),
      lockTiers,
      { preset: lockPreset },
    );
    rowLock = row.rowLock;
    const ys = row.labels.map((l) => l.rect.y);
    if (!refY) refY = ys;
    const shift = ys.map((y, i) => (refY![i] === undefined ? y - refY![0]! : y - refY![i]!));
    console.log(
      `    ${step.label}  y = [${ys.map((y) => screenPx(y).toFixed(1)).join(', ')}] 物理像素` +
        `  位移 = [${shift.map((d) => d.toFixed(6)).join(', ')}]`,
    );
  }
  // 对照：无锁（每帧重算中位数）—— 真机上就是这样整排下移的
  const unlocked = steps.map((s) =>
    augmentTierLabels(
      s.cards.map((c, i) => ({ rect: c, augmentId: 9001 + i })),
      lockTiers,
      { preset: lockPreset },
    ).map((l) => screenPx(l.rect.y)),
  );
  console.log(
    `    对照（无锁，每帧重算中位数）：最后一步 y = [${unlocked[2]!.map((y) => y.toFixed(1)).join(', ')}]` +
      ` 物理像素 → 整排下移 **${(unlocked[2]![0]! - unlocked[0]![0]!).toFixed(1)} 物理像素**（这就是被修掉的现象）`,
  );
}

/* ------------------------------------------------------------------ */
/* 三个候选的**cap 高占卡高比**一览（用户按这一栏挑；目标 0.065~0.075）    */
/* ------------------------------------------------------------------ */

if (first) {
  console.log(
    `\n候选大小一览（风格 ${cli.treatments[0]!.toUpperCase()} —— 间隙那一栏随风格变；` +
      `字母 cap 高 / 卡高，用户这次的要求是 0.065~0.075）：`,
  );
  for (const r of rowsByTreatment.get(cli.treatments[0]!) ?? []) {
    const p = AUGMENT_BADGE_PRESETS[r.size];
    console.log(
      `  候选 ${r.candidate}  ${r.size.padEnd(6)} cap 高 ${(r.capOfCard * 100).toFixed(1)}% 卡高` +
        `  = ${r.capDip.toFixed(1)} DIP = ${r.capScreen.toFixed(0)} 屏幕物理像素` +
        `（字号 ${r.fontDip} DIP、选取率行 ${r.rateDip.toFixed(1)} DIP）` +
        `  发光外廓↔选取率间隙 ${r.clearanceDip >= 0 ? '+' : ''}${r.clearanceDip.toFixed(2)} DIP` +
        `${r.size === AUGMENT_BADGE_DEFAULT ? '  ← 当前默认档' : ''}`,
    );
  }
  console.log(
    '\n当前默认档 = 候选 1（**small**，cap 6.6% 卡高 = 29.4 DIP = 44 屏幕物理像素）——' +
      '2026-10-06 用户看过真机观感后定的："small 字体比较合适，但位置稍微有点靠下，' +
      '有点覆盖到「选取率」，需要稍微向上移动一点点"。\n' +
      '于是这一版只改**纵向**，字母大小一个像素都没动：① `marginY` 0.06 → 0.07（整条上移）；' +
      '② 字母与选取率行之间的空隙 0.26 → 0.38 cap；③ 发光半径 0.32 → 0.28 cap' +
      '（描边/发光**仍然按 cap 成比例**，没有写死像素）。\n' +
      '⚠️ 用户看到的"字"其实是**发光外廓**（实测外廓 ≈ 字母墨迹的 1.9 倍），' +
      '所以真正要保证的是「发光外廓下沿 ↔ 选取率墨迹上沿」留**正间隙**：' +
      '计划 +2.4 / +3.1 / +3.3 DIP，渲染端像素实测 **+4.7 / +4.7 / +5.3 DIP**' +
      '（改前是三档全部重叠：−2.3 / −1.9 / −2.0 DIP）。\n' +
      '想改默认档只改一处：packages/vision/src/augment-label.ts 的 AUGMENT_BADGE_DEFAULT。',
  );
}

console.log(
  `\n产物：${cli.out}（${out.width}×${out.height}，${drawnFrames.length} 段纵向叠放；` +
    `每段里三张卡依次是 ${PREVIEW_ROWS.map((r) => `候选${r.candidate}=${r.size} ${r.tier}`).join(' / ')}）`,
);
console.log(
  `挑好之后改两处：packages/vision/src/label-draw.ts 的 TIER_TREATMENT（风格）与\n` +
    'packages/vision/src/augment-label.ts 的 AUGMENT_BADGE_DEFAULT（大小）。\n' +
    "进对局临时试：$env:HEXBOX_AUGMENT_BADGE='small'; pnpm --filter @hexbox/overlay debug:augment\n" +
    '只看某套风格：node --experimental-strip-types scripts/preview-augment-labels.mts --style a',
);
console.log(
  '提示：档位字母现在是**与局内同一套字体**（Segoe UI Black 900）的轮廓数据' +
    '（packages/vision/src/label-letter-outlines.ts + label-letter.ts，' +
    '由 scripts/render-tier-letter-glyphs.ps1 生成），' +
    '发光/描边按"到墨迹的距离场"向外扩 —— 与局内 canvas 的 strokeText 同语义；' +
    '「选取率」三个汉字仍是内置点阵（局内是微软雅黑矢量字形），' +
    '剩下的差别只有 hinting：框大小、字号、位置、居中、视觉居中偏移、尖括号折线、' +
    '选取率行与配色都是同一份纯函数。\n',
);
