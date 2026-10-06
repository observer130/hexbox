/**
 * 海克斯强度**标签**位置与尺寸测试
 *
 * 锁住 2026-10-05 与用户确认（并给了参考图）后的几何含义：
 *   ① 标签画在卡片**底部空白区**：不压图标、名字、稀有度标签、描述，也不越出卡片；
 *   ② 位置**水平居中**（参考图就是"卡下方正中间"）——不再是右下角的小圆角徽章；
 *   ③ 标签**整条**（字母 cap + 空隙 + 下方「选取率 x%」行）的高由预设给，
 *      字母 cap 高 = 整条高 ÷ `TIER_STACK_RATIO`；
 *   ④ `marginX` 在居中时是**两侧最小安全间距**（预设宽到贴边时才会夹住）；
 *   ⑤ 2026-10-06 用户第一次："S/A/B/C 字母太大了，应该小一些" → 三档整体缩小；
 *   ⑥ 2026-10-06 用户第二次："字体似乎没变，还是太大" → 先量后改（渲染端真实产物
 *      量出字母墨迹 54.0 → 39.3 DIP，证明上一版确实生效，只是**描边+发光把外廓
 *      撑到字母的 1.9 倍**），于是再缩一档：默认档字母 cap 高落在卡高的
 *      **0.065~0.075**（见下面对应的用例）；
 *   ⑦ 同一排的标签**纵向对齐**（用户："同一排三个标签明显不在一个高度上"）：
 *      `alignRowLabels()` 让整排共用一个纵向基准（见文件末尾的行对齐用例）；
 *   ⑧ 整排基准**锁**（用户二次验收："某次单卡刷新后，三个标签整体下移了一点"）：
 *      中位数只抗离群、不保证不变 → 局内改成"开边沿用 `lockLabelRowBand()` 锁一次、
 *      之后一直复用"，刷新只改内容（见文件末尾的锁用例）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUGMENT_BADGE_DEFAULT,
  AUGMENT_BADGE_PRESETS,
  AUGMENT_LABEL_ZONE,
  alignRowLabels,
  alignRowLabelsLocked,
  augmentBadgeZone,
  augmentLabelRect,
  augmentLabelRects,
  labelRowBand,
  lockLabelRowBand,
  median,
  type AugmentBadgeSize,
} from './augment-label.ts';
import { labelBoxPlan, TIER_STACK_RATIO } from './label-draw.ts';
import type { Rect } from './types.ts';

/** 真机实测的卡片矩形（4587×1920 帧，第一张卡）。 */
const CARD: Rect = { x: 0.298, y: 0.191, w: 0.124, h: 0.463 };

/**
 * 同一张卡片的**屏幕 DIP** 坐标（显示器 3440×1440 @1.5× → 2293×960 DIP）。
 *
 * `labelBoxPlan()` 要真实像素（字号取整、字号下限都在它里面做），
 * 所以凡是核对字号/像素的用例都得用这一份，不能用归一化坐标。
 */
const CARD_DIP: Rect = {
  x: CARD.x * (3440 / 1.5),
  y: CARD.y * (1440 / 1.5),
  w: CARD.w * (3440 / 1.5),
  h: CARD.h * (1440 / 1.5),
};

/** 卡内布局实测（卡内归一化）：描述到 0.72，往下是空白区。 */
const LAYOUT = { iconEnd: 0.37, name: [0.44, 0.51], rarity: [0.52, 0.55], desc: [0.6, 0.72] } as const;

/** 改版前那一版（右下角小圆角徽章）：0.26×0.10、距右 0.08。 */
const OLD_ZONE = { y: 0.85, height: 0.1, width: 0.26 } as const;

const SIZES: readonly AugmentBadgeSize[] = ['small', 'medium', 'large'];

test('三档预设俱全，宽/高单调递增（字号比例略降，绝对字号见 label-draw 测试）', () => {
  assert.deepEqual(Object.keys(AUGMENT_BADGE_PRESETS).sort(), ['large', 'medium', 'small']);
  let prevW = 0;
  let prevH = 0;
  for (const s of SIZES) {
    const p = AUGMENT_BADGE_PRESETS[s];
    assert.ok(p.width > prevW, `${s} 宽应比上一档大`);
    assert.ok(p.height > prevH, `${s} 高应比上一档大`);
    // 字号 = 框高 × fontScale；fontScale 由 label-draw 的常量算出来（= 1/(整条高/cap 高 × cap 比)）
    assert.ok(p.fontScale > 0.8 && p.fontScale < 0.95, `${s} 字号比例应在 0.8~0.95，实际 ${p.fontScale}`);
    assert.ok(p.marginX > 0 && p.marginY > 0, '必须留边距，不贴边框');
    assert.ok(p.align === 'center', `${s} 必须水平居中（用户给参考图后的决定）`);
    prevW = p.width;
    prevH = p.height;
  }
});

test('默认档就是「小」，且 AUGMENT_LABEL_ZONE 与它一致（只有一个开关）', () => {
  // 2026-10-06 第四次：用户看过 small 的真机观感（"small 字体比较合适"）→ 默认改 small
  assert.equal(AUGMENT_BADGE_DEFAULT, 'small');
  assert.deepEqual(AUGMENT_LABEL_ZONE, augmentBadgeZone(AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT]));
  assert.equal(
    AUGMENT_LABEL_ZONE.y,
    1 - AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT].marginY - AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT].height,
  );
  // 默认档的取值必须是三档之一（打错字会静默拿到 undefined 几何）
  assert.ok(SIZES.includes(AUGMENT_BADGE_DEFAULT));
});

test('2026-10-06 第四次"往上挪一点点"：三档 marginY 一致上移，字母大小**一个像素都没动**', () => {
  /** 上一版（第三次定尺寸）的三档：框高 + 距卡底留白。 */
  const PREV: Readonly<Record<AugmentBadgeSize, { readonly height: number; readonly marginY: number }>> = {
    small: { height: 0.105, marginY: 0.06 },
    medium: { height: 0.112, marginY: 0.06 },
    large: { height: 0.119, marginY: 0.06 },
  };
  /** 上一版量出来的 cap 高（DIP，见 label-draw.test.ts 的同一组用例）。 */
  const PREV_CAP: Readonly<Record<AugmentBadgeSize, number>> = { small: 29.41, medium: 30.81, large: 32.91 };
  for (const s of SIZES) {
    const p = AUGMENT_BADGE_PRESETS[s];
    // ① 整条标签上移（留白变大 = 更靠上），且三档一致
    assert.ok(p.marginY > PREV[s].marginY, `${s} marginY 应比上一版大（整条上移）实际 ${p.marginY}`);
    assert.equal(p.marginY, AUGMENT_BADGE_PRESETS.small.marginY, '三档留白一致（同一排才对得齐）');
    // ② 内部空隙变大 → 框（= 整条标签高）必须按同一比例放大，才能让 cap 高**逐位不变**
    assert.ok(p.height > PREV[s].height, `${s} 框高应随内部空隙放大`);
    const rect = augmentLabelRect(CARD_DIP, augmentBadgeZone(p));
    const cap = labelBoxPlan(rect, { color: '#f7c948', textScale: p.fontScale, style: 'tier', text: 'S' }).tier!.capHeight;
    assert.ok(
      Math.abs(cap - PREV_CAP[s]) < 0.02,
      `${s} 字母 cap 高应保持 ${PREV_CAP[s]} DIP（用户："small 字体比较合适"），实际 ${cap.toFixed(2)}`,
    );
  }
});

test('三档都落在卡片底部空白区（不压描述、不越出卡片、留底边距）', () => {
  for (const s of SIZES) {
    const p = AUGMENT_BADGE_PRESETS[s];
    const r = augmentLabelRect(CARD, augmentBadgeZone(p));
    const top = (r.y - CARD.y) / CARD.h;
    const bottom = (r.y + r.h - CARD.y) / CARD.h;
    assert.ok(top >= LAYOUT.desc[1], `${s} 顶部 ${top.toFixed(3)} 应不高于描述底 ${LAYOUT.desc[1]}`);
    assert.ok(top > LAYOUT.iconEnd && top > LAYOUT.name[1] && top > LAYOUT.rarity[1]);
    assert.ok(bottom <= 1 - p.marginY + 1e-9, `${s} 底部 ${bottom.toFixed(3)} 应留出 ${p.marginY} 边距`);
    assert.ok(Math.abs(bottom - (1 - p.marginY)) < 1e-9);
  }
});

test('**水平居中**：标签中心 = 卡片中心（不再是右下角）', () => {
  for (const s of SIZES) {
    const r = augmentLabelRect(CARD, augmentBadgeZone(AUGMENT_BADGE_PRESETS[s]));
    assert.ok(
      Math.abs(r.x + r.w / 2 - (CARD.x + CARD.w / 2)) < 1e-9,
      `${s} 应水平居中（中心 ${(r.x + r.w / 2).toFixed(4)} / 卡心 ${(CARD.x + CARD.w / 2).toFixed(4)}）`,
    );
  }
});

test('标签**整条**（字母 + 选取率行）不压描述：真机 DIP 下字母 cap 高在卡高 6.5%~7.5%', () => {
  for (const s of SIZES) {
    const preset = AUGMENT_BADGE_PRESETS[s];
    const rect = augmentLabelRect(CARD_DIP, augmentBadgeZone(preset));
    // ⚠️ 传 `text` 才是真实路径：字号由**框高**定，但宽字母（A/M/W）还可能被框宽
    // 再压小一号（保证尖括号不越出框，见 label-draw.test.ts 的逐字母字距测试）。
    // 这里用窄字母 `S` 验证"预设 height = 整条标签高"这条**语义**本身。
    const tag = labelBoxPlan(rect, {
      color: '#f7c948',
      textScale: preset.fontScale,
      style: 'tier',
      text: 'S',
    }).tier!;
    // 预设 height 是**整条**标签的高：cap 高 = 框高 ÷ TIER_STACK_RATIO
    const capFromBox = tag.capHeight * TIER_STACK_RATIO;
    assert.ok(
      Math.abs(capFromBox / rect.h - 1) < 0.02,
      `${s} cap 高 × ${TIER_STACK_RATIO.toFixed(3)} 应≈框高（${capFromBox.toFixed(1)} vs ${rect.h.toFixed(1)}）`,
    );
    const capOfCard = tag.capHeight / CARD_DIP.h;
    assert.ok(
      capOfCard >= 0.065 && capOfCard <= 0.075,
      `${s} 字母 cap 占卡高 ${capOfCard.toFixed(3)} 应在 0.065~0.075`,
    );
    // 最宽的字母（A）即使被框宽压一号，也必须仍落在 6.5%~7.5% 这条产品要求里
    const wide = labelBoxPlan(rect, {
      color: '#f7c948',
      textScale: preset.fontScale,
      style: 'tier',
      text: 'A',
    }).tier!;
    const wideShare = wide.capHeight / CARD_DIP.h;
    assert.ok(
      wideShare >= 0.065 && wideShare <= 0.075,
      `${s} A 的 cap 占卡高 ${wideShare.toFixed(3)} 也应合规`,
    );
    assert.ok(wide.capHeight <= tag.capHeight, `${s} 宽字母的字号只会更小（框宽是上限）`);
  }
});

test('2026-10-06 第二次"还是太大"：默认档比上一版再小 12%~24%，比最初版小 35% 以上', () => {
  /** 上一版（用户第一次说"太大"之后定的三档，cap/卡高）。 */
  const PREV: Readonly<Record<AugmentBadgeSize, number>> = { small: 0.075, medium: 0.085, large: 0.095 };
  /** 最初版（2026-10-05 真机实测，见 docs/AUGMENT-PANEL.md §十三）。 */
  const BEFORE: Readonly<Record<AugmentBadgeSize, number>> = { small: 0.106, medium: 0.119, large: 0.131 };
  const shares = new Map<AugmentBadgeSize, number>();
  for (const s of SIZES) {
    const preset = AUGMENT_BADGE_PRESETS[s];
    const rect = augmentLabelRect(CARD_DIP, augmentBadgeZone(preset));
    const tag = labelBoxPlan(rect, {
      color: '#f7c948',
      textScale: preset.fontScale,
      style: 'tier',
      text: 'S',
    }).tier!;
    const share = tag.capHeight / CARD_DIP.h;
    shares.set(s, share);
    assert.ok(share < PREV[s], `${s} 应比上一版 ${PREV[s]} 小，实际 ${share.toFixed(3)}`);
    assert.ok(share < BEFORE[s], `${s} 应比最初版 ${BEFORE[s]} 小，实际 ${share.toFixed(3)}`);
  }
  // 用户这次的要求：默认档比上一版**再小 12%~24%**（目标 0.065~0.075）
  const medium = shares.get('medium')!;
  const shrink = 1 - medium / PREV.medium;
  assert.ok(
    shrink >= 0.12 && shrink <= 0.24,
    `默认档应比上一版再小 12%~24%，实际 ${(shrink * 100).toFixed(1)}%`,
  );
  // 累计比最初版小 35% 以上（用户两次说"太大"）
  assert.ok(1 - medium / BEFORE.medium >= 0.35, `累计缩幅 ${((1 - medium / BEFORE.medium) * 100).toFixed(1)}%`);
  // 三档仍随档递增
  assert.ok(shares.get('small')! < medium && medium < shares.get('large')!);
});

test('比第一版的右下角小徽章仍然大得多（字母本体，不是整框）', () => {
  const p = AUGMENT_BADGE_PRESETS.medium;
  const plan = labelBoxPlan(augmentLabelRect(CARD_DIP, augmentBadgeZone(p)), {
    color: '#f7c948',
    textScale: p.fontScale,
    style: 'tier',
  });
  // 第一版徽章：框高 0.10 卡高、正文（胜率数字）字号 = 框高 × 0.52
  const oldTextCap = CARD_DIP.h * OLD_ZONE.height * 0.52;
  assert.ok(plan.tier!.capHeight > oldTextCap * 1.25, '字母 cap 高仍明显大于旧徽章的正文');
  // 整条标签（字母 + 选取率行）仍比旧徽章的框高，宽度也仍更宽
  assert.ok(plan.h > CARD_DIP.h * OLD_ZONE.height, '整条标签仍比旧徽章的框高');
  assert.ok(plan.w > CARD_DIP.w * OLD_ZONE.width, '框也比旧徽章宽');
});

test('框宽不足时按两侧安全间距夹住（`marginX` 在居中时的作用）', () => {
  // 0.9 卡宽 + 两侧各 0.06 = 1.02 > 1：安全间距放不下 → 退化为"贴左安全线"，但绝不越出卡片
  const wide = { ...AUGMENT_BADGE_PRESETS.medium, width: 0.9 };
  const r = augmentLabelRect(CARD, augmentBadgeZone(wide));
  const inset = CARD.w * wide.marginX;
  assert.ok(Math.abs(r.x - (CARD.x + inset)) < 1e-9, '贴住左侧安全线（不越出卡片）');
  assert.ok(r.x >= CARD.x && r.x + r.w <= CARD.x + CARD.w + 1e-9, '仍在卡内');
  // 正常预设（0.44 + 0.12 < 1）里安全间距**不生效**：仍是精确居中
  const normal = augmentLabelRect(CARD, augmentBadgeZone(AUGMENT_BADGE_PRESETS.medium));
  assert.ok(Math.abs(normal.x + normal.w / 2 - (CARD.x + CARD.w / 2)) < 1e-9);
});

test('右下角贴边（align: right）也仍然支持（第一版的几何，没被删掉）', () => {
  const zone = { ...augmentBadgeZone(AUGMENT_BADGE_PRESETS.medium), align: 'right' as const };
  const r = augmentLabelRect(CARD, zone);
  assert.ok(Math.abs((CARD.x + CARD.w - (r.x + r.w)) / CARD.w - zone.marginX) < 1e-9, '距卡右 = marginX');
  assert.ok(
    Math.abs((CARD.y + CARD.h - (r.y + r.h)) / CARD.h - AUGMENT_BADGE_PRESETS.medium.marginY) < 1e-9,
    '距卡底 = marginY',
  );
  assert.ok(r.x > CARD.x, '左边仍在卡内');
});

test('尺寸随卡片等比缩放（换分辨率不变形）', () => {
  const narrow: Rect = { ...CARD, w: CARD.w / 2, h: CARD.h / 2 };
  const a = augmentLabelRect(CARD);
  const b = augmentLabelRect(narrow);
  assert.ok(Math.abs(b.w / a.w - 0.5) < 1e-6, '宽度应等比');
  assert.ok(Math.abs(b.h / a.h - 0.5) < 1e-6, '高度应等比');
  assert.ok(Math.abs((b.x - narrow.x) / narrow.w - (a.x - CARD.x) / CARD.w) < 1e-9, '卡内相对位置一致');
});

test('认不准的卡不画（augmentId === null 被过滤）—— 语义与改版前一致', () => {
  const cards = [
    { card: CARD, augmentId: 1373 },
    { card: CARD, augmentId: null },
    { card: CARD, augmentId: 1326 },
  ];
  const out = augmentLabelRects(cards);
  assert.equal(out.length, 2, '只画认出来的两张');
  assert.deepEqual(
    out.map((o) => o.card.augmentId),
    [1373, 1326],
  );
});

test('退化输入不炸（零尺寸卡片）', () => {
  const r = augmentLabelRect({ x: 0.5, y: 0.5, w: 0, h: 0 });
  assert.equal(r.w, 0);
  assert.equal(r.h, 0);
});

test('自定义标签区可覆盖（将来挪位置只改一处）', () => {
  const r = augmentLabelRect(CARD, { y: 0.8, height: 0.1, width: 0.25, marginX: 0.1, align: 'center' });
  assert.ok(Math.abs((r.y - CARD.y) / CARD.h - 0.8) < 1e-9);
  assert.ok(Math.abs(r.h / CARD.h - 0.1) < 1e-9);
  assert.ok(Math.abs(r.w / CARD.w - 0.25) < 1e-9);
  assert.ok(Math.abs(r.x + r.w / 2 - (CARD.x + CARD.w / 2)) < 1e-9, '居中');
  const right = augmentLabelRect(CARD, { y: 0.8, height: 0.1, width: 0.25, marginX: 0.1, align: 'right' });
  assert.ok(Math.abs((CARD.x + CARD.w - (right.x + right.w)) / CARD.w - 0.1) < 1e-9);
});

/* ------------------------------------------------------------------ */
/* 行对齐（用户 2026-10-06："同一排三个标签明显不在一个高度上"）            */
/* ------------------------------------------------------------------ */

/**
 * 真机 `debug/augment/report.json`（atMs=23221，**单卡重随**那一帧）反推出来的
 * 三张卡矩形：前两张是面板开启时冻结的矩形，第三张是"重随那一刻"重新识别的
 * 矩形（卡片正在翻牌动画里，所以又高又靠上）。反推用的预设是该次报告记录的
 * `0.37 × 0.136`（见报告里的 `labels.preset`）。
 */
const REROLL_CARDS: readonly Rect[] = [
  { x: 0.29735271614384085, y: 0.1917050736842105, w: 0.12501912777352715, h: 0.460610379679144 },
  { x: 0.43981637337413926, y: 0.1917050736842105, w: 0.12501912777352715, h: 0.460610379679144 },
  { x: 0.5812921053812845, y: 0.17287065943116413, w: 0.12637597349980165, h: 0.4976025273475413 },
];

/** 归一化 y → 屏幕物理像素（真机 3440×1440 @1.5×：DIP 高 960）。 */
const SCREEN_H = 1440;
/** 屏幕缩放倍率（DIP → 物理像素）。 */
const SCREEN_SCALE = 1.5;

/** 归一化矩形 → 屏幕 DIP（x/w 按宽、y/h 按高 —— 两个轴各乘各的）。 */
function toDip(r: Rect): Rect {
  return {
    x: r.x * (3440 / 1.5),
    y: r.y * (1440 / 1.5),
    w: r.w * (3440 / 1.5),
    h: r.h * (1440 / 1.5),
  };
}

/**
 * 一条标签的**基线**（字母 cap 带的下沿，DIP）—— "三个标签在同一高度"最终看的就是它。
 *
 * ⚠️ 必须先把归一化矩形换成屏幕 DIP 再调 `labelBoxPlan()`：直接喂归一化的小数
 * 会算出"字号下限 6"那种无意义的结果（字号本该是几十 DIP）。
 */
function baselineOf(rectNorm: Rect): number {
  return labelBoxPlan(toDip(rectNorm), {
    color: '#f7c948',
    textScale: AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT].fontScale,
    style: 'tier',
    text: 'S',
  }).tier!.letter.textY;
}

/** 一条标签的字母 cap 高（DIP）。 */
function capOf(rectNorm: Rect): number {
  return labelBoxPlan(toDip(rectNorm), {
    color: '#f7c948',
    textScale: AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT].fontScale,
    style: 'tier',
    text: 'S',
  }).tier!.capHeight;
}

test('行对齐：三张卡矩形有差异时，标签 y / h **完全相等**（真机"单卡重随"那一帧）', () => {
  const zone = augmentBadgeZone(AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT]);
  const before = REROLL_CARDS.map((c) => augmentLabelRect(c, zone));
  const after = alignRowLabels(REROLL_CARDS, zone);

  // 改前：第三个标签明显偏低（真机实测 ≈17 屏幕物理像素，肉眼就是"不在一个高度"）
  const spreadBefore = (Math.max(...before.map((r) => r.y)) - Math.min(...before.map((r) => r.y))) * SCREEN_H;
  assert.ok(spreadBefore > 15 && spreadBefore < 19, `改前错开 ${spreadBefore.toFixed(1)} px 应是十几像素`);
  // 改前连**字母大小**都不一样（h 差 ≈6 px）→ 基线差得更多
  const hBefore = (Math.max(...before.map((r) => r.h)) - Math.min(...before.map((r) => r.h))) * SCREEN_H;
  assert.ok(hBefore > 5, `改前 h 极差 ${hBefore.toFixed(1)} px`);

  // 改后：y 与 h 都**逐位相同** → 基线像素级相同
  assert.equal(new Set(after.map((r) => r.y)).size, 1, '三个标签 y 必须完全相等');
  assert.equal(new Set(after.map((r) => r.h)).size, 1, '三个标签 h（字母大小）也必须相等');
  // 基线（= 框顶 + cap）也随之相同，且 cap 是"几十 DIP"的正常值（不是字号下限 6）
  assert.equal(new Set(after.map(baselineOf)).size, 1, '三个标签基线必须完全相等');
  assert.equal(new Set(after.map(capOf)).size, 1, '三个字母的 cap 高也必须相等');
  const cap = capOf(after[0]!);
  assert.ok(cap > 25 && cap < 35, `cap 高 ${cap.toFixed(1)} DIP 应是正常字号算出来的（≈31 DIP）`);
  // 改前基线差多少（真机实测 ≈20.8 屏幕物理像素）—— 证明这不是"本来就没差"
  const baseSpread =
    (Math.max(...before.map(baselineOf)) - Math.min(...before.map(baselineOf))) * SCREEN_SCALE;
  assert.ok(baseSpread > 18 && baseSpread < 24, `改前基线差 ${baseSpread.toFixed(1)} px`);

  // 横向**没被改**：仍是各自卡片水平居中，且框宽仍随各自卡片
  for (const [i, r] of after.entries()) {
    const card = REROLL_CARDS[i]!;
    assert.ok(
      Math.abs(r.x + r.w / 2 - (card.x + card.w / 2)) < 1e-9,
      `${i + 1} 号仍水平居中于自己的卡片`,
    );
    assert.ok(Math.abs(r.w - card.w * zone.width) < 1e-9);
  }
  // 纵向基准取的是**中位数**：第三张（动画里偏大的那张）不该把整排拉走
  const band = labelRowBand(REROLL_CARDS, zone)!;
  assert.ok(band.h > 0);
  assert.ok(
    Math.abs(band.h - REROLL_CARDS[0]!.h * zone.height) < 1e-9,
    '中位数 h = 两张稳定卡的高度（动画那张不参与）',
  );
});

test('行对齐的退化情况：单张卡 == 原几何；两张卡也共用同一 y/h；数量变化不崩', () => {
  const zone = augmentBadgeZone(AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT]);
  // 空
  assert.deepEqual(alignRowLabels([]), []);
  assert.equal(labelRowBand([]), null);
  // 单张：与逐卡几何**完全一致**（数值也逐位相同）
  for (const card of REROLL_CARDS) {
    assert.deepEqual(alignRowLabels([card], zone), [augmentLabelRect(card, zone)]);
  }
  // 两张（y/h 都不同）：仍然共用同一个 y/h，且是中位数（= 两者均值）
  const two = [REROLL_CARDS[0]!, REROLL_CARDS[2]!];
  const out = alignRowLabels(two, zone);
  assert.equal(out.length, 2);
  assert.equal(new Set(out.map((r) => r.y)).size, 1);
  assert.equal(new Set(out.map((r) => r.h)).size, 1);
  const band = labelRowBand(two, zone)!;
  assert.ok(Math.abs(band.h - ((two[0]!.h + two[1]!.h) / 2) * zone.height) < 1e-9);
  // 数量变化：1/2/3/4 张都不崩，且输出条数 == 输入条数
  for (const n of [1, 2, 3, 4]) {
    const cards = Array.from({ length: n }, (_, i) => ({
      ...REROLL_CARDS[0]!,
      x: REROLL_CARDS[0]!.x + i * 0.14,
      y: REROLL_CARDS[0]!.y + i * 0.002,
      h: REROLL_CARDS[0]!.h - i * 0.003,
    }));
    const rs = alignRowLabels(cards, zone);
    assert.equal(rs.length, n);
    assert.equal(new Set(rs.map((r) => r.y)).size, 1, `${n} 张时 y 仍统一`);
  }
  // 零尺寸卡片不炸
  assert.equal(alignRowLabels([{ x: 0, y: 0, w: 0, h: 0 }], zone)[0]!.h, 0);
  assert.equal(alignRowLabels([{ x: 0, y: 0, w: 0, h: 0 }], zone)[0]!.y, 0);
});

test('median：奇数取中间、偶数取中间两个均值、空数组 null、不改动入参', () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([2, 2, 9]), 2, '中位数天然抗离群值（均值会给 4.33）');
  const input = [3, 1, 2];
  median(input);
  assert.deepEqual(input, [3, 1, 2], '入参不被排序/改动');
});

/* ------------------------------------------------------------------ */
/* 行基准的**锁**（2026-10-06 真机二次验收："某次单卡刷新后整体下移了一点"）  */
/* ------------------------------------------------------------------ */

const ZONE = augmentBadgeZone(AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT]);

test('行基准锁：首次 ≥1 张卡时锁定；已锁定就**原样返回**（绝不重算）', () => {
  // 面板刚开、一张都没认出来 → 不锁定（继续保持 null）
  assert.equal(lockLabelRowBand(null, [], ZONE), null);
  assert.equal(lockLabelRowBand(undefined, [], ZONE), null);
  // 首次 ≥1 张：用**这一批**卡片矩形锁（单张时与无锁形态逐位相同）
  const one = lockLabelRowBand(null, [REROLL_CARDS[0]!], ZONE)!;
  assert.deepEqual(one.band, labelRowBand([REROLL_CARDS[0]!], ZONE));
  assert.deepEqual(one.cards, [REROLL_CARDS[0]!]);
  // 已经锁了 → 同一个对象：卡片怎么变（重随动画帧）、变成空、都不动它
  assert.equal(lockLabelRowBand(one, REROLL_CARDS, ZONE), one, '不重算');
  assert.equal(lockLabelRowBand(one, [], ZONE), one, '空输入也不会解锁');
  // 三张卡锁定：基准取中位数（= 两张稳定卡，动画那张不参与）
  const three = lockLabelRowBand(null, REROLL_CARDS, ZONE)!;
  assert.equal(three.band.h, REROLL_CARDS[0]!.h * ZONE.height);
  assert.equal(three.cards.length, 3);
});

test('alignRowLabelsLocked：锁定后卡片矩形怎么变，**纵向**都动不了（横向仍各自居中）', () => {
  const lock = lockLabelRowBand(null, REROLL_CARDS, ZONE)!;
  const before = alignRowLabelsLocked(REROLL_CARDS, lock, ZONE);
  assert.equal(before.length, 3);
  assert.equal(new Set(before.map((r) => r.y)).size, 1);
  assert.equal(new Set(before.map((r) => r.h)).size, 1);
  assert.equal(before[0]!.y, lock.band.y);
  assert.equal(before[0]!.h, lock.band.h);
  // 三张卡的矩形全被换成"动画中间帧"那种明显不同的（y ±0.03、h ±0.05、w 也变）
  const moved = REROLL_CARDS.map((c, i) => ({ ...c, y: c.y + (i % 2 === 0 ? 0.03 : -0.03), h: c.h + 0.05, w: c.w + 0.01 }));
  const after = alignRowLabelsLocked(moved, lock, ZONE);
  // 纵向：逐位相同（0 位移）—— 这就是"刷新不许改基准"的那条保证
  assert.deepEqual(
    after.map((r) => [r.y, r.h]),
    before.map((r) => [r.y, r.h]),
  );
  // 横向：仍按**本帧**各自的卡片水平居中（横向从来不是问题，语义没改）
  for (const [i, r] of after.entries()) {
    const card = moved[i]!;
    assert.ok(Math.abs(r.x + r.w / 2 - (card.x + card.w / 2)) < 1e-9, `${i + 1} 号仍居中于自己的卡片`);
    assert.ok(Math.abs(r.w - card.w * ZONE.width) < 1e-9);
  }
  // 没有锁（这一局面板一张卡都没认出来过）→ 不画
  assert.deepEqual(alignRowLabelsLocked(REROLL_CARDS, null, ZONE), []);
  assert.deepEqual(alignRowLabelsLocked(REROLL_CARDS, undefined, ZONE), []);
  assert.deepEqual(alignRowLabelsLocked([], lock, ZONE), []);
});

test('回归：alignRowLabels()（无锁形态）"三张卡矩形有差异 → y 全等"的性质没被改动', () => {
  const after = alignRowLabels(REROLL_CARDS, ZONE);
  assert.equal(new Set(after.map((r) => r.y)).size, 1);
  assert.equal(new Set(after.map((r) => r.h)).size, 1);
  // 与锁定形态在"三张卡本来就一致"的真机开边沿帧上逐位相同
  const lock = lockLabelRowBand(null, REROLL_CARDS, ZONE)!;
  const locked = alignRowLabelsLocked(REROLL_CARDS, lock, ZONE);
  assert.deepEqual(
    locked.map((r) => [r.y, r.h]),
    after.map((r) => [r.y, r.h]),
    '锁定基准取自同一批矩形时，两种形态的纵向几何一致',
  );
});
