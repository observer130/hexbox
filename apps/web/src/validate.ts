/**
 * 运行时数据校验（**纯函数**，不依赖 vue/DOM，可 Node 直测）
 *
 * 为什么需要这一层（2026-11 审查 P2）：`fetchJson` 原本只做
 * `res.json() as T` —— 类型断言只在编译期成立，运行时拿到旧版本或写坏的
 * JSON（例如加入国服图鉴之前的 `dataset.json` 没有 `hextechs` 字段）时，
 * computed 里遍历 `undefined` 直接抛 TypeError → Vue 渲染中断 → **整页白屏**，
 * 用户只看到控制台一行报错。
 *
 * 现在的约定：数据形状不对就抛**带用户可执行提示**的 Error，由 `useDataset.ts`
 * 转成页面上的「数据不兼容」说明，而不是白屏。
 *
 * 边界：只校验**页面实际读取的必需形状**（顶层字段 + 数组元素是对象），
 * 不做深拷贝/重排 —— 通过后原样返回调用方（`DataState` 直接把同一对象放进
 * shallowRef，避免 900KB 数据无谓复制）。
 */

import { DATA_SCHEMA_VERSION, type Dataset, type RankingSnapshot } from '@hexbox/core';

/**
 * 数据不兼容时的统一文案前缀（直接展示给用户）。
 *
 * 后半句给的是**可执行动作**：重新 `pnpm sync` 生成新格式数据。
 */
export const INCOMPATIBLE_DATA_MESSAGE = '数据文件格式不兼容（可能来自旧版本），请重新 pnpm sync';

/** 造一条带字段名的「不兼容」错误，便于用户/开发者定位脏数据。 */
function incompatible(field: string): Error {
  return new Error(`${INCOMPATIBLE_DATA_MESSAGE}（字段：${field}）`);
}

/** 断言是普通对象（数组/null 都不算）。 */
function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw incompatible(field);
  }
  return value as Record<string, unknown>;
}

/** 断言字段是非空字符串（`fetchedAt` / `dataDate` 都按这个口径）。 */
function requireString(record: Record<string, unknown>, key: string, field: string): void {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw incompatible(field);
}

/**
 * 断言字段是数组，且每个元素是普通对象。
 *
 * 元素级检查是给模板兜底的：数组存在但塞了 `null`（写了一半的文件）同样会让
 * `a.name.toLowerCase()` / `h.augmentNameId.replace(...)` 抛 TypeError。
 */
function requireObjectArray(
  record: Record<string, unknown>,
  key: string,
  field: string,
): Record<string, unknown>[] {
  const value = record[key];
  if (!Array.isArray(value)) throw incompatible(field);
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw incompatible(`${field}[${i}]`);
    }
  }
  return value as Record<string, unknown>[];
}

/** 断言字段是数字（页面会直接做数值比较/排序）。 */
function requireNumber(record: Record<string, unknown>, key: string, field: string): void {
  if (typeof record[key] !== 'number' || !Number.isFinite(record[key] as number)) {
    throw incompatible(field);
  }
}

/** 断言字段是数组（`modes` 这类只遍历、不参与数值运算的字段）。 */
function requireArray(record: Record<string, unknown>, key: string, field: string): void {
  if (!Array.isArray(record[key])) throw incompatible(field);
}

/**
 * 数据文件版本：来自**更新版本** hexbox 的文件明确拒绝（提示升级），
 * 不让页面在未知格式上"尽力渲染"。缺省（旧文件）按 1 处理，字段校验兜底。
 */
function requireSupportedSchema(meta: Record<string, unknown>): void {
  const version = meta['schemaVersion'];
  if (typeof version === 'number' && version > DATA_SCHEMA_VERSION) {
    throw new Error(
      `数据文件由更新版本的 hexbox 生成（schema ${version}，当前支持 ${DATA_SCHEMA_VERSION}）：` +
        '请升级 hexbox 后重试，或重新 pnpm sync 生成本版本数据',
    );
  }
}

/** 数组元素级必填字段校验（页面实际读取的字段）。 */
function eachEntry(
  entries: readonly Record<string, unknown>[],
  base: string,
  check: (entry: Record<string, unknown>, field: string) => void,
): void {
  entries.forEach((entry, i) => {
    check(entry, `${base}[${i}]`);
  });
}

/**
 * 校验 `data/dataset.json`（`pnpm sync` 产物）的必需形状。
 *
 * 必需字段：`meta.fetchedAt` 字符串 + `augments` / `champions` / `items` /
 * `hextechs` 数组。旧版本数据缺 `hextechs` 时**必须拒绝**（否则图鉴合并会
 * 遍历 undefined 白屏），由调用方提示重新 sync。
 *
 * @throws Error 形状不兼容（消息含 {@link INCOMPATIBLE_DATA_MESSAGE} 与字段名）
 */
export function parseDataset(value: unknown): Dataset {
  const root = requireRecord(value, '根对象');
  const meta = requireRecord(root.meta, 'meta');
  requireString(meta, 'fetchedAt', 'meta.fetchedAt');
  requireSupportedSchema(meta);
  const augments = requireObjectArray(root, 'augments', 'augments');
  const champions = requireObjectArray(root, 'champions', 'champions');
  const items = requireObjectArray(root, 'items', 'items');
  const hextechs = requireObjectArray(root, 'hextechs', 'hextechs');

  // 条目级必填字段（页面会直接读这些字段，缺了同样会 TypeError 白屏）
  eachEntry(augments, 'augments', (a, field) => {
    requireNumber(a, 'id', `${field}.id`);
    requireString(a, 'augmentNameId', `${field}.augmentNameId`);
    requireString(a, 'name', `${field}.name`);
    requireArray(a, 'modes', `${field}.modes`);
  });
  eachEntry(champions, 'champions', (c, field) => {
    requireNumber(c, 'id', `${field}.id`);
    requireString(c, 'name', `${field}.name`);
    requireString(c, 'alias', `${field}.alias`);
  });
  eachEntry(items, 'items', (i, field) => {
    requireNumber(i, 'id', `${field}.id`);
    requireString(i, 'name', `${field}.name`);
  });
  eachEntry(hextechs, 'hextechs', (h, field) => {
    requireNumber(h, 'id', `${field}.id`);
    requireString(h, 'augmentNameId', `${field}.augmentNameId`);
    requireString(h, 'name', `${field}.name`);
  });

  // 只做形状校验；通过后原样返回（不做深拷贝/重排）。
  return value as Dataset;
}

/**
 * 校验 `data/rankings.json`（官方排行榜产物）的必需形状。
 *
 * 必需字段：`meta.dataDate` 字符串 + `augments` / `heroes` 数组。
 * 排行榜是独立容错的（`useDataset` 的 `rankingsError`）：失败只影响榜单区，
 * 不阻塞图鉴。
 *
 * @throws Error 形状不兼容（消息含 {@link INCOMPATIBLE_DATA_MESSAGE} 与字段名）
 */
export function parseRankings(value: unknown): RankingSnapshot {
  const root = requireRecord(value, '根对象');
  const meta = requireRecord(root.meta, 'meta');
  requireString(meta, 'dataDate', 'meta.dataDate');
  requireSupportedSchema(meta);
  const augmentRows = requireObjectArray(root, 'augments', 'augments');
  const heroRows = requireObjectArray(root, 'heroes', 'heroes');

  eachEntry(augmentRows, 'augments', (a, field) => {
    requireNumber(a, 'id', `${field}.id`);
    requireNumber(a, 'winRate', `${field}.winRate`);
    requireNumber(a, 'pickRate', `${field}.pickRate`);
  });
  eachEntry(heroRows, 'heroes', (h, field) => {
    requireNumber(h, 'championId', `${field}.championId`);
    requireNumber(h, 'winRate', `${field}.winRate`);
    requireNumber(h, 'pickRate', `${field}.pickRate`);
  });

  return value as RankingSnapshot;
}
