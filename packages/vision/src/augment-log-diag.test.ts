/**
 * 常驻路径轻量诊断的测试（2026-10-11）
 *
 * 锁三件事：
 *   ① 每个 `[augment]` / `[hexbox]` 行都带 `[+Xs]`，且**续行不动**（否则卡片那几行会散架）；
 *   ② 采样窗口汇总能把"一帧没取到"与"帧在跑但门控没看到面板"分开 ——
 *      这正是"第 2 次海克斯没抓到"唯一可靠的判据；
 *   ③ API 追踪行默认不产生（只有显式打开才用），格式含等级/死亡/待选。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  captureWindowVerdict,
  formatApiTraceLine,
  formatCaptureWindowLine,
  withLogOffset,
} from './augment-log-diag.ts';

test('偏移插在标签之后：过滤与文档里的日志形状仍然对得上', () => {
  assert.equal(
    withLogOffset('[augment] 🔌 开截屏：死亡（等级 13，待选 [11]）：开截屏', 123_400),
    '[augment] [+123.4s] 🔌 开截屏：死亡（等级 13，待选 [11]）：开截屏',
  );
  assert.equal(withLogOffset('[hexbox] 🧹 清空强度标签：原因=x', 12_345), '[hexbox] [+12.3s] 🧹 清空强度标签：原因=x');
  assert.equal(withLogOffset('没有标签的行', 0), '[+0.0s] 没有标签的行');
  // 只剩标签时把偏移接在标签后（不留尾随空格）
  assert.equal(withLogOffset('[augment] x', 2500), '[augment] [+2.5s] x');
});

test('续行（以空格开头，卡片那几行）原样返回', () => {
  assert.equal(withLogOffset('      卡1 渴血  分数 0.705 分差 0.142', 9000), '      卡1 渴血  分数 0.705 分差 0.142');
});

test('负偏移/非有限值不产生怪日志', () => {
  assert.equal(withLogOffset('[augment] x', -5), '[augment] [+0.0s] x');
});

/* ------------------------------------------------------------------ */

const stats = {
  ms: 45_000,
  samples: 178,
  hits: 0,
  presenceFrames: 0,
  openEdges: 0,
  closeEdges: 0,
};

test('★ 裁决：帧在跑但两条判据都说没面板 → "面板不在这一窗里"（本次真机漏抓的形状）', () => {
  assert.match(captureWindowVerdict(stats), /面板不在这一窗里/);
  const line = formatCaptureWindowLine(stats, '窗口超时（未见面板）：关截屏，待选 [11,15] 保留');
  assert.match(line, /^\[augment\] 🪟 采样窗口 45\.0s：采样 178 帧/);
  assert.match(line, /窗口超时（未见面板）/);
});

test('裁决：一帧都没取到 → 这一窗的"没见面板"不作数（与"面板不在"分开）', () => {
  const v = captureWindowVerdict({ ...stats, samples: 0 });
  assert.match(v, /一帧都没取到/);
  assert.doesNotMatch(v, /面板不在这一窗里/);
});

test('裁决：只有面板信号托底 / 命中但没成开边沿 / 面板出现过', () => {
  assert.match(captureWindowVerdict({ ...stats, presenceFrames: 4 }), /只有面板信号托底/);
  assert.match(captureWindowVerdict({ ...stats, hits: 7 }), /没形成开边沿/);
  assert.match(
    captureWindowVerdict({ ...stats, hits: 20, openEdges: 1, closeEdges: 1 }),
    /面板出现过/,
  );
});

test('窗口行在 reason 为空时也不留空括号', () => {
  const line = formatCaptureWindowLine({ ...stats, openEdges: 1 }, '');
  assert.doesNotMatch(line, /（）/);
  assert.match(line, /面板出现过/);
});

test('API 追踪行：等级/死亡/复活/待选/capture 都在一行里', () => {
  const line = formatApiTraceLine({
    offsetMs: 301_500,
    gameTime: 295.4,
    level: 11,
    isDead: true,
    respawnTimer: 12.3,
    capture: true,
    pending: [11, 15],
    reason: '死亡（等级 11，待选 [11]）：开截屏',
  });
  assert.equal(
    line,
    '[augment] 👁 API [+301.5s] 对局 295.4s 等级 11 死亡(复活12.3s) capture=on 待选 [11,15]：' +
      '死亡（等级 11，待选 [11]）：开截屏',
  );
  assert.match(
    formatApiTraceLine({
      offsetMs: 1000,
      gameTime: 0,
      level: 1,
      isDead: false,
      respawnTimer: 0,
      capture: false,
      pending: [0, 7, 11, 15],
      reason: '常态：不截屏',
    }),
    /存活\(复活0\.0s\) capture=off 待选 \[0,7,11,15\]/,
  );
});
