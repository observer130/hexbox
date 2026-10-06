/**
 * 海克斯强度标签（S5.4c）测试
 *
 * 锁住五条产品决策与三条坐标/取数约定：
 *   1. 认不准不画（`augmentId === null`）；
 *   2. 查不到强度不画；
 *   3. 标签内容 = **档位字母**（`text`）+ **一行「选取率 x%」**（`subText`）；
 *      选取率查不到/为 0 时**只少那一行**，字母照画（绝不猜数字）；
 *   4. 关闭边沿清空（无状态：空输入 → 空输出）；
 *   5. 标签矩形在卡片底部空白区、**水平居中**、随卡片等比缩放；
 *   6. 屏幕坐标复用 S2 的 `normalizedRectToScreen`（含窗口偏移），并带上 `style: 'tier'`；
 *   7. 档位配色 S 金 / A 红 / B 青蓝 / C 灰，未知档位给中性色（照画）。
 *
 * 卡片矩形取自真机录制产物（`debug/augment/checkpoint.json`，3440×1440 帧），
 * 不是编出来的数字 —— 标定值改动时这几个用例会跟着红。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUGMENT_PICK_RATE_PREFIX,
  AUGMENT_TIER_COLORS,
  AUGMENT_TIER_UNKNOWN_COLOR,
  augmentPickRateTable,
  augmentTierColor,
  augmentTierLabels,
  augmentTierLabelsLocked,
  augmentTierTable,
  lookupAugmentPickRate,
  lookupAugmentTier,
  pickRateText,
  resolveAugmentTiers,
  toScreenTierLabels,
  type AugmentTierLabel,
} from './augment-tier-label.ts';
import {
  AUGMENT_BADGE_DEFAULT,
  AUGMENT_BADGE_PRESETS,
  augmentBadgeZone,
} from './augment-label.ts';
import { labelBoxPlan } from './label-draw.ts';
import { normalizedRectToScreen } from './geometry.ts';
import type { CaptureGeometry, Rect } from './types.ts';

/** 真机实测的三张卡（`debug/augment/checkpoint.json`，扇巴掌/虹吸/终极不可阻挡）。 */
const REAL_CARDS = [
  { rect: { x: 0.29735271614384085, y: 0.18962105263157897, w: 0.12443764345830145, h: 0.4633894736842106 }, augmentId: 1136 },
  { rect: { x: 0.43981637337413926, y: 0.18962105263157897, w: 0.12443764345830145, h: 0.4633894736842106 }, augmentId: 2073 },
  { rect: { x: 0.5822800306044377, y: 0.18962105263157897, w: 0.12443764345830145, h: 0.4633894736842106 }, augmentId: 1112 },
] as const;

/** 该英雄的强度表（tier 来自 `augment_json_irank` 的「强度」列）。 */
const TIERS = new Map<number, string>([
  [1136, 'S'],
  [2073, 'A'],
  [1112, 'C'],
]);

/** 同一张 per-hero 表里的登场率（`augments[].pickRate`，0..1）。 */
const PICKS = new Map<number, number>([
  [1136, 0.1214],
  [2073, 0.0731],
  [1112, 0.1993],
]);

/* ------------------------------------------------------------------ */
/* 产品决策                                                            */
/* ------------------------------------------------------------------ */

test('认不准的卡不画（augmentId === null 被过滤，不画占位）', () => {
  const cards = [
    { rect: REAL_CARDS[0].rect, augmentId: 1136 },
    { rect: REAL_CARDS[1].rect, augmentId: null },
    { rect: REAL_CARDS[2].rect, augmentId: 1112 },
  ];
  const out = augmentTierLabels(cards, TIERS);
  assert.equal(out.length, 2, '只画认出来的两张');
  assert.deepEqual(
    out.map((l) => l.augmentId),
    [1136, 1112],
  );
});

test('认不准的卡：即便强制给了 id 也查不到档位 → 不画', () => {
  const out = resolveAugmentTiers([{ rect: REAL_CARDS[0].rect, augmentId: null }], TIERS);
  assert.deepEqual(out, []);
});

test('查不到 tier 不画（该英雄未收录这颗海克斯）', () => {
  const cards = [
    { rect: REAL_CARDS[0].rect, augmentId: 1136 },
    { rect: REAL_CARDS[1].rect, augmentId: 999999 }, // 表里没有
  ];
  const out = augmentTierLabels(cards, TIERS);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.augmentId, 1136);
});

test('档位为空串也不画（没有等级就没有可画的东西）', () => {
  const out = augmentTierLabels([{ rect: REAL_CARDS[0].rect, augmentId: 1136 }], { 1136: '   ' });
  assert.deepEqual(out, []);
});

test('文案：`text` 只有档位字母；选取率是**单独一行** `subText`（不拼进字母）', () => {
  const cards = [
    { rect: REAL_CARDS[0].rect, augmentId: 1136 },
    { rect: REAL_CARDS[1].rect, augmentId: 2073 },
  ];
  const out = augmentTierLabels(cards, TIERS, { pickRates: PICKS });
  assert.deepEqual(
    out.map((l) => l.text),
    ['S', 'A'],
  );
  for (const l of out) {
    assert.equal(l.text, l.tier);
    assert.ok(!l.text.includes('%'), '字母里不得带百分号');
    assert.ok(!/\d/.test(l.text), '字母里不得含任何数字（登场率是另一行）');
  }
  assert.equal(out[0]!.subText, `${AUGMENT_PICK_RATE_PREFIX} 12.1%`);
  assert.equal(out[1]!.subText, `${AUGMENT_PICK_RATE_PREFIX} 7.3%`);
  assert.equal(out[0]!.pickRate, 0.1214);
});

test('选取率缺失/为 0 时**只少那一行**：subText 空串、字母与位置照旧', () => {
  const noTable = augmentTierLabels([{ rect: REAL_CARDS[0].rect, augmentId: 1136 }], TIERS);
  assert.equal(noTable[0]!.subText, '', '没给选取率表 → 不画那一行');
  assert.equal(noTable[0]!.pickRate, null);
  assert.equal(noTable[0]!.text, 'S');
  const zero = augmentTierLabels([{ rect: REAL_CARDS[0].rect, augmentId: 1136 }], TIERS, {
    pickRates: new Map([[1136, 0]]),
  });
  assert.equal(zero[0]!.subText, '', '0 不画（不补一个猜出来的数）');
  // 位置/字号完全不受"有没有那一行"影响
  assert.deepEqual(zero[0]!.rect, noTable[0]!.rect);
  assert.equal(zero[0]!.fontScale, noTable[0]!.fontScale);
});

test('面板关闭立刻清空：空卡片列表 → 空输出（本模块无跨帧状态）', () => {
  assert.deepEqual(augmentTierLabels([], TIERS), []);
  assert.deepEqual(resolveAugmentTiers([], TIERS), []);
  // 空强度表（英雄详情缺失 / 数据没同步）同样什么都不画
  assert.deepEqual(augmentTierLabels(REAL_CARDS.map((c) => ({ ...c })), new Map()), []);
});

/* ------------------------------------------------------------------ */
/* 位置：卡内底部空白区 + 水平居中 + 随卡片等比缩放                      */
/* ------------------------------------------------------------------ */

test('标签**水平居中**落在卡片底部空白区（不越出卡片、留边距）', () => {
  const preset = AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT];
  const zone = augmentBadgeZone(preset);
  const out = augmentTierLabels(REAL_CARDS.map((c) => ({ ...c })), TIERS);
  assert.equal(out.length, 3);
  for (const [i, l] of out.entries()) {
    const card = REAL_CARDS[i]!.rect;
    const top = (l.rect.y - card.y) / card.h;
    const bottom = (l.rect.y + l.rect.h - card.y) / card.h;
    assert.ok(Math.abs(top - zone.y) < 1e-9, `标签顶 = 卡内 y ${zone.y}`);
    assert.ok(Math.abs(bottom - (1 - preset.marginY)) < 1e-9, '标签底 = 卡底 − 底边距');
    assert.ok(l.rect.x > card.x && l.rect.x + l.rect.w < card.x + card.w, '左右都在卡内');
    assert.ok(
      Math.abs(l.rect.x + l.rect.w / 2 - (card.x + card.w / 2)) < 1e-9,
      '**水平居中**（不再贴右下角）',
    );
    assert.equal(l.card, card, '同时保留卡片矩形，便于排查');
    assert.equal(l.fontScale, preset.fontScale, '字号比例随预设带来（渲染端不要自己猜）');
  }
});

test('坐标随卡片等比缩放（换分辨率/窗口大小不变形）', () => {
  const big: Rect = { x: 0.2, y: 0.15, w: 0.2, h: 0.5 };
  const small: Rect = { x: 0.4, y: 0.3, w: 0.1, h: 0.25 }; // 宽高各 1/2
  const a = augmentTierLabels([{ rect: big, augmentId: 1136 }], TIERS)[0]!;
  const b = augmentTierLabels([{ rect: small, augmentId: 1136 }], TIERS)[0]!;
  assert.ok(Math.abs(b.rect.w / a.rect.w - 0.5) < 1e-9);
  assert.ok(Math.abs(b.rect.h / a.rect.h - 0.5) < 1e-9);
  // 卡内相对位置完全一致（与分辨率无关）
  assert.ok(Math.abs((b.rect.x - small.x) / small.w - (a.rect.x - big.x) / big.w) < 1e-9);
  assert.ok(Math.abs((b.rect.y - small.y) / small.h - (a.rect.y - big.y) / big.h) < 1e-9);
});

test('标签区可覆盖（将来换档/挪位置只改一处：预设）', () => {
  const preset = {
    name: '测试',
    width: 0.3,
    height: 0.12,
    marginX: 0.05,
    marginY: 0.08,
    align: 'center' as const,
    fontScale: 0.6,
  };
  const r = resolveAugmentTiers([{ rect: REAL_CARDS[0].rect, augmentId: 1136 }], TIERS, { preset })[0]!;
  const card = REAL_CARDS[0].rect;
  assert.ok(Math.abs((r.rect.y - card.y) / card.h - (1 - preset.marginY - preset.height)) < 1e-9);
  assert.ok(Math.abs(r.rect.h / card.h - preset.height) < 1e-9);
  assert.ok(Math.abs(r.rect.w / card.w - preset.width) < 1e-9);
  assert.ok(Math.abs(r.rect.x + r.rect.w / 2 - (card.x + card.w / 2)) < 1e-9, 'align=center 时居中');
  assert.equal(r.fontScale, preset.fontScale);
});

/* ------------------------------------------------------------------ */
/* 行对齐（2026-10-06 用户："同一排三个标签明显不在一个高度上"）           */
/* ------------------------------------------------------------------ */

/**
 * 真机 `debug/augment/report.json`（atMs=23221，**单卡重随**那一帧）反推的三张卡：
 * 前两张是面板开启时冻结的矩形，第三张是重随那一刻重新识别的（正在翻牌动画里）。
 */
const REROLL_CARDS = [
  { rect: { x: 0.29735271614384085, y: 0.1917050736842105, w: 0.12501912777352715, h: 0.460610379679144 }, augmentId: 1136 },
  { rect: { x: 0.43981637337413926, y: 0.1917050736842105, w: 0.12501912777352715, h: 0.460610379679144 }, augmentId: 2073 },
  { rect: { x: 0.5812921053812845, y: 0.17287065943116413, w: 0.12637597349980165, h: 0.4976025273475413 }, augmentId: 1112 },
] as const;

test('整排对齐：三张卡矩形有差异时，三个标签的 y 完全相等（真机"单卡重随"帧）', () => {
  const out = augmentTierLabels(REROLL_CARDS.map((c) => ({ ...c })), TIERS, { pickRates: PICKS });
  assert.equal(out.length, 3);
  assert.equal(new Set(out.map((l) => l.rect.y)).size, 1, '三个标签 y 必须完全相等');
  assert.equal(new Set(out.map((l) => l.rect.h)).size, 1, '三个标签高（字母大小）也必须相等');
  // 横向仍是各自卡片水平居中（横向不是问题，没改）
  for (const [i, l] of out.entries()) {
    const card = REROLL_CARDS[i]!.rect;
    assert.ok(
      Math.abs(l.rect.x + l.rect.w / 2 - (card.x + card.w / 2)) < 1e-9,
      `${i + 1} 号标签仍水平居中于自己的卡片`,
    );
    assert.equal(l.card, card, '仍保留各自的卡片矩形（排查用）');
  }
});

test('行基准只由**要画的卡**决定：认不出的那张不参与、也不会让别的标签乱跳', () => {
  // 第三张认不准 → 只剩前两张（矩形本来就一样）→ 基准 == 那两张自己的几何
  const withNull = [
    { rect: REROLL_CARDS[0].rect, augmentId: 1136 },
    { rect: REROLL_CARDS[1].rect, augmentId: 2073 },
    { rect: REROLL_CARDS[2].rect, augmentId: null },
  ];
  const out = augmentTierLabels(withNull, TIERS);
  assert.equal(out.length, 2);
  for (const [i, l] of out.entries()) {
    const card = REROLL_CARDS[i]!.rect;
    assert.ok(Math.abs(l.rect.y - (card.y + card.h * augmentBadgeZone(AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT]).y)) < 1e-9);
  }
  // 查不到档位的那张同样不参与（过滤语义没变）
  const noTier = augmentTierLabels(
    [
      { rect: REROLL_CARDS[0].rect, augmentId: 1136 },
      { rect: REROLL_CARDS[2].rect, augmentId: 999999 },
    ],
    TIERS,
  );
  assert.equal(noTier.length, 1);
  // 数量变化不崩：0 / 1 / 2 / 3 张都给得出合法结果
  assert.deepEqual(augmentTierLabels([], TIERS), []);
  for (const n of [1, 2, 3]) {
    const out2 = augmentTierLabels(REROLL_CARDS.slice(0, n).map((c) => ({ ...c })), TIERS);
    assert.equal(out2.length, n);
    assert.equal(new Set(out2.map((l) => l.rect.y)).size, 1, `${n} 张时 y 仍统一`);
  }
});

/* ------------------------------------------------------------------ */
/* 行基准锁：局内那条路（`augmentTierLabelsLocked()`）                    */
/* 2026-10-06 真机二次验收："某次单卡刷新后，三个标签整体下移了一点"          */
/* ------------------------------------------------------------------ */

/**
 * 真机验收报告那一帧的数字（用户给的 `report.json` 单卡重随帧）：
 *
 *   · 卡 1 / 卡 2 是面板**开边沿冻结**的矩形（两张逐位相同，这正是真机常态）；
 *   · 卡 3 在重随那一刻被重新识别成**翻牌动画中间帧**的矩形（又高又靠上）——
 *     旧代码把它当成"这一张卡的新矩形"传进来，于是三张里出现了第二个不同的矩形。
 *
 * 注意：修完之后渲染端**根本不会**再把动画矩形传上来（`capture/worker.ts` 的
 * `frozenRects`），这里两个用例故意都跑一遍 —— 一条证明"线上路径 0 位移"，
 * 一条证明"即便有人把动画矩形喂进来，几何也动不了"（纵深防御）。
 */
const FROZEN_RECT_1: Rect = { x: 0.29735271614384085, y: 0.1917050736842105, w: 0.12501912777352715, h: 0.460610379679144 };
const FROZEN_RECT_2: Rect = { x: 0.43981637337413926, y: 0.1917050736842105, w: 0.12501912777352715, h: 0.460610379679144 };
const FROZEN_RECT_3: Rect = { x: 0.5812921053812845, y: 0.1917050736842105, w: 0.12501912777352715, h: 0.460610379679144 };
/** 重随那一刻检测到的卡 3（**翻牌动画中间帧**）：y 更小、h 更大。 */
const REROLL_RECT_3: Rect = { x: 0.5812921053812845, y: 0.17287065943116413, w: 0.12637597349980165, h: 0.4976025273475413 };

/** 该英雄的强度表（含重随之后新认出来的那颗，验证"内容确实换了"）。 */
const TIERS_LOCK = new Map<number, string>([
  [1136, 'S'],
  [2073, 'A'],
  [1112, 'C'],
  [1305, 'B'],
]);

/** 真机 3440×1440 @1.5×：归一化 → 屏幕 DIP（`labelBoxPlan` 要真实像素算字号）。 */
function toDip(r: Rect): Rect {
  return { x: r.x * (3440 / 1.5), y: r.y * (1440 / 1.5), w: r.w * (3440 / 1.5), h: r.h * (1440 / 1.5) };
}

/** 一条标签的**基线**（字母 cap 带下沿，DIP）；同一字母才能比几何。 */
function baselineOf(rect: Rect, text = 'S'): number {
  return labelBoxPlan(toDip(rect), {
    color: '#f7c948',
    textScale: AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT].fontScale,
    style: 'tier',
    text,
  }).tier!.letter.textY;
}

/** 一条标签的字母 cap 高（DIP）。 */
function capOf(rect: Rect, text = 'S'): number {
  return labelBoxPlan(toDip(rect), {
    color: '#f7c948',
    textScale: AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT].fontScale,
    style: 'tier',
    text,
  }).tier!.capHeight;
}

/** 开边沿那一帧：三张卡都是冻结矩形（真机实测两张/三张逐位相同）。 */
const OPEN_ROW = [
  { rect: FROZEN_RECT_1, augmentId: 1136 },
  { rect: FROZEN_RECT_2, augmentId: 2073 },
  { rect: FROZEN_RECT_3, augmentId: 1112 },
] as const;

test('真机重随帧：刷新后三张标签的 y / 框高 / 基线 / cap 高与刷新前**逐位相同**（0 位移）', () => {
  const first = augmentTierLabelsLocked(null, OPEN_ROW, TIERS_LOCK, { pickRates: PICKS });
  assert.equal(first.labels.length, 3);
  assert.equal(new Set(first.labels.map((l) => l.rect.y)).size, 1, '开边沿三张本来就在同一高度');

  // 第二次识别：卡 3 刷新成另一颗（旧代码会把**动画矩形**一起带上来）
  const after = [
    { rect: FROZEN_RECT_1, augmentId: 1136 },
    { rect: FROZEN_RECT_2, augmentId: 2073 },
    { rect: REROLL_RECT_3, augmentId: 1305 },
  ] as const;
  const second = augmentTierLabelsLocked(first.rowLock, after, TIERS_LOCK, { pickRates: PICKS });
  assert.equal(second.labels.length, 3);
  assert.equal(second.rowLock, first.rowLock, '锁必须原样复用（同一条基准、同一个对象）');

  const zone = augmentBadgeZone(AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT]);
  for (const [i, l] of second.labels.entries()) {
    const before = first.labels[i]!;
    assert.equal(l.rect.y, before.rect.y, `卡${i + 1} 标签 y 必须逐位相同`);
    assert.equal(l.rect.h, before.rect.h, `卡${i + 1} 标签框高（字母大小）必须逐位相同`);
    assert.equal(l.rect.y - before.rect.y, 0, '位移必须恰好是 0');
    // 基线 = 框顶 + cap 高：逐位相同（同一字母比才只反映几何）
    assert.equal(baselineOf(l.rect), baselineOf(before.rect), `卡${i + 1} 基线必须逐位相同`);
    assert.equal(capOf(l.rect), capOf(before.rect), `卡${i + 1} cap 高必须逐位相同`);
    // 三张仍共用同一个基准（彼此也同高）
    assert.equal(l.rect.h, first.rowLock!.band.h);
    assert.equal(l.rect.y, first.rowLock!.band.y);
    // 纵向基准 = 开边沿那三张冻结矩形算出来的（中位数），没有被动画矩形带偏
    assert.equal(first.rowLock!.band.h, FROZEN_RECT_1.h * zone.height);
  }
  // 内容确实换了（几何不变 ≠ 什么都没更新）：卡 3 的字母 C → B，选取率跟着换
  assert.equal(first.labels[2]!.text, 'C');
  assert.equal(second.labels[2]!.text, 'B');
  assert.notEqual(second.labels[2]!.subText, first.labels[2]!.subText);
  // 横向：卡 1/2 完全没动；卡 3 的横向仍按**这一帧**它自己的卡片居中（横向语义未改）
  assert.deepEqual(second.labels[0]!.rect, first.labels[0]!.rect);
  assert.deepEqual(second.labels[1]!.rect, first.labels[1]!.rect);
  assert.ok(
    Math.abs(second.labels[2]!.rect.x + second.labels[2]!.rect.w / 2 - (REROLL_RECT_3.x + REROLL_RECT_3.w / 2)) < 1e-9,
  );
});

test('反向情形：刷新把某张卡矩形改成明显不同（y ±0.03 / h ±0.05）→ 标签纵向仍一动不动', () => {
  const first = augmentTierLabelsLocked(null, OPEN_ROW, TIERS_LOCK);
  const before = first.labels.map((l) => [l.rect.y, l.rect.h] as const);
  for (const delta of [0.03, -0.03]) {
    const moved = [
      { rect: FROZEN_RECT_1, augmentId: 1136 },
      { rect: { ...FROZEN_RECT_2, y: FROZEN_RECT_2.y + delta, h: FROZEN_RECT_2.h + delta }, augmentId: 2073 },
      { rect: FROZEN_RECT_3, augmentId: 1112 },
    ] as const;
    const out = augmentTierLabelsLocked(first.rowLock, moved, TIERS_LOCK);
    assert.equal(out.labels.length, 3);
    assert.deepEqual(
      out.labels.map((l) => [l.rect.y, l.rect.h] as const),
      before,
      `Δy=${delta} 时三张标签的 y/h 必须一字不动`,
    );
    assert.equal(new Set(out.labels.map((l) => l.rect.y)).size, 1, '仍然彼此同高');
  }
  // 反面对照：**没有锁**（老的无锁形态 = 每帧重算中位数）时，同样的输入会让整排挪走。
  //
  // ⚠️ 注意这里是"三张里**两张**变成动画矩形"（= 真机 `report.json` 里第二次重随那一帧
  //    的实际情形）：两张冻结矩形**逐位相同**时，只改一张的中位数仍然是那个值
  //    （中位数抗离群），所以真机上看到"整体下移"的那一次其实是**第二张也被刷新之后**
  //    —— 这正是"中位数挡不住"的证据：三张里两张一变，整排基准就跟着走了。
  const unlockedFirst = augmentTierLabels(OPEN_ROW.map((c) => ({ ...c })), TIERS_LOCK);
  const unlockedAfter = augmentTierLabels(
    [
      { rect: FROZEN_RECT_1, augmentId: 1136 },
      { rect: { ...FROZEN_RECT_2, y: REROLL_RECT_3.y, h: REROLL_RECT_3.h }, augmentId: 2073 },
      { rect: REROLL_RECT_3, augmentId: 1112 },
    ],
    TIERS_LOCK,
  );
  assert.notEqual(
    unlockedAfter[0]!.rect.y,
    unlockedFirst[0]!.rect.y,
    '无锁形态确实会整排平移（这就是被修掉的现象）',
  );
  assert.ok(unlockedAfter[0]!.rect.y > unlockedFirst[0]!.rect.y, '而且是**整体下移**（与用户描述一致）');
  // 锁上之后同样的输入一动不动（与上面第一段的断言同源，这里再钉一次）
  const lockedAfter = augmentTierLabelsLocked(
    first.rowLock,
    [
      { rect: FROZEN_RECT_1, augmentId: 1136 },
      { rect: { ...FROZEN_RECT_2, y: REROLL_RECT_3.y, h: REROLL_RECT_3.h }, augmentId: 2073 },
      { rect: REROLL_RECT_3, augmentId: 1112 },
    ],
    TIERS_LOCK,
  );
  assert.deepEqual(
    lockedAfter.labels.map((l) => [l.rect.y, l.rect.h] as const),
    before,
  );
});

test('基准锁定语义：开边沿 1 张 → 后来 3 张；只允许"新卡沿用同一基准"', () => {
  const first = augmentTierLabelsLocked(null, [{ rect: FROZEN_RECT_2, augmentId: 2073 }], TIERS_LOCK);
  assert.equal(first.labels.length, 1);
  const band = first.rowLock!.band;
  assert.equal(band.y, FROZEN_RECT_2.y + FROZEN_RECT_2.h * augmentBadgeZone(AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT]).y);
  // 后来另外两张也认出来了 → 三张共用**那一条**基准（不是三张重新成排）
  const later = augmentTierLabelsLocked(first.rowLock, OPEN_ROW, TIERS_LOCK);
  assert.equal(later.labels.length, 3);
  assert.equal(later.rowLock, first.rowLock);
  for (const l of later.labels) {
    assert.equal(l.rect.y, band.y);
    assert.equal(l.rect.h, band.h);
  }
  // 是的：这一条基准与"3 张开边沿就锁定"逐位相同（三张冻结矩形本来就一致）
  const direct = augmentTierLabelsLocked(null, OPEN_ROW, TIERS_LOCK);
  assert.deepEqual(direct.rowLock!.band, band);
});

test('基准锁定语义：开边沿 3 张 → 后来 2 张（某张认不出）不崩、已有标签原地不动', () => {
  const first = augmentTierLabelsLocked(null, OPEN_ROW, TIERS_LOCK, { pickRates: PICKS });
  const after = [
    { rect: FROZEN_RECT_1, augmentId: 1136 },
    { rect: FROZEN_RECT_2, augmentId: null },
    { rect: FROZEN_RECT_3, augmentId: 1112 },
  ] as const;
  const second = augmentTierLabelsLocked(first.rowLock, after, TIERS_LOCK, { pickRates: PICKS });
  assert.equal(second.labels.length, 2, '认不准的那张不画（过滤语义未改）');
  assert.deepEqual(second.labels.map((l) => l.augmentId), [1136, 1112]);
  for (const [i, l] of second.labels.entries()) {
    assert.equal(l.rect.y, first.labels[i]!.rect.y, '剩下的标签**原地不动**（绝不重排）');
    assert.equal(l.rect.h, first.labels[i]!.rect.h);
  }
  // 反向：开边沿 2 张 → 后来 3 张，同样不崩、共用同一条基准
  const two = augmentTierLabelsLocked(null, OPEN_ROW.slice(0, 2).map((c) => ({ ...c })), TIERS_LOCK);
  const three = augmentTierLabelsLocked(two.rowLock, OPEN_ROW, TIERS_LOCK);
  assert.equal(three.labels.length, 3);
  assert.equal(three.rowLock, two.rowLock);
  assert.equal(new Set(three.labels.map((l) => l.rect.y)).size, 1);
  // 全认不出：什么都不画，但**锁还在**（面板没关，下次认出来仍沿用同一基准）
  const none = augmentTierLabelsLocked(second.rowLock, [{ rect: FROZEN_RECT_1, augmentId: null }], TIERS_LOCK);
  assert.deepEqual(none.labels, []);
  assert.equal(none.rowLock, first.rowLock);
  // 从没锁定过（开边沿一张都没认出来）→ 输出为空、锁仍是 null
  const never = augmentTierLabelsLocked(null, [{ rect: FROZEN_RECT_1, augmentId: null }], TIERS_LOCK);
  assert.deepEqual(never.labels, []);
  assert.equal(never.rowLock, null);
});

/* ------------------------------------------------------------------ */
/* 配色                                                                */
/* ------------------------------------------------------------------ */

test('S/A/B/C 各有配色（S 金 / A 红 / B 青蓝 / C 灰），未知档位给中性色（不猜）', () => {
  assert.equal(augmentTierColor('S'), AUGMENT_TIER_COLORS.S);
  assert.equal(augmentTierColor('a'), AUGMENT_TIER_COLORS.A, '小写档位也能对上配色');
  assert.equal(augmentTierColor('D'), AUGMENT_TIER_UNKNOWN_COLOR);
  assert.equal(augmentTierColor('S+'), AUGMENT_TIER_UNKNOWN_COLOR);
  // 未知档位**照画**（字母仍然正确），只是中性色
  const out = augmentTierLabels([{ rect: REAL_CARDS[0].rect, augmentId: 1136 }], { 1136: 'D' });
  assert.equal(out[0]!.text, 'D');
  assert.equal(out[0]!.color, AUGMENT_TIER_UNKNOWN_COLOR);
});

test('配色常量四档俱全且互不相同，C 档是中性灰', () => {
  const keys = Object.keys(AUGMENT_TIER_COLORS);
  assert.deepEqual([...keys].sort(), ['A', 'B', 'C', 'S']);
  assert.equal(new Set(keys.map((k) => AUGMENT_TIER_COLORS[k as 'S'])).size, 4);
  // C 必须是"低饱和中性灰"（红≈绿≈蓝），否则就不是"保持中性灰"那条决策了
  const c = /^#(\w\w)(\w\w)(\w\w)$/.exec(AUGMENT_TIER_COLORS.C)!;
  const [r, g, b] = [c[1]!, c[2]!, c[3]!].map((h) => Number.parseInt(h, 16));
  assert.ok(Math.max(r!, g!, b!) - Math.min(r!, g!, b!) < 60, `C 档灰度过低（${AUGMENT_TIER_COLORS.C}）`);
  // A 偏红（红分量最大）、S 偏金（红>绿>蓝）、B 偏青蓝（蓝/绿 > 红）
  const rgb = (hex: string): number[] => {
    const m = /^#(\w\w)(\w\w)(\w\w)$/.exec(hex)!;
    return [m[1]!, m[2]!, m[3]!].map((h) => Number.parseInt(h, 16));
  };
  const [ar, ag, ab] = rgb(AUGMENT_TIER_COLORS.A);
  assert.ok(ar! > ag! && ar! > ab!, `A 应为红（${AUGMENT_TIER_COLORS.A}）`);
  const [sr, sg, sb] = rgb(AUGMENT_TIER_COLORS.S);
  assert.ok(sr! > sg! && sg! > sb!, `S 应为金（${AUGMENT_TIER_COLORS.S}）`);
  const [br, bg, bb] = rgb(AUGMENT_TIER_COLORS.B);
  assert.ok(bb! > br! && bg! > br!, `B 应为青蓝（${AUGMENT_TIER_COLORS.B}）`);
});

/* ------------------------------------------------------------------ */
/* 选取率取数                                                          */
/* ------------------------------------------------------------------ */

test('augmentPickRateTable：与强度表同源，重复取先出现的、非有限值跳过', () => {
  const t = augmentPickRateTable([
    { augmentId: 1, pickRate: 0.2 },
    { augmentId: 1, pickRate: 0.9 },
    { augmentId: 2, pickRate: Number.NaN },
    { augmentId: 3, pickRate: 0.05 },
  ]);
  assert.equal(t.size, 2);
  assert.equal(t.get(1), 0.2);
  assert.equal(t.get(3), 0.05);
  assert.equal(t.has(2), false);
});

test('lookupAugmentPickRate：Map/普通对象都支持，认不准或没表都是 null', () => {
  assert.equal(lookupAugmentPickRate(new Map([[7, 0.25]]), 7), 0.25);
  assert.equal(lookupAugmentPickRate({ 7: 0.25 }, 7), 0.25);
  assert.equal(lookupAugmentPickRate({ 7: 0.25 }, 8), null);
  assert.equal(lookupAugmentPickRate(undefined, 7), null, '没给表 → null（那一行不画）');
  assert.equal(lookupAugmentPickRate(new Map([[7, 0.25]]), null), null);
});

test('pickRateText：一位小数、缺失/0/负数/非有限值都不画', () => {
  assert.equal(pickRateText(0.1214), `${AUGMENT_PICK_RATE_PREFIX} 12.1%`);
  assert.equal(pickRateText(0.19935), `${AUGMENT_PICK_RATE_PREFIX} 19.9%`);
  assert.equal(pickRateText(1), `${AUGMENT_PICK_RATE_PREFIX} 100.0%`);
  assert.equal(pickRateText(0.0731), `${AUGMENT_PICK_RATE_PREFIX} 7.3%`);
  for (const bad of [null, undefined, 0, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(pickRateText(bad), '', `${String(bad)} 不应产生文案`);
  }
});

/* ------------------------------------------------------------------ */
/* 屏幕坐标：复用 S2 的换算桥                                          */
/* ------------------------------------------------------------------ */

test('屏幕坐标复用 normalizedRectToScreen（显示器快照形态），并带上 style/pickRate', () => {
  // 真机：显示器逻辑 1720×720、截屏 3440×1440（倍率 2）
  const geo: CaptureGeometry = {
    captureWidth: 3440,
    captureHeight: 1440,
    windowX: 0,
    windowY: 0,
    windowWidth: 1720,
    windowHeight: 720,
  };
  const labels = augmentTierLabels(REAL_CARDS.map((c) => ({ ...c })), TIERS, { pickRates: PICKS });
  const screen = toScreenTierLabels(labels, geo);
  assert.equal(screen.length, 3);
  const preset = AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT];
  for (const [i, s] of screen.entries()) {
    const expect = normalizedRectToScreen(labels[i]!.rect, geo);
    assert.deepEqual(
      { x: s.x, y: s.y, w: s.w, h: s.h },
      { x: expect.x, y: expect.y, w: expect.w, h: expect.h },
    );
    // 框宽 = 卡宽 × 预设宽，随窗口宽等比：0.1244 × 0.44 × 1720 ≈ 94 DIP
    assert.ok(Math.abs(s.w - REAL_CARDS[i]!.rect.w * preset.width * 1720) < 1e-6);
    assert.equal(s.fontScale, preset.fontScale, '字号比例一路带到屏幕坐标（渲染端直接用）');
    // 渲染端据此走"大字母 + 尖括号 + 选取率行"那条路（而不是选人标签的深色底）
    assert.equal(s.style, 'tier');
    assert.equal(s.subText, pickRateText(PICKS.get(REAL_CARDS[i]!.augmentId)!));
    assert.equal(s.pickRate, PICKS.get(REAL_CARDS[i]!.augmentId));
    // 标签**居中**于卡片
    const cardCenter = (REAL_CARDS[i]!.rect.x + REAL_CARDS[i]!.rect.w / 2) * 1720;
    assert.ok(Math.abs(s.x + s.w / 2 - cardCenter) < 1e-6);
  }
});

test('屏幕坐标带窗口偏移（游戏在副屏/工作区非原点时不能少加这一层）', () => {
  const geo: CaptureGeometry = {
    captureWidth: 4587,
    captureHeight: 1920,
    windowX: 100,
    windowY: 50,
    windowWidth: 2294,
    windowHeight: 960,
  };
  const label: AugmentTierLabel = augmentTierLabels([{ rect: REAL_CARDS[0].rect, augmentId: 1136 }], TIERS)[0]!;
  const s = toScreenTierLabels([label], geo)[0]!;
  assert.ok(Math.abs(s.x - (100 + label.rect.x * 2294)) < 1e-9);
  assert.ok(Math.abs(s.y - (50 + label.rect.y * 960)) < 1e-9);
  assert.equal(s.text, 'S');
  assert.equal(s.color, AUGMENT_TIER_COLORS.S);
});

/* ------------------------------------------------------------------ */
/* 强度表组装（augment_json_irank → Map）                              */
/* ------------------------------------------------------------------ */

test('augmentTierTable：同 ID 重复取先出现的那条（上游按 rank 升序）', () => {
  const t = augmentTierTable([
    { augmentId: 1104, tier: 'S' },
    { augmentId: 1104, tier: 'B' },
    { augmentId: 1068, tier: 'A' },
  ]);
  assert.equal(t.size, 2);
  assert.equal(t.get(1104), 'S');
  assert.equal(t.get(1068), 'A');
});

test('augmentTierTable：档位为空的条目跳过；lookup 支持 Map 与普通对象', () => {
  const t = augmentTierTable([
    { augmentId: 1, tier: '' },
    { augmentId: 2, tier: ' B ' },
  ]);
  assert.equal(t.size, 1);
  assert.equal(lookupAugmentTier(t, 2), 'B', '档位两端空白应被去掉');
  assert.equal(lookupAugmentTier({ 2: 'B' }, 2), 'B', '普通对象形态同样支持');
  assert.equal(lookupAugmentTier({ 2: 'B' }, 3), null);
  assert.equal(lookupAugmentTier(t, null), null);
});
