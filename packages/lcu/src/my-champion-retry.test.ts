/**
 * 重连恢复用的"带重试解析英雄"测试（假 2999 / 假睡眠，不碰网络、不真等 2 秒）
 *
 * 为什么要单独立一组断言：这条路径**只在重连时**走，真机上很难复现，
 * 一旦写成"无限重试"或"重试时换了识别口径"，就会变成"每轮多打一堆本地请求"
 * 或"又去取第一个 championId"（后者是本项目最贵的一次真机 bug）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Champion } from '@hexbox/core';

import type { LiveChampionNames, LiveDataClient, LivePlayerState } from './live-data.ts';
import { resolveMyChampionIdentityWithRetry } from './my-champion.ts';

/** 只实现 `getChampionNames` 的最小 2999 客户端（其余成员给安全空实现）。 */
function stubLive(getChampionNames: () => Promise<LiveChampionNames | null>): LiveDataClient {
  return {
    getChampionNames,
    getPlayerState: async (): Promise<LivePlayerState | null> => null,
    lastError: null,
  };
}

const CHAMPIONS: readonly Champion[] = [
  { id: 79, name: '酒桶', alias: 'Gragas', roles: [], iconPath: '' },
  { id: 43, name: '天启者', alias: 'Karma', roles: [], iconPath: '' },
];

/** 假 2999：前 `failTimes` 次返回 null（模拟"重连后 2999 还没就绪"）。 */
function flakyLive(failTimes: number): {
  client: LiveDataClient;
  calls: () => number;
} {
  let calls = 0;
  return {
    client: stubLive(async (): Promise<LiveChampionNames | null> => {
      calls++;
      if (calls <= failTimes) return null;
      return { rawChampionName: 'game_character_displayname_Gragas', championName: '', myChampionName: '' };
    }),
    calls: () => calls,
  };
}

/** 假睡眠：记录间隔，立即返回（真机上这里会是 2 秒）。 */
function fakeSleep(): { sleep: (ms: number) => Promise<void>; slept: number[] } {
  const slept: number[] = [];
  return {
    sleep: (ms: number) => {
      slept.push(ms);
      return Promise.resolve();
    },
    slept,
  };
}

test('★ 第一次就成功：只试 1 次、不睡眠', async () => {
  const live = flakyLive(0);
  const { sleep, slept } = fakeSleep();
  const r = await resolveMyChampionIdentityWithRetry(
    null,
    { champions: CHAMPIONS, live: live.client },
    { sleep },
  );
  assert.equal(r.identity.championId, 79);
  assert.equal(r.identity.source, 'activePlayer-raw');
  assert.equal(r.attempts, 1);
  assert.equal(r.exhausted, false);
  assert.deepEqual(slept, []);
});

test('★ 前两次拿不到、第三次拿到：尝试 3 次、睡眠 2 次且间隔是 2000ms', async () => {
  const live = flakyLive(2);
  const { sleep, slept } = fakeSleep();
  const prepared: number[] = [];
  const r = await resolveMyChampionIdentityWithRetry(
    null,
    { champions: CHAMPIONS, live: live.client },
    { sleep, beforeAttempt: (n) => void prepared.push(n) },
  );
  assert.equal(r.identity.championId, 79);
  assert.equal(r.attempts, 3);
  assert.equal(r.exhausted, false);
  assert.deepEqual(slept, [2000, 2000], '默认 3 次 × 2 秒');
  assert.deepEqual(prepared, [1, 2, 3], '每次尝试前都要给"重建 2999"的机会');
  assert.equal(r.notes.length, 3);
  assert.ok(r.notes[2]?.includes('成功'), '最后一条必须是成功说明');
});

test('★ 三次都拿不到：exhausted=true、不猜英雄（championId 保持 0）', async () => {
  const live = flakyLive(99);
  const { sleep, slept } = fakeSleep();
  const r = await resolveMyChampionIdentityWithRetry(
    null,
    { champions: CHAMPIONS, live: live.client },
    { sleep },
  );
  assert.equal(r.identity.championId, 0, '宁缺勿错：不许退回任何猜测');
  assert.equal(r.exhausted, true);
  assert.equal(r.attempts, 3);
  assert.deepEqual(slept, [2000, 2000]);
  assert.ok(r.notes[r.notes.length - 1]?.includes('不显示该英雄数据'));
});

test('attempts / intervalMs 可配；0 或负数归一到 1 次', async () => {
  const live = flakyLive(99);
  const a = fakeSleep();
  await resolveMyChampionIdentityWithRetry(
    null,
    { champions: CHAMPIONS, live: live.client },
    { attempts: 5, intervalMs: 500, sleep: a.sleep },
  );
  assert.deepEqual(a.slept, [500, 500, 500, 500]);

  const b = fakeSleep();
  const r = await resolveMyChampionIdentityWithRetry(
    null,
    { champions: CHAMPIONS, live: live.client },
    { attempts: 0, sleep: b.sleep },
  );
  assert.equal(r.attempts, 1, '至少要试一次（否则等于没做恢复）');
  assert.deepEqual(b.slept, []);
});

test('★ beforeAttempt 抛错不中止重试（重连时"重建 2999"本身就可能失败）', async () => {
  const live = flakyLive(1);
  const { sleep } = fakeSleep();
  let throws = 0;
  const r = await resolveMyChampionIdentityWithRetry(
    null,
    { champions: CHAMPIONS, live: live.client },
    {
      sleep,
      beforeAttempt: () => {
        throws++;
        throw new Error('重建客户端失败');
      },
    },
  );
  assert.equal(throws, 2, '两次尝试都要调准备（第一次失败后仍要继续）');
  assert.equal(r.identity.championId, 79, '第二次仍然成功');
  assert.ok(r.notes.some((n) => n.includes('准备失败')), '准备失败要留痕');
});

test('★ 入参允许是**工厂**：每次尝试都要重新取一次（重连要能换上重建后的 2999 客户端）', async () => {
  // 只有"每次重新取"才能让 beforeAttempt 里重建的 2999 真正生效；
  // 传对象的话第一次就固定住了，重建等于白做。
  let builds = 0;
  let liveCalls = 0;
  const { sleep } = fakeSleep();
  const r = await resolveMyChampionIdentityWithRetry(
    null,
    () => {
      builds++;
      const live = stubLive(async (): Promise<LiveChampionNames | null> => {
        liveCalls++;
        // 第 3 次构建出来的客户端才拿得到名字（模拟 2999 刚起来）
        return builds >= 3 ? { rawChampionName: 'game_character_displayname_Gragas', championName: '', myChampionName: '' } : null;
      });
      return { champions: CHAMPIONS, live };
    },
    { attempts: 3, sleep, beforeAttempt: () => void 0 },
  );
  assert.equal(builds, 3, '工厂必须每次尝试都被调用一次');
  assert.equal(liveCalls, 3, '每次都问的是**新**客户端');
  assert.equal(r.identity.championId, 79);
  assert.equal(r.attempts, 3);
});

test('★ 传对象时的等价性：也只在成功那一次停止（不额外调用）', async () => {
  const live = flakyLive(1);
  const { sleep } = fakeSleep();
  const r = await resolveMyChampionIdentityWithRetry(
    null,
    { champions: CHAMPIONS, live: live.client },
    { attempts: 3, sleep },
  );
  assert.equal(r.attempts, 2);
  assert.equal(live.calls(), 2, '成功即停，不再多问一次 2999');
});

test('重试用的是**同一个**解析口径：LCU 里只有队友的 championId 时必须放弃（不许取第一个）', async () => {
  // 回归本项目最贵的真机 bug：没有"我自己的身份"时，任何通道都不许猜
  const lcu = {
    get: <T,>() => Promise.resolve({} as T),
    getOrNull: <T,>(path: string) =>
      Promise.resolve(
        (path === '/lol-gameflow/v1/session'
          ? { phase: 'InProgress', gameData: { teamOne: [{ championId: 43 }] } }
          : null) as T | null,
      ),
  };
  const { sleep } = fakeSleep();
  const r = await resolveMyChampionIdentityWithRetry(lcu, { champions: CHAMPIONS }, { attempts: 2, sleep });
  assert.equal(r.identity.championId, 0, '只有队友的 ID 时不许猜出 Karma');
  assert.equal(r.exhausted, true);
});
