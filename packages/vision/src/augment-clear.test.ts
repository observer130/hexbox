/**
 * 「清空强度标签」的原因词表与日志行测试
 *
 * 这一组是**可观测性契约**（2026-10-06 真机缺陷："局内面板开着不动，标签几秒后
 * 自己消失"）：日志格式一漂移，用户的排查手册就失效，所以字面量与格式都被锁住。
 * 词表改了 = 排查手册改了，必须是一次**显式**修改。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUGMENT_CLEAR_REASONS,
  augmentChainStopKeepsLabelsLine,
  augmentClearLogLine,
  augmentClearReasonForEmptyLabels,
  augmentClearReasonForRefreshedCard,
  augmentStopClearsLabels,
} from './augment-clear.ts';

test('原因词表：字面量被锁住（用户按这些字符串 grep / 写进复现步骤）', () => {
  assert.deepEqual(AUGMENT_CLEAR_REASONS, {
    panelClosed: '面板关闭边沿',
    chainStop: '链路停止',
    stageHandover: '阶段换手',
    rerollUnknown: '刷新后认不出',
    rerollNoTier: '刷新后查不到强度',
    recognizeFailed: '重识别失败',
  });
});

test('清空日志行：统一前缀 + 原因；detail 为空时不打印空括号', () => {
  const line = augmentClearLogLine(AUGMENT_CLEAR_REASONS.panelClosed);
  assert.equal(line, '🧹 清空强度标签：原因=面板关闭边沿');
  assert.ok(!line.includes('（）'), '没有 detail 时不许出现空括号');
  // 用户 grep 的那一段必须是**每一次清空**都有的固定前缀
  assert.ok(line.startsWith('🧹 清空强度标签：原因='));
});

test('清空日志行：带 detail 时进括号（第几次 / 卡号 / 触发者）', () => {
  assert.equal(
    augmentClearLogLine(AUGMENT_CLEAR_REASONS.panelClosed, '第 2 次'),
    '🧹 清空强度标签：原因=面板关闭边沿（第 2 次）',
  );
  assert.equal(
    augmentClearLogLine(AUGMENT_CLEAR_REASONS.chainStop, '离开对局'),
    '🧹 清空强度标签：原因=链路停止（离开对局）',
  );
  assert.equal(
    augmentClearLogLine(AUGMENT_CLEAR_REASONS.rerollUnknown, '卡2'),
    '🧹 清空强度标签：原因=刷新后认不出（卡2）',
  );
  assert.equal(
    augmentClearLogLine(AUGMENT_CLEAR_REASONS.stageHandover, 'augment → none；面板在屏=false'),
    '🧹 清空强度标签：原因=阶段换手（augment → none；面板在屏=false）',
  );
});

test('词表里每个原因都能拼出一行合法日志（没有漏配的）', () => {
  for (const reason of Object.values(AUGMENT_CLEAR_REASONS)) {
    const line = augmentClearLogLine(reason);
    assert.ok(line.includes(`原因=${reason}`), `原因 ${reason} 必须出现在日志行里`);
  }
});

test('一次（重）识别整批没有可画结果：开边沿 = 重识别失败，重随 = 刷新后认不出', () => {
  assert.equal(augmentClearReasonForEmptyLabels('open'), AUGMENT_CLEAR_REASONS.recognizeFailed);
  assert.equal(augmentClearReasonForEmptyLabels('reroll'), AUGMENT_CLEAR_REASONS.rerollUnknown);
});

test('重随后单卡没有可画结果：**认不出**与**查不到强度**必须分开（排查方向不同）', () => {
  // 认不出（OCR 宁漏勿错）→ 识别问题（换分辨率/字体要复标定）
  assert.equal(
    augmentClearReasonForRefreshedCard(null, null),
    AUGMENT_CLEAR_REASONS.rerollUnknown,
  );
  // 认出来了但该英雄表里没有这颗（官方每英雄只有 95~162 条）→ 数据覆盖问题
  assert.equal(
    augmentClearReasonForRefreshedCard(2116, null),
    AUGMENT_CLEAR_REASONS.rerollNoTier,
  );
  // 有可画结果 → 不清（返回 null）
  assert.equal(augmentClearReasonForRefreshedCard(1373, 'S'), null);
  // 边界：augmentId 为 null 时即使 tier 给了值也按"认不出"（不可能同时成立，但不能崩）
  assert.equal(
    augmentClearReasonForRefreshedCard(null, 'S'),
    AUGMENT_CLEAR_REASONS.rerollUnknown,
  );
});

/* ------------------------------------------------------------------ */
/* 标签生命周期 ⇄ 链路生命周期（2026-10-06 真机缺陷："闪一下就没了"）        */
/* ------------------------------------------------------------------ */

test('链路停止**默认不清标签**（标签生命周期与链路生命周期解耦）', () => {
  // 改前 `AugmentController.stop()` **无条件**清标签 → 任何一次停止（含"在途启动
  // 的回调把期间新起的会话一起收掉"）都会把**面板还开着**的标签抹掉 ——
  // 用户看到"面板刚弹出、标签刚画上，随即被清掉"。
  assert.equal(augmentStopClearsLabels(undefined), false, '不传 = 这次停止与标签无关');
  assert.equal(augmentStopClearsLabels(false), false);
  // 只有**明确**要求才清：程序退出（窗口马上销毁）/ 录制工具收工（不留残留字母）
  assert.equal(augmentStopClearsLabels(true), true);
});

test('「链路停止但不清标签」日志行：字面量被锁住（用户按它排除"链路把标签停掉了"）', () => {
  assert.equal(
    augmentChainStopKeepsLabelsLine('离开对局', true),
    '⏹ 链路停止但不清标签（面板仍开）：原因=离开对局' +
      ' —— 标签只由「面板关闭边沿」或「确认离开对局」清空',
  );
  assert.equal(
    augmentChainStopKeepsLabelsLine('屏幕流不可用', false),
    '⏹ 链路停止但不清标签（面板不在屏）：原因=屏幕流不可用' +
      ' —— 标签只由「面板关闭边沿」或「确认离开对局」清空',
  );
  // "没清"与"清了"两行必须一眼可分辨（清空行有 🧹 清空强度标签 前缀）
  assert.ok(!augmentChainStopKeepsLabelsLine('x', true).includes('🧹 清空强度标签'));
});
