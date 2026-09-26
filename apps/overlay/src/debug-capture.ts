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
import { join } from 'node:path';

import {
  captureScale,
  decodePack,
  detectCards,
  extractGray,
  makeGeometry,
  matchChampionCareful,
  normalizedRectToScreen,
  prepareTemplates,
  type Bitmap,
  type PortraitTemplate,
  type PreparedTemplate,
  type Rect,
} from '@hexbox/vision';

const OUT_DIR = join(process.cwd(), 'debug');

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

async function grabGameWindow(): Promise<{
  img: Electron.NativeImage;
} | null> {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;

  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: width * 2, height: height * 2 },
  });
  const lol = sources.find((s) => /League of Legends/i.test(s.name));
  if (!lol) return null;
  return { img: lol.thumbnail };
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
  const candidates = [
    join(process.cwd(), 'data', 'templates.json'),
    join(process.cwd(), '..', '..', 'data', 'templates.json'),
  ];
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
/* 标注图                                                              */
/* ------------------------------------------------------------------ */

function buildAnnotationSvg(
  dataUrl: string,
  cssW: number,
  cssH: number,
  cards: DebugResult['cards'],
  note: string,
): string {
  const boxes = cards
    .map((c, i) => {
      const x = c.rect.x * cssW;
      const y = c.rect.y * cssH;
      const w = c.rect.w * cssW;
      const h = c.rect.h * cssH;
      const label = c.championName ?? (c.championId ? `#${c.championId}` : '未识别');
      const color = c.championId ? '#4ade80' : '#e0b64a';
      return `
        <rect x="${x}" y="${y}" width="${w}" height="${h}"
              fill="none" stroke="${color}" stroke-width="3" />
        <rect x="${x}" y="${y + h}" width="${Math.min(w, 240)}" height="28"
              fill="rgba(0,0,0,0.75)" />
        <text x="${x + 6}" y="${y + h + 20}" fill="${color}"
              font-family="Microsoft YaHei, sans-serif" font-size="17">
          ${i + 1}. ${label} ${c.score > 0 ? c.score.toFixed(3) : ''}
        </text>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${cssW}" height="${cssH}"
     viewBox="0 0 ${cssW} ${cssH}">
    <image href="${dataUrl}" x="0" y="0" width="${cssW}" height="${cssH}" />
    ${boxes}
    <rect x="0" y="${cssH - 34}" width="${Math.max(cssW, note.length * 9)}" height="34" fill="rgba(0,0,0,0.8)" />
    <text x="10" y="${cssH - 12}" fill="#ffd" font-family="Microsoft YaHei, monospace" font-size="16">${note}</text>
  </svg>`;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  mkdirSync(OUT_DIR, { recursive: true });

  // 0) 阶段检查：上次在结算界面跑出一堆误检图，就是缺了这一步
  const phase = await currentPhase();
  console.log(`[debug] LCU phase = ${phase ?? '未知（无凭证，跳过检查）'}`);
  if (phase && phase !== 'ChampSelect') {
    console.error(
      `✗ 当前阶段是 ${phase}，不是 ChampSelect。\n` +
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
    console.error('✗ 未找到「League of Legends」窗口 —— 请先进入游戏（选人阶段）再运行。');
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
    const dsPath = join(process.cwd(), '..', '..', 'data', 'dataset.json');
    const altPath = join(process.cwd(), 'data', 'dataset.json');
    const raw = await readFile(altPath, 'utf8').catch(() => readFile(dsPath, 'utf8'));
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

  const cards: DebugResult['cards'] = [];
  for (const rect of det.cards) {
    const inner: Rect = {
      x: rect.x + rect.w * PORTRAIT_INSET.x,
      y: rect.y + rect.h * PORTRAIT_INSET.y,
      w: rect.w * PORTRAIT_INSET.w,
      h: rect.h * PORTRAIT_INSET.h,
    };
    const gray = extractGray(bmp, inner, templates[0]?.norm.length ? Math.sqrt(templates[0]!.norm.length) : 24);
    const m = gray && templates.length > 0 ? matchChampionCareful(gray, templates) : null;
    cards.push({
      rect,
      screenRect: normalizedRectToScreen(rect, geo),
      championId: m?.championId ?? null,
      championName: m ? (nameById.get(m.championId) ?? null) : null,
      score: m?.score ?? 0,
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

  // 4) 标注图（PNG，便于直接查看）
  const cssW = bmp.width;
  const cssH = bmp.height;
  const note = `phase=${phase ?? '?'}  lines=${det.lines.length}  cards=${det.cards.length}  scale=${scale.scale.toFixed(2)}`;
  const svg = buildAnnotationSvg(grabbed.img.toDataURL(), cssW, cssH, cards, note);
  const render = new BrowserWindow({ show: false, width: 1280, height: 720 });
  try {
    await render.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<html><body style="margin:0"><script>document.body.innerHTML = ${JSON.stringify(
            `<img style="width:100vw" src="${'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')}">`,
          )};</` + `script></body></html>`,
        ),
    );
    await render.webContents.executeJavaScript('void 0');
    // 直接用 NativeImage 从 dataURL 解码，避免依赖窗口尺寸
    const { nativeImage } = await import('electron');
    const image = nativeImage.createFromDataURL(
      'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'),
    );
    writeFileSync(join(OUT_DIR, 'annotated.png'), image.toPNG());
  } catch (e) {
    console.warn('[debug] 标注图渲染失败（result.json / raw.png 仍可用）:', e instanceof Error ? e.message : e);
  } finally {
    render.destroy();
  }

  console.log('\n已输出到 debug/：');
  console.log('  annotated.png  原图 + 检测框（请人工核对）');
  console.log('  raw.png        原始截屏');
  console.log('  result.json    检测结果');
  for (const [i, c] of cards.entries()) {
    console.log(
      `  #${i + 1} ${c.championName ?? '未识别'}  score=${c.score.toFixed(3)}  ` +
        `归一化 x=${c.rect.x.toFixed(3)} w=${c.rect.w.toFixed(3)}  ` +
        `屏幕 (${c.screenRect.x.toFixed(0)},${c.screenRect.y.toFixed(0)})`,
    );
  }

  app.quit();
});

app.on('window-all-closed', () => app.quit());
