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

interface RemoteSets {
  accountId: number;
  itemSets: ItemSet[];
  timestamp: number;
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

async function readSets(client: LcuClient, sid: number): Promise<RemoteSets> {
  const v = await client.getOrNull<RemoteSets>(`/lol-item-sets/v1/item-sets/${sid}/sets`);
  return v ?? { accountId: sid, itemSets: [], timestamp: 0 };
}

/** list：只读，展示既有方案并区分来源。 */
async function cmdList(client: LcuClient): Promise<void> {
  const sid = await getSummonerId(client);
  const sets = await readSets(client, sid);
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

  const existing = await readSets(client, sid);
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
  const existing = await readSets(client, sid);
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
    case 'clean':
      await cmdClean(client);
      break;
    default:
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
  }
}

main().catch((err: unknown) => {
  console.error('未捕获错误:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
