/**
 * 故障排查表测试
 *
 * 这张表的读者是**用户**（自测输出 + 文档），所以测试盯的是两件"会让人白折腾"的事：
 *   ① 症状清单被改过（用户按文档搜，就再也对不上）；
 *   ② 表里写的"搜日志：xxx"**在真实日志里不存在** —— 那就等于把用户送进死胡同。
 * 第 ② 条用**跨模块**断言来保证：凡是引用我们自己词表的片段，都拿真函数跑一遍，
 * 确认那段文字确实会被打出来（例如"重置熔断"必须真的出现在重连判定的原因里）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AUGMENT_CLEAR_REASONS, augmentChainStopKeepsLabelsLine } from './augment-clear.ts';
import {
  failureTaxonomyText,
  LABEL_SYMPTOM_TAXONOMY,
  LABEL_SYMPTOMS,
  symptomEntry,
} from './failure-taxonomy.ts';
import { decideReconnectChainAction } from './reconnect-recovery.ts';

test('★ 症状清单被字面量锁住（用户/文档按它搜）', () => {
  assert.deepEqual(
    [...LABEL_SYMPTOMS],
    ['选人阶段不显示', '海克斯阶段不显示', '两个阶段都不显示', '玩了几局后不显示', '显示信息偏移'],
  );
  assert.equal(LABEL_SYMPTOM_TAXONOMY.length, LABEL_SYMPTOMS.length, '每个症状都必须有一条');
  assert.deepEqual(
    LABEL_SYMPTOM_TAXONOMY.map((e) => e.symptom),
    [...LABEL_SYMPTOMS],
    '顺序也必须一致（从最常见排到最少见）',
  );
});

test('每条症状都有解释、且至少 3 条可能原因（只有一条等于没排查表）', () => {
  for (const entry of LABEL_SYMPTOM_TAXONOMY) {
    assert.ok(entry.why.length >= 10, `${entry.symptom}: why 太短`);
    assert.ok(entry.causes.length >= 3, `${entry.symptom}: 只有 ${entry.causes.length} 条原因`);
    for (const c of entry.causes) {
      assert.ok(c.cause.length >= 8, `${entry.symptom}: 原因太短「${c.cause}」`);
      assert.ok(c.grep.length >= 2, `${entry.symptom}: 搜日志的片段太短「${c.grep}」`);
      assert.ok(c.action.length >= 10, `${entry.symptom}: 动作太短「${c.action}」`);
      assert.ok(
        !/^(检查一下|看看|注意|确认)$/.test(c.action.trim()),
        `${entry.symptom}: 动作必须是可执行的一步，不能是「${c.action}」`,
      );
    }
  }
});

test('★ "搜日志"的片段在**同一条症状内**不许重复（重复了用户还是不知道看哪）', () => {
  // 跨症状允许重复：同一个物理原因（例如"画布停在 300x150"）确实会同时造成
  // "选人不显示"和"两个阶段都不显示" —— 那是有意义的重复，不是抄错。
  // 但**同一条症状内**出现两次相同的 grep 一定是复制粘贴留下的错行。
  for (const entry of LABEL_SYMPTOM_TAXONOMY) {
    const greps = entry.causes.map((c) => c.grep);
    assert.equal(
      new Set(greps).size,
      greps.length,
      `${entry.symptom} 内有重复 grep：${greps.join(' | ')}`,
    );
  }
});

test('grep 片段不许互为子串（`面板` 这种过泛的片段会把用户淹掉）', () => {
  const greps = LABEL_SYMPTOM_TAXONOMY.flatMap((e) => e.causes.map((c) => c.grep));
  for (const a of greps) {
    for (const b of greps) {
      if (a === b) continue;
      assert.ok(!b.includes(a), `「${a}」是「${b}」的子串 —— 搜它会把两处都命中`);
    }
  }
});

test('★ 跨模块：表里引用的日志片段，确实由我们自己的函数打出来', () => {
  const greps = new Set(LABEL_SYMPTOM_TAXONOMY.flatMap((e) => e.causes.map((c) => c.grep)));

  // ① 重连恢复的两条（`vision/reconnect-recovery.ts` 的 reason 会进日志）
  assert.ok(greps.has('重置熔断'));
  assert.ok(
    decideReconnectChainAction({ chainState: 'failed', captureState: 'unavailable' }).reason.includes(
      '重置熔断',
    ),
    '「重置熔断」必须真的出现在重连判定的原因里',
  );
  assert.ok(greps.has('僵尸会话'));
  assert.ok(
    decideReconnectChainAction({ chainState: 'running', captureState: 'unavailable' }).reason.includes(
      '僵尸会话',
    ),
    '「僵尸会话」必须真的出现在重连判定的原因里',
  );

  // ② 链路停止不清标签那一行（`vision/augment-clear.ts`）
  assert.ok(greps.has('链路停止但不清标签'));
  assert.ok(augmentChainStopKeepsLabelsLine('测试', true).includes('链路停止但不清标签'));

  // ③ 清空原因词表里的"查不到强度"（`AUGMENT_CLEAR_REASONS.rerollNoTier`）
  assert.ok(greps.has('查不到强度'));
  assert.ok(
    AUGMENT_CLEAR_REASONS.rerollNoTier.includes('查不到强度'),
    'grep「查不到强度」必须能命中词表里的字面量（否则用户搜不到）',
  );
});

test('symptomEntry：按症状取值；未知返回 null（不抛）', () => {
  for (const s of LABEL_SYMPTOMS) {
    assert.equal(symptomEntry(s)?.symptom, s);
  }
  assert.equal(symptomEntry('没这个症状'), null);
  assert.equal(symptomEntry(''), null);
});

test('★ failureTaxonomyText：把整张表都打出来（不许悄悄少打几行）', () => {
  const text = failureTaxonomyText();
  for (const entry of LABEL_SYMPTOM_TAXONOMY) {
    assert.ok(text.includes(`【${entry.symptom}】`), `少打了症状 ${entry.symptom}`);
    for (const c of entry.causes) {
      assert.ok(text.includes(c.grep), `少打了 grep ${c.grep}`);
      assert.ok(text.includes(c.action), `少打了动作 ${c.action}`);
    }
  }
  const expectedLines =
    LABEL_SYMPTOM_TAXONOMY.length +
    LABEL_SYMPTOM_TAXONOMY.reduce((n, e) => n + e.causes.length * 3, 0);
  assert.equal(text.split('\n').length, expectedLines, '行数 = 症状 + 每条原因 3 行');
  assert.ok(!text.includes('undefined'), '不许把 undefined 打进用户日志');
});
