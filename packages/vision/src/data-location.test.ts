/**
 * 数据目录解析测试（纯函数）
 *
 * 这些用例就是"数据放在哪儿"的契约：
 *   · 新默认 = 文档目录（写目标也在这儿，**永远不写安装目录**）；
 *   · 升级用户读到旧位置（LOCALAPPDATA / 安装快照）→ 只读，下一次更新写到文档；
 *   · 开发版优先仓库 `data/`（与 pnpm sync 对账），没有才用文档目录；
 *   · 显式 `HEXBOX_DATA_DIR` 读写都听它；
 *   · 什么都没有 = 首次运行（`none`），仍然给出文档目录供更新写入。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DATA_DIR_SOURCE_LABEL,
  resolveDataLocation,
  type DataLocationInput,
} from './data-location.ts';

function input(over: Partial<DataLocationInput> = {}): DataLocationInput {
  return {
    isPackaged: true,
    explicit: null,
    documentsDir: 'C:\\Users\\me\\Documents\\hexbox\\data',
    documentsExists: false,
    legacyDir: 'C:\\Users\\me\\AppData\\Local\\hexbox\\data',
    legacyExists: false,
    installSnapshotDir: 'C:\\Program Files\\hexbox\\resources\\data',
    installSnapshotExists: false,
    devRepoDir: null,
    devRepoExists: false,
    ...over,
  };
}

test('打包版：文档目录存在 → 读它、写它', () => {
  const r = resolveDataLocation(input({ documentsExists: true, legacyExists: true }));
  assert.equal(r.dir, 'C:\\Users\\me\\Documents\\hexbox\\data');
  assert.equal(r.writeDir, r.dir);
  assert.equal(r.source, 'documents');
  assert.equal(r.legacyRead, false, '已经迁到文档目录，不该再提示"旧位置"');
});

test('打包版：只有旧 LOCALAPPDATA → 读旧目录，但写文档目录（可迁移）', () => {
  const r = resolveDataLocation(input({ legacyExists: true }));
  assert.equal(r.dir, 'C:\\Users\\me\\AppData\\Local\\hexbox\\data');
  assert.equal(r.writeDir, 'C:\\Users\\me\\Documents\\hexbox\\data');
  assert.equal(r.source, 'legacy-localappdata');
  assert.equal(r.legacyRead, true);
});

test('打包版：只有旧安装快照 → 读快照，写文档目录', () => {
  const r = resolveDataLocation(input({ installSnapshotExists: true }));
  assert.equal(r.dir, 'C:\\Program Files\\hexbox\\resources\\data');
  assert.equal(r.writeDir, 'C:\\Users\\me\\Documents\\hexbox\\data');
  assert.equal(r.source, 'install-snapshot');
  assert.equal(r.legacyRead, true);
});

test('打包版：什么都没有 → 首次运行（none），读写都指向文档目录', () => {
  const r = resolveDataLocation(input());
  assert.equal(r.source, 'none');
  assert.equal(r.dir, 'C:\\Users\\me\\Documents\\hexbox\\data');
  assert.equal(r.writeDir, r.dir);
  assert.equal(r.legacyRead, false);
});

test('打包版：绝不把安装目录当写目标', () => {
  for (const over of [
    { installSnapshotExists: true },
    { legacyExists: true },
    { documentsExists: true },
  ] satisfies Partial<DataLocationInput>[]) {
    const r = resolveDataLocation(input(over));
    assert.doesNotMatch(r.writeDir, /Program Files/, `写目标跑到安装目录：${r.writeDir}`);
  }
});

test('显式指定：读写都听它（即使文档目录里有数据）', () => {
  const r = resolveDataLocation(
    input({ explicit: 'D:\\hexbox-data', documentsExists: true, legacyExists: true }),
  );
  assert.equal(r.dir, 'D:\\hexbox-data');
  assert.equal(r.writeDir, 'D:\\hexbox-data');
  assert.equal(r.source, 'explicit');
});

test('开发版：仓库 data/ 存在（文档无数据）→ 读仓库，但写文档目录（与打包版同一条写路径）', () => {
  const r = resolveDataLocation(
    input({
      isPackaged: false,
      devRepoDir: 'D:\\Projects\\hexbox\\data',
      devRepoExists: true,
    }),
  );
  assert.equal(r.dir, 'D:\\Projects\\hexbox\\data');
  assert.equal(r.writeDir, 'C:\\Users\\me\\Documents\\hexbox\\data');
  assert.equal(r.source, 'dev-repo');
  assert.equal(r.legacyRead, false);
});

test('开发版：文档目录已经有数据 → 优先读它（不再被仓库 data/ 遮蔽）', () => {
  const r = resolveDataLocation(
    input({
      isPackaged: false,
      devRepoDir: 'D:\\Projects\\hexbox\\data',
      devRepoExists: true,
      documentsExists: true,
    }),
  );
  assert.equal(r.dir, 'C:\\Users\\me\\Documents\\hexbox\\data');
  assert.equal(r.writeDir, r.dir);
  assert.equal(r.source, 'documents');
});

test('开发版：没有仓库数据 → 退到文档目录（与打包版同一条路）', () => {
  const r = resolveDataLocation(input({ isPackaged: false, documentsExists: true }));
  assert.equal(r.dir, 'C:\\Users\\me\\Documents\\hexbox\\data');
  assert.equal(r.writeDir, r.dir);
  assert.equal(r.source, 'documents');
});

test('开发版：显式指定优先于仓库', () => {
  const r = resolveDataLocation(
    input({
      isPackaged: false,
      explicit: 'D:\\tmp\\data',
      devRepoDir: 'D:\\Projects\\hexbox\\data',
      devRepoExists: true,
    }),
  );
  assert.equal(r.source, 'explicit');
  assert.equal(r.dir, 'D:\\tmp\\data');
});

test('每个来源都有人话标签（启动日志直接用）', () => {
  const sources = [
    'explicit',
    'documents',
    'legacy-localappdata',
    'install-snapshot',
    'dev-repo',
    'none',
  ] as const;
  for (const s of sources) {
    assert.ok(DATA_DIR_SOURCE_LABEL[s].length > 0, `${s} 缺标签`);
  }
});
