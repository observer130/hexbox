/**
 * 海克斯卡上的**强度评级标签**位置与尺寸（纯函数，可单测）
 *
 * 产品决策（2026-10-05，用户给了虎牙助手的参考图后定稿）：
 *   ① 标签画在**卡片底部空白区**（不遮图标/名字/稀有度/描述）；
 *   ② 位置**水平居中**（不要再贴右下角）——参考图就是"卡下方正中间"；
 *   ③ 内容 = **大号彩色字母（带描边/发光）+ 两侧尖括号 `‹ S ›` + 下方一行小字
 *      「选取率 12.1%」**，**没有色块底**。
 *      （第一版是右下角的小圆角徽章，第二版是通栏横条 —— 都被用户否掉了。）
 *
 * 依据是真机实测的卡内布局（原生 571×889 的卡片，见 docs/AUGMENT-PANEL.md §八、§十三）：
 *
 *   y 0.07 ~ 0.37   图标
 *   y 0.44 ~ 0.51   名字
 *   y 0.52 ~ 0.55   稀有度标签（功能 / 速度 …）
 *   y 0.60 ~ 0.72   描述（2~3 行；实测最长的一帧到 **0.713**）
 *   y 0.72 ~ 1.00   **空白** ← 标签画这里（中央列一直空到底部内框 ≈0.96）
 *
 * 与选人阶段标签的区别：选人标签压在英雄名/职业图标上，靠"卡片同宽 + 固定高度"
 * 定位；海克斯卡底部本来就空，直接用卡内比例定位即可，不需要额外的避让逻辑。
 *
 * ⚠️ **所有可调参数集中在 `AUGMENT_BADGE_PRESETS` 一处**（见 docs/AUGMENT-PANEL.md §十三）：
 * 局内渲染（`apps/overlay/src/renderer/overlay-canvas.ts`）与离线预览
 * （`scripts/preview-augment-labels.mts`）都经 `augmentBadgeZone()` → `augmentLabelRect()`
 * → `labelBoxPlan()` 取几何与字号，不存在"预览好看、局内不一样"。
 */

import { TIER_FONT_SCALE } from './label-draw.ts';
import type { Rect } from './types.ts';

/** 标签水平对齐：底部居中（默认）或右下角贴边（第一版的做法，保留给测试/将来用）。 */
export type AugmentBadgeAlign = 'right' | 'center';

/**
 * 一档**标签预设**（长度都是**卡内**归一化比例）。
 *
 * 为什么用"框宽 + 框高 + 留白"四个量而不是一个缩放系数：卡片纵横比固定
 * （实测 427×667 物理像素 ≈ 1:1.56），所以横竖两个方向的占比必须分开给，
 * 否则换分辨率/窗口大小时标签会变形。
 */
export interface AugmentBadgePreset {
  /** 档名（终端打印与预览图标注用）。 */
  readonly name: string;
  /** 框宽 / 卡宽（**上限**：内容居中，窄框由 `labelBoxPlan` 按宽收缩）。 */
  readonly width: number;
  /** **整条标签**的高 / 卡高（字母 cap + 空隙 + 选取率行；cap 高 = 它 ÷ `TIER_STACK_RATIO`）。 */
  readonly height: number;
  /**
   * 距**卡右**内边的留白 / 卡宽（`align === 'right'` 时生效）。
   * 居中时改用作**两侧最小安全间距**：万一预设宽到贴边，标签会被夹在卡内不压描边。
   */
  readonly marginX: number;
  /** 距**卡底**内边的留白 / 卡高。 */
  readonly marginY: number;
  /** 水平对齐。 */
  readonly align: AugmentBadgeAlign;
  /** 字号 / 框高（渲染端与预览共用同一条规则）。 */
  readonly fontScale: number;
}

/** 三档预设的键。 */
export type AugmentBadgeSize = 'small' | 'medium' | 'large';

/**
 * 三档预设（真机 3440×1440 上卡片 427×667 物理像素 / 284.7×444.7 DIP）。
 *
 * 2026-10-06 第四次定尺寸 —— **只改纵向**（用户第三次反馈："**small 字体比较合适，
 * 但位置稍微有点靠下，有点覆盖到「选取率」，需要稍微向上移动一点点**"）。
 * 先说结论：**字母大小一个像素都没动**（cap 高仍是 29.4 / 30.8 / 32.9 DIP，
 * 占卡高 6.6% / 6.9% / 7.4%），改的是三件事：
 *
 *   ① 把整条标签**整体上移一点点**：`marginY` 0.06 → **0.07**（真机 ≈4.4 DIP）；
 *   ② 把字母与选取率行之间的**内部空隙**从 0.26 cap 加到 **0.38 cap**
 *      （`label-draw.ts` 的 `TIER_RATE_GAP`）—— 字母因此相对选取率行**再上移 ≈3.5 DIP**
 *      （选取率行相对卡底的位置只由 ① 的 `marginY` 决定：它跟着整条一起上移 ≈4.4 DIP）；
 *   ③ 把发光半径从 0.32 cap 收到 **0.28 cap**（`TIER_TREATMENTS.b.glow`）——
 *      压字的正是那圈光晕；**描边与发光仍然全部按 cap 成比例**，没有写死像素。
 *
 * 为什么 `height` 跟着变（0.105/0.112/0.119 → **0.114/0.119/0.128**）：
 * 预设的 `height` 是**整条标签**（字母 cap + 空隙 + 选取率墨迹）占卡高的比例，
 * 而 cap 高 = `height ÷ TIER_STACK_RATIO`（见 `label-draw.ts`）。内部空隙变大 →
 * `TIER_STACK_RATIO` 从 1.602 变 1.722 → 想让 cap 高**一个像素都不变**，
 * `height` 就得按同一比例放大（每档 +0.009）。三档的 cap 高因此与上一版逐位相同。
 *
 * 当前三档（cap 高 = 框高 ÷ `TIER_STACK_RATIO`(≈1.722)）：
 *
 * | 档 | 框（卡内占比）| 框 DIP | 字母 cap 高（卡高占比）| 字号 | 选取率行 |
 * |---|---|---|---|---|---|
 * | 小 small（**默认**）| 0.30 × 0.114 | 85.4 × 50.7 | **0.066** 卡高 = 29.4 DIP（44 px）| 42 DIP / 63 px | 11 DIP |
 * | 中 medium | 0.32 × 0.119 | 91.1 × 52.9 | **0.069** 卡高 = 30.8 DIP（46 px）| 44 DIP / 66 px | 11 DIP |
 * | 大 large  | 0.34 × 0.128 | 96.8 × 56.9 | **0.074** 卡高 = 32.9 DIP（49 px）| 47 DIP / 71 px | 12 DIP |
 *
 * （三档都落在用户给的 **0.065 ~ 0.075** 区间；表里的 DIP 是**真机**
 * 3440×1440 上的值，换分辨率/窗口大小时整条标签随卡片等比缩放。）
 *
 * · 三档都**水平居中**、距卡底 0.07 卡高（整条标签的下沿）；
 * · 字号 = 框高 × `TIER_FONT_SCALE` = `cap 高 ÷ LABEL_CAP_RATIO`；
 * · 尖括号 / 选取率行 / 描边 / 发光**全部按 cap 高推导**（见 `label-draw.ts` 的
 *   `tierTagPlan()`），所以整条标签（含那圈光晕）会随这几个数一起等比缩小，
 *   不需要另调 —— 实测外廓/字母比稳定在 1.9×，光晕不会"缩得比字母慢"；
 * · 三档的 cap 高 / 字号都随档递增（越大越醒目）。
 *
 * ⚠️ **发光外廓与选取率行必须留正间隙**（真机实测 ≥4 DIP，见 `tierTagBounds()`）：
 * 这条关系由 `TIER_RATE_GAP > TIER_LETTER_GLOW` 保证，两者都按 cap 成比例，
 * 所以换档/换分辨率都不会重新压上；单测锁死。
 */
export const AUGMENT_BADGE_PRESETS: Readonly<Record<AugmentBadgeSize, AugmentBadgePreset>> = {
  small: { name: '小', width: 0.3, height: 0.114, marginX: 0.06, marginY: 0.07, align: 'center', fontScale: TIER_FONT_SCALE },
  medium: { name: '中', width: 0.32, height: 0.119, marginX: 0.06, marginY: 0.07, align: 'center', fontScale: TIER_FONT_SCALE },
  large: { name: '大', width: 0.34, height: 0.128, marginX: 0.06, marginY: 0.07, align: 'center', fontScale: TIER_FONT_SCALE },
};

/**
 * **默认档**：换大小只改这一行（不必碰任何几何代码）。
 *
 * 2026-10-06 第四次：用户看过 small 的真机观感 —— "**small 字体比较合适**"，
 * 只是位置要往上挪一点点 → **默认档 medium → small**（medium/large 原样保留，
 * 想要更大时用 `HEXBOX_AUGMENT_BADGE=medium|large`）。
 *
 * 想临时试别的档而不改代码：`HEXBOX_AUGMENT_BADGE=medium|large`
 * （见 apps/overlay/src/debug-augment.ts；只有录制/自测路径读它）。
 */
export const AUGMENT_BADGE_DEFAULT: AugmentBadgeSize = 'small';

/** 标签区（**卡内**归一化几何；由预设算出，`augmentLabelRect` 只认这几个量）。 */
export interface AugmentLabelZone {
  /** 框顶 / 卡高。 */
  readonly y: number;
  /** 框高 / 卡高。 */
  readonly height: number;
  /** 框宽 / 卡宽。 */
  readonly width: number;
  /** 距卡右内边的留白 / 卡宽（`align === 'right'` 时生效；居中时 = 两侧最小间距）。 */
  readonly marginX: number;
  readonly align: AugmentBadgeAlign;
}

/**
 * 预设 → 卡内矩形参数。
 *
 * 纵向不用"框顶"而用"**距卡底留白**"表达：卡片下沿是唯一稳定的参照物，
 * 而卡内 y 0.72~1.00 是空白带、底部留 6% 不贴边框。
 */
export function augmentBadgeZone(preset: AugmentBadgePreset): AugmentLabelZone {
  return {
    y: 1 - preset.marginY - preset.height,
    height: preset.height,
    width: preset.width,
    marginX: preset.marginX,
    align: preset.align,
  };
}

/** 默认识别档（= 默认预设的几何）。 */
export const AUGMENT_LABEL_ZONE: AugmentLabelZone = augmentBadgeZone(
  AUGMENT_BADGE_PRESETS[AUGMENT_BADGE_DEFAULT],
);

/**
 * 计算某张卡上的标签矩形（**截屏归一化**，与卡片矩形同一坐标系）。
 *
 * · `align === 'center'`（默认）：**水平居中**；`marginX` 作为两侧最小安全间距 ——
 *   只有预设宽到贴边时才会夹住（正常预设下是精确居中），保证标签永远不压卡片描边；
 * · `align === 'right'`：右下角贴边（第一版的几何，保留）。
 *
 * @param card 卡片矩形（`detectAugmentPanel` 的输出）
 * @param zone 标签区（默认 `AUGMENT_LABEL_ZONE` = 默认预设）
 */
export function augmentLabelRect(card: Rect, zone: AugmentLabelZone = AUGMENT_LABEL_ZONE): Rect {
  const w = Math.max(0, card.w * zone.width);
  const inset = card.w * zone.marginX;
  let x: number;
  if (zone.align === 'right') {
    x = card.x + card.w - inset - w;
  } else {
    const centered = card.x + (card.w - w) / 2;
    const minX = card.x + inset;
    const maxX = card.x + card.w - inset - w;
    // 框比"卡宽 − 两侧间距"还宽时 `maxX < minX`：退化为贴左安全线（不越出卡片）
    x = maxX < minX ? minX : Math.min(Math.max(centered, minX), maxX);
  }
  return {
    x,
    y: card.y + card.h * zone.y,
    w,
    h: Math.max(0, card.h * zone.height),
  };
}

/**
 * 一组卡的标签矩形（识别不出来的卡**不画** —— 用户的"认不准就不画"）。
 *
 * ⚠️ 这是**逐卡各自定位**的老几何：三张卡并排时，如果检测给出的卡片矩形
 * 有像素级差异（真机"单卡重随"必然如此，见 `labelRowBand` 的注释），
 * 三个标签就不在同一高度。局内要的是 `alignRowLabels()`。
 *
 * @param cards 每张卡（`card` 为定位矩形；`augmentId` 为 null 表示没认出来）
 */
export function augmentLabelRects<T extends { readonly card: Rect; readonly augmentId: number | null }>(
  cards: readonly T[],
  zone?: AugmentLabelZone,
): Array<{ readonly card: T; readonly rect: Rect }> {
  const out: Array<{ readonly card: T; readonly rect: Rect }> = [];
  for (const c of cards) {
    if (c.augmentId === null) continue;
    out.push({ card: c, rect: augmentLabelRect(c.card, zone) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 行对齐：同一排的标签共用一个纵向基准（用户："三个标签明显不在一个高度"）   */
/* ------------------------------------------------------------------ */

/**
 * 一排标签的**纵向基准**（这一排所有标签共用 `y` 与 `h`，所以基线像素级相同）。
 *
 * 为什么必须有它（2026-10-06 真机验收，用户："明显不在一个高度上"）：
 *   标签的纵向位置原本是 `card.y + zone.y × card.h` —— **每张卡各自的**检测矩形。
 *   面板开启那一帧三张卡的矩形通常完全一致（实测差值 0.00 px），但**单卡重随**
 *   时只有被刷新那一张会重新全分辨率识别（`augment-reroll.ts` 的
 *   `mergeRefreshedCards()` 用新矩形替换旧矩形，另外两张保留冻结矩形），
 *   而重随那一刻卡片还在翻牌动画里 → 那张卡的矩形又高又靠上。
 *   真机 report.json（atMs=23221）实测（按**当前默认档**算出的标签）：
 *
 *     卡 1/2  y=0.191705 h=0.460611 → 标签 y = 550.17 DIP（825.3 物理 px），基线 871.7 px
 *     卡 3    y=0.172871 h=0.497603 → 标签 y = 561.49 DIP（842.2 物理 px），基线 892.5 px
 *     ⇒ y 差 **17.0 物理像素**，基线差 **20.8 物理像素**，而且那张卡的字母还大一号
 *       （h 差 3.98 DIP → cap 差 2.8 DIP：字母大小不再是同一个尺寸）。
 *
 * 取**中位数**而不是均值：三张里有一张在动画中（明显偏大/偏上）时，
 * 中位数只认"另外两张稳的"，均值会被那一张拉走。
 *
 * ⚠️ 中位数只抗**离群**、不保证**不变**：一旦有两张卡都换了矩形（三张里两张被
 * 重随重认）中位数就会跟着挪 —— 真机二次验收确实撞上了（见 `LabelRowLock`）。
 * 所以局内**不再每帧调它**：开边沿用 `lockLabelRowBand()` 锁一次，之后一直复用。
 * `labelRowBand()` / `alignRowLabels()` 保留为**无锁**的形态（单测、离线预览的单排
 * 计算、以及"没有跨帧状态的调用方"）。
 */
export interface LabelRowBand {
  /** 整排标签的**框顶**（同一坐标系）。 */
  readonly y: number;
  /** 整排标签的**框高**（同一坐标系）—— 三张标签的字母大小因此也一致。 */
  readonly h: number;
}

/**
 * 中位数（偶数个取中间两个的均值；空数组 → `null`）。
 *
 * 纯函数、不排序入参（自己拷一份排），所以调用方的数组不会被改动。
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * 一排卡片 → **统一的标签带**（`h` 取中位数、`y` 取中位数后按同一个 `zone.y` 推）。
 *
 * 空数组 → `null`（调用方不画）。单张卡时退化为"就按这张卡自己算"，
 * 与 `augmentLabelRect(card, zone)` 完全相等（数值也逐位相同）。
 */
export function labelRowBand(
  cards: readonly Rect[],
  zone: AugmentLabelZone = AUGMENT_LABEL_ZONE,
): LabelRowBand | null {
  const medianY = median(cards.map((c) => c.y));
  const medianH = median(cards.map((c) => c.h));
  if (medianY === null || medianH === null) return null;
  return { y: medianY + medianH * zone.y, h: Math.max(0, medianH * zone.height) };
}

/**
 * 一排卡片的标签矩形：**纵向取整行基准、横向仍按各自卡片居中**。
 *
 * 用户的话是"同一排三个标签不在同一高度" —— 所以只改纵向：
 *   · 横向（`x` / `w`）**完全不变**，仍是每张卡各自水平居中（横向从来不是问题）；
 *   · 纵向 `y` / `h` 一律取 `labelRowBand()`，三张标签的**基线像素级相同**
 *     （基线 = 框顶 + cap 高，两者都统一了），字母大小也一致。
 *
 * 退化情况：空数组 → `[]`；单张卡 → 与 `augmentLabelRect()` 完全一致；
 * 两张卡 → 中位数 = 两者均值（仍然共用同一个 y/h）；卡片数量随意变都不崩。
 *
 * ⚠️ 这是**无锁**形态（每帧按本帧的卡片重算）。局内走 `alignRowLabelsLocked()`：
 * 基准在开边沿锁定，刷新/过滤变化都不许动它。
 */
export function alignRowLabels(
  cards: readonly Rect[],
  zone: AugmentLabelZone = AUGMENT_LABEL_ZONE,
): Rect[] {
  const band = labelRowBand(cards, zone);
  if (!band) return [];
  return cards.map((card) => ({
    ...augmentLabelRect(card, zone),
    y: band.y,
    h: band.h,
  }));
}

/* ------------------------------------------------------------------ */
/* 行基准的**锁**：开边沿锁定、面板关闭前一直复用同一条                     */
/* ------------------------------------------------------------------ */

/**
 * 一排标签的**锁定基准**（一个面板 = 一把锁；面板关闭即丢弃）。
 *
 * 为什么还要在"中位数对齐"之上再加一把锁（2026-10-06 真机二次验收，
 * 用户："**某次单卡刷新后，三个标签整体下移了一点**"）：
 *
 * 中位数只是**抗离群**，不是**不变** —— 三张卡里被刷新的那张每刷新一次就把自己的
 * 矩形换成"翻牌动画中间帧"的矩形（`mergeRefreshedCards()` 的语义，见 §十五），
 * 于是 `{a, b, c}` 变成 `{a, b, c'}`，**中位数会跟着挪**：
 *
 *   · 一个值变了且新值**落在另外两个之间** → 中位数就是那个新值（3 个数的中位数
 *     是"排序后中间那个"）→ 整排基准平移；
 *   · 真机 `debug/augment/report.json`（2026-10-06 那份）里两张冻结矩形**逐位相同**，
 *     所以第一次重随（atMs=14150）中位数没动，**第二次重随**（atMs=17750，三张里
 *     两张已变成动画矩形）中位数从 `y=0.189621 h=0.463389` 跳到
 *     `y=0.179117 h=0.487192` → 三个标签一起下移 12.84 物理像素、字母还大了 3.9 像素。
 *
 * 产品事实决定了正确语义：**面板存续期间卡片不会动**（翻牌是原地换内容），
 * 所以整排的纵向基准应当**在开边沿定一次、之后复用**；刷新只更新**内容**
 * （tier / 选取率 / 是否存在），**不允许**改几何。锁定之后任何动画抖动、检测抖动、
 * 卡片过滤变化都无法移动标签 —— 这比"每次重算中位数"强，也比它简单。
 *
 * 退化语义（明确定义，别猜）：
 *   · 面板打开时**一张都没认出来**（`cards` 为空）→ 不锁定（`null`）；
 *   · **首次得到 ≥1 张卡**（无论 1 张还是 3 张）→ 用**这一批**卡片矩形锁定基准；
 *   · 之后**只增不减**：后来多认出来几张 → 沿用同一条基准；某张认不出（标签消失）
 *     → 基准也不动（剩下的标签**原地不动**，绝不重排）；
 *   · 面板关闭 → 调用方丢掉这把锁（下一块面板可以是别的位置/别的三张卡）。
 */
export interface LabelRowLock {
  /** 锁定的纵向基准（这一排所有标签共用）。 */
  readonly band: LabelRowBand;
  /** 锁定时参与推基准的卡片矩形（**只作诊断/产物**，不参与后续计算）。 */
  readonly cards: readonly Rect[];
}

/**
 * 推进行基准锁：已经锁了就**原样返回**（同一把锁，绝不重算）；还没锁且这一批卡
 * 非空 → 用这一批卡片矩形的中位数锁定（`labelRowBand()`，即"输入是稳定/冻结矩形"）。
 *
 * @param previous 上一帧的锁（`null`/`undefined` = 这一局面板还没锁定过）
 * @param cards 本帧这一排**要画的卡**矩形（稳定/冻结矩形，见文件头与 §十五）
 */
export function lockLabelRowBand(
  previous: LabelRowLock | null | undefined,
  cards: readonly Rect[],
  zone: AugmentLabelZone = AUGMENT_LABEL_ZONE,
): LabelRowLock | null {
  if (previous) return previous;
  const band = labelRowBand(cards, zone);
  if (!band) return null;
  return { band, cards: [...cards] };
}

/**
 * 一排卡片的标签矩形：**纵向用锁定的基准**，横向仍按各自卡片居中。
 *
 * 与 `alignRowLabels()` 的区别只有一处输入：纵向不再由本帧卡片现算，而是拿
 * `lockLabelRowBand()` 锁定的 `band` —— 于是"刷新只改内容、不动基准"是代码保证的。
 * 没有锁（这一局面板一张卡都没认出来过）→ `[]`（不画；锁由调用方在首次 ≥1 张时建立）。
 */
export function alignRowLabelsLocked(
  cards: readonly Rect[],
  lock: LabelRowLock | null | undefined,
  zone: AugmentLabelZone = AUGMENT_LABEL_ZONE,
): Rect[] {
  if (!lock) return [];
  return cards.map((card) => ({
    ...augmentLabelRect(card, zone),
    y: lock.band.y,
    h: lock.band.h,
  }));
}
