/**
 * 标签 hover 的纯计算测试（命中测试 + 提示框布局）
 *
 * 这里每条断言都对应真机上"提示框看不见/跑到屏幕外"的一种具体成因 ——
 * 局内三张卡就在屏幕下半部分，提示框默认朝下会直接出屏；靠右的卡片如果
 * 还按居中算，右半边也会出屏。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  hoveredLabelIndex,
  TOOLTIP_COLORS,
  TOOLTIP_STYLE,
  tooltipPlan,
  tooltipPlanFor,
  type TooltipStyle,
} from './label-hover.ts';

/* ------------------------------------------------------------------ */
/* 命中测试                                                            */
/* ------------------------------------------------------------------ */

const L = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

test('命中测试：内部命中、外部不命中（含边界）', () => {
  const labels = [L(10, 10, 100, 40)];
  assert.equal(hoveredLabelIndex(labels, 60, 30), 0, '正中');
  assert.equal(hoveredLabelIndex(labels, 10, 10), 0, '左上角算命中（闭区间）');
  assert.equal(hoveredLabelIndex(labels, 110, 50), 0, '右下角算命中');
  assert.equal(hoveredLabelIndex(labels, 9.9, 30), null, '左外 1px');
  assert.equal(hoveredLabelIndex(labels, 60, 50.1), null, '下外 1px');
});

test('命中测试：空列表 / 畸形框都不许抛', () => {
  assert.equal(hoveredLabelIndex([], 0, 0), null);
  assert.equal(hoveredLabelIndex([L(0, 0, 0, 0)], 0, 0), 0, '零面积框只有正好点上才命中');
  assert.equal(hoveredLabelIndex([L(NaN, 0, 10, 10)], 5, 5), null, 'NaN 框不许命中');
});

test('★ 命中测试：重叠时取**后画**的那个（数组靠后的画在上面）', () => {
  const labels = [L(0, 0, 100, 100), L(50, 50, 100, 100)];
  assert.equal(hoveredLabelIndex(labels, 75, 75), 1, '重叠区命中上面那个');
  assert.equal(hoveredLabelIndex(labels, 10, 10), 0, '只有第一个覆盖的区域仍命中第一个');
});

/* ------------------------------------------------------------------ */
/* 提示框布局                                                          */
/* ------------------------------------------------------------------ */

/** 确定性的假测量：每字宽 10（标题同宽），于是宽度 = 字数 × 10。 */
function fixedMeasure(charWidth = 10): (text: string, font: string) => number {
  return (text) => [...text].length * charWidth;
}

const STYLE: TooltipStyle = {
  font: '12px sans-serif',
  titleFont: 'bold 13px sans-serif',
  lineHeight: 16,
  titleLineHeight: 20,
  padding: 8,
  maxWidth: 240,
  gap: 6,
  measure: fixedMeasure(),
};

const CANVAS = { width: 1000, height: 600 };

test('没有内容 → null（不许画一个空框）', () => {
  assert.equal(
    tooltipPlan({ anchor: L(100, 100, 50, 20), canvas: CANVAS, style: STYLE }),
    null,
  );
  assert.equal(
    tooltipPlan({ title: '   ', lines: ['', '  '], anchor: L(100, 100, 50, 20), canvas: CANVAS, style: STYLE }),
    null,
    '全空白也算没有内容',
  );
});

test('★ 基本布局：宽度 = 最宽文本 + 两侧内边距；高度按行数算', () => {
  const plan = tooltipPlan({
    title: '强度评级 S', // 6 字 = 60
    lines: ['选取率 12.1%'], // 9 字 = 90 → 最宽 90
    anchor: L(400, 200, 100, 30),
    canvas: CANVAS,
    style: STYLE,
  });
  assert.ok(plan);
  assert.equal(plan.w, 90 + 16, '最宽行 + 2×padding');
  assert.equal(plan.h, 8 * 2 + 20 + 16, 'padding×2 + 标题行高 + 1 行');
  assert.equal(plan.rows.length, 2);
  assert.equal(plan.rows[0]?.isTitle, true);
  assert.equal(plan.rows[0]?.text, '强度评级 S');
  assert.equal(plan.rows[1]?.isTitle, false);
  assert.equal(plan.flipped, false, '空间充足时在下方');
});

test('★ 行 top 单调递增且第一行就是 padding 偏移（渲染端只按 top 画）', () => {
  const plan = tooltipPlan({
    title: 'A',
    lines: ['一', '二', '三'],
    anchor: L(400, 200, 100, 30),
    canvas: CANVAS,
    style: STYLE,
  });
  assert.ok(plan);
  assert.equal(plan.rows.length, 4);
  assert.equal(plan.rows[0]!.top, plan.y + STYLE.padding);
  for (let i = 1; i < plan.rows.length; i++) {
    assert.ok(plan.rows[i]!.top > plan.rows[i - 1]!.top, `第 ${i} 行必须比上一行低`);
  }
});

test('★ 贴底：下方放不下 → 翻到标签上方（局内三张卡就在屏幕下半部分）', () => {
  const anchorNearBottom = L(400, 520, 100, 40); // 下方只剩 40px
  const plan = tooltipPlan({
    title: '强度评级 S',
    lines: ['选取率 12.1%'],
    anchor: anchorNearBottom,
    canvas: CANVAS,
    style: STYLE,
  });
  assert.ok(plan);
  assert.equal(plan.flipped, true);
  assert.ok(plan.y + plan.h <= anchorNearBottom.y, '必须整体在标签上方');
  assert.ok(plan.y >= 0);
});

test('★ 上下都放不下（标签几乎占满屏幕）→ 夹进画布，绝不画到屏幕外', () => {
  const huge = L(0, 0, 1000, 600);
  const plan = tooltipPlan({
    title: '标题',
    lines: ['第一行', '第二行'],
    anchor: huge,
    canvas: CANVAS,
    style: STYLE,
  });
  assert.ok(plan);
  assert.ok(plan.y >= 0 && plan.y + plan.h <= CANVAS.height, '垂直必须落在画布内');
  assert.ok(plan.x >= 0 && plan.x + plan.w <= CANVAS.width, '水平必须落在画布内');
});

test('★ 贴右/贴左：水平夹进画布（靠右的卡片不许把提示框推到屏幕外）', () => {
  const right = tooltipPlan({
    title: '强度评级 S',
    lines: ['选取率 12.1%'],
    anchor: L(980, 100, 20, 30),
    canvas: CANVAS,
    style: STYLE,
  });
  assert.ok(right);
  assert.ok(right.x + right.w <= CANVAS.width, `右边界：${right.x}+${right.w} > ${CANVAS.width}`);

  const left = tooltipPlan({
    title: '强度评级 S',
    lines: ['选取率 12.1%'],
    anchor: L(0, 100, 20, 30),
    canvas: CANVAS,
    style: STYLE,
  });
  assert.ok(left);
  assert.equal(left.x, 0, '左边界夹到 0');
});

test('宽度上限：超长文本夹到 maxWidth（渲染端按框裁剪），且不小于最小宽度', () => {
  const plan = tooltipPlan({
    title: '短',
    lines: ['这是一行特别特别特别特别长的说明文字，长到超过上限'],
    anchor: L(400, 100, 100, 30),
    canvas: CANVAS,
    style: STYLE,
  });
  assert.ok(plan);
  assert.equal(plan.w, STYLE.maxWidth);

  const narrow = tooltipPlan({
    title: '短',
    anchor: L(400, 100, 100, 30),
    canvas: CANVAS,
    style: STYLE,
  });
  assert.ok(narrow);
  assert.equal(narrow.w, 96, '只有两个字时用最小宽度');
});

test('画布比 maxWidth 还窄时，宽度不许超过画布（自测小窗口 / 换屏瞬间）', () => {
  const plan = tooltipPlan({
    title: '强度评级 S',
    lines: ['选取率 12.1%'],
    anchor: L(10, 10, 20, 20),
    canvas: { width: 80, height: 60 },
    style: STYLE,
  });
  assert.ok(plan);
  assert.ok(plan.w <= 80, `宽度 ${plan.w} 超过画布 80`);
  assert.ok(plan.x >= 0 && plan.x + plan.w <= 80);
  assert.ok(plan.y >= 0 && plan.y + plan.h <= 60);
});

test('回归：NaN / 非法测量值不许把布局带崩（宁可宽一点，也不许 NaN 坐标）', () => {
  const style: TooltipStyle = { ...STYLE, measure: () => NaN };
  const plan = tooltipPlan({
    title: '标题',
    lines: ['正文'],
    anchor: L(400, 100, 100, 30),
    canvas: CANVAS,
    style,
  });
  assert.ok(plan);
  for (const v of [plan.x, plan.y, plan.w, plan.h]) {
    assert.ok(Number.isFinite(v), `坐标必须有限：${String(v)}`);
  }
});

test('tooltipPlanFor：用默认视觉参数（渲染端只注入 measure，不自己排版）', () => {
  const plan = tooltipPlanFor(fixedMeasure(), {
    title: '强度评级 S',
    lines: ['选取率 12.1%'],
    anchor: L(400, 200, 100, 30),
    canvas: CANVAS,
  });
  assert.ok(plan);
  assert.equal(plan.w, 90 + TOOLTIP_STYLE.padding * 2);
  assert.equal(plan.h, TOOLTIP_STYLE.padding * 2 + TOOLTIP_STYLE.titleLineHeight + TOOLTIP_STYLE.lineHeight);
  assert.equal(plan.rows[0]?.font, TOOLTIP_STYLE.titleFont);
  assert.equal(plan.rows[1]?.font, TOOLTIP_STYLE.font);
});

test('tooltipPlanFor：overrides 可覆盖视觉参数（离线预览要放大看细节时用）', () => {
  const plan = tooltipPlanFor(
    fixedMeasure(),
    { title: 'A', anchor: L(400, 200, 100, 30), canvas: CANVAS },
    { padding: 0, lineHeight: 10, titleLineHeight: 10, maxWidth: 1000 },
  );
  assert.ok(plan);
  assert.equal(plan.h, 10, 'title 行高 + 0 padding ×2');
});

test('视觉参数是导出的常量（离线预览与渲染端不可能各写一套）', () => {
  assert.ok(TOOLTIP_STYLE.maxWidth > 0 && TOOLTIP_STYLE.gap >= 0);
  assert.ok(TOOLTIP_COLORS.fill.startsWith('rgba('), '底色必须半透明，别把游戏画面挡死');
  assert.ok(TOOLTIP_COLORS.radius > 0);
});
