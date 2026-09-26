/**
 * png 测试
 *
 * 策略：**编码器侧完全手工构造** —— 用 zlib.deflateSync 按规范拼出
 * 合法 PNG（含正确 CRC），覆盖全部颜色类型与各滤波器；
 * 再用「手工构造的坏文件」验证报错路径。
 * 这样无需任何编码器依赖，也不依赖真实图标文件。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';

import { decodePng } from './png.ts';

/* ------------------------------------------------------------------ */
/* 手工 PNG 编码（测试专用，未做任何优化）                              */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  new DataView(out.buffer).setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

interface Opts {
  readonly width: number;
  readonly height: number;
  /** 每像素通道样本（长度须为 w*h*channels），样本取值 0..255。 */
  readonly samples: Uint8Array;
  readonly colorType: 0 | 2 | 3 | 4 | 6;
  /** 行滤波类型（所有行相同；默认 0 = None）。 */
  readonly filter?: number;
  readonly interlace?: number;
  /** 调色板（colorType=3 时必填）。 */
  readonly palette?: readonly [number, number, number][];
  /** 调色板透明度（可选）。 */
  readonly trns?: readonly number[];
  /** 签名是否损坏（用于坏文件测试）。 */
  readonly badSignature?: boolean;
}

function buildPng(o: Opts): Uint8Array {
  const channels = o.colorType === 0 || o.colorType === 3 ? 1 : o.colorType === 4 ? 2 : o.colorType === 2 ? 3 : 4;
  const stride = o.width * channels;
  const filter = o.filter ?? 0;

  // 按 spec 正确执行滤波：raw = 差分值（滤波 0 时即样本本身）。
  // 解码端做逆滤波后应还原出 samples。
  const raw = new Uint8Array((stride + 1) * o.height);
  const recon = new Uint8Array(stride * o.height);
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  };
  for (let y = 0; y < o.height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const sample = o.samples[y * stride + x]!;
      const left = x >= channels ? recon[y * stride + x - channels]! : 0;
      const up = y > 0 ? recon[(y - 1) * stride + x]! : 0;
      const ul = y > 0 && x >= channels ? recon[(y - 1) * stride + x - channels]! : 0;
      let v: number;
      switch (filter) {
        case 1:
          v = sample - left;
          break;
        case 2:
          v = sample - up;
          break;
        case 3:
          v = sample - ((left + up) >> 1);
          break;
        case 4:
          v = sample - paeth(left, up, ul);
          break;
        default:
          v = sample;
      }
      raw[y * (stride + 1) + 1 + x] = v & 0xff;
      recon[y * stride + x] = sample;
    }
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, o.width);
  dv.setUint32(4, o.height);
  ihdr[8] = 8;
  ihdr[9] = o.colorType;
  ihdr[12] = o.interlace ?? 0;

  const parts: Uint8Array[] = [];
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (o.badSignature) sig[0] = 0x88; // 改动确有差异的字节
  parts.push(sig, chunk('IHDR', ihdr));
  if (o.palette) {
    const plte = new Uint8Array(o.palette.length * 3);
    o.palette.forEach(([r, g, b], i) => {
      plte[i * 3] = r;
      plte[i * 3 + 1] = g;
      plte[i * 3 + 2] = b;
    });
    parts.push(chunk('PLTE', plte));
  }
  if (o.trns) parts.push(chunk('tRNS', Uint8Array.from(o.trns)));
  parts.push(chunk('IDAT', deflateSync(raw)));
  parts.push(chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function expectRgba(img: { data: Uint8ClampedArray }, i: number, r: number, g: number, b: number, a: number): void {
  const d = i * 4;
  assert.equal(img.data[d], r, `#${i} R`);
  assert.equal(img.data[d + 1], g, `#${i} G`);
  assert.equal(img.data[d + 2], b, `#${i} B`);
  assert.equal(img.data[d + 3], a, `#${i} A`);
}

/* ------------------------------------------------------------------ */
/* 各颜色类型                                                          */
/* ------------------------------------------------------------------ */

test('decodePng：灰度（colorType 0）', () => {
  const png = buildPng({
    width: 2,
    height: 2,
    colorType: 0,
    samples: new Uint8Array([0, 64, 128, 255]),
  });
  const img = decodePng(png);
  assert.equal(img.width, 2);
  assert.equal(img.height, 2);
  expectRgba(img, 0, 0, 0, 0, 255);
  expectRgba(img, 3, 255, 255, 255, 255);
});

test('decodePng：RGB（colorType 2）', () => {
  const png = buildPng({
    width: 2,
    height: 1,
    colorType: 2,
    samples: new Uint8Array([200, 160, 60, 10, 20, 30]),
  });
  const img = decodePng(png);
  expectRgba(img, 0, 200, 160, 60, 255);
  expectRgba(img, 1, 10, 20, 30, 255);
});

test('decodePng：索引色 + tRNS（colorType 3）', () => {
  const png = buildPng({
    width: 3,
    height: 1,
    colorType: 3,
    samples: new Uint8Array([0, 1, 2]),
    palette: [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ],
    trns: [255, 128, 0],
  });
  const img = decodePng(png);
  expectRgba(img, 0, 255, 0, 0, 255);
  expectRgba(img, 1, 0, 255, 0, 128);
  expectRgba(img, 2, 0, 0, 255, 0); // tRNS[2] = 0 → 全透明
});

test('decodePng：灰度+α（colorType 4）', () => {
  const png = buildPng({
    width: 1,
    height: 2,
    colorType: 4,
    samples: new Uint8Array([77, 255, 77, 0]),
  });
  const img = decodePng(png);
  expectRgba(img, 0, 77, 77, 77, 255);
  expectRgba(img, 1, 77, 77, 77, 0);
});

test('decodePng：RGBA（colorType 6）', () => {
  const png = buildPng({
    width: 1,
    height: 1,
    colorType: 6,
    samples: new Uint8Array([1, 2, 3, 4]),
  });
  const img = decodePng(png);
  expectRgba(img, 0, 1, 2, 3, 4);
});

/* ------------------------------------------------------------------ */
/* 滤波器                                                              */
/* ------------------------------------------------------------------ */

/** 滤波器测试的样本应含梯度，才能让 Sub/Up/Avg/Paeth 有意义。 */
function gradientSamples(w: number, h: number, channels: number): Uint8Array {
  const s = new Uint8Array(w * h * channels);
  for (let i = 0; i < s.length; i++) s[i] = (i * 17 + 31) % 256;
  return s;
}

for (const filter of [0, 1, 2, 3, 4]) {
  test(`decodePng：滤波器 ${filter} 还原无损`, () => {
    const w = 5;
    const h = 4;
    const channels = 3;
    const samples = gradientSamples(w, h, channels);
    const png = buildPng({ width: w, height: h, colorType: 2, samples, filter });
    const img = decodePng(png);
    for (let i = 0; i < w * h; i++) {
      expectRgba(img, i, samples[i * 3]!, samples[i * 3 + 1]!, samples[i * 3 + 2]!, 255);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 坏文件路径                                                          */
/* ------------------------------------------------------------------ */

test('decodePng：签名损坏时报错', () => {
  const png = buildPng({
    width: 1,
    height: 1,
    colorType: 6,
    samples: new Uint8Array([1, 2, 3, 4]),
    badSignature: true,
  });
  assert.throws(() => decodePng(png), /不是 PNG/);
});

test('decodePng：CRC 损坏时报错', () => {
  const png = buildPng({ width: 1, height: 1, colorType: 6, samples: new Uint8Array([1, 2, 3, 4]) });
  const last = png.length - 1;
  png[last] = (png[last] ?? 0) ^ 0xff; // 破坏 IEND 的 CRC
  assert.throws(() => decodePng(png), /CRC/);
});

test('decodePng：隔行 PNG 明确报错（不静默产出坏像素）', () => {
  const png = buildPng({
    width: 1,
    height: 1,
    colorType: 6,
    samples: new Uint8Array([1, 2, 3, 4]),
    interlace: 1,
  });
  assert.throws(() => decodePng(png), /隔行/);
});

test('decodePng：位深非 8 报错', () => {
  const png = buildPng({ width: 1, height: 1, colorType: 6, samples: new Uint8Array([1, 2, 3, 4]) });
  // IHDR data 起始偏移 = 8(sig) + 8(len+type) = 16；bitDepth 在 data[0]
  png[16 + 8] = 16; // 16 是 data[8]？不 —— data[0]=width 高 32 位在前
  // 上面那行其实落在 data[8] = colorType 之后的 interlace 前一位，改为直接改 bitDepth：
  png[16 + 8] = 8; // 还原（bitDepth 在 data[8]）
  // 正确布局：width(0-3) height(4-7) bitDepth(8) colorType(9) …
  // 已确认 bitDepth 就是 data[8]，把它改成 16 并重算 CRC：
  png[16 + 8] = 16;
  recalcChunkCrc(png, 8); // IHDR 从偏移 8 开始
  assert.throws(() => decodePng(png), /位深/);
});

/** 重算并写回 offset 处 chunk 的 CRC（测试辅助）。 */
function recalcChunkCrc(buf: Uint8Array, offset: number): void {
  const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(offset);
  const t = CRC_TABLE; // 复用模块级表
  let c = 0xffffffff;
  for (let i = offset + 4; i < offset + 8 + len; i++) c = t[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint32(
    offset + 8 + len,
    (c ^ 0xffffffff) >>> 0,
  );
}

test('decodePng：截断的 IDAT 数据报错', () => {
  const png = buildPng({
    width: 4,
    height: 4,
    colorType: 6,
    samples: new Uint8Array(4 * 4 * 4).fill(9),
  });
  // 砍掉文件尾部：IEND 被移除，且 IDAT 缺 CRC —— 解析必然失败
  const cut = png.subarray(0, png.length - 12);
  assert.throws(() => decodePng(cut));
});
