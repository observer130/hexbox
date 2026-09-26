/**
 * 最小 PNG 解码器（零依赖）
 *
 * 为什么自己写而不用图像库：本项目刻意保持**零外部运行时依赖**
 * （见 match.ts 头注），而模板构建（`pnpm templates`）只需要
 * 「PNG → RGBA 像素」这一步。这里支持 PNG 规范中实际会遇到的组合：
 *
 *   - 位深 8，颜色类型 0（灰度）/ 2（RGB）/ 3（索引）/ 4（灰度+α）/ 6（RGBA）
 *   - Interlace 一律不支持（CDragon 图标均不隔行；遇到即报错，
 *     静默产出错误像素比报错更糟）
 *   - 解压用 Node 内置 zlib（inflate），PNG 的 zlib 流即原始 deflate
 *
 * 输出统一为 RGBA（每像素 4 字节），与 `Bitmap` 的约定一致。
 */

import { deflateSync, inflateSync } from 'node:zlib';

/** PNG 文件签名（8 字节）。 */
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** CRC32 查表（PNG chunk 校验用）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface PngImage {
  readonly width: number;
  readonly height: number;
  /** RGBA，长度 = width * height * 4。 */
  readonly data: Uint8ClampedArray;
}

interface Chunk {
  readonly type: string;
  readonly start: number; // data 起始（不含 type/length）
  readonly end: number; // data 结束
}

/** 组装一个 PNG chunk（length + type + data + crc）。 */
function writeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  // crc32 的签名是 (buf, start, end)：此处对整块 out 按 [4, 8+len) 计算
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/**
 * PNG 编码（RGBA 位图 → 8bit RGB PNG，行滤波 0）。
 *
 * 用途：标注图合成（debug-capture 把检测框画到位图副本上再落盘）。
 * 此前用隐藏窗口 canvas 渲染 + capturePage —— 时序不确定
 * （同一代码三次运行一次产出空图），纯 Node 合成完全确定。
 *
 * alpha 通道被忽略（输出不透明）；与 `decodePng` 互逆，有往返测试锁定。
 */
export function encodePng(img: {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}): Uint8Array {
  const { width, height } = img;
  if (width <= 0 || height <= 0) throw new Error(`图像尺寸非法 ${width}x${height}`);

  // 像素 → 行滤波 0 的 RGB 扫描线
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter = None
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 4;
      const di = y * (stride + 1) + 1 + x * 3;
      raw[di] = img.data[si]!;
      raw[di + 1] = img.data[si + 1]!;
      raw[di + 2] = img.data[si + 2]!;
    }
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB

  const parts = [
    new Uint8Array(SIGNATURE),
    writeChunk('IHDR', ihdr),
    writeChunk('IDAT', deflateSync(raw, { level: 6 })),
    writeChunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function readChunks(buf: Uint8Array): Chunk[] {
  const chunks: Chunk[] = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const len = dv.getUint32(off);
    const type = String.fromCharCode(
      buf[off + 4]!,
      buf[off + 5]!,
      buf[off + 6]!,
      buf[off + 7]!,
    );
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) throw new Error(`PNG chunk ${type} 越界`);
    const expect = dv.getUint32(dataEnd);
    // CRC 覆盖 chunk 的 type + data（不含 CRC 自身）
    const actual = crc32(buf, off + 4, dataEnd);
    if (expect !== actual) throw new Error(`PNG chunk ${type} CRC 校验失败`);
    chunks.push({ type, start: dataStart, end: dataEnd });
    off = dataEnd + 4; // 跳过 CRC
    if (type === 'IEND') break;
  }
  return chunks;
}

/** 8 位精度下的每像素字节数（内部先统一转成 8bit 样本数组）。 */
function channelsOf(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1; // 灰度
    case 2:
      return 3; // RGB
    case 3:
      return 1; // 索引
    case 4:
      return 2; // 灰度+α
    case 6:
      return 4; // RGBA
    default:
      throw new Error(`不支持的颜色类型 ${colorType}`);
  }
}

/** PAETH 预测器。 */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 解码 PNG → RGBA 位图。
 *
 * @throws 不是 PNG、含不支持的特性（隔行/位深）或数据损坏时抛错。
 *         调用方（模板构建）应让它失败而不是静默跳过 —— 坏图标不如不建模板。
 */
export function decodePng(buf: Uint8Array): PngImage {
  if (buf.length < 8 || SIGNATURE.some((b, i) => buf[i] !== b)) {
    throw new Error('不是 PNG 文件（签名不符）');
  }

  const chunks = readChunks(buf);
  // 文件完整性：缺 IEND 意味着下载/传输被截断 —— 必须报错而不是
  // 拿半截数据建模板（宁可失败，不可产出坏像素）。
  if (!chunks.some((c) => c.type === 'IEND')) throw new Error('PNG 被截断（缺少 IEND）');
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('PNG 缺少 IHDR');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = dv.getUint32(ihdr.start);
  const height = dv.getUint32(ihdr.start + 4);
  const bitDepth = buf[ihdr.start + 8]!;
  const colorType = buf[ihdr.start + 9]!;
  const interlace = buf[ihdr.start + 12]!;
  if (width <= 0 || height <= 0) throw new Error(`PNG 尺寸非法 ${width}x${height}`);
  if (bitDepth !== 8) throw new Error(`不支持的位深 ${bitDepth}（仅支持 8）`);
  if (interlace !== 0) throw new Error('不支持隔行 PNG（Adam7）');
  const channels = channelsOf(colorType);

  const idat = chunks
    .filter((c) => c.type === 'IDAT')
    .map((c) => buf.subarray(c.start, c.end));
  if (idat.length === 0) throw new Error('PNG 缺少 IDAT');
  const total = idat.reduce((n, c) => n + c.length, 0);
  const compressed = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    compressed.set(c, o);
    o += c.length;
  }
  const raw = inflateSync(compressed);

  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (raw.length < expected) {
    throw new Error(`PNG 像素数据不足：需要 ${expected} 字节，实际 ${raw.length}`);
  }

  // 反滤波 → 每像素 channels 个 8bit 样本
  const img = new Uint8Array(stride * height);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const rowStart = y * (stride + 1) + 1;
    const row = img.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const rawV = raw[rowStart + x]!;
      const left = x >= channels ? row[x - channels]! : 0;
      const up = prev[x]!;
      const ul = x >= channels ? prev[x - channels]! : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = rawV;
          break;
        case 1:
          v = rawV + left;
          break;
        case 2:
          v = rawV + up;
          break;
        case 3:
          v = rawV + ((left + up) >> 1);
          break;
        case 4:
          v = rawV + paeth(left, up, ul);
          break;
        default:
          throw new Error(`未知的行滤波类型 ${filter}`);
      }
      row[x] = v & 0xff;
    }
    prev.set(row);
  }

  // 统一转 RGBA
  const out = new Uint8ClampedArray(width * height * 4);
  const palette = (() => {
    const plte = chunks.find((c) => c.type === 'PLTE');
    if (!plte) return null;
    return {
      rgb: buf.subarray(plte.start, plte.end),
      trns: (() => {
        const t = chunks.find((c) => c.type === 'tRNS');
        return t ? buf.subarray(t.start, t.end) : null;
      })(),
    };
  })();

  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    switch (colorType) {
      case 0: {
        const g = img[s]!;
        out[d] = out[d + 1] = out[d + 2] = g;
        out[d + 3] = 255;
        break;
      }
      case 2:
        out[d] = img[s]!;
        out[d + 1] = img[s + 1]!;
        out[d + 2] = img[s + 2]!;
        out[d + 3] = 255;
        break;
      case 3: {
        const idx = img[s]!;
        const p = palette;
        if (!p || idx * 3 + 2 >= p.rgb.length) {
          throw new Error(`调色板索引越界 ${idx}`);
        }
        out[d] = p.rgb[idx * 3]!;
        out[d + 1] = p.rgb[idx * 3 + 1]!;
        out[d + 2] = p.rgb[idx * 3 + 2]!;
        out[d + 3] = p.trns && idx < p.trns.length ? p.trns[idx]! : 255;
        break;
      }
      case 4: {
        const g = img[s]!;
        out[d] = out[d + 1] = out[d + 2] = g;
        out[d + 3] = img[s + 1]!;
        break;
      }
      case 6:
        out[d] = img[s]!;
        out[d + 1] = img[s + 1]!;
        out[d + 2] = img[s + 2]!;
        out[d + 3] = img[s + 3]!;
        break;
    }
  }

  return { width, height, data: out };
}
