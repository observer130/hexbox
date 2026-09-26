/**
 * data-cli 测试
 *
 * 重点覆盖 `mergeDatasets` —— 多源合并是本模块唯一的纯逻辑，
 * 也是隐性风险点：当前策略是「后者只补前者没有的部分」，且只处理 hextechs。
 *
 * 注：cli.ts 已加入入口保护（isDirectRun），import 本模块不会执行 CLI。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';

import type { Dataset, HextechStatic } from '@hexbox/core';

import { fetchTemplates, mergeDatasets } from './cli.ts';

function hex(id: number, name: string): HextechStatic {
  return {
    id,
    augmentNameId: `ARAM_${name}`,
    name,
    tooltip: '',
    rarity: 'kSilver',
    modes: ['KIWI'],
    largeIcon: '',
    smallIcon: '',
    isNew: false,
  };
}

function ds(source: string, opts: Partial<Dataset> = {}): Dataset {
  return {
    meta: { source, patch: null, fetchedAt: '2026-09-26T00:00:00.000Z' },
    augments: [],
    champions: [],
    items: [],
    hextechs: [],
    ...opts,
  };
}

test('mergeDatasets：单源时原样返回', () => {
  const only = ds('a', { hextechs: [hex(1, 'X')] });
  const merged = mergeDatasets([only]);
  assert.equal(merged.meta.source, 'a');
  assert.equal(merged.hextechs.length, 1);
});

test('mergeDatasets：以第一个源为基准（meta/英雄/装备取自它）', () => {
  const primary = ds('cdragon', {
    champions: [{ id: 1, name: '安妮', alias: 'Annie', roles: [], iconPath: '' }],
    items: [{ id: 1001, name: '长剑', description: '', price: 0, priceTotal: 0, iconPath: '', categories: [] }],
  });
  const secondary = ds('tencent', { hextechs: [hex(1001, '泰坦')] });

  const merged = mergeDatasets([primary, secondary]);
  assert.equal(merged.meta.source, 'cdragon'); // 基准源的 meta 保留
  assert.equal(merged.champions.length, 1);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.hextechs.length, 1); // 由次源补上
});

test('mergeDatasets：基准源已有 hextechs 时不覆盖', () => {
  const primary = ds('cdragon', { hextechs: [hex(1, '原有')] });
  const secondary = ds('tencent', { hextechs: [hex(2, '外来')] });

  const merged = mergeDatasets([primary, secondary]);
  assert.equal(merged.hextechs.length, 1);
  assert.equal(merged.hextechs[0]!.name, '原有'); // 保持基准源
});

test('mergeDatasets：多个次源按顺序补齐（首个非空者胜出）', () => {
  const primary = ds('cdragon');
  const first = ds('source-a', { hextechs: [hex(1, 'A')] });
  const second = ds('source-b', { hextechs: [hex(2, 'B')] });

  const merged = mergeDatasets([primary, first, second]);
  assert.equal(merged.hextechs.length, 1);
  assert.equal(merged.hextechs[0]!.name, 'A');
});

test('mergeDatasets：不修改输入对象（无副作用）', () => {
  const primary = ds('cdragon');
  const secondary = ds('tencent', { hextechs: [hex(1, 'X')] });

  mergeDatasets([primary, secondary]);

  // 合并结果应写入新对象，原 primary 不应被就地改写
  assert.equal(primary.hextechs.length, 0);
});

test('mergeDatasets：空数组抛错（避免写出空数据集）', () => {
  assert.throws(() => mergeDatasets([]), /没有可合并的数据集/);
});

/**
 * 记录当前合并策略的**已知边界**：只合并 hextechs。
 *
 * 这不是在认可该行为，而是把它钉成显式契约 —— 将来若新增
 * 第二个需要合并的字段（如 augments 增量），这个测试会失败，
 * 提醒开发者同步扩展 mergeDatasets，而不是静默丢数据。
 */
test('mergeDatasets：当前只合并 hextechs（已知边界，改动需显式扩展）', () => {
  const primary = ds('cdragon');
  const secondary = ds('tencent', {
    augments: [
      {
        id: 9,
        augmentNameId: 'ARAM_Extra',
        name: '额外',
        simpleName: '',
        iconPath: '',
        rarity: 'kGold',
        modes: ['KIWI'],
      },
    ],
  });

  const merged = mergeDatasets([primary, secondary]);
  // 次源的 augments 目前**不会**被合并进来
  assert.equal(merged.augments.length, 0);
  assert.equal(merged.hextechs.length, 0);
});

/* ------------------------------------------------------------------ */
/* fetchTemplates：构建期模板包生成                                     */
/* ------------------------------------------------------------------ */

/** 测试用手工 PNG 编码：8bit RGBA、滤波 0（与 vision/png.test.ts 同法）。 */
function tinyPng(pixels: readonly [number, number, number, number][]): Uint8Array {
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf: Uint8Array): number => {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    new DataView(out.buffer).setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };

  const n = pixels.length;
  const side = Math.round(Math.sqrt(n));
  const stride = side * 4;
  const raw = new Uint8Array((stride + 1) * side);
  for (let i = 0; i < n; i++) {
    const [r, g, b, a] = pixels[i]!;
    const o = i * 4;
    raw[Math.floor(o / stride) * (stride + 1) + 1 + (o % stride)] = r;
    raw[Math.floor((o + 1) / stride) * (stride + 1) + 1 + ((o + 1) % stride)] = g;
    raw[Math.floor((o + 2) / stride) * (stride + 1) + 1 + ((o + 2) % stride)] = b;
    raw[Math.floor((o + 3) / stride) * (stride + 1) + 1 + ((o + 3) % stride)] = a;
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, side);
  dv.setUint32(4, side);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

test('fetchTemplates：拉取→构建→编码全链路（本地 HTTP 服务）', async () => {
  const png = tinyPng([[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255]]);
  const { createServer } = await import('node:http');

  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(Buffer.from(png));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const champions = [
      { id: 1, name: '黑暗之女', alias: 'Annie', iconPath: '/x.png' },
      { id: 2, name: '狂战士', alias: 'Olaf', iconPath: '/y.png' },
    ];
    const pack = await fetchTemplates(champions, {
      baseUrl: `http://127.0.0.1:${port}`,
      size: 4,
    });
    assert.equal(pack.version, 1);
    assert.equal(pack.size, 4);
    assert.equal(pack.count, 2);
    assert.deepEqual(
      pack.templates.map((t) => t.championId),
      [1, 2],
      '应按 championId 升序',
    );
    assert.equal(pack.templates[0]!.name, '黑暗之女');
    assert.equal(pack.templates[0]!.norm.length, 16);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('fetchTemplates：单个头像失败只跳过该英雄', async () => {
  const png = tinyPng([[1, 2, 3, 255]]);
  const { createServer } = await import('node:http');

  const server = createServer((req, res) => {
    // 模板构建按英雄 ID 请求：/rcp-be-lol-game-data/global/default/v1/champion-icons/<id>.png
    if (req.url?.includes('/2.png')) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(Buffer.from(png));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const pack = await fetchTemplates(
      [
        { id: 1, name: 'A', alias: 'A', iconPath: '' },
        { id: 2, name: 'B', alias: 'B', iconPath: '' },
      ],
      { baseUrl: `http://127.0.0.1:${port}`, size: 2 },
    );
    assert.equal(pack.count, 1);
    assert.equal(pack.templates[0]!.championId, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('fetchTemplates：全部失败时抛错（不产出空包）', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    await assert.rejects(
      () =>
        fetchTemplates([{ id: 1, name: 'A', alias: 'A', iconPath: '/x.png' }], {
          baseUrl: `http://127.0.0.1:${port}`,
        }),
      /全部.*失败/,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
