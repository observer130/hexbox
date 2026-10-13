/**
 * 自测场景序列的测试（假宿主，不碰 Electron）
 *
 * 为什么值得测：这段逻辑决定"自测到底算不算通过"，而它自己出错的方式很隐蔽 ——
 * 比如把"悬停后仍是 0 像素"判成通过（那等于把 item 3 的功能整个漏掉还是绿的）。
 * 所以这里用**假画布**跑三遍：全好 / 悬停不出现 / 清空有残留，各自要给出正确结论。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  labelProbeRect,
  runLabelOverlayScenarios,
  tooltipProbeRect,
  type ScenarioHost,
  type ScenarioRect,
} from './label-selftest-scenarios.ts';

const LABEL: ScenarioRect = { x: 810, y: 440, w: 300, h: 200 };
const ORIGIN = { originX: 0, originY: 0 };

/** 一个假"渲染端"：用一个矩形集合表示"现在画布上有像素"。 */
function fakeHost(options: { tooltipOnHover?: boolean; residueOnEmpty?: boolean } = {}): {
  host: ScenarioHost;
  hovers: Array<{ x: number; y: number }>;
  bounds: { x: number; y: number; width: number; height: number };
  pushes: number;
} {
  const tooltipOnHover = options.tooltipOnHover ?? true;
  const residueOnEmpty = options.residueOnEmpty ?? false;
  const labelBox = labelProbeRect(LABEL, ORIGIN.originX, ORIGIN.originY);
  const tipBox = tooltipProbeRect(LABEL, ORIGIN.originX, ORIGIN.originY);
  const hovers: Array<{ x: number; y: number }> = [];
  const state = { labels: true, tip: false, bounds: { x: 0, y: 0, width: 1000, height: 700 }, pushes: 0 };

  const inRect = (r: ScenarioRect, x: number, y: number): boolean =>
    x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

  const host: ScenarioHost = {
    run: async (script: string): Promise<unknown> => {
      // 极简脚本识别：够用即止（真实脚本由 Electron 执行，这里只验判定逻辑）
      if (script.includes("new MouseEvent('mousemove'")) {
        const m = /clientX: (-?\d+), clientY: (-?\d+)/.exec(script);
        const x = Number(m?.[1] ?? 0);
        const y = Number(m?.[2] ?? 0);
        hovers.push({ x, y });
        state.tip = tooltipOnHover && inRect(labelBox, x, y);
        return true;
      }
      if (script.includes('getImageData')) {
        if (script.includes(`${tipBox.x} * dpr`)) return state.tip ? 500 : 0;
        if (script.includes(`${labelBox.x} * dpr`)) return state.labels ? 900 : 0;
        return 0;
      }
      if (script.includes('innerWidth')) {
        // 画布尺寸**总是**跟着窗口走（真实实现里这是渲染端每次绘制前设的）
        return {
          innerW: state.bounds.width,
          innerH: state.bounds.height,
          canvasW: state.bounds.width,
          canvasH: state.bounds.height,
          dpr: 1,
        };
      }
      return null;
    },
    bounds: () => ({ ...state.bounds }),
    setBounds: (b) => {
      state.bounds = { ...b };
    },
    pushLabels: () => {
      state.labels = true;
      state.pushes += 1;
    },
    pushEmpty: () => {
      state.labels = residueOnEmpty;
      state.tip = residueOnEmpty;
    },
  };
  return {
    host,
    hovers,
    get bounds() {
      return state.bounds;
    },
    get pushes() {
      return state.pushes;
    },
  };
}

/** 假睡眠：立即返回（真机上的等待在单测里没有必要）。 */
const noSleep = async (): Promise<void> => {};

test('★ 三个场景全好 → 整体通过，且每项都给出可读的读数', async () => {
  const f = fakeHost();
  const report = await runLabelOverlayScenarios(f.host, { centerLabel: LABEL, ...ORIGIN, sleep: noSleep });
  assert.equal(report.results.length, 3);
  assert.deepEqual(
    report.results.map((r) => r.ok),
    [true, true, true],
  );
  assert.equal(report.ok, true);
  assert.ok(report.results[0]!.detail.includes('悬停中 500 像素'), report.results[0]!.detail);
  assert.ok(report.results[1]!.detail.includes('推空后标签区 0'), report.results[1]!.detail);
  assert.ok(report.results[1]!.detail.includes('提示框区 0'), report.results[1]!.detail);
});

test('★ 悬停不出提示框 → 必须判失败（否则 item 3 整个漏掉还是绿的）', async () => {
  const f = fakeHost({ tooltipOnHover: false });
  const report = await runLabelOverlayScenarios(f.host, { centerLabel: LABEL, ...ORIGIN, sleep: noSleep });
  assert.equal(report.results[0]!.ok, false);
  assert.equal(report.ok, false);
  assert.ok(report.results[0]!.detail.includes('期望：0 → >0 → 0'));
});

test('★ 清空后有残留（上一局的标签/提示框没清）→ 必须判失败', async () => {
  const f = fakeHost({ residueOnEmpty: true });
  const report = await runLabelOverlayScenarios(f.host, { centerLabel: LABEL, ...ORIGIN, sleep: noSleep });
  assert.equal(report.results[1]!.ok, false);
  assert.equal(report.ok, false);
});

test('悬停坐标用的是**标签中心**（窗口内坐标），移开用的是窗口外坐标', async () => {
  const f = fakeHost();
  await runLabelOverlayScenarios(f.host, { centerLabel: LABEL, ...ORIGIN, sleep: noSleep });
  assert.deepEqual(f.hovers[0], { x: LABEL.x + LABEL.w / 2, y: LABEL.y + LABEL.h / 2 });
  assert.deepEqual(f.hovers[1], { x: -50, y: -50 });
});

test('副屏原点：探针与悬停坐标都要减掉工作区原点', async () => {
  const originX = -1920;
  const f = fakeHost();
  // 标签在副屏（屏幕坐标 x 为负），窗口内坐标应当是正的
  const label: ScenarioRect = { x: originX + 810, y: 440, w: 300, h: 200 };
  await runLabelOverlayScenarios(f.host, { centerLabel: label, originX, originY: 0, sleep: noSleep });
  assert.deepEqual(f.hovers[0], { x: 810 + 150, y: 540 });
});

test('宿主抛异常 → 记成该场景失败并带原因，**不许**让自测半路崩掉', async () => {
  const f = fakeHost();
  const broken: ScenarioHost = {
    ...f.host,
    run: async () => {
      throw new Error('渲染端已销毁');
    },
  };
  const report = await runLabelOverlayScenarios(broken, { centerLabel: LABEL, ...ORIGIN, sleep: noSleep });
  assert.equal(report.ok, false);
  assert.equal(report.results.length, 3, '三个场景都要有结论');
  assert.ok(report.results[0]!.detail.includes('渲染端已销毁'), report.results[0]!.detail);
});

test('改尺寸场景：窗口矩形会被复原（不许把自测窗口留在缩小状态）', async () => {
  const f = fakeHost();
  await runLabelOverlayScenarios(f.host, { centerLabel: LABEL, ...ORIGIN, sleep: noSleep });
  assert.deepEqual(f.bounds, { x: 0, y: 0, width: 1000, height: 700 });
});

test('探针矩形的几何：提示框探针在标签**下方**，标签探针就是标签本体', () => {
  const labelBox = labelProbeRect(LABEL, 0, 0);
  assert.deepEqual(labelBox, { x: 810, y: 440, w: 300, h: 200 });
  const tipBox = tooltipProbeRect(LABEL, 0, 0);
  assert.ok(tipBox.y >= labelBox.y + labelBox.h, '提示框探针必须在标签下方（提示框默认朝下）');
  assert.ok(tipBox.w > labelBox.w, '探针要比提示框宽一点，免得刚好压在边上数到 0');
});
