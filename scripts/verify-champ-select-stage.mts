/**
 * 诊断：用**已有的真机选人帧**离线复核阶段判据（不需要游戏/桌面/管理员）
 *
 * 为什么值得留：`confirmed.ts` 的顶栏 10 格 + `champ-select-stage.ts` 的
 * 「占用 ≥1 → 第二阶段」是整条选人链路的岔路口，而它曾经错过两次
 * （2026-10 的"幽灵格"把"可用"二字当槽位；2026-11 又有人照着过期注释提出
 * 要扩成 11 格）。这两次都是**只看注释、没跑帧**造成的。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-champ-select-stage.mts
 *   node --experimental-strip-types scripts/verify-champ-select-stage.mts <帧目录|帧.png...>
 *
 * 输出：每个帧的「占用格数 + 命中的格序号 + 判出的阶段」。
 * 与屏幕上的实际阶段逐帧对照即可 —— 第一阶段必须 **0 格**，第二阶段 **≥1 格**。
 * 帧是窗口预览（如 1500×843 = 2400×1350 的 0.625×）也成立：坐标是归一化的。
 *
 * 已知的一手证据（2026-11-08，`debug/cards-check/` 的 7 张帧）：
 *   4 张一阶段帧 → 占用 0；3 张二阶段帧 → 占用 1（首格）；7/7 与目视一致。
 *   若把 x0 改成 549/2400（"11 格"），那 4 张一阶段帧会**全部误判成二阶段**。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  countOccupiedSlots,
  decideChampSelectStage,
  decodePng,
  isSlotOccupied,
  topBarSlotRects,
  type Bitmap,
  type Rect,
} from '../packages/vision/src/index.ts';

/** 收集输入：目录 → 其中所有 png；文件 → 原样；都没给 → 默认 debug/cards-check。 */
function collect(args: readonly string[]): string[] {
  const inputs = args.length > 0 ? [...args] : ['debug/cards-check'];
  const out: string[] = [];
  for (const p of inputs) {
    if (!existsSync(p)) {
      console.warn(`⚠ 跳过不存在的路径：${p}`);
      continue;
    }
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) {
        if (f.toLowerCase().endsWith('.png')) out.push(join(p, f));
      }
    } else {
      out.push(p);
    }
  }
  return out;
}

const files = collect(process.argv.slice(2));
if (files.length === 0) {
  console.error('✗ 没有可用的 PNG。用法见文件头。');
  process.exitCode = 1;
} else {
  const slots: Rect[] = topBarSlotRects();
  console.log(`顶栏槽位：${slots.length} 格，x0=${slots[0]!.x.toFixed(4)}（归一化）\n`);

  /** 客户端的窗口比例（2400×1350）。整窗帧必须与它同比。 */
  const WINDOW_ASPECT = 2400 / 1350;
  let used = 0;

  for (const file of files) {
    let bmp: Bitmap;
    try {
      bmp = decodePng(readFileSync(file)) as Bitmap;
    } catch (e) {
      console.log(`${file.padEnd(52)} 解不开：${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const name = file.split(/[\\/]/).pop() ?? file;
    // ⚠️ 这些目录里常混着裁剪片段（卡片特写、名字带、桌面截图）。它们不是整窗帧，
    //    套归一化槽位只会算出 nonsense（实测 10 格全"占用"）。按比例筛掉并说明。
    const aspect = bmp.width / bmp.height;
    if (Math.abs(aspect - WINDOW_ASPECT) / WINDOW_ASPECT > 0.01) {
      console.log(
        `${name.padEnd(46)} ${String(bmp.width).padStart(4)}×${String(bmp.height).padEnd(5)}` +
          ` 跳过（宽高比 ${aspect.toFixed(3)} ≠ 窗口 ${WINDOW_ASPECT.toFixed(3)}：裁剪片段不是整窗帧）`,
      );
      continue;
    }
    used++;
    const hits = slots.map((s, i) => (isSlotOccupied(bmp, s) ? i : -1)).filter((i) => i >= 0);
    const occupied = countOccupiedSlots(bmp, slots);
    // pickState 取 'unknown'：正是"LCU 说不清、只能靠像素"的那条路径
    const d = decideChampSelectStage({ pickState: 'unknown', topBarOccupiedCount: occupied });
    console.log(
      `${name.padEnd(46)} ${String(bmp.width).padStart(4)}×${String(bmp.height).padEnd(5)}` +
        ` 占用 ${occupied} 格${hits.length > 0 ? ` [${hits.join(',')}]` : ''}` +
        ` → ${d.stage}（${d.reason}）`,
    );
  }
  console.log(`\n有效整窗帧 ${used} / ${files.length}。`);
  console.log('对照：第一阶段必须 0 格（→ cards），第二阶段 ≥1 格（→ topbar）。');
}
