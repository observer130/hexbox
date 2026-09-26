#!/usr/bin/env node
/**
 * 截屏识别调试工具（S1.4，反馈回路的核心）
 *
 * 用途：**在选人阶段运行**，输出原图 + 检测框 + 识别出的英雄名，
 * 供人工核对定位是否准确（docs/SCREENSHOT-DEV.md §四）。
 *
 * 与上一版相比修复的三个真实问题：
 *   1. 在结算界面运行时照样检测，产出大量误检图 ——
 *      现在先查 LCU gameflow phase，非 ChampSelect 时明确拒绝；
 *   2. 窗口矩形靠「主显示器 ÷ 2」猜测 ——
 *      现在用 win-geometry（GetWindowRect，只读几何）拿真实矩形，
 *      配合截屏尺寸自校准 captureScale（不假设固定 2.0）；
 *   3. 模板运行时从 CDragon 现拉（慢、依赖网络、依赖 Chromium 解码）——
 *      现在读构建期产物 data/templates.json（pnpm templates 生成）。
 *
 * 用法（需真实桌面；读 LCU 凭证需管理员，但纯定位调试不需要）：
 *   pnpm --filter @hexbox/overlay debug:capture
 *
 * 产物（debug/ 目录）：
 *   raw.png        原始截屏
 *   annotated.png  原图 + 检测框（人工核对用）
 *   result.json    检测结果（坐标、识别、置信度、诊断信息）
 */

import { app, BrowserWindow, desktopCapturer, screen } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  base64ToBits,
  captureScale,
  decodePack,
  detectCards,
  encodePng,
  extractGray,
  extractGrayRaw,
  extractNameStrip,
  makeGeometry,
  matchChampionCareful,
  matchName,
  NAME_STRIP,
  normalizedRectToScreen,
  normalizeGray,
  prepareTemplates,
  similarity,
  type Bitmap,
  type NameFingerprint,
  type PortraitTemplate,
  type PreparedTemplate,
  type Rect,
} from '@hexbox/vision';

/**
 * 产物目录：固定在**仓库根**的 debug/（与文档、.gitignore 一致）。
 *
 * 不能用 process.cwd()：`pnpm --filter` 运行时 cwd 是 apps/overlay，
 * 产物会散落到包目录里。dist 的深度固定（apps/overlay/dist），
 * 因此从 __dirname 向上三级即仓库根；prod 模式 app.isPackaged 时退回 cwd。
 */
const OUT_DIR = app.isPackaged
  ? join(process.cwd(), 'debug')
  : join(__dirname, '..', '..', '..', 'debug');

/** 卡片内头像区域的相对位置（避开金色边框）。 */
const PORTRAIT_INSET = { x: 0.08, y: 0.06, w: 0.84, h: 0.62 };

interface DebugResult {
  captureWidth: number;
  captureHeight: number;
  /** 游戏窗口物理矩形（GetWindowRect 直出；null = 未找到窗口）。 */
  windowPhysical: { x: number; y: number; width: number; height: number } | null;
  /** 截屏 → 窗口物理像素 的缩放（estimated=true 表示没拿到窗口矩形、按 1 兜底）。 */
  captureScale: number;
  captureScaleEstimated: boolean;
  confident: boolean;
  reason?: string;
  /** 等宽筛选的诊断（定位失败时区分「无线」与「被筛掉」）。 */
  lines: number[];
  cards: Array<{
    rect: Rect;
    screenRect: Rect;
    championId: number | null;
    championName: string | null;
    score: number;
    /** 相似度前 3 候选（诊断用；识别阈值极严，正式认定见 championId）*/
    top3: Array<{ id: number; name: string; score: number }>;
  }>;
}

/* ------------------------------------------------------------------ */
/* LCU 阶段检查（防呆：只在选人阶段检测才有意义）                        */
/* ------------------------------------------------------------------ */

async function currentPhase(): Promise<string | null> {
  try {
    const { detectCredentialsDetailed, LcuClient } = await import('@hexbox/lcu');
    const creds = await detectCredentialsDetailed();
    if (!creds?.credentials) return null; // 无凭证 → 不拦截（纯定位调试也允许）
    const client = new LcuClient(creds.credentials);
    const session = await client.getOrNull<{ phase?: string }>('/lol-gameflow/v1/session');
    return session?.phase ?? 'None';
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 截屏                                                                */
/* ------------------------------------------------------------------ */

/** 窗口枚举结果（缩略图 + 原始字节尺寸，供截屏缩放校准）。 */
interface Grabbed {
  img: Electron.NativeImage;
  /** desktopCapturer 请求的缩略图上限（原始字节尺寸）。 */
  requested: { width: number; height: number };
}

async function grabGameWindow(): Promise<Grabbed | null> {
  const display = screen.getPrimaryDisplay();
  const requested = { width: display.size.width * 2, height: display.size.height * 2 };

  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: requested,
    fetchWindowIcons: false,
  });
  // 匹配策略：精确名 "League of Legends"（游戏本体），其次包含匹配。
  // 注意 LeagueClientUx（客户端 UI）窗口名是「英雄联盟客户端」等，不会被误选。
  const lol =
    sources.find((s) => s.name === 'League of Legends') ??
    sources.find((s) => /League of Legends/i.test(s.name));
  if (!lol) {
    console.error('[debug] 当前窗口列表：' + sources.map((s) => `"${s.name}"`).join(', '));
    return null;
  }
  return { img: lol.thumbnail, requested };
}

/** NativeImage → Bitmap（RGBA）。 */
function toBitmap(img: Electron.NativeImage): Bitmap {
  const size = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  const out = new Uint8ClampedArray(size.width * size.height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = bmp[i + 2]!;
    out[i + 1] = bmp[i + 1]!;
    out[i + 2] = bmp[i]!;
    out[i + 3] = bmp[i + 3]!;
  }
  return { width: size.width, height: size.height, data: out };
}

/* ------------------------------------------------------------------ */
/* 模板（构建期产物，离线）                                             */
/* ------------------------------------------------------------------ */

async function loadTemplates(): Promise<PreparedTemplate[]> {
  // OUT_DIR = 仓库根/debug → data 在 仓库根/data
  const dataDir = join(dirname(OUT_DIR), 'data');
  const candidates = [join(dataDir, 'templates.json')];
  for (const path of candidates) {
    try {
      const encoded = await readFile(path, 'utf8');
      const pack = decodePack(encoded);
      const portraits: PortraitTemplate[] = pack.templates.map((t) => ({
        championId: t.championId,
        size: t.size,
        // 序列化存的是归一化值；先反归一化回 0..255，比较时两端
        // 都走 normalizeGray 统一管线（逆变换 + 再标准化 ≈ 恒等，
        // 序列化舍入 < 1e-4，对相关性排序无影响）
        gray: denormalize(t.norm, t.size),
      }));
      console.log(`[debug] 模板包 ${pack.count} 个 (${pack.size}×${pack.size}) ← ${path}`);
      return prepareTemplates(portraits);
    } catch {
      /* 尝试下一个候选路径 */
    }
  }
  console.warn('[debug] 读不到 data/templates.json —— 请先运行 pnpm templates（跳过识别，只做定位）');
  return [];
}

/** 名字指纹库（OCR 阶段 1 的比对库）。 */
async function loadNameLibrary(): Promise<NameFingerprint[]> {
  const path = join(dirname(OUT_DIR), 'data', 'templates.json');
  try {
    const pack = decodePack(await readFile(path, 'utf8'));
    if (!pack.names || pack.names.length === 0) {
      console.warn('[debug] 模板包无名字指纹 —— 运行 pnpm templates 重建（含 scripts/render-name-fingerprints.ps1 产物）');
      return [];
    }
    const lib = pack.names.map((n) => ({
      championId: n.championId,
      name: n.name,
      width: n.width,
      height: n.height,
      bits: base64ToBits(n.bits, n.width * n.height),
    }));
    console.log(`[debug] 名字指纹 ${lib.length} 个（OCR 主识别通道）`);
    return lib;
  } catch {
    return [];
  }
}

/** 把归一化灰度还原为 0..255 灰度（逆变换，使比较走统一管线）。 */
function denormalize(norm: readonly number[], size: number): Uint8Array {
  const n = norm.length;
  const out = new Uint8Array(size * size);
  let mean = 0;
  for (const v of norm) mean += v;
  mean /= n;
  let std = 0;
  for (const v of norm) std += (v - mean) * (v - mean);
  std = Math.sqrt(std / n);
  if (std < 1e-6) return out; // 纯色模板：识别必然拒绝，返回全 0 即可
  for (let i = 0; i < n; i++) {
    const v = (norm[i]! - mean) / std; // 再标准化一次 = 恒等（消除序列化舍入）
    out[i] = Math.max(0, Math.min(255, Math.round(128 + v * 64)));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  mkdirSync(OUT_DIR, { recursive: true });

  // 0) 阶段检查：上次在结算界面跑出一堆误检图，就是缺了这一步。
  //
  // ⚠️ 无凭证（phase = null）也必须拒绝：真机教训 —— 调试工具以
  // 非管理员运行时读不到 LCU 凭证，phase 为 null,若放行就会在
  // **游戏对局内**误检出"卡片"（对局画面结构复杂,等宽校验拦不住）。
  const phase = await currentPhase();
  console.log(`[debug] LCU phase = ${phase ?? '未知（读不到凭证）'}`);
  if (phase !== 'ChampSelect') {
    const why =
      phase === null
        ? '读不到 LCU 凭证（请以管理员身份运行，或让 LCU 客户端处于登录状态）'
        : `当前阶段是 ${phase}`;
    console.error(
      `✗ 无法确认处于选人阶段：${why}。\n` +
        `  卡片定位只对选人界面有效 —— 请进入选人阶段后再运行。\n` +
        `  （仍要强制调试其它界面：设 HEXBOX_DEBUG_FORCE=1）`,
    );
    if (process.env['HEXBOX_DEBUG_FORCE'] !== '1') {
      app.quit();
      process.exitCode = 1;
      return;
    }
  }

  // 1) 窗口矩形（只读几何）+ 截屏
  const { findGameWindowRect } = await import('@hexbox/vision');
  const windowPhysical = await findGameWindowRect();
  console.log(
    windowPhysical
      ? `[debug] 游戏窗口物理矩形 ${windowPhysical.width}x${windowPhysical.height} @ (${windowPhysical.x},${windowPhysical.y})`
      : '[debug] 未找到游戏窗口矩形（LeagueClientUx 未启动？）',
  );

  const grabbed = await grabGameWindow();
  if (!grabbed) {
    console.error(
      '✗ 未找到「League of Legends」窗口，或其处于最小化状态。\n' +
        '  - 请进入游戏（选人阶段），且**不要最小化**游戏窗口；\n' +
        '  - 无边框/全屏模式均可，最小化会导致系统截屏失败。\n',
    );
    app.quit();
    process.exitCode = 1;
    return;
  }
  const bmp = toBitmap(grabbed.img);
  console.log(`[debug] 截屏 ${bmp.width}x${bmp.height}`);

  const scale = captureScale(
    { width: bmp.width, height: bmp.height },
    windowPhysical,
  );
  console.log(
    `[debug] captureScale = ${scale.scale.toFixed(3)}${scale.estimated ? '（估算）' : ''}`,
  );

  // 2) 定位卡片
  const det = detectCards(bmp);
  console.log(`[debug] 竖线 ${det.lines.length} 条 → 卡片 ${det.cards.length} 张，置信=${det.confident}`);
  if (det.reason) console.log(`[debug] ${det.reason}`);

  // 3) 识别英雄（本地模板，离线）
  const templates = await loadTemplates();
  const nameById = new Map<number, string>();
  try {
    const dsPath = join(dirname(OUT_DIR), 'data', 'dataset.json');
    const raw = await readFile(dsPath, 'utf8');
    const ds = JSON.parse(raw) as { champions: Array<{ id: number; name: string }> };
    for (const c of ds.champions) nameById.set(c.id, c.name);
  } catch {
    /* 无名字也能出结果 */
  }

  // 屏幕逻辑坐标换算：物理 → DIP 用主显示器 scaleFactor
  const display = screen.getPrimaryDisplay();
  const geo = makeGeometry(bmp.width, bmp.height, {
    x: (windowPhysical?.x ?? display.workArea.x) / display.scaleFactor,
    y: (windowPhysical?.y ?? display.workArea.y) / display.scaleFactor,
    width: (windowPhysical?.width ?? bmp.width / scale.scale) / display.scaleFactor,
    height: (windowPhysical?.height ?? bmp.height / scale.scale) / display.scaleFactor,
  });

  const nameLibrary = await loadNameLibrary();

  const cards: DebugResult['cards'] = [];
  for (const rect of det.cards) {
    // 识别主通道（阶段 1）：卡片下部**名字区 OCR**
    // 名字带中心 ≈ 0.885 卡高（见 vision/ocr.ts NAME_STRIP）
    const stripRect: Rect = {
      x: rect.x + rect.w * (1 - NAME_STRIP.width) / 2,
      y: rect.y + rect.h * (NAME_STRIP.yCenter - NAME_STRIP.height / 2),
      w: rect.w * NAME_STRIP.width,
      h: rect.h * NAME_STRIP.height,
    };
    const stripRaw = extractGrayRaw(bmp, stripRect);
    let ocrId: number | null = null;
    let ocrName: string | null = null;
    let ocrScore = 0;
    if (stripRaw && nameLibrary.length > 0) {
      const strip = extractNameStrip(stripRaw.gray, stripRaw.width, stripRaw.height);
      const m = matchName(strip, nameLibrary, { minScore: 0.45 });
      if (m) {
        ocrId = m.championId;
        ocrName = m.name;
        ocrScore = m.score;
      }
    }

    // 识别副通道（阶段 2 预留）：头像模板（真机数据表明对渲染立绘不可靠,
    // 仅在 OCR 未命中时输出最近候选供诊断）
    const inner: Rect = {
      x: rect.x + rect.w * PORTRAIT_INSET.x,
      y: rect.y + rect.h * PORTRAIT_INSET.y,
      w: rect.w * PORTRAIT_INSET.w,
      h: rect.h * PORTRAIT_INSET.h,
    };
    const gray = extractGray(bmp, inner, 24);
    let top3: Array<{ id: number; score: number }> = [];
    if (gray && templates.length > 0) {
      const q = normalizeGray(gray);
      top3 = templates
        .map((t) => ({ id: t.championId, score: similarity(q, t.norm) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
    }

    cards.push({
      rect,
      screenRect: normalizedRectToScreen(rect, geo),
      championId: ocrId,
      championName: ocrName ?? (ocrId ? (nameById.get(ocrId) ?? null) : null),
      score: ocrScore,
      top3: top3.map((t) => ({ id: t.id, name: nameById.get(t.id) ?? `#${t.id}`, score: t.score })),
    });
  }

  const result: DebugResult = {
    captureWidth: bmp.width,
    captureHeight: bmp.height,
    windowPhysical,
    captureScale: scale.scale,
    captureScaleEstimated: scale.estimated,
    confident: det.confident,
    reason: det.reason,
    lines: det.lines,
    cards,
  };

  writeFileSync(join(OUT_DIR, 'raw.png'), grabbed.img.toPNG());
  writeFileSync(join(OUT_DIR, 'result.json'), JSON.stringify(result, null, 2));

  // 4) 标注图（PNG）—— 纯 Node 位图合成 + encodePng
  //
  // ⚠️ 已废弃的两条路（都真实踩过，勿回退）：
  //   a. nativeImage.createFromDataURL(SVG)：不支持 SVG → 1x1 空图；
  //   b. 隐藏窗口 canvas + capturePage：时序不确定（三次运行一次空图），
  //      且视口裁切需要额外缩放处理。
  // 位图合成完全确定：在 raw 的 RGBA 副本上直接写像素。
  {
    const ann = new Uint8ClampedArray(bmp.data); // 副本
    const W = bmp.width;
    const H = bmp.height;
    const drawRect = (nx: number, ny: number, nw: number, nh: number, r: number, g: number, b: number, thickness = 3): void => {
      const x0 = Math.max(0, Math.round(nx * W));
      const y0 = Math.max(0, Math.round(ny * H));
      const x1 = Math.min(W - 1, Math.round((nx + nw) * W));
      const y1 = Math.min(H - 1, Math.round((ny + nh) * H));
      const set = (x: number, y: number): void => {
        const i = (y * W + x) * 4;
        ann[i] = r;
        ann[i + 1] = g;
        ann[i + 2] = b;
        ann[i + 3] = 255;
      };
      for (let t = 0; t < thickness; t++) {
        for (let x = x0; x <= x1; x++) {
          set(x, Math.min(H - 1, y0 + t));
          set(x, Math.max(0, y1 - t));
        }
        for (let y = y0; y <= y1; y++) {
          set(Math.min(W - 1, x0 + t), y);
          set(Math.max(0, x1 - t), y);
        }
      }
    };
    for (const c of cards) {
      // 认定=绿；未认定=黄（同时画出名字带,便于核对 OCR 提取区域）
      const [r, g, b] = c.championId ? [0x4a, 0xde, 0x80] : [0xe0, 0xb6, 0x4a];
      drawRect(c.rect.x, c.rect.y, c.rect.w, c.rect.h, r, g, b);
      drawRect(
        c.rect.x + c.rect.w * (1 - NAME_STRIP.width) / 2,
        c.rect.y + c.rect.h * (NAME_STRIP.yCenter - NAME_STRIP.height / 2),
        c.rect.w * NAME_STRIP.width,
        c.rect.h * NAME_STRIP.height,
        0x6f, 0xb3, 0xd2, 2,
      );
    }
    writeFileSync(join(OUT_DIR, 'annotated.png'), encodePng({ width: W, height: H, data: ann }));
  }

  // 5) 名字带裁剪图（OCR 输入,人工核对提取区域是否精准）
  for (const [i, c] of cards.entries()) {
    const stripRect: Rect = {
      x: c.rect.x + c.rect.w * (1 - NAME_STRIP.width) / 2,
      y: c.rect.y + c.rect.h * (NAME_STRIP.yCenter - NAME_STRIP.height / 2),
      w: c.rect.w * NAME_STRIP.width,
      h: c.rect.h * NAME_STRIP.height,
    };
    const raw = extractGrayRaw(bmp, stripRect);
    if (!raw) continue;
    // 灰度 → RGBA（放大 2 倍便于查看）
    const scale2 = 2;
    const w = raw.width * scale2;
    const h = raw.height * scale2;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const g = raw.gray[Math.floor(y / scale2) * raw.width + Math.floor(x / scale2)]!;
        const d = (y * w + x) * 4;
        rgba[d] = g;
        rgba[d + 1] = g;
        rgba[d + 2] = g;
        rgba[d + 3] = 255;
      }
    }
    writeFileSync(join(OUT_DIR, `name-strip-${i + 1}.png`), encodePng({ width: w, height: h, data: rgba }));
  }

  console.log('\n已输出到 debug/：');
  console.log('  annotated.png      原图 + 检测框 + 名字带（人工核对）');
  console.log('  name-strip-N.png   每张卡的名字区裁剪（OCR 输入）');
  console.log('  raw.png            原始截屏');
  console.log('  result.json        检测结果');
  for (const [i, c] of cards.entries()) {
    const decided = c.championName ?? '未认定';
    const top = c.top3.map((t) => `${t.name}=${t.score.toFixed(3)}`).join(' > ');
    console.log(
      `  #${i + 1} ${decided}  score=${c.score.toFixed(3)}  ` +
        `归一化 x=${c.rect.x.toFixed(3)} w=${c.rect.w.toFixed(3)}`,
    );
    if (c.championId === null && top) console.log(`      候选: ${top}`);
  }

  app.quit();
});

app.on('window-all-closed', () => app.quit());
