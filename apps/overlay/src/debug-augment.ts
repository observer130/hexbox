#!/usr/bin/env node
/**
 * 局内海克斯面板**录制/验证**工具（S5.1）
 *
 * 用途：在**一局真实对局里**跑它，把"面板在/不在"的判断依据、识别结果与
 * 强度标签录下来，供离线复核 `vision/augment-panel.ts` 的判据与阈值。
 *
 * 为什么需要它：局内面板出现的**时刻无法预测**（回合节奏不固定、可重随、
 * 可关了再开），接口也拿不到（2999 端口的 Live Client Data API 不含 augment
 * 字段，见 docs/AUGMENT-PANEL.md §一）。所以门控只能靠屏幕像素。
 *
 * ⚠️ **S5.4d 起，局内链路本身不在这里**：触发状态机、采样节奏、识别、强度表、
 * 标签与行基准锁、单卡刷新编排全都在 `main/augment-controller.ts`
 * ——**常驻覆盖层（`pnpm dev:overlay`）跑的是同一份**。本文件只保留
 * **录制专属**的三件事：
 *   1. **产物**：timeline.csv / open-*.png / report.json / checkpoint.json /
 *      api-trigger.csv / bench.json（`debug/augment/`）；
 *   2. **诊断**：边沿取证（一次性截屏，默认关）、状态行、耗时统计；
 *   3. **生命周期**：阶段等待、固定时长/跟随整局、Ctrl+C 哨兵、
 *      一次性截屏兜底路径（对照/兜底）、覆盖窗自测、节流自测。
 * 这条链路的任何逻辑改动都请改控制器，**不要**在这里再写一份。
 *
 * 两条截屏路径（`HEXBOX_AUGMENT_CAPTURE`）：
 *   · `stream`（默认）—— 常驻截屏流：`getDisplayMedia` 建一次流，之后逐帧取图。
 *     真机基准实测一次性截屏**每次固定 0.5~1.0s**（window@16px 仍要 707ms！
 *     见 bench.json），连续跑会把帧率吃掉，所以正式路径是流。
 *   · `oneshot` —— 对照/兜底路径：每轮 `desktopCapturer.getSources` 截一次。
 *     慢但简单，出问题时用来判断"是不是锅在流"。它把读数喂给同一个控制器
 *     （`controller.pushExternalReading()`），所以边沿/清空语义与流路径一致。
 *
 * 产出（debug/augment/）：timeline.csv / open-*.png /
 * close-N.png / closed-sample-N.png / report.json（基准模式另写 bench.json）
 *
 * 用法（需管理员 + 真实桌面；在一局对局中运行）：
 *   pnpm --filter @hexbox/overlay debug:augment
 *
 * 截屏基准（约 30 秒，决定截屏路径）：
 *   $env:HEXBOX_AUGMENT_BENCH='1'; pnpm --filter @hexbox/overlay debug:augment
 *
 * 可调（环境变量；**链路**的旋钮在 main/augment-controller.ts，这里只列录制专属）：
 *   HEXBOX_AUGMENT_CAPTURE=stream|oneshot（默认 stream）
 *   HEXBOX_AUGMENT_SECONDS=180        录制时长（秒；0 = 跟随整局）
 *   HEXBOX_AUGMENT_OUT=<名字>         产物写到 debug/<名字>/（多次录制不互相覆盖）
 *   HEXBOX_AUGMENT_FORENSICS=1        边沿也抓全分辨率帧（会让系统光标卡约 1 秒）
 *   HEXBOX_AUGMENT_CLOSED_SAMPLES=N   关闭态抽查抓几张（默认 0）
 *   HEXBOX_AUGMENT_OPEN_SAMPLE_MS=4000 面板停留期间的取证重采样间隔
 *   HEXBOX_DEBUG_FORCE=1              跳过 LCU 阶段检查
 *   HEXBOX_LABEL_OVERLAY_TEST=1       **覆盖窗自测**（不需要游戏）：屏幕上画
 *                                     左/中/右三个大字母，5 秒后自动退出，
 *                                     用来单独验证"透明画布能不能显示出来"
 *                                     （见 apps/overlay/README.md）
 * 链路旋钮（触发方式/采样间隔/标签档位等）见 `main/augment-controller.ts` 头注。
 *
 * 合规：只读屏幕像素与窗口几何。不注入、不读内存、不解析封包、不打开游戏进程句柄。
 */

import { app, desktopCapturer, screen } from 'electron';
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import {
  detectAugmentPanel,
  detectPanelPresence,
  findGameWindowRectCached,
  panelRowRectInCapture,
  PANEL_ROW_REGION,
  PANEL_THRESHOLDS,
  type Bitmap,
  type Rect,
} from '@hexbox/vision';
import { detectCredentialsDetailed, LcuClient } from '@hexbox/lcu';

import { AugmentStream, type AugmentFrame } from './main/augment-stream.ts';
import {
  AUGMENT_CHAIN_CADENCE,
  AUGMENT_CHAIN_CAPTURE,
  AugmentController,
  resolveAugmentCaptureGeometry,
  type AugmentLabelSink,
  type AugmentReadingEvent,
} from './main/augment-controller.ts';
import {
  attachLabelOverlayDiagnostics,
  clearLabelOverlay,
  createLabelOverlay,
  pushLabelOverlay,
} from './main/label-overlay.ts';
import { isLabelOverlaySelfTest, runLabelOverlaySelfTest } from './main/label-selftest.ts';

/**
 * 产物目录。
 *
 * 默认仓库根 `debug/augment`（`debug/` 在 .gitignore 里，且含个人信息）。
 * `HEXBOX_AUGMENT_OUT=<名字或绝对路径>` 可改到子目录 —— 这样**多次录制不会
 * 互相覆盖**（真实教训：本地自测跑了一次，就把用户那一局的 timeline.csv 覆盖了；
 * 帧图还在，但 CSV 没了）。
 */
const DEFAULT_OUT = app.isPackaged
  ? join(process.cwd(), 'debug', 'augment')
  : join(__dirname, '..', '..', '..', 'debug', 'augment');
const OUT_DIR = (() => {
  const out = process.env['HEXBOX_AUGMENT_OUT'];
  if (!out) return DEFAULT_OUT;
  return isAbsolute(out) ? out : join(DEFAULT_OUT, '..', out);
})();

const BENCH = process.env['HEXBOX_AUGMENT_BENCH'] === '1';
/** 只验证"节流切换能不能真的下发到渲染端"的自测（不需要游戏）。 */
const SELFTEST_CADENCE = process.env['HEXBOX_AUGMENT_SELFTEST_CADENCE'] === '1';
const CAPTURE = process.env['HEXBOX_AUGMENT_CAPTURE'] === 'oneshot' ? 'oneshot' : 'stream';
const SECONDS = Number(process.env['HEXBOX_AUGMENT_SECONDS'] ?? 0);

/**
 * 是否抓全分辨率取证帧。
 *
 * ⚠️ **默认 0（关闭）**：抓帧走 `desktopCapturer.getSources`，
 * 真机上会让**系统光标卡住约 1 秒**（用户实测一局 3 次，与取证时间戳完全对齐）。
 * 要标定样本时再开，并接受卡顿。
 */
const FORENSICS = process.env['HEXBOX_AUGMENT_FORENSICS'] === '1';
/** 常态（closed）也抓几张样本？默认 0 —— 同样是为了不卡光标。 */
const MAX_CLOSED_SAMPLES = Number(process.env['HEXBOX_AUGMENT_CLOSED_SAMPLES'] ?? 0);
/** 面板停留期间的**取证**重采样间隔（不是采样间隔：采样在控制器里）。 */
const OPEN_SAMPLE_MS = Number(process.env['HEXBOX_AUGMENT_OPEN_SAMPLE_MS'] ?? 4000);
/**
 * 是否把强度标签**画到屏幕上**（S5.4c）。默认开。
 *
 * `HEXBOX_AUGMENT_DRAW=0` 关掉：只跑识别 + 打印 + 落盘，屏幕上什么都看不到
 * （对标定判据/性能的录制有用 —— 画布虽然点击穿透，但压在卡上会进截屏帧）。
 */
const DRAW = process.env['HEXBOX_AUGMENT_DRAW'] !== '0';

const CLOSED_SAMPLE_EVERY_MS = 30_000;
const BENCH_ITERS = 6;
const BENCH_STREAM_SECONDS = 5;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function num(v: number | null | undefined, digits = 3): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '' : v.toFixed(digits);
}

function csvField(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function summary(values: readonly number[]): { avg: number; p50: number; min: number; max: number } {
  if (values.length === 0) return { avg: 0, p50: 0, min: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    avg: values.reduce((s, v) => s + v, 0) / values.length,
    p50: sorted[Math.floor(sorted.length / 2)]!,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

/** 全帧平均亮度（每 4 像素采样；仅诊断记录用）。 */
function frameLuma(bmp: Bitmap): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < bmp.height; y += 4) {
    for (let x = 0; x < bmp.width; x += 4) {
      const i = (y * bmp.width + x) * 4;
      sum += 0.299 * bmp.data[i]! + 0.587 * bmp.data[i + 1]! + 0.114 * bmp.data[i + 2]!;
      n++;
    }
  }
  return sum / n;
}

/* ------------------------------------------------------------------ */
/* 一次性截屏（边沿取证 + 对照/兜底路径；只在面板出现/消失时做，频率极低） */
/* ------------------------------------------------------------------ */

type SourceKind = 'window' | 'screen';

interface Grabbed {
  readonly img: Electron.NativeImage;
  readonly bmp: Bitmap;
  readonly sourceCount: number;
  readonly sourceName: string;
}

function toBitmap(img: Electron.NativeImage): Bitmap {
  const size = img.getSize();
  const raw = img.toBitmap(); // BGRA
  const data = new Uint8ClampedArray(size.width * size.height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = raw[i + 2]!;
    data[i + 1] = raw[i + 1]!;
    data[i + 2] = raw[i]!;
    data[i + 3] = raw[i + 3]!;
  }
  return { width: size.width, height: size.height, data };
}

async function grab(
  scale: number,
  display: Electron.Display,
  kind: SourceKind = 'window',
): Promise<Grabbed | null> {
  const sources = await desktopCapturer.getSources({
    types: [kind],
    thumbnailSize: {
      width: Math.max(16, Math.round(display.size.width * 2 * scale)),
      height: Math.max(16, Math.round(display.size.height * 2 * scale)),
    },
    fetchWindowIcons: false,
  });
  const src =
    kind === 'window'
      ? (sources.find((s) => s.name === 'League of Legends') ??
        sources.find((s) => /League of Legends/i.test(s.name)))
      : (sources.find((s) => s.display_id === String(display.id)) ?? sources[0]);
  if (!src) return null;
  const size = src.thumbnail.getSize();
  if (size.width <= 0 || size.height <= 0) return null;
  return {
    img: src.thumbnail,
    bmp: toBitmap(src.thumbnail),
    sourceCount: sources.length,
    sourceName: src.name,
  };
}

/* ------------------------------------------------------------------ */
/* LCU 阶段检查（录制的生命周期，链路本身不关心）                         */
/* ------------------------------------------------------------------ */

/**
 * 找仓库根的 `data/` 目录。
 *
 * ⚠️ **不能用 `process.cwd()`**（2026-10-05 真机事故：三次海克斯全部"认不准"）：
 * `pnpm --filter @hexbox/overlay debug:augment` 会把工作目录设成**包目录**
 * `apps/overlay`，于是 `cwd/data/augment-names.json` 不存在 → 指纹库为空 →
 * 每张卡都认不出来（而门控/取帧全都正常，所以表现是"识别全灭"而不是报错）。
 *
 * 与主 overlay 同一套做法（见 `main/index.ts` 的注释）：**向上遍历、
 * 以 `data/dataset.json` 是否存在为准**。`OUT_DIR` 早就有这种回退，只有这里漏了。
 */
function resolveDataDir(): string {
  const starts = [process.cwd(), __dirname];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      const cand = join(dir, 'data');
      if (existsSync(join(cand, 'dataset.json'))) return cand;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return join(process.cwd(), 'data');
}

async function currentPhase(): Promise<string | null> {
  try {
    const creds = await detectCredentialsDetailed();
    if (!creds?.credentials) return null;
    const client = new LcuClient(creds.credentials);
    const session = await client.getOrNull<{ phase?: string }>('/lol-gameflow/v1/session');
    return session?.phase ?? 'None';
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

interface Row {
  readonly ms: number;
  readonly found: boolean;
  readonly cards: number;
  readonly state: string;
  readonly edge: string | null;
  readonly detectMs: number;
  readonly grabMs: number;
  readonly sincePrevMs: number;
  readonly luma: number;
}

interface SavedFrame {
  readonly file: string;
  readonly atMs: number;
  readonly state: string;
  readonly reason: string;
}

app.whenReady().then(async () => {
  // ── 覆盖窗自测（`HEXBOX_LABEL_OVERLAY_TEST=1`）────────────────────────
  // 放在**最前面**：不查 LCU 阶段、不建截屏流、不写产物，只在屏幕上画
  // 左/中/右三个大字母并自动退出。局内标签"画了但看不见"时先用它验窗口。
  if (isLabelOverlaySelfTest()) {
    runLabelOverlaySelfTest();
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });

  const phase = BENCH ? null : await currentPhase();
  if (!BENCH) {
    console.log(`[augment] LCU phase = ${phase ?? '未知（读不到凭证）'}`);
    // ⚠️ 只有"**明确知道**不在对局中"才拒绝；读不到凭证（非管理员等）只警告。
    // 真实教训：这道闸门曾在没管理员权限时直接退出，且**什么都不写**
    // —— 用户看到的是"跑完了但没有任何产物"，无从判断原因。
    // 门控只依赖屏幕像素，跟 LCU 无关，所以读不到凭证时应当继续。
    //
    // ⚠️ 2026-10-05 第二次踩：凭证探测修好后阶段变得可读，于是"在进游戏前启动"
    // 就命中这道闸门**立刻退出**（用户："程序启动完就退出"）。
    // 但**跟随整局**模式本来就是"先启动、再进游戏"，所以这种情况应当**等**
    // 对局开始，而不是退出（固定时长模式才拒绝，那是明确的"现在就要录"意图）。
    if (phase !== null && phase !== 'InProgress') {
      const force = process.env['HEXBOX_DEBUG_FORCE'] === '1';
      const fixed = Number(process.env['HEXBOX_AUGMENT_SECONDS'] ?? 0) > 0;
      if (!force && !fixed) {
        console.log(
          `[augment] 当前阶段 ${phase}，不在对局中 → **等待进入对局**（跟随整局模式；Ctrl+C 退出）…`,
        );
        // 每 5 秒问一次，直到进入对局（或收到停止哨兵）
        for (;;) {
          if (existsSync(join(OUT_DIR, '.stop'))) {
            console.log('[augment] 等待期间收到停止哨兵 → 退出');
            app.quit();
            return;
          }
          await new Promise((r) => setTimeout(r, 5000));
          const p2 = await currentPhase().catch(() => null);
          if (p2 === 'InProgress') {
            console.log('[augment] 已进入对局，开始录制');
            break;
          }
          if (p2 !== null && p2 !== phase) console.log(`[augment] 阶段 ${p2}…继续等`);
        }
      } else if (!force) {
        console.error(
          `✗ 当前阶段是 ${phase}，不是对局中。\n` +
            `  本工具需要在**一局海克斯乱斗进行中**运行（面板只在局内出现）。\n` +
            `  （仍要强制运行：设 HEXBOX_DEBUG_FORCE=1；不设 HEXBOX_AUGMENT_SECONDS 则自动等待）`,
        );
        app.quit();
        process.exitCode = 1;
        return;
      }
    } else if (phase === null) {
      console.warn(
        '⚠ 读不到 LCU 凭证（多半是没以管理员运行）—— 继续录制。\n' +
          '  门控只看屏幕像素，与 LCU 无关；只是无法替你确认"现在确实在对局中"。',
      );
    }
  }

  const thumbScale = AUGMENT_CHAIN_CAPTURE.thumbScale;
  const geometry = await resolveAugmentCaptureGeometry(thumbScale);
  const { display, windowPhysical } = geometry;
  const regionFor = (w: number, h: number): Rect =>
    panelRowRectInCapture({ width: w, height: h }, windowPhysical, display);

  /* ---------------- 基准模式（只会在这里建第二条流做对照） ---------------- */
  if (BENCH) {
    const variants: Array<{ name: string; scale: number; kind: SourceKind }> = [
      { name: 'window @1.00', scale: 1, kind: 'window' },
      { name: 'window @0.25', scale: 0.25, kind: 'window' },
      { name: 'window @tiny(16px)', scale: 16 / (display.size.width * 2), kind: 'window' },
      { name: 'screen @0.25', scale: 0.25, kind: 'screen' },
      { name: 'screen @1.00', scale: 1, kind: 'screen' },
    ];
    console.log(`\n[bench] 一次性截屏：每种跑 ${BENCH_ITERS} 次\n`);
    const oneShot: Array<{ name: string; ms: ReturnType<typeof summary>; size: string; sources: number }> = [];
    for (const v of variants) {
      const times: number[] = [];
      let size = '—';
      let sources = 0;
      for (let i = 0; i < BENCH_ITERS; i++) {
        const t0 = Date.now();
        const g = await grab(v.scale, display, v.kind);
        times.push(Date.now() - t0);
        if (!g) {
          size = '未找到源';
          break;
        }
        size = `${g.bmp.width}x${g.bmp.height}`;
        sources = g.sourceCount;
      }
      const s = summary(times);
      oneShot.push({ name: v.name, ms: s, size, sources });
      console.log(
        `  ${v.name.padEnd(22)} ${size.padEnd(12)} 源数=${String(sources).padEnd(3)} ` +
          `P50=${s.p50.toFixed(0)}ms 最快=${s.min.toFixed(0)}ms 最慢=${s.max.toFixed(0)}ms`,
      );
    }

    // 常驻流：候选方案。测每帧耗时 + **实际到达帧数**（节流/不合成会立刻暴露）
    const region = geometry.region;
    console.log(
      `\n[bench] 常驻流（getDisplayMedia）：画布宽 ${geometry.targetWidth}，间隔 ${AUGMENT_CHAIN_CADENCE.activeMs}ms，测 ${BENCH_STREAM_SECONDS}s\n`,
    );
    const streamFrames: AugmentFrame[] = [];
    const stream = new AugmentStream({
      config: {
        region,
        intervalMs: AUGMENT_CHAIN_CADENCE.activeMs,
        targetWidth: geometry.targetWidth,
      },
      onFrame: (f) => streamFrames.push(f),
      onStatus: (m, e) => console.log(`  ${e ? '⚠' : '·'} ${m}`),
    });
    const started = await stream.start(display);
    await new Promise((r) => setTimeout(r, BENCH_STREAM_SECONDS * 1000));
    stream.stop();
    const arrived = streamFrames.length;
    const expected = Math.floor(
      (BENCH_STREAM_SECONDS * 1000) / AUGMENT_CHAIN_CADENCE.activeMs,
    );
    const streamResult = {
      started,
      targetWidth: geometry.targetWidth,
      intervalMs: AUGMENT_CHAIN_CADENCE.activeMs,
      seconds: BENCH_STREAM_SECONDS,
      frames: arrived,
      expectedFrames: expected,
      achievedFps: arrived / BENCH_STREAM_SECONDS,
      detectMs: summary(streamFrames.map((f) => f.detectMs)),
      grabMs: summary(streamFrames.map((f) => f.grabMs)),
      sincePrevMs: summary(streamFrames.slice(1).map((f) => f.sincePrevMs)),
      canvas: streamFrames[0] ? `${streamFrames[0].width}x${streamFrames[0].height}` : '—',
      foundFrames: streamFrames.filter((f) => f.found).length,
    };
    console.log(
      `  到达 ${arrived} 帧 / 期望 ${expected} 帧（${streamResult.achievedFps.toFixed(1)} fps，画布 ${streamResult.canvas}）`,
    );
    console.log(
      `  取像素 P50 ${streamResult.grabMs.p50.toFixed(1)}ms / 检测 P50 ${streamResult.detectMs.p50.toFixed(1)}ms / ` +
        `帧间隔 P50 ${streamResult.sincePrevMs.p50.toFixed(0)}ms；认定面板 ${streamResult.foundFrames} 帧`,
    );
    writeFileSync(
      join(OUT_DIR, 'bench.json'),
      JSON.stringify({ display, windowPhysical, oneShot, stream: streamResult }, null, 2),
    );
    console.log('\n判读：一次性截屏的固定开销（window@16px ≈707ms）说明它不能高频用；');
    console.log('常驻流的"帧间隔 P50"应≈设定间隔、检测 P50 应为个位数 ms。');
    console.log('（结果已写入 debug/augment/bench.json）');
    app.quit();
    return;
  }

  console.log(
    `[augment] 截屏路径=${CAPTURE}，录制 ${
      SECONDS > 0 ? `${SECONDS}s（固定）` : '跟随整局（LCU 阶段离开"对局中"即收工，硬上限 45 分钟）'
    }，画布缩放 ${thumbScale}`,
  );
  if (SECONDS === 0) {
    console.log('[augment] 想固定时长：HEXBOX_AUGMENT_SECONDS=600（秒）');
  }
  console.log(
    '[augment] 请在**海克斯面板弹出**时保持正常游玩；' +
      (DRAW
        ? '识别出的强度标签会画在卡片底部（关掉：HEXBOX_AUGMENT_DRAW=0）。'
        : '本工具只记录，不绘制任何东西（HEXBOX_AUGMENT_DRAW=0）。'),
  );

  const csvPath = join(OUT_DIR, 'timeline.csv');
  writeFileSync(
    csvPath,
    [
      'ms',
      'found',
      'cards',
      'bands',
      'frameLuma',
      'detectMs',
      'grabMs',
      'sincePrevMs',
      'state',
      'edgeEvent',
      'cadence',
      'hits',
      // ⚠️ `misses` 的语义（2026-10-06 起）：**两个信号都不在**的连续帧数
      //（旧版是"卡片判据连续未命中"）。复盘翻牌误判时看它 + `presence` + `presenceHolds`。
      'misses',
      // 「面板仍在」独立信号（渲染端在卡片判据未命中帧上算）：
      //   1/0 = 在/不在；`presenceHolds` = 它连续托底了几帧（>0 就是"卡片在动、面板没走"）。
      'presence',
      'presenceHolds',
      'presenceReason',
      'reason',
    ].join(',') + '\n',
  );

  const startedAt = Date.now();
  const rows: Row[] = [];
  const saved: SavedFrame[] = [];
  let finished = false;
  /** 取证用的"面板停留期间"计时（与采样节奏无关）。 */
  let lastOpenSampleAt = 0;
  // ⚠️ 用 startedAt 而不是 0 初始化：否则 `now - 0 >= 30000` 恒真，
  // 第一帧就会去做一次全分辨率"关闭态采样"（本地实跑看到过：开局即
  // `Failed to start capture`，白白浪费一次截屏）。
  let lastClosedSampleAt = startedAt;
  let closedSamples = 0;
  let lastStatusAt = 0;

  /* ---------------- 标签画布（与选人阶段共用同一份窗口代码） ---------------- */

  /**
   * 局内标签画布（与选人阶段 S2 **同一份窗口代码**；懒建，见 ensureLabelWin）。
   *
   * ⚠️ 必须**提前建**（而不是首次推送时）：`loadFile` 是异步的，
   * 建完立刻推的第一个消息会丢（S2 覆盖层也有这个特性，只是它推送频繁不显）。
   * 所以控制器的 `prepare()` 一到就建好（面板最早也要开局后几秒才出现）。
   */
  let labelWin: Electron.BrowserWindow | null = null;
  const ensureLabelWin = (): Electron.BrowserWindow | null => {
    if (!DRAW) return null;
    if (labelWin && !labelWin.isDestroyed()) return labelWin;
    labelWin = createLabelOverlay({ display });
    // 渲染端的 console/加载错误转发到终端 —— "画布空白"时唯一能看见原因的地方
    attachLabelOverlayDiagnostics(labelWin, 'augment:label');
    return labelWin;
  };
  const labelSink: AugmentLabelSink = {
    prepare: () => {
      if (!ensureLabelWin()) return;
      console.log('[augment] 🏷 强度标签画布已就绪（全屏透明、点击穿透、与 S2 选人标签同一条通道）');
    },
    push: (msg) => {
      const win = ensureLabelWin();
      if (win) pushLabelOverlay(win, display, msg);
    },
    clear: (why) => clearLabelOverlay(labelWin, why),
  };

  /* ---------------- 边沿取证（一次性截屏；默认关闭） ---------------- */

  /** 取证是否正在进行（避免叠加；同时让门控知道"该丢过期帧了"）。 */
  let savingForensics = false;

  /**
   * 边沿取证：抓一张全分辨率帧 + JSON。
   *
   * ⚠️⚠️ **默认关闭**（`HEXBOX_AUGMENT_FORENSICS=1` 才开）：这条路径用
   * `desktopCapturer.getSources` 抓全分辨率帧，真机上会让**系统光标卡住约 1 秒**
   * （2026-10-05 用户实测：一局卡 3 次，与这里 3 次取证的时间戳完全对齐）。
   * 它是 **DWM/合成器级别**的卡顿，不是"我们进程自己慢" —— 所以异步化救不了，
   * 只能不在对局中用。常态识别走**渲染端**从已有屏幕流取原生帧（S5.4b）。
   *
   * 另有两条真机教训（2026-10-05，都花了整整一局才发现）：
   *
   * 1. **必须用 `screen` 源，不能用按窗口名找的 window 源**：真机上
   *    `sources.find(s => s.name === 'League of Legends')` 命中的是**客户端窗口**
   *    （3413×1920，"游戏仍在进行中……"），不是游戏窗口 —— 存下来的帧里根本没有
   *    卡片。而门控走的是 getDisplayMedia 的**屏幕**源，两者必须同一个坐标系，
   *    否则搜索区/卡片框全对不上。
   * 2. **不能 `await`**：一次取证（getSources ~600ms + toBitmap + toPNG）约 1.7s，
   *    期间渲染端照常推帧、消息排队，回头一次性处理会造出**假边沿**
   *    （实测凭空多出一对 close/open）。所以：不 await + 丢弃过期帧
   *    （控制器里的 `STALE_FRAME_MS`）。
   *
   * 另外不再在运行时生成 annotated.png（JS 里编码 3440×1440 很贵）。需要标注图时
   * 用离线脚本 `scripts/diag-augment-frames.mts <帧.png> --annotate` 画。
   */
  const saveForensics = async (
    tag: string,
    note: { state: string; reason: string },
    edgeAtMs: number,
  ): Promise<void> => {
    // ⚠️ 默认关闭 —— 见上方注释（会让系统光标卡约 1 秒）
    if (!FORENSICS) return;
    if (savingForensics) return;
    savingForensics = true;
    const t0 = Date.now();
    try {
      const grabbed = await grab(1, display, 'screen');
      if (!grabbed) {
        console.warn('[augment] ⚠ 取证截屏失败（屏幕源不可用？）');
        return;
      }
      const { bmp } = grabbed;
      const det = detectAugmentPanel(bmp, regionFor(bmp.width, bmp.height));
      writeFileSync(join(OUT_DIR, `${tag}.png`), grabbed.img.toPNG());
      writeFileSync(
        join(OUT_DIR, `${tag}.json`),
        JSON.stringify(
          {
            tag,
            atMs: edgeAtMs - startedAt,
            state: note.state,
            gateReason: note.reason,
            capture: `${bmp.width}x${bmp.height}`,
            source: grabbed.sourceName,
            tookMs: Date.now() - t0,
            region: regionFor(bmp.width, bmp.height),
            found: det.found,
            detectReason: det.reason,
            cards: det.cards.map((c) => ({
              rect: c.rect,
              interiorLuma: Number(c.interiorLuma.toFixed(1)),
              edgeLuma: Number(c.edgeLuma.toFixed(1)),
            })),
          },
          null,
          2,
        ),
      );
      saved.push({ file: `${tag}.png`, atMs: edgeAtMs - startedAt, state: note.state, reason: note.reason });
    } finally {
      savingForensics = false;
    }
  };

  /* ---------------- 链路控制器（与常驻覆盖层**同一份**代码） ---------------- */

  /**
   * 门控读数 → timeline.csv + 取证 + 状态行。
   *
   * ⚠️ 这一切都是**录制专属**的：控制器已经做完了计数、节流、边沿、识别、
   * 标签与清空（`AugmentController`），这里只负责把它们落到产物里。
   */
  const onReading = (e: AugmentReadingEvent): void => {
    appendFileSync(
      csvPath,
      [
        String(e.atMs - startedAt),
        e.found ? '1' : '0',
        String(e.cardCount),
        String(e.bands),
        num(e.luma, 2),
        num(e.detectMs, 2),
        num(e.grabMs, 2),
        num(e.sincePrevMs, 1),
        e.state,
        e.edge ?? '',
        e.cadenceLabel,
        String(e.hits),
        String(e.misses),
        // 面板信号：1/0 = 在/不在；托底次数；原因（引号包住，逗号安全）
        e.presence === null ? '' : e.presence.present ? '1' : '0',
        String(e.presenceHolds),
        csvField(e.presence?.reason ?? ''),
        csvField(e.reason),
      ].join(',') + '\n',
    );
    rows.push({
      ms: e.atMs - startedAt,
      found: e.found,
      cards: e.cardCount,
      state: e.state,
      edge: e.edge,
      detectMs: e.detectMs,
      grabMs: e.grabMs,
      sincePrevMs: e.sincePrevMs,
      luma: e.luma,
    });

    if (e.edge === 'open') {
      // 不 await：取证约 1.7s，阻塞会让排队帧补处理出假边沿（真实教训）
      void saveForensics(`open-${e.openEdges}`, { state: e.state, reason: e.reason }, e.atMs);
      lastOpenSampleAt = e.atMs;
    } else if (e.edge === 'close') {
      void saveForensics(`close-${e.closeEdges}`, { state: e.state, reason: e.reason }, e.atMs);
    } else if (e.state === 'open' && e.atMs - lastOpenSampleAt >= OPEN_SAMPLE_MS) {
      lastOpenSampleAt = e.atMs;
      void saveForensics(
        `open-${e.openEdges}-t${Math.round((e.atMs - startedAt) / 1000)}`,
        { state: e.state, reason: e.reason },
        e.atMs,
      );
    } else if (
      e.state === 'closed' &&
      closedSamples < MAX_CLOSED_SAMPLES &&
      e.atMs - lastClosedSampleAt >= CLOSED_SAMPLE_EVERY_MS
    ) {
      lastClosedSampleAt = e.atMs;
      closedSamples++;
      void saveForensics(
        `closed-sample-${closedSamples}`,
        { state: e.state, reason: e.reason },
        e.atMs,
      );
    }

    const now = Date.now();
    if (now - lastStatusAt >= 5000) {
      lastStatusAt = now;
      const interiors = e.interiors.map((v) => v.toFixed(0)).join('/');
      console.log(
        `[augment] ${((now - startedAt) / 1000).toFixed(0)}s 状态=${e.state} 节流=${e.cadenceLabel} 卡片=${e.cardCount}` +
          ` 内部=[${interiors}] 取像素=${e.grabMs.toFixed(1)}ms 检测=${e.detectMs.toFixed(1)}ms`,
      );
    }
  };

  /** 节流自测用：每帧的到达时刻（**未做任何过滤** —— 控制器也拿它数帧）。 */
  const arrivals: Array<{ t: number; sincePrevMs: number }> = [];
  const externalCapture = CAPTURE === 'oneshot';
  const controller = new AugmentController({
    dataDir: resolveDataDir(),
    labels: DRAW ? labelSink : undefined,
    // 触发方式沿用环境变量（未设 = pixel，录制工具的既有语义）
    externalCapture,
    // api 模式只在"已知在对局中"时计 2999 的失败（进游戏前一定没有 2999）
    inMatch: () => phase === 'InProgress',
    onReading,
    onStreamFrame: (f) => arrivals.push({ t: Date.now(), sincePrevMs: f.sincePrevMs }),
  });

  const captureState = await controller.start();
  const onStream = captureState === 'stream';

  if (!onStream && !externalCapture) {
    console.warn(
      '⚠ 常驻流不可用（见上面带 ⚠ 的日志）→ 回退到一次性截屏路径。\n' +
        '  请把那些日志发回，我据此改流的实现。',
    );
  }

  const finish = (): void => {
    if (finished) return;
    finished = true;
    // 收工必须清空标签（否则最后一块面板的字母会留在屏幕上）+ 复位重随基线 + 停流。
    // ⚠️ 必须是 `{ clearLabels: true }`：链路停止**默认不清标签**（局内正常离开
    // 对局时清空由"阶段换手"负责）——录制收工是**明确要求清**的少数调用方之一
    controller.stop('录制结束', { clearLabels: true });
    const snap = controller.snapshot();
    const report = {
      startedAt: new Date(startedAt).toISOString(),
      capture: CAPTURE,
      seconds: SECONDS, // 0 = 跟随整局
      cadence: snap.cadence,
      thumbScale,
      windowPhysical,
      display: { bounds: display.bounds, scaleFactor: display.scaleFactor },
      samples: snap.samples,
      counts: snap.counts,
      timings: {
        grabMs: summary(snap.timings.grabMs),
        detectMs: summary(snap.timings.detectMs),
        roundMs: summary(snap.timings.roundMs),
        sincePrevMs: summary(snap.timings.sincePrevMs.slice(1)),
      },
      thresholds: PANEL_THRESHOLDS,
      searchRegion: PANEL_ROW_REGION,
      // api 触发的复盘信息：常态是否真的一帧不取、开关了几次、结束时还欠哪几次
      trigger: snap.trigger,
      frames: saved,
      recognized: snap.recognized,
      // S5.4c：强度标签（与 recognized 一一对应）。每条的 items 里记了
      // 「档位字母 + 标签矩形（归一化/屏幕坐标）+ 有没有画」，复盘不必截图。
      //
      // ⚠️ `championIdSource` 是**必须**看的字段：标签的档位是"以该英雄为准"的，
      // 认错英雄就会整局显示别人的强度表（真机事故：剑圣→154 Zac、酒桶→43 Karma）。
      labels: {
        draw: DRAW,
        championId: snap.champion.championId,
        championIdSource: snap.champion.source,
        championName: snap.champion.name,
        championAlias: snap.champion.alias,
        championMatchedBy: snap.champion.matchedBy,
        championReason: snap.champion.reason,
        tierCount: snap.champion.tierCount,
        /** 同一张 per-hero 表里的登场率条数（标签第二行「选取率 x%」的来源）。 */
        pickRateCount: snap.champion.pickRateCount,
        /** 标签预设（几何 + 字号一处开关）：名/档/卡内占比，复盘时核对用的就是它。 */
        preset: snap.preset,
        /**
         * **单卡刷新（reroll）检测**的配置与事件（S5.7）。
         *
         * 产品事实（用户 2026-10-06）：每张卡**最多刷新一次**，且刷新发生在
         * **面板保持打开期间** —— 所以开/关边沿看不到它，必须靠"每张卡的画面
         * 内容变了"来发现，并把那张卡的标签重算/清掉。
         */
        reroll: snap.reroll,
        events: snap.labels,
      },
      notes: [
        '判据是"卡片行结构 + 内部暗/对比强"，不是"相对基线压暗"（后者在录制从面板打开时开始会自锁）。',
        'open-*.png 是边沿全分辨率帧；需要标注图用 scripts/diag-augment-frames.mts 离线画。',
        '若 closed 帧里出现 found=1，说明有假阳性 —— 用 diag-augment-frames.mts 复现。',
        'pixel 模式：cadence.share.idle 越高越省；active 占比异常高说明有假阳性在反复升频。',
        'api 模式：常态应**一帧不取**（openEdges 只应出现在死亡触发的窗口内）；配合 api-trigger.csv 复盘。',
        'labels.events：每张卡的 tier 与 pickRate 都来自该英雄的 augment_json_irank；augmentId 为 null' +
          '（认不准）或查不到 tier 的卡**不画**，items[].drawn 会是 false。',
        'labels.events[].origin：该次是「开边沿整批识别」（open）还是「面板停留期间单卡刷新后的重识别」' +
          '（reroll）；reroll 时 refreshed 给出被重认的卡号、tookMs 是这次重识别的耗时。',
        'labels.events[].pickRate 缺失/为 0 时标签**只少那一行**（字母照画）—— 绝不猜一个百分比。',
        'labels.events[].rowBand：整排标签**共用的纵向基准**（框顶 y / 框高 h）——' +
          '面板开边沿锁一次（lockedAtMs 就是那一次），之后**复用同一条**：' +
          '一块面板里所有事件的 y/h 必须逐位相同。刷新只改内容（字母/选取率/是否存在），' +
          '绝不许改基准 —— 这是"某次单卡刷新后三个标签整体下移"的修复点。',
        'labels.preset：标签几何/字号的唯一开关（见 docs/AUGMENT-PANEL.md §十三）；标签**水平居中**，' +
          '内容 = 大号档位字母 + 两侧尖括号 + 「选取率 x%」行。',
        'labels.reroll：面板停留期间的**单卡刷新**检测（每张卡最多刷新一次）——' +
          'detected 是"发现某张卡被换掉"的次数，events[].distance 是判定的结构距离（阈值见 threshold）。' +
          '刷新后**查不到强度/认不出**的卡会立刻清掉它自己的标签（labels.events 的 items[].drawn=false）。',
        'labels.championIdSource：本局英雄是从哪条数据面认出来的' +
          '（activePlayer-raw / activePlayer-name / lcu-champsession / gameflow-self / none）。' +
          '**none 表示一张标签都没画** —— 档位以英雄为准，认错英雄等于整局显示别人的强度表。',
        '标签"画了但屏幕上没有"先用 HEXBOX_LABEL_OVERLAY_TEST=1 验窗口（不需游戏），再进对局。',
      ],
    };
    writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));

    if (snap.trigger.mode === 'api' && snap.apiLog.length > 0) {
      writeFileSync(
        join(OUT_DIR, 'api-trigger.csv'),
        'ms,gameTime,level,isDead,respawnTimer,capture,pending,reason\n' +
          snap.apiLog.join('\n') +
          '\n',
      );
      console.log(`\nAPI 采样 ${snap.apiLog.length} 条 → debug/augment/api-trigger.csv`);
      console.log(
        `结束时：开截屏=${snap.trigger.captureAtEnd ? '是' : '否'}  未选=[${snap.trigger.pendingAtEnd.join(',')}]` +
          (snap.trigger.apiFallback ? '  ⚠ 已退回像素节流' : ''),
      );
    }

    console.log('\n──────── 录制完成 ────────');
    console.log(
      `样本 ${snap.samples}  认定面板 ${snap.counts.foundFrames} 帧  出现 ${snap.counts.openEdges} 次 / 消失 ${snap.counts.closeEdges} 次`,
    );
    console.log(
      `节流占比：常态 ${(snap.cadence.share.idle * 100).toFixed(0)}% / probe ${(snap.cadence.share.probe * 100).toFixed(0)}%` +
        ` / 高频 ${(snap.cadence.share.active * 100).toFixed(0)}%（常态 ${snap.cadence.idleMs}ms ↔ 高频 ${snap.cadence.activeMs}ms）`,
    );
    console.log(
      `耗时：取像素 P50 ${report.timings.grabMs.p50.toFixed(1)}ms、检测 P50 ${report.timings.detectMs.p50.toFixed(1)}ms、` +
        `帧间隔 P50 ${report.timings.sincePrevMs.p50.toFixed(0)}ms`,
    );
    // 强度标签小结：画了几张、哪些卡因为"认不准/查不到强度"没画、几张带选取率行
    const labelItems = snap.labels.flatMap((e) => e.items);
    if (DRAW) {
      const withPick = labelItems.filter(
        (i) => i.tier !== null && i.pickRate !== null && i.pickRate > 0,
      );
      const rerollEvents = snap.labels.filter((e) => e.origin === 'reroll');
      console.log(
        `强度标签：${labelItems.filter((i) => i.tier !== null).length} 张画了（共 ${labelItems.length} 张卡）` +
          `、其中 ${withPick.length} 张带「选取率」行` +
          `，本局英雄 #${snap.champion.championId}（来源 ${snap.champion.source}` +
          `${snap.champion.name !== '' ? ` / ${snap.champion.name}` : ''}）` +
          `、强度表 ${snap.champion.tierCount} 条`,
      );
      console.log(
        `单卡刷新：检测到 ${snap.reroll.detected} 次（面板停留期间每 ${snap.reroll.pollMs}ms 比一次指纹，阈值 ${snap.reroll.threshold}）` +
          (rerollEvents.length > 0
            ? `；重识别耗时 ${rerollEvents.map((e) => `${e.tookMs.toFixed(0)}ms`).join('/')}`
            : ''),
      );
      if (snap.champion.championId <= 0) {
        console.log(`  未认出本局英雄的原因：${snap.champion.reason}`);
      }
    }
    console.log('请把 report.json + timeline.csv + 边沿帧图发回。');
    app.quit();
  };

  process.on('SIGINT', () => {
    console.log('\n[augment] 收到中断，先落盘再退出…');
    try {
      finish();
    } catch {
      app.quit();
    }
  });

  /**
   * Ctrl+C 的**哨兵**：Electron 是 GUI 子系统进程、不挂控制台，
   * Windows 的 CTRL_C_EVENT **送不到这里**（`SIGINT` 钩子在真机上是死代码，
   * 2026-10-05 用户实测：Ctrl+C 退出后整局产物没落盘）。
   * 所以由 launcher（`run-electron.mjs`，它挂控制台）收到信号后写这个文件，
   * 我们每秒轮询到就干净收尾。
   */
  const STOP_SENTINEL = join(OUT_DIR, '.stop');
  // 清掉上一次遗留的哨兵：否则新一轮会"一启动就收尾"
  try {
    rmSync(STOP_SENTINEL, { force: true });
  } catch {
    /* 无所谓 */
  }
  const stopRequested = (): boolean => existsSync(STOP_SENTINEL);
  /** 每 15 秒写一份"精简快照"：哪怕被强杀（关终端），识别结果与触发状态也在。 */
  const CHECKPOINT_MS = 15_000;

  // ⚠️ 退出也要落盘（真机教训 2026-10-05）：用户"打完就关游戏/关终端"时，
  // 如果只有到点才写 report.json，整局的数据就全丢了 —— 那一局恰好抓到了
  // 7 级死亡触发的面板（timeline.csv 里有 3 张卡的命中行），但 report/识别结果没落盘。
  app.on('before-quit', () => {
    if (finished) return;
    try {
      finish();
    } catch {
      /* 退出路径里不再抛 */
    }
  });

  /**
   * 录制时长。
   *
   * ⚠️ 默认 **0 = 跟随整局**（2026-10-05 用户实测反馈："命令行很快就退出了，
   * 游戏还在进行" —— 旧默认写死 180 秒，而一局 20 分钟，等于只录了开头）。
   *
   * 跟随模式下的结束条件（任一命中）：
   *   · LCU 阶段已知且**不再是 `InProgress`**（对局结束/回到客户端）→ 立刻收工；
   *   · 硬上限 `MAX_FOLLOW_MINUTES`（防"阶段读不到"时无限跑）。
   * 想固定时长仍可 `HEXBOX_AUGMENT_SECONDS=600`。
   */
  const FIXED_SECONDS = Number(process.env['HEXBOX_AUGMENT_SECONDS'] ?? 0);
  const MAX_FOLLOW_MS = Number(process.env['HEXBOX_AUGMENT_MAX_MINUTES'] ?? 45) * 60_000;
  const deadline = FIXED_SECONDS > 0 ? startedAt + FIXED_SECONDS * 1000 : startedAt + MAX_FOLLOW_MS;
  const armed = (): boolean => Date.now() < deadline;

  /** 一次性截屏路径（对照/兜底；慢，但确认能用）。读数喂给**同一个**控制器。 */
  const loop = async (): Promise<void> => {
    if (!armed()) {
      finish();
      return;
    }
    try {
      const t0 = Date.now();
      const grabbed = await grab(thumbScale, display, 'window');
      if (grabbed) {
        const bmp = grabbed.bmp;
        const det = detectAugmentPanel(bmp, regionFor(bmp.width, bmp.height));
        const elapsed = Date.now() - t0;
        // 一次性截屏路径也要**带上"面板仍在"信号**（与流路径同一套语义，见
        // `augment-presence.ts`）：只在卡片判据未命中时算，命中帧不必算。
        const presence = det.found ? null : detectPanelPresence(bmp);
        controller.pushExternalReading(
          det,
          { detectMs: 0, grabMs: elapsed, sincePrevMs: 0, atMs: Date.now() },
          frameLuma(bmp),
          presence,
        );
      }
    } catch (e) {
      console.warn('[augment] ⚠ 本轮异常:', e instanceof Error ? e.message : String(e));
    }
    setTimeout(() => void loop(), AUGMENT_CHAIN_CADENCE.activeMs);
  };

  if (!onStream) {
    await loop();
    return;
  }

  // ── 节流自测：验证"切换间隔"真的下达到了渲染端 ──
  // 这段路径（主进程决策 → IPC → worker 重开定时器）无法离线验证，
  // 而它一旦不通，真机表现就是"命中后依然是 1 秒一次"，很难看出来。
  if (SELFTEST_CADENCE) {
    const measure = async (ms: number): Promise<number[]> => {
      controller.setCadence(ms, `自测下发 ${ms}ms`);
      const from = Date.now();
      await new Promise((r) => setTimeout(r, 3500));
      return arrivals.filter((a) => a.t > from + 500).map((a) => a.sincePrevMs);
    };
    const fast = await measure(AUGMENT_CHAIN_CADENCE.activeMs);
    const slow = await measure(AUGMENT_CHAIN_CADENCE.idleMs);
    const p = (v: number[]): number => (v.length === 0 ? -1 : summary(v).p50);
    const pFast = p(fast);
    const pSlow = p(slow);
    const ok =
      pFast > 0 &&
      pFast < AUGMENT_CHAIN_CADENCE.activeMs * 2.5 &&
      pSlow > AUGMENT_CHAIN_CADENCE.idleMs * 0.7;
    console.log('\n──────── 节流自测 ────────');
    console.log(
      `  下发 ${AUGMENT_CHAIN_CADENCE.activeMs}ms → 实测帧间隔 P50 ${pFast.toFixed(0)}ms（${fast.length} 帧）`,
    );
    console.log(
      `  下发 ${AUGMENT_CHAIN_CADENCE.idleMs}ms → 实测帧间隔 P50 ${pSlow.toFixed(0)}ms（${slow.length} 帧）`,
    );
    console.log(`  结论：${ok ? '✅ 节流切换有效' : '❌ 节流切换没生效 —— 请把这段发回'}`);
    controller.stop('节流自测结束');
    writeFileSync(
      join(OUT_DIR, 'selftest-cadence.json'),
      JSON.stringify(
        {
          requestedFast: AUGMENT_CHAIN_CADENCE.activeMs,
          measuredFastMs: pFast,
          requestedIdle: AUGMENT_CHAIN_CADENCE.idleMs,
          measuredIdleMs: pSlow,
          ok,
        },
        null,
        2,
      ),
    );
    app.quit();
    process.exitCode = ok ? 0 : 1;
    return;
  }

  console.log(
    FIXED_SECONDS > 0
      ? `[augment] 常驻流已出帧，按流路径录制（固定 ${FIXED_SECONDS}s）`
      : '[augment] 常驻流已出帧，按流路径录制（**跟随整局**：LCU 阶段离开"对局中"即收工）',
  );

  await new Promise<void>((resolve) => {
    let since = Date.now();
    let sinceCheckpoint = Date.now();
    /** 连续几次没找到游戏窗口（LCU 阶段不可读时的兜底收工信号）。 */
    let missingWindowChecks = 0;
    const wait = setInterval(() => {
      // launcher 的 Ctrl+C 哨兵（Electron 收不到控制台信号，见上）
      if (stopRequested()) {
        console.log('[augment] 收到停止哨兵（Ctrl+C 接力）→ 收尾');
        clearInterval(wait);
        resolve();
        return;
      }
      // 每 15 秒写一次精简快照：被强杀也不至于丢光整局
      if (Date.now() - sinceCheckpoint >= CHECKPOINT_MS) {
        sinceCheckpoint = Date.now();
        const snap = controller.snapshot();
        try {
          writeFileSync(
            join(OUT_DIR, 'checkpoint.json'),
            JSON.stringify(
              {
                atMs: Date.now() - startedAt,
                note: '录制中途快照（进程被强杀时用它，完整产物看 report.json）',
                trigger: snap.trigger,
                counts: {
                  foundFrames: snap.counts.foundFrames,
                  openEdges: snap.counts.openEdges,
                  closeEdges: snap.counts.closeEdges,
                },
                recognized: snap.recognized,
                // 强杀也不丢标签结果（与 recognized 一一对应）+ 英雄身份来源
                champion: {
                  id: snap.champion.championId,
                  source: snap.champion.source,
                  name: snap.champion.name,
                  matchedBy: snap.champion.matchedBy,
                },
                labels: snap.labels,
              },
              null,
              2,
            ),
          );
        } catch {
          /* 快照失败不影响录制 */
        }
      }
      if (Date.now() >= deadline) {
        clearInterval(wait);
        resolve();
        return;
      }
      // 跟随模式：每 20 秒判断"对局还在不在"
      if (FIXED_SECONDS === 0 && Date.now() - since >= 20_000) {
        since = Date.now();
        void currentPhase()
          .then(async (p) => {
            if (p !== null && p !== 'InProgress') {
              console.log(`[augment] 对局结束（LCU phase = ${p}）→ 收工`);
              clearInterval(wait);
              resolve();
              return;
            }
            // ⚠️ LCU 拿不到阶段时（真机常见：非管理员读不到凭证），
            // 用"**游戏窗口还在不在**"作为兜底信号 —— 否则游戏打完了
            // 程序还在跑（用户实测：打完还得手动 Ctrl+C）。
            if (p === null) {
              const rect = await findGameWindowRectCached().catch(() => null);
              if (rect === null) {
                missingWindowChecks++;
                console.log(
                  `[augment] 未找到游戏窗口（第 ${missingWindowChecks}/3 次）—— 若对局已结束将自动收工`,
                );
                if (missingWindowChecks >= 3) {
                  console.log('[augment] 游戏窗口已消失且 LCU 阶段不可读 → 判定对局结束，收工');
                  clearInterval(wait);
                  resolve();
                }
              } else {
                missingWindowChecks = 0;
              }
            }
          })
          .catch(() => {
            /* 读不到就继续，不因为一次失败收工 */
          });
      }
    }, 250);
  });
  finish();
});

app.on('window-all-closed', () => app.quit());

/**
 * 兜底：任何未捕获的异常/未处理的 Promise 都要**说出来并退出**。
 *
 * ⚠️ 本地实跑踩到过：`loadFile` 的 reject 冒到 whenReady 链之外后，
 * Electron 进程既不报错也不退出 —— 表现为"跑完了但一个产物都没有"，
 * 用户完全无从判断。宁可吵，也不要静默挂死。
 */
process.on('unhandledRejection', (reason) => {
  console.error('[augment] ✗ 未处理的 Promise 拒绝：', reason instanceof Error ? reason.stack : String(reason));
  app.quit();
});
process.on('uncaughtException', (err) => {
  console.error('[augment] ✗ 未捕获异常：', err.stack ?? String(err));
  app.quit();
});
