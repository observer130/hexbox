/**
 * 标签**绘制约定**（纯常量 + 纯函数；渲染端与离线预览**共用同一套**）
 *
 * 为什么把这个抽成纯函数（2026-10-05，用户："预览出来的外观必须与局内渲染一致"）：
 *   · 局内绘制在 Electron 渲染端的 canvas 里（`renderer/overlay-canvas.ts`），
 *     **CI 跑不了**，改一个圆角/字号没有任何东西能拦住它；
 *   · 离线预览（`scripts/preview-augment-labels.mts`）要画出一模一样的标签，
 *     否则"预览好看、局内不一样"，工具本身就是误导。
 *
 * 所以"底色/描边/圆角/字体/字号/文本锚点"全部集中在这里，两边都调
 * `labelBoxPlan()` 取同一份**绘制计划**：渲染端把计划喂给 canvas，
 * 预览把计划喂给 `label-raster.ts` 的软件光栅化器。差异只可能来自
 * canvas 与软件光栅化的像素级实现，不来自参数。
 *
 * 两种样式（`LabelStyle`）：
 *   · `label`（选人阶段）：深色圆角底 + 居中大字（胜率）+ 右下小字（英雄名）；
 *   · `tier`（局内强度评级，2026-10-05 用户给参考图后定）：
 *     **居中**的大号描边彩色字母 + 两侧尖括号（`‹ S ›`）+ 下方一行小字「选取率 12.1%」，
 *     **没有色块底**。几何见本文件的 `tierTagPlan()`；
 *     字体是**展示型重型字体栈**（`LABEL_TIER_FONT_FAMILY` + 900，2026-10-06 按用户
 *     "S/A/B/C 的字体太难看了"改），字形轮廓在 `label-letter-outlines.ts`、度量在 `label-letter.ts`（离线预览共用同一份）。
 *
 * `pxPerDip`：canvas 用逻辑坐标（DIP），所以默认 1；离线预览画在**截屏帧**上
 * （帧像素 ≠ DIP，真机帧是 DIP 的 2 倍），传它做等比换算 ——
 * 这样"帧上的预览"与"屏幕上的实际标签"在同一物理尺寸下。
 * ⚠️ 只影响**绝对长度**常量（圆角、描边宽、文本边距）；`tier` 样式的几何
 * **全部由字号派生**，而字号由框高算出（框本身已是调用方单位），所以不需要它。
 */

import type { Rect } from './types.ts';
import {
  TIER_LETTERS_CAP_RATIO,
  TIER_LETTERS_DESIGN_INK_ASPECT,
  tierLetterEmMetrics,
} from './label-letter.ts';

/** RGBA 颜色（0~255 + 0~1 alpha）。 */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** RGBA → canvas 认的 css 颜色串。 */
export function rgbaCss(c: Rgba): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
}

/** 取同一颜色的另一个 alpha（`tier` 样式的描边/发光/尖括号都由强调色派生）。 */
export function withAlpha(c: Rgba, a: number): Rgba {
  return { r: c.r, g: c.g, b: c.b, a: Math.max(0, Math.min(1, a)) };
}

/**
 * 解析 css 颜色串（`#rgb` / `#rrggbb` / `rgb()` / `rgba()`）。
 *
 * 只覆盖本项目用到的形态：档位配色是十六进制（`AUGMENT_TIER_COLORS`），
 * 兜底色是本文件里的 rgba 串。解析不出来返回**不透明黑**
 * （宁可画黑也不要静默不画 —— 预览里一眼能看出配色没接上）。
 */
export function parseCssColor(css: string): Rgba {
  const s = css.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    const h = hex[1]!;
    const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
    return {
      r: Number.parseInt(full.slice(0, 2), 16),
      g: Number.parseInt(full.slice(2, 4), 16),
      b: Number.parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(s);
  if (fn) {
    const parts = fn[1]!.split(/[,/\s]+/).filter((p) => p !== '');
    const num = (i: number, dflt: number): number => {
      const v = Number.parseFloat(parts[i] ?? '');
      return Number.isFinite(v) ? v : dflt;
    };
    return {
      r: Math.max(0, Math.min(255, Math.round(num(0, 0)))),
      g: Math.max(0, Math.min(255, Math.round(num(1, 0)))),
      b: Math.max(0, Math.min(255, Math.round(num(2, 0)))),
      a: Math.max(0, Math.min(1, parts.length > 3 ? num(3, 1) : 1)),
    };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

/* ------------------------------------------------------------------ */
/* 视觉常量（改这里 = 同时改局内与预览）                                  */
/* ------------------------------------------------------------------ */

/** 标签底色（深色半透明）：选人胜率标签与局内档位徽章是同一套视觉语言。 */
export const LABEL_FILL_RGBA: Rgba = { r: 10, g: 14, b: 24, a: 0.88 };
export const LABEL_FILL = rgbaCss(LABEL_FILL_RGBA);

/** 描边宽度（DIP）。 */
export const LABEL_STROKE_WIDTH = 1;

/** 圆角半径（DIP）。 */
export const LABEL_CORNER_RADIUS = 6;

/** 字体族：与卡面名字指纹库同源（卡面是微软雅黑粗体）。 */
export const LABEL_FONT_FAMILY = '"Microsoft YaHei", sans-serif';
export const LABEL_TEXT_WEIGHT = 700;
export const LABEL_SUB_WEIGHT = 600;

/**
 * 档位字母（局内强度评级）的**展示型字体栈** + 字重。
 *
 * 用户 2026-10-06 反馈"S/A/B/C 的字体太难看了"：之前档位字母和正文同族
 * （雅黑粗体 / 通用无衬线），观感就是"普通文本"，没有展示型字母的分量。
 * 这里换成 Windows 上**真实存在**的重型字体栈（本机逐个核过，
 * 见 `docs/AUGMENT-PANEL.md` §十四），字重显式取 `900`：
 *
 *   · `Segoe UI Black`（`seguibl.ttf`）—— 首选：字形干净、本身就是 900 字重，
 *     不会触发合成粗体（伪粗体会把字怀糊掉）；
 *   · `Arial Black`（`ariblk.ttf`）/ `Impact`（`impact.ttf`）—— 次选（同为重型展示体）；
 *   · `Microsoft YaHei UI` / `Microsoft YaHei` —— 兜底（只在前两者都缺失时才轮到）。
 *
 * ⚠️ `label-letter*.ts` 的字形与度量是从**首项**导出的（有单测锁"首项 == 生成字体"）：
 * 换首项就必须重跑 `scripts/render-tier-letter-glyphs.ps1`，否则预览会与局内分家。
 */
export const LABEL_TIER_FONT_FAMILY =
  '"Segoe UI Black", "Arial Black", Impact, "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
/** 档位字体字重（显式 900：重型字体族本身就是 900，回退字体也尽量变重）。 */
export const LABEL_TIER_FONT_WEIGHT = 900;

/** 主文本字号 / 框高（普通标签）。 */
export const LABEL_TEXT_SCALE = 0.52;
/** 主文本字号 / 框高（紧凑标签：顶栏槽位这种很矮的框）。 */
export const LABEL_COMPACT_TEXT_SCALE = 0.62;
/** 低于这个高度（DIP）按"紧凑"处理（顶栏槽位实测 ≈26 DIP）。 */
export const LABEL_COMPACT_MAX_H = 30;
/** 字号下限（DIP）：再小就不可读了，不如让框自己撑不开。 */
export const LABEL_MIN_FONT_SIZE = 6;

/** 无 `color` 时的强调色：有统计绿、无统计灰（**绝不猜一个数字**）。 */
export const LABEL_ACCENT_COLOR = { hasData: '#4ade80', empty: '#8b96ad' } as const;
export const LABEL_STROKE_RGBA = {
  hasData: { r: 74, g: 222, b: 128, a: 0.5 },
  empty: { r: 139, g: 150, b: 173, a: 0.4 },
} as const;
export const LABEL_STROKE_COLOR: Readonly<Record<'hasData' | 'empty', string>> = {
  hasData: rgbaCss(LABEL_STROKE_RGBA.hasData),
  empty: rgbaCss(LABEL_STROKE_RGBA.empty),
};

/** 副文本（选人标签的英雄名）：字号 / 框高 + 颜色。局内标签的副文本见 `TIER_RATE_*`。 */
export const LABEL_SUB_SCALE = 0.3;
export const LABEL_SUB_COLOR = '#c8a84e';
/** 副文本右边距与最小可用宽度（DIP）——槽位盒只有 ~62px 宽，必须给下限。 */
export const LABEL_SUB_RIGHT_PAD = 10;
export const LABEL_SUB_MIN_WIDTH = 24;
export const LABEL_SUB_RESERVED = 90;

/* ------------------------------------------------------------------ */
/* `tier` 样式（局内强度评级：大号描边字母 + 尖括号 + 选取率行）            */
/* ------------------------------------------------------------------ */

/**
 * 大写字高（cap）/ 字号 —— **就是档位字体栈首项 `Segoe UI Black` 的实测值**。
 *
 * 由 `scripts/render-tier-letter-glyphs.ps1` 从字体轮廓量出并写进
 * `label-letter.ts`（`TIER_LETTERS_CAP_RATIO`），这里**引用**它 —— 与
 * `label-glyph.ts` 的 `GLYPH_CAP_RATIO` 同一套做法，两边不可能漂：
 * 离线预览的真字形按它画，尖括号位置与选取率行的位置也按它算。
 */
export const LABEL_CAP_RATIO = TIER_LETTERS_CAP_RATIO;

/**
 * 一个档位字母的**排版度量**（cap 单位）。
 *
 * 展示型字体的墨迹并不落在前进宽正中（`S` 偏左、`B` 偏右…），而 canvas 的
 * `textAlign='center'` 居中的是**前进宽** —— 同一个框里三个字母会各自偏一点，
 * 卡与卡并排时看得出来。`TIER_LETTERS` 的实测度量让每个字母按**墨迹**居中。
 */
export interface TierLetterMetrics {
  /** 墨迹宽 / cap 高（尖括号间距与内容宽按它排）。 */
  readonly inkAspect: number;
  /** 视觉居中偏移 / cap 高（`前进宽/2 − 墨迹中心`）。 */
  readonly centerOffset: number;
}

/** 档位字母的**设计**墨迹宽 / cap 高 = S/A/B/C 的实测最大值（未知字母的保守值）。 */
export const TIER_LETTER_INK_ASPECT = TIER_LETTERS_DESIGN_INK_ASPECT;

/** 没有实测度量的字母（非 A~Z）按它保守排版：尖括号因此永远不会压到字。 */
export const TIER_LETTER_METRICS_FALLBACK: TierLetterMetrics = {
  inkAspect: TIER_LETTER_INK_ASPECT,
  centerOffset: 0,
};

/** 取某个字母的排版度量（`undefined` / 非 A~Z → 保守缺省值，与"缺字形就不画"无关）。 */
export function tierLetterMetrics(ch: string | undefined): TierLetterMetrics {
  const g = ch === undefined ? null : tierLetterEmMetrics(ch);
  if (!g) return TIER_LETTER_METRICS_FALLBACK;
  return {
    inkAspect: (g.inkRight - g.inkLeft) / LABEL_CAP_RATIO,
    centerOffset: (g.advance / 2 - (g.inkLeft + g.inkRight) / 2) / LABEL_CAP_RATIO,
  };
}

/** 尖括号宽 / cap 高（比高小 → 尖角形）。 */
export const TIER_BRACKET_WIDTH = 0.36;
/** 尖括号高 / cap 高（比字母矮一截，收敛一点 —— 参考图里尖括号明显小于字母）。 */
export const TIER_BRACKET_HEIGHT = 0.78;
/** 尖括号笔画宽 / cap 高（比字母细）。 */
export const TIER_BRACKET_STROKE = 0.11;
/** 字母墨迹与尖括号之间的空隙 / cap 高（尖括号贴着**该字母的墨迹**，见 `tierTagPlan`）。 */
export const TIER_BRACKET_GAP = 0.26;
/** 尖括号颜色 alpha（用同一档位色，稍暗、稍小 —— 参考图就是这样）。 */
export const TIER_BRACKET_ALPHA = 0.82;

/**
 * 两套候选的"描边 + 发光"风格（2026-10-06）。
 *
 * 用户要"更厚重"的观感，而描边厚度与发光强度是**互相牵制**的两个量：
 * 描边细 → 字形轮廓靠发光定形；描边粗 → 字母更"实"但会更吃字的细节。
 * 所以一次给出两套，用同一张预览图对照（`debug/label-preview.png`），
 * 挑完只改 `TIER_TREATMENT` 一行。
 */
export type TierTreatmentName = 'a' | 'b';

/** 一套描边 + 发光处理（几何与配色与风格无关，只有这两个量随风格变）。 */
export interface TierTreatment {
  /** 显示名（预览图标注与终端打印用）。 */
  readonly name: string;
  /** 深色描边宽 / cap 高（canvas `lineWidth`；居中压在墨迹边界 → 向外扩一半）。 */
  readonly outline: number;
  /** 外发光总半径 / cap 高（0 = 不发光）。 */
  readonly glow: number;
  /** 各层发光的 alpha（内 → 外；再乘档位色自身的 alpha）。 */
  readonly glowAlphas: readonly number[];
}

export const TIER_TREATMENTS: Readonly<Record<TierTreatmentName, TierTreatment>> = {
  a: { name: 'A  thin dark outline + SOFT glow', outline: 0.07, glow: 0.16, glowAlphas: [0.34, 0.18] },
  // `glow` 2026-10-06 从 0.32 收到 0.28：用户真机反馈"发光外廓压到选取率行"，
  // 而光晕半径原本比字母与选取率行之间的空隙还大（0.32 > 0.26 cap，必然压进去）。
  // 描边/发光的**成比例**关系没变（两者都还是 cap 高的比例，见 `tierTagPlan`）。
  b: { name: 'B  thick dark outline + STRONG glow', outline: 0.15, glow: 0.28, glowAlphas: [0.42, 0.26, 0.14] },
};

/**
 * **上线**的那一套（预览同时给两套对照，用户挑完改这一行）。
 *
 * 2026-10-06 选 B：对照图里 B 的字母有**明显的深色包边 + 一圈柔光**，在花哨的卡面
 * 插画上比 A（细描边、弱发光）更容易一眼读出档位；A 保留给"更素"的口味。
 */
export const TIER_TREATMENT: TierTreatmentName = 'b';

/** 字母描边色：近黑（与标签底色同族）—— 给彩色字母定形，在亮背景上也不糊。 */
export const TIER_OUTLINE_RGBA: Rgba = { r: 6, g: 9, b: 14, a: 0.92 };

/** 上线风格的深色描边宽 / cap 高（canvas 的 `lineWidth`）。 */
export const TIER_LETTER_OUTLINE = TIER_TREATMENTS[TIER_TREATMENT].outline;
/**
 * 上线风格的外发光半径 / cap 高。
 *
 * 刻意**不用 canvas 的 `shadowBlur`**：它是"设备像素级"的模糊量、与 CTM/DPR 的
 * 关系各家实现不一致（离线预览也没有滤镜），一旦用上，预览与局内的光晕大小就对不上了。
 * 这里改成**明确的分层加宽描边** —— 层半径与 alpha 都由本文件给出
 * （`tierGlowLayers()`），局内与离线预览画同一份数据。
 */
export const TIER_LETTER_GLOW = TIER_TREATMENTS[TIER_TREATMENT].glow;
/** 上线风格各层发光的 alpha（内 → 外，越大越宽越淡）。 */
export const TIER_GLOW_ALPHAS = TIER_TREATMENTS[TIER_TREATMENT].glowAlphas;

/** 选取率行：字号 / cap 高（≈字母的 1/3，参考图观感）。 */
export const TIER_RATE_FONT = 0.36;
/** 选取率行：墨迹高 / 字号（实测雅黑汉字墨迹 ≈0.92~0.98 em，取一个上限值保版面）。 */
export const TIER_RATE_INK = 0.95;
/**
 * 选取率行与字母之间的空隙 / cap 高。
 *
 * ⚠️ **它必须大于发光半径**（`TIER_LETTER_GLOW`），否则那圈光晕会压进选取率那一行 ——
 * 2026-10-06 真机反馈就是这个：原本 `0.26 < 0.32`，用渲染端真实产物量出来
 * **三档全部重叠**（small −2.3 / medium −1.9 / large −2.0 DIP），用户的原话是
 * "small 字体比较合适，但位置稍微有点靠下，有点覆盖到「选取率」"。
 * 现在 `0.38 > 0.28`：计划间隙 = `(0.38 − 0.28) × cap − 字母墨迹出格`
 * ≈ **+2.4~3.3 DIP**，渲染端像素实测 **+4.7 / +4.7 / +5.3 DIP**
 * （见 `tierTagBounds()` 与 `debug/measure-tier-gap.mts`）。改这个值必须同时看
 * `TIER_LETTER_GLOW` —— 单测锁的就是"空隙 > 发光半径"这条关系。
 */
export const TIER_RATE_GAP = 0.38;
/** 选取率行颜色：中性浅灰（**不要抢字母的视觉**）。 */
export const TIER_RATE_COLOR = '#e8edf6';
export const TIER_RATE_RGBA: Rgba = { r: 232, g: 237, b: 246, a: 0.92 };
/** 选取率行字重：常规（细一点，不跟字母抢；预览的汉字点阵也是常规字重渲染的）。 */
export const TIER_RATE_WEIGHT = 400;

/**
 * 整条标签（字母 cap + 空隙 + 选取率墨迹）的高 / cap 高。
 *
 * 预设里的 `height` 是**整条标签的高 / 卡高**，所以 cap 高 = `height ÷ 本值`。
 */
export const TIER_STACK_RATIO = 1 + TIER_RATE_GAP + TIER_RATE_FONT * TIER_RATE_INK;

/**
 * 字号 / 框高（`tier` 样式）。
 *
 * = `1 ÷ (整条标签高/cap 高 × cap 比)` —— 这样"预设框高"正好等于整条标签的高，
 * 字母 cap 高 = 框高 ÷ `TIER_STACK_RATIO`（默认档 `small` ≈ 卡高的 0.066）。
 */
export const TIER_FONT_SCALE = 1 / (TIER_STACK_RATIO * LABEL_CAP_RATIO);

/**
 * 标签**内容宽** / 字号（字母墨迹 + 两侧尖括号 + 两段空隙 + 折线笔画的一半）。
 *
 * 框宽不足时按它反推字号上限 —— 保证尖括号（含笔画）**永远不会越出框**
 * （也就不会压到卡片描边），而不是"希望预设宽够大"。尖括号贴着**这个字母自己的**
 * 墨迹（`metrics.inkAspect`），所以宽字母（`A`/`M`）会自动用更小的字号，
 * 而不是让尖括号跑出框。
 */
export function tierContentFontAspect(inkAspect: number): number {
  return (
    LABEL_CAP_RATIO *
    (inkAspect + 2 * (TIER_BRACKET_GAP + TIER_BRACKET_WIDTH) + TIER_BRACKET_STROKE)
  );
}

/** 未知字母（保守墨迹宽）时的内容宽 / 字号。 */
export const TIER_CONTENT_FONT_ASPECT = tierContentFontAspect(TIER_LETTER_INK_ASPECT);

/** 折线点（调用方单位）。 */
export type PlanPoint = readonly [number, number];

/** 字母本体的绘制参数（canvas 用 `textBaseline='alphabetic'` + `textY` = 基线）。 */
export interface TierLetterPlan {
  readonly fontSize: number;
  readonly font: string;
  /** 字面中心 x（canvas `textAlign='center'`）。 */
  readonly textX: number;
  /** **基线** y（不是框心：这样字母墨迹正好落在算好的 cap 带里）。 */
  readonly textY: number;
  readonly fillColor: string;
  readonly fillRgba: Rgba;
  readonly outlineWidth: number;
  readonly outlineColor: string;
  readonly outlineRgba: Rgba;
}

/** 一层发光：向外扩 `reach`（调用方单位）+ 该层的颜色。 */
export interface TierGlowLayer {
  /**
   * 向**外**扩散的距离（调用方单位，从字母墨迹边界算起）。
   *
   * 两边按同一份关系画，只是"加宽"的手段不同：
   *   · 局内 canvas：`strokeText(lineWidth = 2 × reach)`（居中描边 → 向外扩 `reach`）；
   *   · 离线预览：`clamp(1 + reach − 到墨迹的距离)` —— 字形是矢量轮廓，
   *     向外扩只能靠距离场（`label-glyph.ts` 的 `drawTierLetter()`）。
   * 两者的外扩量**同源同值**，所以 DPR/字号变了也不会漂。
   */
  readonly reach: number;
  readonly rgba: Rgba;
}

/** 发光（外光晕）：分层加宽描边 —— 与 `shadowBlur` 无关，DPR 变了也不会漂。 */
export interface TierGlowPlan {
  /** 最外层半径（调用方单位）。 */
  readonly reach: number;
  /** 由内到外的各层（已含 alpha）。 */
  readonly layers: readonly TierGlowLayer[];
}

/**
 * 由总半径拆出各层（内层窄而亮、外层宽而淡）—— 局内与预览共用这一份。
 *
 * @param alphas 各层 alpha（内 → 外）；缺省 = 上线风格那一套
 */
export function tierGlowLayers(
  base: Rgba,
  totalReach: number,
  alphas: readonly number[] = TIER_GLOW_ALPHAS,
): readonly TierGlowLayer[] {
  const n = Math.max(1, alphas.length);
  return alphas.map((alpha, k) => ({
    reach: Math.max(0.5, (totalReach * (k + 1)) / n),
    rgba: withAlpha(base, base.a * alpha),
  }));
}

/** 一条尖括号：**折线**（2 段 3 点）——两边都按这个折线描边，形状完全一致。 */
export interface TierBracketPlan {
  readonly points: readonly PlanPoint[];
  readonly width: number;
}

/** 选取率行的几何（文案由 `augment-tier-label.ts` 的 `pickRateText()` 给）。 */
export interface TierRatePlan {
  readonly fontSize: number;
  readonly font: string;
  /** 字面中心 x（与字母同一个中心）。 */
  readonly textX: number;
  /** 基线 y（汉字没有降部，墨迹 = 基线往上 `inkHeight`）。 */
  readonly textY: number;
  readonly color: string;
  readonly rgba: Rgba;
  readonly inkHeight: number;
}

/** 一条局内强度标签的完整绘制计划（字形/颜色/位置全在这里）。 */
export interface TierTagPlan {
  /** 字母墨迹（cap）高 —— 所有几何都由它派生，单测也按它核对"字号与卡高成比例"。 */
  readonly capHeight: number;
  /** 整条标签的内容高 = cap 高 + 空隙 + 选取率墨迹高。 */
  readonly contentHeight: number;
  /** 内容宽 = 字母墨迹 + 两侧尖括号 + 两段空隙。 */
  readonly contentWidth: number;
  readonly contentLeft: number;
  readonly contentRight: number;
  readonly letter: TierLetterPlan;
  readonly glow: TierGlowPlan;
  readonly brackets: readonly TierBracketPlan[];
  readonly bracketColor: string;
  readonly bracketRgba: Rgba;
  readonly rate: TierRatePlan;
}

/**
 * 由**框 + 字号 + 强调色 + 该字母的度量**算出 `tier` 样式的完整绘制计划
 * （纯计算，无副作用）。
 *
 * 纵向：整条内容在框内**垂直居中**（`contentHeight` 与框高相等时就是占满），
 * 字母基线 = cap 带的下沿；横向：尖括号关于**框心**对称、字母墨迹也居中于框心
 * （`textX` 已含 `metrics.centerOffset` 的视觉居中修正 —— canvas 居中的是前进宽）。
 * **选取率行缺失时不画那一行，但字母位置不变**（位置只由框决定，不随数据跳动）。
 *
 * 字母填充 / 发光 / 尖括号全部由 `accent` 派生（尖括号与发光只是 alpha 不同），
 * 所以档位配色只有一个来源（`AUGMENT_TIER_COLORS`），加档也不会漏配。
 *
 * @param metrics 该字母的度量（`tierLetterMetrics(text)`；缺省 = 保守值）
 * @param treatment 描边/发光风格（缺省 = 上线的 `TIER_TREATMENT`）
 */
export function tierTagPlan(
  rect: Rect,
  fontSize: number,
  accent: string,
  metrics: TierLetterMetrics = TIER_LETTER_METRICS_FALLBACK,
  treatment: TierTreatment = TIER_TREATMENTS[TIER_TREATMENT],
): TierTagPlan {
  const accentRgba = parseCssColor(accent);
  const capHeight = fontSize * LABEL_CAP_RATIO;
  const rateFontSize = Math.max(1, Math.round(capHeight * TIER_RATE_FONT));
  const rateInk = rateFontSize * TIER_RATE_INK;
  const gap = capHeight * TIER_RATE_GAP;
  const contentHeight = capHeight + gap + rateInk;
  const centerX = rect.x + rect.w / 2;
  const centerY = rect.y + rect.h / 2;
  const top = centerY - contentHeight / 2;
  const baseline = top + capHeight;
  const capCenterY = top + capHeight / 2;

  // 尖括号按**这个字母的实测墨迹宽**排：每个字母都是"墨迹 + 固定空隙 + 尖括号"，
  // 三个字母并排时观感一致（固定槽位会让 S 显得空、A 显得挤）
  const inkWidth = capHeight * metrics.inkAspect;
  const bracketWidth = capHeight * TIER_BRACKET_WIDTH;
  const bracketHeight = capHeight * TIER_BRACKET_HEIGHT;
  const bracketStroke = Math.max(1, capHeight * TIER_BRACKET_STROKE);
  const offset = inkWidth / 2 + capHeight * TIER_BRACKET_GAP + bracketWidth / 2;
  // 内容宽要算上**折线笔画的一半**：圆头笔画会越过折线端点 `stroke/2`
  //（真机 canvas 量过：折线宽 103.5 DIP 的标签实际墨迹 ≈109.3 DIP）
  const contentWidth =
    inkWidth + 2 * (capHeight * TIER_BRACKET_GAP + bracketWidth) + bracketStroke;
  const centerLeft = centerX - offset;
  const centerRight = centerX + offset;
  const halfW = bracketWidth / 2;
  const halfH = bracketHeight / 2;
  const outlineWidth = Math.max(1, capHeight * treatment.outline);
  const glowReach = Math.max(1, capHeight * treatment.glow);

  return {
    capHeight,
    contentHeight,
    contentWidth,
    contentLeft: centerX - contentWidth / 2,
    contentRight: centerX + contentWidth / 2,
    letter: {
      fontSize,
      font: labelTierFont(fontSize),
      // 视觉居中：canvas 居中前进宽 → 再把它挪到"墨迹居中"
      textX: centerX + capHeight * metrics.centerOffset,
      textY: baseline,
      fillColor: accent,
      fillRgba: accentRgba,
      outlineWidth,
      outlineColor: rgbaCss(TIER_OUTLINE_RGBA),
      outlineRgba: TIER_OUTLINE_RGBA,
    },
    glow: {
      reach: glowReach,
      layers: tierGlowLayers(accentRgba, glowReach, treatment.glowAlphas),
    },
    brackets: [
      // 左 `‹`：右上 → 左中 → 右下
      {
        points: [
          [centerLeft + halfW, capCenterY - halfH],
          [centerLeft - halfW, capCenterY],
          [centerLeft + halfW, capCenterY + halfH],
        ],
        width: bracketStroke,
      },
      // 右 `›`：左上 → 右中 → 左下
      {
        points: [
          [centerRight - halfW, capCenterY - halfH],
          [centerRight + halfW, capCenterY],
          [centerRight - halfW, capCenterY + halfH],
        ],
        width: bracketStroke,
      },
    ],
    bracketColor: rgbaCss(withAlpha(accentRgba, TIER_BRACKET_ALPHA)),
    bracketRgba: withAlpha(accentRgba, TIER_BRACKET_ALPHA),
    rate: {
      fontSize: rateFontSize,
      font: labelFont(rateFontSize, TIER_RATE_WEIGHT),
      textX: centerX,
      textY: top + capHeight + gap + rateInk,
      color: TIER_RATE_COLOR,
      rgba: TIER_RATE_RGBA,
      inkHeight: rateInk,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 纵向边界（发光外廓 ↔ 选取率行是否重叠；单测、预览与像素诊断共用）        */
/* ------------------------------------------------------------------ */

/**
 * 一条 `tier` 标签的**纵向边界**（调用方单位）。
 *
 * 为什么单独有一个函数：`tierTagPlan()` 给的是基线 / 半径 / 字号，而"发光外廓会不会
 * 压到选取率那一行"要的是**两条边界的差**。这个差必须能被单测锁死（用户 2026-10-06
 * 真机反馈的正是它），也必须被离线预览与像素诊断脚本共用 —— 不允许各自再算一遍。
 */
export interface TierTagBounds {
  /** 字母墨迹上沿（= cap 带上沿，含圆字母的 overshoot）。 */
  readonly inkTop: number;
  /** 字母墨迹下沿（含 overshoot；**不是**基线）。 */
  readonly inkBottom: number;
  /** 深色描边的外沿下沿（居中描边 → 向外扩半个线宽）。 */
  readonly outlineBottom: number;
  /** 发光外廓的上/下沿（分层加宽描边：`lineWidth = 2 × reach` → 向外扩 `reach`）。 */
  readonly glowTop: number;
  readonly glowBottom: number;
  /** 选取率行的墨迹上/下沿（汉字没有降部 → 下沿 = 基线）。 */
  readonly rateInkTop: number;
  readonly rateInkBottom: number;
  /** **发光外廓下沿 ↔ 选取率墨迹上沿**：正 = 有间隙，负 = 重叠。 */
  readonly clearance: number;
}

/**
 * 由 `tierTagPlan()` 的计划 + **该字母墨迹的出格量**算出纵向边界（纯函数）。
 *
 * @param tag   字母的绘制计划（`labelBoxPlan(rect, { style: 'tier' }).tier`）
 * @param inkEm 该字母的墨迹上/下沿（**em**，来自 `label-letter.ts` 的 `tierLetterEmMetrics()`；
 *              `inkTop` 为负 = 基线之上、`inkBottom` 为正 = 基线之下）。缺省 = "墨迹正好等于
 *              cap 带、基线之下没有出格"，这对**间隙**是最乐观的假设（真实圆字母 `S`/`C`
 *              会略微向下出格，只会让间隙更小一点），所以真实调用方应当传它。
 */
export function tierTagBounds(
  tag: TierTagPlan,
  inkEm?: { readonly inkTop: number; readonly inkBottom: number },
): TierTagBounds {
  const topEm = inkEm?.inkTop ?? -LABEL_CAP_RATIO;
  const bottomEm = inkEm?.inkBottom ?? 0;
  const inkTop = tag.letter.textY + topEm * tag.letter.fontSize;
  const inkBottom = tag.letter.textY + bottomEm * tag.letter.fontSize;
  const rateInkTop = tag.rate.textY - tag.rate.inkHeight;
  const glowTop = inkTop - tag.glow.reach;
  const glowBottom = inkBottom + tag.glow.reach;
  return {
    inkTop,
    inkBottom,
    outlineBottom: inkBottom + tag.letter.outlineWidth / 2,
    glowTop,
    glowBottom,
    rateInkTop,
    rateInkBottom: tag.rate.textY,
    clearance: rateInkTop - glowBottom,
  };
}

/* ------------------------------------------------------------------ */
/* 纯计算                                                              */
/* ------------------------------------------------------------------ */

/** 是否按"紧凑标签"处理（矮框用更大的字号比例，否则框里显得空）。 */
export function labelIsCompact(h: number): boolean {
  return h < LABEL_COMPACT_MAX_H;
}

/** 主文本字号比例（`override` = 调用方给定，例如徽章预设的 `fontScale`）。 */
export function labelTextScale(h: number, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return override;
  return labelIsCompact(h) ? LABEL_COMPACT_TEXT_SCALE : LABEL_TEXT_SCALE;
}

/**
 * 主文本字号（**整数像素**，与 canvas 的 `font` 串一致）。
 *
 * ⚠️ 取整发生在**调用方自己的单位**里：渲染端传 DIP（canvas 再乘 DPR 变物理像素），
 * 预览传帧像素。所以两者可能差 1 个帧像素（四舍五入的位置不同），这是刻意的 ——
 * 让两边都"按自己那套坐标取整"，而不是让预览去猜 DPR。
 */
export function labelFontSize(h: number, scale: number): number {
  return Math.max(LABEL_MIN_FONT_SIZE, Math.round(h * scale));
}

/** canvas `font` 串。 */
export function labelFont(px: number, weight: number = LABEL_TEXT_WEIGHT): string {
  return `${weight} ${px}px ${LABEL_FONT_FAMILY}`;
}

/** 档位字母的 canvas `font` 串（**只有这里**能拼它 —— 字体栈与字重只有一个来源）。 */
export function labelTierFont(px: number): string {
  return `${LABEL_TIER_FONT_WEIGHT} ${px}px ${LABEL_TIER_FONT_FAMILY}`;
}

/** 强调色（描边 + 文字）：有档位色就用它，否则按 `hasData` 取绿/灰。 */
export function labelAccentColor(color: string | undefined, hasData: boolean): string {
  return color ?? (hasData ? LABEL_ACCENT_COLOR.hasData : LABEL_ACCENT_COLOR.empty);
}

/**
 * 描边色：**与强调色不同**——没给 `color` 时用半透明的绿/灰（避免细描边太抢眼），
 * 给了 `color`（局内档位）就原样使用。
 */
export function labelStrokeColor(color: string | undefined, hasData: boolean): string {
  return color ?? (hasData ? LABEL_STROKE_COLOR.hasData : LABEL_STROKE_COLOR.empty);
}

/** 标签样式：`label` = 深色圆角底（选人）；`tier` = 大号描边字母 + 尖括号（局内）。 */
export type LabelStyle = 'label' | 'tier';

export interface LabelBoxOptions {
  /** 强调色（描边 + 文字）；缺省按 `hasData` 取绿/灰。 */
  readonly color?: string;
  /** 是否有官方统计（无 `color` 时的绿/灰依据）。 */
  readonly hasData?: boolean;
  /** 字号比例覆盖（徽章用预设的 `fontScale`，不要落到紧凑规则上）。 */
  readonly textScale?: number;
  /** 单位换算：canvas = DIP（1）；离线预览画在截屏帧上时 = 帧像素 / DIP。 */
  readonly pxPerDip?: number;
  /** 绘制样式（默认 `label`；局内强度评级传 `tier`）。 */
  readonly style?: LabelStyle;
  /**
   * 这条标签要画的**主文本**（`tier` 样式就是那个档位字母）。
   *
   * 只需要它来查**该字母的排版度量**（墨迹宽、视觉居中偏移）—— 文字本身由调用方
   * 传给 `fillText`。缺省 = 用保守度量（行为与"不知道是哪个字母"时一致）。
   */
  readonly text?: string;
  /** `tier` 样式的描边/发光风格（缺省 = 上线的 `TIER_TREATMENT`；预览用它做对照）。 */
  readonly treatment?: TierTreatmentName;
}

/**
 * 一条标签的**完整绘制计划**（渲染端与预览共用）。
 *
 * 文本锚点按 canvas 的 `textAlign='center'` 给出；`textBaseline` 与 `textY`
 * 配套（`label` 样式 = em 盒居中；`tier` 样式 = **字母基线**，见 `tierTagPlan`）。
 */
export interface LabelBoxPlan {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** 圆角半径（已含 `pxPerDip`）。 */
  readonly radius: number;
  readonly strokeWidth: number;
  readonly fill: string;
  readonly fillRgba: Rgba;
  readonly strokeColor: string;
  readonly strokeRgba: Rgba;
  readonly accentColor: string;
  readonly accentRgba: Rgba;
  /** 主文本字号（调用方单位）。 */
  readonly fontSize: number;
  readonly font: string;
  readonly textX: number;
  readonly textY: number;
  readonly textBaseline: 'middle' | 'alphabetic';
  /** 是否画深色圆角底 + 边框（`tier` 样式**不画底**，参考图没有色块）。 */
  readonly boxVisible: boolean;
  /** 矮框（顶栏槽位）：只画主文本，不画副文本。 */
  readonly compact: boolean;
  readonly subFont: string;
  readonly subColor: string;
  readonly subX: number;
  readonly subY: number;
  readonly subMaxWidth: number;
  /** 局内强度评级的绘制计划；`label` 样式为 `null`。 */
  readonly tier: TierTagPlan | null;
}

/** 由矩形 + 选项算出绘制计划（无副作用、无 IO）。 */
export function labelBoxPlan(rect: Rect, options: LabelBoxOptions = {}): LabelBoxPlan {
  const scale = Number.isFinite(options.pxPerDip) && (options.pxPerDip ?? 0) > 0 ? options.pxPerDip! : 1;
  const hasData = options.hasData ?? true;
  const color = options.color;
  const tier = (options.style ?? 'label') === 'tier';
  const textScale = labelTextScale(rect.h, options.textScale);
  const byHeight = labelFontSize(rect.h, textScale);
  // `tier` 样式：字号还要受**框宽**约束（尖括号必须留在框内 —— 也就不压卡片描边）。
  // 内容宽按**该字母自己的墨迹宽**算，所以宽字母(A/M/W)自动用小一号的字，
  // 而不会让尖括号越出框（也就不会压到卡片描边）。
  const metrics = tier ? tierLetterMetrics(options.text) : TIER_LETTER_METRICS_FALLBACK;
  // 宽字母(A/M)会被框宽压到 byHeight 以下：**向下取整**，保证内容宽 ≤ 框宽（不压卡片描边）
  const byWidth = Math.floor(rect.w / tierContentFontAspect(metrics.inkAspect));
  const fontSize = tier ? Math.min(byHeight, Math.max(LABEL_MIN_FONT_SIZE, byWidth)) : byHeight;
  const subSize = labelFontSize(rect.h, LABEL_SUB_SCALE);
  const accentColor = labelAccentColor(color, hasData);
  const treatment = TIER_TREATMENTS[options.treatment ?? TIER_TREATMENT];
  const tag = tier ? tierTagPlan(rect, fontSize, accentColor, metrics, treatment) : null;
  return {
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    radius: LABEL_CORNER_RADIUS * scale,
    strokeWidth: LABEL_STROKE_WIDTH * scale,
    fill: LABEL_FILL,
    fillRgba: LABEL_FILL_RGBA,
    strokeColor: labelStrokeColor(color, hasData),
    strokeRgba: parseCssColor(labelStrokeColor(color, hasData)),
    accentColor,
    accentRgba: parseCssColor(accentColor),
    fontSize,
    font: tag ? tag.letter.font : labelFont(fontSize),
    // `tier` 样式的锚点由计划给（含**视觉居中**偏移，见 tierTagPlan）
    textX: tag ? tag.letter.textX : rect.x + rect.w / 2,
    textY: tag ? tag.letter.textY : rect.y + rect.h * 0.5,
    textBaseline: tag ? 'alphabetic' : 'middle',
    boxVisible: !tier,
    compact: labelIsCompact(rect.h),
    subFont: labelFont(subSize, LABEL_SUB_WEIGHT),
    subColor: LABEL_SUB_COLOR,
    subX: rect.x + rect.w - LABEL_SUB_RIGHT_PAD * scale,
    subY: rect.y + rect.h * 0.42,
    subMaxWidth: Math.max(
      LABEL_SUB_MIN_WIDTH * scale,
      rect.w - LABEL_SUB_RESERVED * scale,
    ),
    tier: tag,
  };
}
