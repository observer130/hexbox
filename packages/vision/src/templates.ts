/**
 * 英雄头像模板包：构建期生成、运行时只读
 *
 * 流程（与 docs/SCREENSHOT-DEV.md §3.3 对应）：
 *   构建期  data-cli「templates」命令从 CDragon 拉全部头像 →
 *           逐个 extractGray + normalizeGray → 序列化为 templates.json 落盘
 *   运行时  overlay/debug 工具**读本地**模板包 → 与截屏头像比对
 *
 * 为什么构建期生成：
 *   - 运行时不联网（悬浮窗「只读本地、离线可用」的产品约束）
 *   - 不再需要 Chromium 解码 PNG（此前 debug-capture 用隐藏窗口
 *     decode 图像，既慢又依赖桌面会话）
 *   - 245 个英雄一次性处理，失败可重跑，产物可提交/缓存
 *
 * 序列化格式（v1，自定义但自描述）：
 *   JSON —— 对 ~245×24×24 的规模，gzip 后约 100KB，可读性与体积兼得；
 *   base64 只用于灰度字节（JSON 无法直接存二进制）。
 */

import { gunzipSync, gzipSync } from 'node:zlib';

import { normalizeGray } from './match.ts';

/**
 * 把归一化灰度（TemplateEntry.norm）还原为 0..255 灰度。
 *
 * 逆变换 + 再标准化 ≈ 恒等（消除序列化舍入）,使比较两端
 * 都走 normalizeGray 统一管线。
 */
export function denormalizeToGray(norm: readonly number[], size: number): Uint8Array {
  const n = norm.length;
  const out = new Uint8Array(size * size);
  let mean = 0;
  for (const v of norm) mean += v;
  mean /= n;
  let std = 0;
  for (const v of norm) std += (v - mean) * (v - mean);
  std = Math.sqrt(std / n);
  if (std < 1e-6) return out; // 纯色模板：识别必然拒绝,返回全 0 即可
  for (let i = 0; i < n; i++) {
    const v = (norm[i]! - mean) / std;
    out[i] = Math.max(0, Math.min(255, Math.round(128 + v * 64)));
  }
  return out;
}

/** 模板包内的一条模板。 */
export interface TemplateEntry {
  readonly championId: number;
  readonly name: string;
  readonly alias: string;
  readonly size: number;
  /** 归一化灰度（Float32 序列化），长度 = size²。 */
  readonly norm: readonly number[];
}

/**
 * 英雄名字指纹（OCR 用）。
 *
 * `bits` 是行优先二值位串（1 = 文字像素），由系统字体
 * （Microsoft YaHei，与游戏内名字字体同款）渲染后二值化得到。
 * 序列化时按位打包成字节再 base64（`packBits`/`unpackBits`）。
 */
export interface NameEntry {
  readonly championId: number;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** base64（打包位串）。 */
  readonly bits: string;
}

export interface TemplatePack {
  readonly version: 1;
  readonly size: number;
  readonly createdAt: string;
  readonly sourceUrl: string;
  readonly count: number;
  readonly templates: readonly TemplateEntry[];
  /** 名字指纹库（OCR 阶段 1 用）。构建环境无 GDI 时缺省。 */
  readonly names?: readonly NameEntry[];
}

/** 把 0/1 位串打包成字节（末位补零）。 */
export function packBits(bits: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) bytes[i >> 3]! |= 1 << (i & 7);
  }
  return bytes;
}

/** `packBits` 的逆变换。 */
export function unpackBits(packed: Uint8Array, bitLength: number): Uint8Array {
  const bits = new Uint8Array(bitLength);
  for (let i = 0; i < bitLength; i++) {
    bits[i] = (packed[i >> 3]! >> (i & 7)) & 1;
  }
  return bits;
}

/** 位串 → base64（NameEntry 序列化用）。 */
export function bitsToBase64(bits: readonly number[]): string {
  return Buffer.from(packBits(bits)).toString('base64');
}

/** base64 → 位串（NameEntry 反序列化用）。 */
export function base64ToBits(b64: string, bitLength: number): Uint8Array {
  return unpackBits(new Uint8Array(Buffer.from(b64, 'base64')), bitLength);
}

/** 从模板灰度构建条目（归一化在此完成，落盘即终态）。 */
export function buildEntry(
  champion: { readonly id: number; readonly name: string; readonly alias: string },
  gray: Uint8Array,
  size: number,
): TemplateEntry {
  if (gray.length !== size * size) {
    throw new Error(`英雄 ${champion.id} 模板灰度长度 ${gray.length} ≠ ${size}²`);
  }
  const norm = normalizeGray(gray);
  return {
    championId: champion.id,
    name: champion.name,
    alias: champion.alias,
    size,
    norm: Array.from(norm, (v) => Math.round(v * 1e4) / 1e4),
  };
}

/** 序列化 → gzip → base64（灰度主体），外层保持可读元信息。 */
export function encodePack(pack: TemplatePack): string {
  const json = JSON.stringify({
    version: pack.version,
    size: pack.size,
    createdAt: pack.createdAt,
    sourceUrl: pack.sourceUrl,
    count: pack.count,
    templates: pack.templates,
    names: pack.names ?? [],
  });
  return gzipSync(Buffer.from(json, 'utf8')).toString('base64');
}

/** 反序列化（与 encodePack 互逆）；损坏时抛错。 */
export function decodePack(encoded: string): TemplatePack {
  let json: string;
  try {
    json = gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8');
  } catch (err) {
    throw new Error(`模板包解压失败（文件损坏？）: ${String(err)}`);
  }
  const raw = JSON.parse(json) as {
    version: number;
    size: number;
    createdAt: string;
    sourceUrl: string;
    count: number;
    templates: Array<{
      championId: number;
      name: string;
      alias: string;
      size: number;
      norm: number[];
    }>;
    names?: Array<{
      championId: number;
      name: string;
      width: number;
      height: number;
      bits: string;
    }>;
  };
  if (raw.version !== 1) throw new Error(`不支持的模板包版本 ${raw.version}`);
  if (!Array.isArray(raw.templates)) throw new Error('模板包缺少 templates 数组');
  const expected = raw.size * raw.size;
  for (const t of raw.templates) {
    if (t.size !== raw.size) throw new Error(`模板 ${t.championId} 尺寸与包声明不一致`);
    if (t.norm.length !== expected) {
      throw new Error(`模板 ${t.championId} 灰度长度 ${t.norm.length} ≠ ${expected}`);
    }
  }
  const out: TemplatePack & { names?: readonly NameEntry[] } = {
    version: 1,
    size: raw.size,
    createdAt: raw.createdAt,
    sourceUrl: raw.sourceUrl,
    count: raw.count,
    templates: raw.templates,
  };
  if (Array.isArray(raw.names)) {
    out.names = raw.names;
  }
  return out;
}
