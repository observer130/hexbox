#!/usr/bin/env node
/**
 * 配装方案 CLI（写入 / 查看 / 清理）
 *
 * 用法（**需要管理员权限**，否则读不到 LCU 凭证）：
 *   node --experimental-strip-types packages/lcu/src/itemset-cli.ts list
 *   node --experimental-strip-types packages/lcu/src/itemset-cli.ts write [英雄ID...]
 *   node --experimental-strip-types packages/lcu/src/itemset-cli.ts clean
 *
 * 设计原则（写操作，必须保守）：
 *   - 只写**本工具生成**的方案（标题以 `hexbox` 开头）；
 *   - 永不删除或覆盖玩家手写的方案；
 *   - 默认只处理「有出装统计」的英雄。
 *
 * ⚠️ 这是把本地统计推送到**你的真实客户端数据**的操作。
 *    `list` 是只读的，建议先跑它确认现状。
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readBuilds, readDataset } from '@hexbox/data-store';
import {
  findDetail,
  isOwnItemSet,
  makeItemSet,
  mergeItemSets,
  type ItemSet,
  type ItemSetPayload,
} from '@hexbox/core';
import { LcuClient, detectCredentialsDetailed } from './index.ts';

const DATA_DIR = resolve(process.cwd(), 'data');

/** 线上方案列表（`GET /lol-item-sets/v1/item-sets/{summonerId}/sets` 的形状）。 */
export interface RemoteSets {
  accountId: number;
  itemSets: ItemSet[];
  timestamp: number;
}

/**
 * 校验线上返回的方案列表（**纯函数**）。
 *
 * 返回 `null` = **读不懂**（不是"没有方案"）。这两件事必须分开：
 *   · `{ itemSets: [] }` 是合法状态 —— 玩家确实一套都没有；
 *   · `null` / 缺字段 / 条目形状异常 = 读取失败。
 * 以前两者被 `v ?? { itemSets: [] }` 混成一个，于是"读不到"会被当成"空"，
 * 紧接着的 `PUT` 就会用"只含本工具方案"的列表把**玩家手写的方案整体删掉**。
 *
 * 只要有一条形状不对就整份判为不可读 —— 丢掉畸形条目再写回去，等于静默删除。
 */
export function parseRemoteSets(raw: unknown): RemoteSets | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const itemSets = record['itemSets'];
  if (!Array.isArray(itemSets)) return null;
  for (const entry of itemSets) {
    if (typeof entry !== 'object' || entry === null) return null;
    const set = entry as Record<string, unknown>;
    // 这三个字段是我们自己的合并/清理/展示逻辑直接读的，缺一个都不敢写回去
    if (typeof set['title'] !== 'string') return null;
    if (!Array.isArray(set['associatedChampions'])) return null;
    if (!Array.isArray(set['blocks'])) return null;
    if (!Array.isArray(set['associatedMaps'])) return null;
  }
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return {
    accountId: num(record['accountId']),
    itemSets: itemSets as ItemSet[],
    timestamp: num(record['timestamp']),
  };
}

/**
 * `writeGuard` 的判定结果。
 *
 * `ok: false` 是**拒绝写入**（不是错误退出码）：调用方必须原样接受，
 * 不允许"读失败就当空列表写回去"的降级。
 */
export type WriteGuardResult =
  | { readonly ok: true; readonly sets: RemoteSets }
  | { readonly ok: false; readonly reason: string };

/**
 * 写盘前的安全检查（**纯函数**）：读不到现有方案就绝不写。
 *
 * 写的是**完整列表**（`PUT` 会整体替换），所以"我不知道原来有什么"
 * 和"原来什么都没有"绝不能等价看待。
 */
export function writeGuard(read: RemoteSets | null): WriteGuardResult {
  if (read === null) {
    return {
      ok: false,
      reason:
        '读不到现有配装方案（LCU 返回空、404 或格式异常）—— 为避免覆盖玩家手写的方案，已拒绝写入。' +
        '请先运行 `list` 确认客户端状态，或在游戏内打开一次「收藏 → 配装方案」后重试。',
    };
  }
  return { ok: true, sets: read };
}

async function connect(): Promise<LcuClient> {
  const r = await detectCredentialsDetailed();
  if (!r.credentials) {
    console.error(
      `✗ 读不到 LCU 凭证。\n  探测详情: ${r.detail}\n` +
        '  请以**管理员身份**运行（否则读不到进程命令行）。',
    );
    process.exit(1);
  }
  return new LcuClient(r.credentials);
}

async function getSummonerId(client: LcuClient): Promise<number> {
  const me = await client.get<{ summonerId?: number }>('/lol-summoner/v1/current-summoner');
  const id = me?.summonerId;
  if (typeof id !== 'number' || id <= 0) throw new Error('无法取得 summonerId');
  return id;
}

async function readSets(client: LcuClient, sid: number): Promise<RemoteSets | null> {
  const v = await client.getOrNull<unknown>(`/lol-item-sets/v1/item-sets/${sid}/sets`);
  return parseRemoteSets(v);
}

/** list：只读，展示既有方案并区分来源。 */
async function cmdList(client: LcuClient): Promise<void> {
  const sid = await getSummonerId(client);
  const read = await readSets(client, sid);
  if (read === null) {
    console.error(
      '✗ 读不到配装方案（LCU 返回空、404 或格式异常）。\n' +
        '  只读命令，没有副作用；写命令在这种情况下会**拒绝写入**。',
    );
    process.exitCode = 1;
    return;
  }
  const sets = read;
  console.log(`召唤师 ${sid}，共 ${sets.itemSets.length} 套配装方案\n`);
  if (sets.itemSets.length === 0) {
    console.log('  （无）');
    return;
  }
  for (const s of sets.itemSets) {
    const own = isOwnItemSet(s) ? '[hexbox]' : '[玩家]  ';
    const champs = s.associatedChampions.join(',') || '-';
    const maps = s.associatedMaps.join(',') || '-';
    const blocks = s.blocks.map((b) => `${b.type}(${b.items.length})`).join(' ');
    console.log(`  ${own} ${s.title}`);
    console.log(`           英雄 ${champs} | 地图 ${maps} | ${blocks}`);
  }
}

/** write：生成并写入（只动自己生成的方案）。 */
async function cmdWrite(client: LcuClient, championIds: number[]): Promise<void> {
  const sid = await getSummonerId(client);

  const ds = await readDataset(DATA_DIR);
  const builds = await readBuilds(DATA_DIR);
  if (!ds || !builds) {
    console.error('✗ 缺少本地数据，请先运行 pnpm sync');
    process.exit(1);
  }

  // 未指定英雄时，为所有有出装统计的英雄生成
  const targets =
    championIds.length > 0
      ? championIds
      : builds.details.map((d) => d.championId);

  const generated: ItemSet[] = [];
  for (const cid of targets) {
    const detail = findDetail(builds, cid);
    if (!detail) continue;
    const name = ds.champions.find((c) => c.id === cid)?.name ?? `英雄${cid}`;
    const set = makeItemSet({
      championId: cid,
      championName: name,
      build: {
        start: [...detail.build.start],
        startCombo: [...detail.build.startCombo],
        shoes: [...detail.build.shoes],
        core: [...detail.build.core],
      },
      dataDate: builds.meta.dataDate,
    });
    if (set) generated.push(set);
  }

  if (generated.length === 0) {
    console.error('✗ 没有可生成的配装方案（缺少出装统计）');
    process.exit(1);
  }

  // ⚠️ 读不到现有方案就**绝不写**：PUT 是"整体替换"，不知道原来有什么时
  //    写回去 = 删除玩家手写的方案（真机风险，2026-11 审查）。
  const guard = writeGuard(await readSets(client, sid));
  if (!guard.ok) {
    console.error(`✗ ${guard.reason}`);
    process.exitCode = 1;
    return;
  }
  const existing = guard.sets;
  const merged = mergeItemSets(existing.itemSets, generated);
  const payload: ItemSetPayload = {
    accountId: existing.accountId || sid,
    itemSets: merged,
    timestamp: existing.timestamp ?? 0,
  };

  console.log(
    `写入 ${generated.length} 套方案（既有 ${existing.itemSets.length} → 合并后 ${merged.length}）`,
  );
  console.log('  玩家手写的方案会被保留，不被覆盖');

  await client.sendJson('PUT', `/lol-item-sets/v1/item-sets/${sid}/sets`, payload);
  console.log('✓ 已写入。请在游戏内「收藏 → 配装方案」查看。');
}

/** clean：只删除本工具生成的方案。 */
async function cmdClean(client: LcuClient): Promise<void> {
  const sid = await getSummonerId(client);
  // 同 write：读不到现有方案就不动 —— 否则"保留的列表"会是空列表，
  // 一次 PUT 就把玩家手写的方案一并删掉。
  const guard = writeGuard(await readSets(client, sid));
  if (!guard.ok) {
    console.error(`✗ ${guard.reason}`);
    process.exitCode = 1;
    return;
  }
  const existing = guard.sets;
  const kept = existing.itemSets.filter((s) => !isOwnItemSet(s));
  const removed = existing.itemSets.length - kept.length;

  if (removed === 0) {
    console.log('没有本工具生成的方案，无需清理。');
    return;
  }
  await client.sendJson('PUT', `/lol-item-sets/v1/item-sets/${sid}/sets`, {
    accountId: existing.accountId || sid,
    itemSets: kept,
    timestamp: existing.timestamp ?? 0,
  } satisfies ItemSetPayload);
  console.log(`✓ 已移除 ${removed} 套本工具生成的方案（玩家手写的已保留）`);
}

async function main(): Promise<void> {
  const [cmd = 'list', ...rest] = process.argv.slice(2);

  // ⚠️ `help`/未知命令不该去连客户端：以前 `connect()` 在 switch 之前，
  //    于是只想看用法的人被要求"以管理员身份运行"（而这台机器上很可能
  //    根本没开客户端）。先判命令，需要连接的分支里再连。
  if (cmd !== 'list' && cmd !== 'write' && cmd !== 'clean') {
    console.log(
      [
        '配装方案 CLI（需管理员权限）',
        '',
        '用法:',
        '  list              查看既有方案（只读，建议先跑）',
        '  write [英雄ID...]  写入配装方案（不传 ID 则为全部有数据的英雄）',
        '  clean             移除本工具生成的方案（保留玩家手写的）',
      ].join('\n'),
    );
    return;
  }

  const client = await connect();

  switch (cmd) {
    case 'list':
      await cmdList(client);
      break;
    case 'write':
      await cmdWrite(
        client,
        rest.map((x) => Number.parseInt(x, 10)).filter((x) => Number.isFinite(x) && x > 0),
      );
      break;
    default:
      await cmdClean(client);
  }
}

/**
 * 入口保护：**只在直接运行本文件时**执行 CLI。
 *
 * 与 `@hexbox/data-cli` 的 `cli.ts` 同一套做法：本文件里的 `parseRemoteSets()` /
 * `writeGuard()` 是写盘前的安全判据，必须能被单测直接 import；无条件执行
 * `main()` 会让 `import` 立刻去探测 LCU 凭证并退出。
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((err: unknown) => {
    console.error('未捕获错误:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
