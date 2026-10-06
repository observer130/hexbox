/**
 * 标签绘制约定测试（纯函数）
 *
 * 这套常量/规则是**渲染端与离线预览的唯一来源**：局内 canvas 与
 * `scripts/preview-augment-labels.mts` 的软件光栅化都调 `labelBoxPlan()`。
 * 所以这里锁四件事：
 *   ① 配色选择（有档位色用档位色、否则按 hasData 取绿/灰）；
 *   ② 字号规则（普通 0.52 / 紧凑 0.62 / 预设覆盖）与取整；
 *   ③ 单位缩放（`pxPerDip`：离线预览画在截屏帧上时圆角/描边/锚点跟着放大）——
 *      它一旦写错，预览就与局内不一样，而这正是用户要求避免的；
 *   ④ **`tier` 样式（局内强度标签）**：水平居中、字母 cap 高与卡高成比例、
 *      两侧尖括号不越出框、换分辨率等比 —— 用户 2026-10-05 定的外观；
 *   ⑤ **发光外廓不压选取率行**（2026-10-06 用户真机反馈"有点覆盖到「选取率」"）：
 *      `TIER_RATE_GAP > TIER_LETTER_GLOW`，三档的计划间隙都 ≥2 DIP ——
 *      这条关系按 cap 成比例，所以换档/换分辨率不会重新压上（`tierTagBounds()`）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LABEL_ACCENT_COLOR,
  LABEL_CAP_RATIO,
  LABEL_COMPACT_MAX_H,
  LABEL_COMPACT_TEXT_SCALE,
  LABEL_CORNER_RADIUS,
  LABEL_FILL,
  LABEL_FILL_RGBA,
  LABEL_MIN_FONT_SIZE,
  LABEL_STROKE_COLOR,
  LABEL_STROKE_WIDTH,
  LABEL_SUB_COLOR,
  LABEL_SUB_SCALE,
  LABEL_TEXT_SCALE,
  LABEL_TIER_FONT_FAMILY,
  LABEL_TIER_FONT_WEIGHT,
  TIER_BRACKET_ALPHA,
  TIER_BRACKET_GAP,
  TIER_BRACKET_WIDTH,
  TIER_GLOW_ALPHAS,
  TIER_LETTER_GLOW,
  TIER_LETTER_METRICS_FALLBACK,
  TIER_RATE_FONT,
  TIER_RATE_GAP,
  TIER_STACK_RATIO,
  TIER_TREATMENTS,
  TIER_TREATMENT,
  labelAccentColor,
  labelBoxPlan,
  labelFont,
  labelFontSize,
  labelIsCompact,
  labelStrokeColor,
  labelTierFont,
  labelTextScale,
  parseCssColor,
  rgbaCss,
  tierContentFontAspect,
  tierGlowLayers,
  tierLetterMetrics,
  tierTagBounds,
  tierTagPlan,
} from './label-draw.ts';
import {
  TIER_LETTERS_CAP_RATIO,
  TIER_LETTERS_DESIGN_INK_ASPECT,
  TIER_LETTERS_FONT,
  tierLetterEmMetrics,
} from './label-letter.ts';
import { TIER_LETTER_OUTLINES, tierLetterGlyph } from './label-letter-outlines.ts';
import { AUGMENT_BADGE_PRESETS, augmentBadgeZone, augmentLabelRect } from './augment-label.ts';
import type { Rect } from './types.ts';

/** 真机实测：显示器 3440×1440 @1.5× → 2293×960 DIP；卡片 427×667 物理像素。 */
const SCREEN_DIP = { w: 3440 / 1.5, h: 1440 / 1.5 };
const CARD_NORM: Rect = { x: 0.298, y: 0.191, w: 0.124, h: 0.463 };

/** 卡片矩形（DIP）。 */
const CARD_DIP: Rect = {
  x: CARD_NORM.x * SCREEN_DIP.w,
  y: CARD_NORM.y * SCREEN_DIP.h,
  w: CARD_NORM.w * SCREEN_DIP.w,
  h: CARD_NORM.h * SCREEN_DIP.h,
};

/** 真机一帧里最长的描述文字下沿（卡内比例，实测 0.713）——标签不许压到它。 */
const CARD_DESC_BOTTOM = 0.713;

const TIER_SIZES = ['small', 'medium', 'large'] as const;

/** 某一档预设的标签矩形（真机 DIP 坐标）。 */
function rectFor(size: (typeof TIER_SIZES)[number]): Rect {
  return augmentLabelRect(CARD_DIP, augmentBadgeZone(AUGMENT_BADGE_PRESETS[size]));
}

/* ------------------------------------------------------------------ */
/* 颜色解析 / 配色选择                                                  */
/* ------------------------------------------------------------------ */

test('parseCssColor：十六进制（3/6 位）与 rgb()/rgba() 都认，坏值给不透明黑', () => {
  assert.deepEqual(parseCssColor('#e6a33a'), { r: 230, g: 163, b: 58, a: 1 });
  assert.deepEqual(parseCssColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseCssColor('rgba(10, 14, 24, 0.88)'), { r: 10, g: 14, b: 24, a: 0.88 });
  assert.deepEqual(parseCssColor('rgb(1,2,3)'), { r: 1, g: 2, b: 3, a: 1 });
  assert.deepEqual(parseCssColor('不是颜色'), { r: 0, g: 0, b: 0, a: 1 });
  // 常量与解析结果必须一致（底色/描边都靠这条）
  assert.deepEqual(parseCssColor(LABEL_FILL), LABEL_FILL_RGBA);
  assert.equal(rgbaCss(LABEL_FILL_RGBA), LABEL_FILL);
});

test('有档位色就用档位色（描边与文字同色）；否则按 hasData 取绿/灰', () => {
  assert.equal(labelAccentColor('#e6a33a', true), '#e6a33a');
  assert.equal(labelStrokeColor('#e6a33a', true), '#e6a33a');
  assert.equal(labelAccentColor(undefined, true), LABEL_ACCENT_COLOR.hasData);
  assert.equal(labelAccentColor(undefined, false), LABEL_ACCENT_COLOR.empty);
  assert.equal(labelStrokeColor(undefined, true), LABEL_STROKE_COLOR.hasData);
  assert.equal(labelStrokeColor(undefined, false), LABEL_STROKE_COLOR.empty);
  // 没给 color 时描边是**半透明**的（细描边不抢眼）；给了 color 就不加透明度
  assert.ok(parseCssColor(LABEL_STROKE_COLOR.hasData).a < 1);
});

/* ------------------------------------------------------------------ */
/* 字号规则                                                            */
/* ------------------------------------------------------------------ */

test('字号规则：普通 0.52、紧凑 0.62、预设覆盖优先，且取整', () => {
  assert.equal(labelTextScale(60), LABEL_TEXT_SCALE);
  assert.equal(labelTextScale(LABEL_COMPACT_MAX_H - 1), LABEL_COMPACT_TEXT_SCALE);
  assert.equal(labelTextScale(60, 0.7), 0.7, '预设的 fontScale 覆盖默认规则');
  assert.equal(labelTextScale(60, 0), LABEL_TEXT_SCALE, '非法覆盖值不生效');
  assert.equal(labelFontSize(60, 0.52), Math.round(60 * 0.52));
  assert.equal(labelFontSize(0, 0.52), LABEL_MIN_FONT_SIZE, '字号有下限（不会画成 0px）');
  assert.equal(labelFont(31), `700 31px "Microsoft YaHei", sans-serif`);
  assert.equal(labelFont(31, 600), `600 31px "Microsoft YaHei", sans-serif`);
  assert.equal(labelIsCompact(26), true);
  assert.equal(labelIsCompact(60), false);
});

test('字号只看**框高**（宽框不会把字母撑成巨型），且锚点在框心', () => {
  const wide = labelBoxPlan({ x: 0, y: 0, w: 400, h: 60 });
  const narrow = labelBoxPlan({ x: 0, y: 0, w: 40, h: 60 });
  assert.equal(wide.fontSize, narrow.fontSize);
  assert.equal(wide.textX, 200);
  assert.equal(wide.textY, 30);
  assert.equal(wide.font, labelFont(labelFontSize(60, LABEL_TEXT_SCALE)));
});

test('徽章预设的字号比例让**绝对字号**随档递增（大档框更大、字母也更大）', () => {
  const sizes = ['small', 'medium', 'large'] as const;
  const fonts = sizes.map((s) => {
    const preset = AUGMENT_BADGE_PRESETS[s];
    const rect = augmentLabelRect(CARD_DIP, augmentBadgeZone(preset));
    return labelBoxPlan(rect, { textScale: preset.fontScale }).fontSize;
  });
  assert.ok(fonts[0]! < fonts[1]!, `小 < 中（${fonts.join(' / ')}）`);
  assert.ok(fonts[1]! < fonts[2]!, `中 < 大（${fonts.join(' / ')}）`);
});

/* ------------------------------------------------------------------ */
/* `tier` 样式（局内强度标签）：居中 + 大字母 + 尖括号 + 选取率行            */
/* ------------------------------------------------------------------ */

test('两种样式互斥：`label` 画色块底，`tier` 没有底、且锚点是**字母基线**', () => {
  const rect: Rect = { x: 10, y: 20, w: 120, h: 80 };
  const label = labelBoxPlan(rect, { textScale: 0.5 });
  assert.equal(label.boxVisible, true, '选人标签要画深色圆角底');
  assert.equal(label.tier, null);
  assert.equal(label.textBaseline, 'middle');
  assert.equal(label.textY, rect.y + rect.h * 0.5);

  const tier = labelBoxPlan(rect, { textScale: 0.5, style: 'tier' });
  assert.equal(tier.boxVisible, false, '局内强度标签**没有色块底**（参考图就没有）');
  assert.ok(tier.tier !== null);
  assert.equal(tier.textBaseline, 'alphabetic');
  // 基线 = cap 带下沿（不是框心）：否则大字母会整体偏低
  assert.equal(tier.textY, tier.tier!.letter.textY);
  assert.equal(tier.font, tier.tier!.letter.font);
  assert.ok(tier.textY < rect.y + rect.h, '基线在框内');
  assert.ok(tier.textY > rect.y + rect.h * 0.5, '基线在框心之下（框上部留给 cap 高）');
});

test('`tier` 整条内容占满框、且字母与选取率行都不越出框', () => {
  for (const s of TIER_SIZES) {
    const rect = rectFor(s);
    const tag = labelBoxPlan(rect, { color: '#f7c948', textScale: AUGMENT_BADGE_PRESETS[s].fontScale, style: 'tier' }).tier!;
    // 内容高 = cap + 空隙 + 选取率墨迹；字号取整 + **宽字母可能被框宽压小一档**
    //（真实墨迹比旧的固定 0.72 cap 宽），所以容差要留出那么一两像素
    assert.ok(
      Math.abs(tag.contentHeight - rect.h) < 3,
      `${s} 内容高 ${tag.contentHeight.toFixed(1)} 应≈框高 ${rect.h.toFixed(1)}`,
    );
    assert.ok(tag.contentHeight <= rect.h + 1.5, `${s} 内容高不应超过框高（会压到描述/卡底）`);
    assert.ok(tag.letter.textY - tag.capHeight >= rect.y - 0.5, `${s} cap 顶在框内`);
    assert.ok(tag.letter.textY <= rect.y + rect.h + 0.5, `${s} 字母基线在框内`);
    assert.ok(tag.rate.textY <= rect.y + rect.h + 0.5, `${s} 选取率基线在框内`);
    assert.ok(
      tag.rate.textY - tag.rate.inkHeight > tag.letter.textY - 1,
      `${s} 选取率行在字母基线之下（不能压住字母）`,
    );
  }
});

test('**发光外廓与选取率行不重叠**（2026-10-06 用户真机反馈："有点覆盖到「选取率」"）', () => {
  const clearances: number[] = [];
  for (const s of TIER_SIZES) {
    const letter = s === 'small' ? 'S' : s === 'medium' ? 'A' : 'B';
    const rect = rectFor(s);
    const tag = labelBoxPlan(rect, {
      color: '#f7c948',
      textScale: AUGMENT_BADGE_PRESETS[s].fontScale,
      style: 'tier',
      text: letter,
    }).tier!;
    // 用**该字母自己的**墨迹出格量（S/C 这类圆字母会略低于基线）
    const b = tierTagBounds(tag, tierLetterEmMetrics(letter)!);
    assert.ok(
      b.clearance >= 2,
      `${s} 发光外廓下沿 ↔ 选取率墨迹上沿 = ${b.clearance.toFixed(2)} DIP，应 ≥2（用户要"明确的正间隙"）`,
    );
    // 光晕确实在字母墨迹之外 —— 否则"不重叠"可能是"根本没发光"造成的假通过
    assert.ok(b.glowBottom > b.inkBottom, `${s} 发光应当向外扩（${b.glowBottom.toFixed(2)} > ${b.inkBottom.toFixed(2)}）`);
    assert.ok(b.outlineBottom > b.inkBottom && b.outlineBottom < b.glowBottom, `${s} 深色描边应夹在墨迹与发光之间`);
    assert.ok(b.glowTop < b.inkTop && b.rateInkTop > b.inkBottom, `${s} 上/下边界方向正确`);
    // 描边与发光**仍然按 cap 成比例**（不许写死像素）
    assert.ok(
      Math.abs(tag.glow.reach / tag.capHeight - TIER_TREATMENTS[TIER_TREATMENT].glow) < 1e-9,
      `${s} 发光半径 = cap × ${TIER_TREATMENTS[TIER_TREATMENT].glow}`,
    );
    assert.ok(
      Math.abs(tag.letter.outlineWidth / tag.capHeight - TIER_TREATMENTS[TIER_TREATMENT].outline) < 1e-9,
      `${s} 描边宽 = cap × ${TIER_TREATMENTS[TIER_TREATMENT].outline}`,
    );
    clearances.push(b.clearance);
  }
  assert.equal(clearances.length, 3);
  // 三档都为正（任务要求"三档都不重叠"）
  assert.ok(clearances.every((c) => c > 0), `三档间隙应为正：${clearances.map((c) => c.toFixed(2)).join(' / ')}`);
});

test('"内部空隙 > 发光半径"是**与 cap 无关**的恒定关系（换档/换分辨率都不会重新压上）', () => {
  assert.ok(
    TIER_RATE_GAP > TIER_LETTER_GLOW,
    `内部空隙 ${TIER_RATE_GAP} 必须大于发光半径 ${TIER_LETTER_GLOW}（否则光晕必然压进选取率行）`,
  );
  // 任意字号都不重叠：两边都是 cap 的比例，所以这条关系不随分辨率漂
  for (const fontSize of [8, 20, 42, 200]) {
    const tag = tierTagPlan({ x: 0, y: 0, w: 400, h: fontSize * 2 }, fontSize, '#f7c948');
    const b = tierTagBounds(tag);
    assert.ok(b.clearance > 0, `字号 ${fontSize} 时间隙 ${b.clearance.toFixed(2)} 应 > 0`);
    // 缺省（不知道是哪个字母）是最乐观的假设，真实字母只会更小一点，但仍是正的
    assert.ok(b.rateInkTop - b.glowBottom === b.clearance);
  }
  // 计划间隙 = (空隙 − 发光) × cap − 墨迹出格：把它写成断言，改任一个常量都会立刻红
  const tag = tierTagPlan({ x: 0, y: 0, w: 400, h: 100 }, 60, '#f7c948');
  const b = tierTagBounds(tag);
  assert.ok(Math.abs(b.clearance - (TIER_RATE_GAP - TIER_LETTER_GLOW) * tag.capHeight) < 1e-9);
});

test('水平居中：尖括号/选取率行以框心为轴，字母带**视觉居中**偏移', () => {
  for (const s of TIER_SIZES) {
    const letter = s === 'small' ? 'S' : s === 'medium' ? 'A' : 'B';
    const rect = rectFor(s);
    const tag = labelBoxPlan(rect, {
      color: '#e8484f',
      textScale: AUGMENT_BADGE_PRESETS[s].fontScale,
      style: 'tier',
      text: letter,
    }).tier!;
    const cx = rect.x + rect.w / 2;
    assert.equal(tag.rate.textX, cx, `${s} 选取率行居中于框心`);
    // 字母：canvas 居中的是**前进宽**，展示型字体的墨迹并不在正中 → 计划里带修正量
    const m = tierLetterMetrics(letter);
    assert.ok(
      Math.abs(tag.letter.textX - cx - tag.capHeight * m.centerOffset) < 1e-9,
      `${s} 字母锚点 = 框心 + 视觉居中偏移`,
    );
    assert.ok(Math.abs(tag.contentLeft + tag.contentRight - 2 * cx) < 1e-9, `${s} 内容关于框心对称`);
    const [left, right] = tag.brackets;
    assert.ok(left && right, `${s} 应有左右两条尖括号`);
    // 折线中点（第二点）就是尖角的位置
    assert.ok(Math.abs((left!.points[1]![0] + right!.points[1]![0]) / 2 - cx) < 1e-9, `${s} 尖角对称`);
    assert.ok(left!.points[1]![0] < cx && right!.points[1]![0] > cx, `${s} 左尖括号在左、右尖括号在右`);
    // 尖括号是"朝外"的尖角：上/下端点比尖角更靠内 → 两段折线
    assert.equal(left!.points.length, 3);
    assert.ok(left!.points[0]![0] > left!.points[1]![0], `${s} ‹ 的尖端朝左`);
    assert.ok(right!.points[0]![0] < right!.points[1]![0], `${s} › 的尖端朝右`);
    // 两条尖括号与字母在**同一条水平中线上**
    const letterCy = tag.letter.textY - tag.capHeight / 2;
    assert.ok(Math.abs(left!.points[1]![1] - letterCy) < 1e-9);
  }
});

/* ------------------------------------------------------------------ */
/* 视觉居中（展示型字体的墨迹不在前进宽正中）与逐字母字距                  */
/* ------------------------------------------------------------------ */

test('视觉居中：按字体度量修正后，字母**墨迹**正好落在框心（S/A/B/C 都成立）', () => {
  const rect = rectFor('medium');
  const cx = rect.x + rect.w / 2;
  let maxDrift = 0;
  for (const letter of ['S', 'A', 'B', 'C']) {
    const g = tierLetterGlyph(letter)!;
    const tag = labelBoxPlan(rect, {
      color: '#f7c948',
      textScale: AUGMENT_BADGE_PRESETS.medium.fontScale,
      style: 'tier',
      text: letter,
    }).tier!;
    // canvas 的 textAlign='center' 把**前进宽**居中 → 笔位原点在左
    const penX = tag.letter.textX - (g.advance * tag.letter.fontSize) / 2;
    const inkCenter = penX + ((g.inkLeft + g.inkRight) / 2) * tag.letter.fontSize;
    assert.ok(Math.abs(inkCenter - cx) < 1e-9, `${letter} 墨迹中心 ${inkCenter} 应 == 框心 ${cx}`);
    maxDrift = Math.max(maxDrift, Math.abs(tag.capHeight * tierLetterMetrics(letter).centerOffset));
  }
  // 这个修正不是摆设：至少有一个字母的偏移超过 cap 的 1%
  assert.ok(maxDrift > rect.h * 0.0016, `修正量太小（${maxDrift.toFixed(3)}）——度量没接上？`);
});

test('逐字母字距：尖括号贴着**该字母自己的**墨迹，内容宽逐个都不越出框', () => {
  const rect = rectFor('medium');
  const cx = rect.x + rect.w / 2;
  const widths: number[] = [];
  for (const letter of Object.keys(TIER_LETTER_OUTLINES)) {
    const tag = labelBoxPlan(rect, {
      color: '#37c1e8',
      textScale: AUGMENT_BADGE_PRESETS.medium.fontScale,
      style: 'tier',
      text: letter,
    }).tier!;
    assert.ok(tag.contentWidth <= rect.w + 1e-9, `${letter} 内容宽 ${tag.contentWidth.toFixed(1)} 应 ≤ 框宽 ${rect.w}`);
    assert.ok(tag.contentLeft >= rect.x - 1e-9 && tag.contentRight <= rect.x + rect.w + 1e-9, `${letter} 尖括号在框内`);
    // 尖括号**尖端**到框心的距离 = 该字母墨迹的一半 + 固定空隙 + 整条尖括号宽
    //（`‹` 的中点是最外侧的端点，所以比"最近边缘"多一个 bracketWidth）
    const [left] = tag.brackets;
    const expected =
      (tag.capHeight * tierLetterMetrics(letter).inkAspect) / 2 +
      tag.capHeight * TIER_BRACKET_GAP +
      tag.capHeight * TIER_BRACKET_WIDTH;
    assert.ok(Math.abs(cx - left!.points[1]![0] - expected) < 1e-9, `${letter} 尖括号间距按自身墨迹宽排`);
    widths.push(tag.contentWidth);
  }
  // 宽字母（M/W）的内容宽必须**明显**大于窄字母（I）——不是固定槽位。
  //（宽字母还会被框宽压小一号字，所以比值小于"墨迹宽之比"本身）
  const max = Math.max(...widths);
  const min = Math.min(...widths);
  assert.ok(max > min * 1.35, `内容宽应随字母墨迹变化（${min.toFixed(1)}~${max.toFixed(1)}）`);
});

test('未知字母（没有实测度量）用保守值：内容宽仍不越出框、居中不偏移', () => {
  const rect = rectFor('medium');
  const unknown = labelBoxPlan(rect, {
    color: '#8b96ad',
    textScale: AUGMENT_BADGE_PRESETS.medium.fontScale,
    style: 'tier',
  }).tier!;
  assert.equal(unknown.letter.textX, rect.x + rect.w / 2, '没有度量就不做视觉居中（不猜）');
  assert.ok(unknown.contentWidth <= rect.w + 1e-9);
  assert.deepEqual(tierLetterMetrics(undefined), TIER_LETTER_METRICS_FALLBACK);
  assert.deepEqual(tierLetterMetrics('中'), TIER_LETTER_METRICS_FALLBACK);
  assert.ok(
    Math.abs(tierContentFontAspect(TIER_LETTER_METRICS_FALLBACK.inkAspect) * unknown.letter.fontSize - unknown.contentWidth) < 1e-9,
    '保守度量下 内容宽 = 字号 × tierContentFontAspect(墨迹宽/cap)',
  );
});

/* ------------------------------------------------------------------ */
/* 字体栈与两套描边/发光风格                                             */
/* ------------------------------------------------------------------ */

test('档位字体：重型展示栈 + 900，且与字形数据**同源**（首项 == 生成字体）', () => {
  assert.equal(LABEL_TIER_FONT_WEIGHT, 900);
  assert.equal(LABEL_TIER_FONT_FAMILY.split(',')[0]!.trim(), `"${TIER_LETTERS_FONT}"`);
  assert.ok(LABEL_TIER_FONT_FAMILY.includes('"Arial Black"'), '要含次选 Arial Black');
  assert.ok(LABEL_TIER_FONT_FAMILY.includes('Impact'), '要含 Impact');
  assert.ok(LABEL_TIER_FONT_FAMILY.includes('"Microsoft YaHei UI"'), '要用微软雅黑 UI 兜底');
  assert.equal(labelTierFont(48), `900 48px ${LABEL_TIER_FONT_FAMILY}`);
  // cap 比引用字形数据 —— "预览里字号多大、局内就多大"这条关系不可能漂
  assert.equal(LABEL_CAP_RATIO, TIER_LETTERS_CAP_RATIO);
  assert.ok(LABEL_CAP_RATIO > 0.65 && LABEL_CAP_RATIO < 0.75, `cap 比 ${LABEL_CAP_RATIO} 应在合理范围`);

  const rect = rectFor('medium');
  const tag = labelBoxPlan(rect, {
    textScale: AUGMENT_BADGE_PRESETS.medium.fontScale,
    style: 'tier',
    text: 'S',
  }).tier!;
  assert.equal(tag.letter.font, labelTierFont(tag.letter.fontSize), '档位字母用档位字体栈');
  assert.ok(tag.letter.font.startsWith('900 '), '字重 900');
});

test('两套描边/发光风格：B 的描边与发光明显更粗，几何/配色完全不受风格影响', () => {
  const rect = rectFor('medium');
  const base = {
    color: '#37c1e8',
    textScale: AUGMENT_BADGE_PRESETS.medium.fontScale,
    style: 'tier' as const,
    text: 'B',
  };
  const a = labelBoxPlan(rect, { ...base, treatment: 'a' }).tier!;
  const b = labelBoxPlan(rect, { ...base, treatment: 'b' }).tier!;
  assert.ok(b.letter.outlineWidth > a.letter.outlineWidth * 1.5, 'B 的深色描边更粗');
  assert.ok(b.glow.reach > a.glow.reach * 1.5, 'B 的发光更大');
  assert.equal(a.glow.layers.length, TIER_TREATMENTS.a.glowAlphas.length);
  assert.equal(b.glow.layers.length, TIER_TREATMENTS.b.glowAlphas.length);
  assert.ok(TIER_TREATMENTS.b.glowAlphas.length > TIER_TREATMENTS.a.glowAlphas.length, 'B 的发光层次更多');
  for (const tag of [a, b]) {
    for (const [i, layer] of tag.glow.layers.entries()) {
      assert.ok(layer.reach > 0);
      if (i > 0) {
        assert.ok(layer.reach > tag.glow.layers[i - 1]!.reach, '越外层越宽');
        assert.ok(layer.rgba.a < tag.glow.layers[i - 1]!.rgba.a, '越外层越淡');
      }
    }
  }
  // 风格只动"粗细"：字号/几何/尖括号/锚点/配色一律不变
  assert.equal(a.letter.fontSize, b.letter.fontSize);
  assert.equal(a.capHeight, b.capHeight);
  assert.equal(a.contentWidth, b.contentWidth);
  assert.equal(a.letter.textX, b.letter.textX);
  assert.equal(a.letter.textY, b.letter.textY);
  assert.deepEqual(a.letter.fillRgba, b.letter.fillRgba);
  assert.deepEqual(a.brackets, b.brackets);
  assert.equal(a.letter.outlineColor, b.letter.outlineColor);
  // 不指定 treatment = 上线的那一套
  const dflt = labelBoxPlan(rect, base).tier!;
  assert.equal(dflt.letter.outlineWidth, Math.max(1, dflt.capHeight * TIER_TREATMENTS[TIER_TREATMENT].outline));
  assert.equal(dflt.glow.reach, Math.max(1, dflt.capHeight * TIER_TREATMENTS[TIER_TREATMENT].glow));
  assert.equal(dflt.glow.layers.length, TIER_GLOW_ALPHAS.length);
  assert.equal(TIER_LETTER_GLOW, TIER_TREATMENTS[TIER_TREATMENT].glow);
});

test('tierGlowLayers：按给定层数与 alpha 分层（reach 内→外递增、alpha 递减）', () => {
  const base = { r: 255, g: 128, b: 0, a: 1 };
  const two = tierGlowLayers(base, 20, [0.5, 0.25]);
  assert.equal(two.length, 2);
  assert.deepEqual(two.map((l) => Math.round(l.reach)), [10, 20]);
  assert.ok(Math.abs(two[0]!.rgba.a - 0.5) < 1e-9);
  assert.ok(Math.abs(two[1]!.rgba.a - 0.25) < 1e-9);
  const one = tierGlowLayers(base, 9, [0.4]);
  assert.equal(one.length, 1);
  assert.equal(Math.round(one[0]!.reach), 9);
  // 档位色半透明时，各层 alpha 再乘它
  const faded = tierGlowLayers({ r: 1, g: 2, b: 3, a: 0.5 }, 10, [0.4]);
  assert.ok(Math.abs(faded[0]!.rgba.a - 0.2) < 1e-9);
});

test('字母高与**卡高**成比例：三档都落在卡高 6.5%~7.5%（2026-10-06 第二次整体缩小），且随档递增', () => {
  const caps: number[] = [];
  for (const s of TIER_SIZES) {
    const rect = rectFor(s);
    const tag = labelBoxPlan(rect, { color: '#37c1e8', textScale: AUGMENT_BADGE_PRESETS[s].fontScale, style: 'tier' }).tier!;
    const share = tag.capHeight / CARD_DIP.h;
    assert.ok(share >= 0.065 && share <= 0.075, `${s} 字母 cap 高占卡高 ${share.toFixed(3)} 应在 0.065~0.075`);
    // 字号 = cap 高 ÷ 雅黑 cap 比（两边共用的那一个常量）
    assert.ok(Math.abs(tag.letter.fontSize * LABEL_CAP_RATIO - tag.capHeight) < 1e-9);
    caps.push(share);
  }
  assert.ok(caps[0]! < caps[1]! && caps[1]! < caps[2]!, `cap 高应随档递增（${caps.map((c) => c.toFixed(3)).join(' / ')}）`);
});

test('标签落在描述之下、不压描述也不贴卡底（真机 DIP）', () => {
  for (const s of TIER_SIZES) {
    const rect = rectFor(s);
    const top = (rect.y - CARD_DIP.y) / CARD_DIP.h;
    const bottom = (rect.y + rect.h - CARD_DIP.y) / CARD_DIP.h;
    assert.ok(top >= CARD_DESC_BOTTOM, `${s} 框顶 ${top.toFixed(3)} 应不高于描述底 ${CARD_DESC_BOTTOM}`);
    assert.ok(bottom <= 1, `${s} 不越出卡片底部`);
    assert.ok(1 - bottom >= 0.05, `${s} 距卡底 ${(1 - bottom).toFixed(3)} 应留 ≥0.05（避开亮边框）`);
    assert.ok(rect.x > CARD_DIP.x && rect.x + rect.w < CARD_DIP.x + CARD_DIP.w, `${s} 左右都在卡内`);
  }
});

test('换分辨率等比：卡片减半 → 字母 cap/尖括号/选取率行全部减半，卡内相对位置不变', () => {
  const big = rectFor('medium');
  const small: Rect = { ...big, x: big.x / 2, y: big.y / 2, w: big.w / 2, h: big.h / 2 };
  const a = labelBoxPlan(big, { color: '#f7c948', textScale: AUGMENT_BADGE_PRESETS.medium.fontScale, style: 'tier' }).tier!;
  const b = labelBoxPlan(small, { color: '#f7c948', textScale: AUGMENT_BADGE_PRESETS.medium.fontScale, style: 'tier' }).tier!;
  // ⚠️ 字号是**整数像素**（`labelFontSize` 会取整，见其注释），所以等比只到"1 个字号像素"以内；
  // 而宽度约束那一档是**向下取整**（保证内容不越出框），两个取整叠加后位置会有
  // 一个"选取率行字号取整"级别（≈0.5 个选取率像素 / 框高）的差 —— 容差按它留。
  const tol = 1 / a.letter.fontSize + 0.005;
  assert.ok(Math.abs(b.capHeight / a.capHeight - 0.5) < tol, `cap 高等比（${(b.capHeight / a.capHeight).toFixed(4)}）`);
  assert.ok(Math.abs(b.contentWidth / a.contentWidth - 0.5) < tol, '内容宽等比');
  assert.ok(Math.abs(b.rate.fontSize / a.rate.fontSize - 0.5) < 0.05, '选取率字号等比');
  assert.ok(
    Math.abs((b.letter.textY - small.y) / small.h - (a.letter.textY - big.y) / big.h) < 0.012,
    '卡内相对位置一致（容差见上）',
  );
  assert.ok(Math.abs((b.letter.textX - small.x) / small.w - (a.letter.textX - big.x) / big.w) < 1e-9, '水平位置精确等比');
});

test('尖括号不越出卡宽：内容宽 ≤ 框宽，且真机三档都 ≤ 卡宽 60%', () => {
  for (const s of TIER_SIZES) {
    const rect = rectFor(s);
    const tag = labelBoxPlan(rect, { color: '#37c1e8', textScale: AUGMENT_BADGE_PRESETS[s].fontScale, style: 'tier' }).tier!;
    assert.ok(tag.contentWidth <= rect.w + 1e-9, `${s} 内容宽 ${tag.contentWidth.toFixed(1)} 不得超框宽 ${rect.w.toFixed(1)}`);
    assert.ok(tag.contentLeft >= rect.x - 1e-9 && tag.contentRight <= rect.x + rect.w + 1e-9, `${s} 尖括号在框内`);
    const share = tag.contentWidth / CARD_DIP.w;
    assert.ok(share <= 0.6, `${s} 内容占卡宽 ${share.toFixed(3)} 应 ≤ 0.6`);
  }
});

test('框太窄时按**框宽**收缩（字号只受框高约束的另一半）：内容永远留在框内', () => {
  const narrow: Rect = { x: 0, y: 0, w: 60, h: 300 };
  const tag = labelBoxPlan(narrow, { color: '#f7c948', textScale: AUGMENT_BADGE_PRESETS.medium.fontScale, style: 'tier' }).tier!;
  assert.ok(tag.contentWidth <= narrow.w + 1e-9, `内容宽 ${tag.contentWidth.toFixed(1)} 应在 60 内`);
  const tall = labelBoxPlan({ x: 0, y: 0, w: 600, h: 300 }, { color: '#f7c948', textScale: AUGMENT_BADGE_PRESETS.medium.fontScale, style: 'tier' }).tier!;
  assert.ok(tag.capHeight < tall.capHeight, '窄框的字母应比宽框小（按宽收缩）');
});

test('配色：字母用档位色，尖括号/发光由它派生（同色、仅 alpha 不同）', () => {
  const rect = rectFor('medium');
  const opts = { color: '#e8484f', textScale: AUGMENT_BADGE_PRESETS.medium.fontScale, style: 'tier' as const };
  const tag = labelBoxPlan(rect, opts).tier!;
  const accent = parseCssColor('#e8484f');
  assert.deepEqual(tag.letter.fillRgba, accent, '字母填充就是档位色');
  assert.equal(tag.letter.fillColor, '#e8484f');
  // 尖括号：同色、更暗
  assert.equal(tag.bracketRgba.r, accent.r);
  assert.equal(tag.bracketRgba.g, accent.g);
  assert.equal(tag.bracketRgba.b, accent.b);
  assert.ok(Math.abs(tag.bracketRgba.a - TIER_BRACKET_ALPHA) < 1e-9, '尖括号用固定的那个 alpha');
  // 发光：分层、由内到外变宽、alpha 递减，颜色仍是档位色
  assert.equal(tag.glow.layers.length, TIER_GLOW_ALPHAS.length);
  for (const [i, layer] of tag.glow.layers.entries()) {
    assert.equal(layer.rgba.r, accent.r);
    assert.ok(layer.reach > 0, '每层都有外扩距离');
    if (i > 0) {
      assert.ok(layer.reach > tag.glow.layers[i - 1]!.reach, '越外层越宽');
      assert.ok(layer.rgba.a < tag.glow.layers[i - 1]!.rgba.a, '越外层越淡');
    }
  }
  assert.ok(tag.glow.reach >= tag.glow.layers[tag.glow.layers.length - 1]!.reach - 1e-9);
  // 换档位色只换颜色，不动几何
  const other = labelBoxPlan(rect, { ...opts, color: '#37c1e8' }).tier!;
  assert.equal(other.capHeight, tag.capHeight);
  assert.equal(other.contentWidth, tag.contentWidth);
  assert.deepEqual(other.brackets, tag.brackets);
  assert.equal(other.letter.textY, tag.letter.textY);
});

test('未知档位色（中性灰）同样画出整套：字母/尖括号/发光齐全，不猜档位', () => {
  const rect = rectFor('medium');
  const tag = labelBoxPlan(rect, { color: '#8b96ad', textScale: AUGMENT_BADGE_PRESETS.medium.fontScale, style: 'tier' }).tier!;
  assert.equal(tag.letter.fillColor, '#8b96ad');
  assert.ok(tag.glow.layers.length > 0);
  assert.equal(tag.brackets.length, 2);
});

test('选取率行：字号约字母 cap 的 0.36（明显小于字母）、居中、有墨迹高', () => {
  const rect = rectFor('medium');
  const tag = labelBoxPlan(rect, { color: '#f7c948', textScale: AUGMENT_BADGE_PRESETS.medium.fontScale, style: 'tier' }).tier!;
  assert.ok(Math.abs(tag.rate.fontSize - Math.round(tag.capHeight * TIER_RATE_FONT)) <= 1);
  assert.ok(tag.rate.fontSize < tag.capHeight * 0.5, '选取率字号应明显小于字母');
  assert.ok(tag.rate.fontSize > 8, '再小就不可读了');
  assert.ok(tag.rate.inkHeight > 0);
  assert.equal(tag.rate.textX, tag.letter.textX);
  // 整条高 = cap + 空隙 + 选取率墨迹（预设 height 就是按它定的）
  assert.ok(Math.abs(tag.contentHeight - tag.capHeight * TIER_STACK_RATIO) < 1.5);
});

test('pxPerDip 不影响 `tier` 几何（预览画在截屏帧上时仍然"预览 = 局内"）', () => {
  const rect = rectFor('medium');
  const opts = { color: '#37c1e8', textScale: AUGMENT_BADGE_PRESETS.medium.fontScale, style: 'tier' as const };
  const dip = labelBoxPlan(rect, opts);
  const frame = labelBoxPlan(rect, { ...opts, pxPerDip: 2 });
  assert.deepEqual(frame.tier, dip.tier, 'tier 计划（含尖括号折线）不随单位换算变');
  assert.equal(frame.fontSize, dip.fontSize);
  assert.equal(frame.textY, dip.textY);
  // 只有"绝对长度"常量跟着放大（它们与字号无关）
  assert.equal(frame.radius, LABEL_CORNER_RADIUS * 2);
  assert.equal(frame.strokeWidth, LABEL_STROKE_WIDTH * 2);
});

test('tierTagPlan 是纯函数：同样的框与字号给同样的计划（可单测、无隐藏状态）', () => {
  const rect: Rect = { x: 5, y: 7, w: 120, h: 70 };
  const a = tierTagPlan(rect, 50, '#f7c948');
  const b = tierTagPlan(rect, 50, '#f7c948');
  assert.deepEqual(a, b);
  // 字号翻倍 → 全部几何翻倍
  const big = tierTagPlan(rect, 100, '#f7c948');
  assert.ok(Math.abs(big.capHeight / a.capHeight - 2) < 1e-9);
  assert.ok(Math.abs(big.contentWidth / a.contentWidth - 2) < 1e-9);
  assert.ok(Math.abs(big.glow.reach / a.glow.reach - 2) < 1e-9);
});

/* ------------------------------------------------------------------ */
/* 单位缩放（离线预览画在截屏帧上）                                      */
/* ------------------------------------------------------------------ */

test('pxPerDip：圆角/描边/文本边距等比放大，几何本身不动', () => {
  const rect: Rect = { x: 100, y: 200, w: 80, h: 40 };
  const dip = labelBoxPlan(rect);
  const frame = labelBoxPlan(rect, { pxPerDip: 2 });
  assert.equal(dip.radius, LABEL_CORNER_RADIUS);
  assert.equal(frame.radius, LABEL_CORNER_RADIUS * 2);
  assert.equal(dip.strokeWidth, LABEL_STROKE_WIDTH);
  assert.equal(frame.strokeWidth, LABEL_STROKE_WIDTH * 2);
  assert.equal(dip.subX, 100 + 80 - 10);
  assert.equal(frame.subX, 100 + 80 - 20);
  assert.equal(dip.subMaxWidth, Math.max(24, 80 - 90));
  assert.equal(frame.subMaxWidth, Math.max(48, 80 - 180));
  // 几何与字号不随单位换算变（预览与局内因此一致）
  assert.equal(frame.x, dip.x);
  assert.equal(frame.w, dip.w);
  assert.equal(frame.fontSize, dip.fontSize);
  assert.equal(frame.textX, dip.textX);
});

test('副文本（英雄名）只在非紧凑框里画；局内强度标签的副文本走 `tier.rate`', () => {
  const big = labelBoxPlan({ x: 0, y: 0, w: 200, h: 60 });
  assert.equal(big.compact, false);
  assert.equal(big.subColor, LABEL_SUB_COLOR);
  assert.equal(big.subFont, labelFont(labelFontSize(60, LABEL_SUB_SCALE), 600));
  assert.equal(big.subY, 60 * 0.42);
  assert.equal(labelBoxPlan({ x: 0, y: 0, w: 200, h: 26 }).compact, true);
});
