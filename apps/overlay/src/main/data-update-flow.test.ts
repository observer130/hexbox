/**
 * 「更新数据」流程测试（Node 环境，不启动 Electron）
 *
 * 为什么能这样测：`data-update-flow.ts` 刻意**不 import electron**
 * （确认框/结果弹窗都通过依赖注入），所以启动检查的节流、确认/取消、
 * 成功后的重读顺序、失败与取消的文案都能在 CI 里被钉住。
 *
 * 覆盖的语义：
 *   · 启动检查每 24h 最多一次，失败也记时间（断网不会每次启动都打上游）；
 *   · 没探到日期 ≠ 没有新数据（不弹"有新数据"的假提示）；
 *   · 用户取消确认框 → 一个请求都不发；
 *   · 成功 → **先 reload 再弹窗**（弹窗说"已生效"必须是真的）；
 *   · 失败/取消 → 如实说明"现有数据未被改动"。
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { SyncProgress, SyncReport } from '@hexbox/data-cli';
import type { DataUpdatePromptText } from '@hexbox/vision';

import {
  createDataUpdateFlow,
  type DataUpdateDialogText,
  type DataUpdateFlowDeps,
} from './data-update-flow.ts';

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

function makeReport(over: Partial<SyncReport> = {}): SyncReport {
  return {
    ok: true,
    aborted: false,
    wrote: ['dataset', 'rankings', 'builds'],
    failures: [],
    skipped: [],
    dataDate: '20261005',
    fetchedAt: '2026-11-02T00:00:00.000Z',
    counts: {
      augments: 0,
      hextechs: 0,
      champions: 2,
      items: 0,
      rankingAugments: 0,
      rankingHeroes: 0,
      details: 2,
      templates: 0,
    },
    templatesRebuilt: false,
    ...over,
  };
}

async function waitFor(cond: () => boolean, label: string, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Harness {
  readonly deps: DataUpdateFlowDeps;
  readonly dir: string;
  /** 记录调用顺序（reload / showResult 等），用于断言"先 reload 再弹窗"。 */
  readonly order: string[];
}

async function harness(
  over: Partial<DataUpdateFlowDeps> & {
    runSync?: DataUpdateFlowDeps['runSync'];
    checkUpstream?: DataUpdateFlowDeps['checkUpstream'];
  } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'hexbox-flow-'));
  const order: string[] = [];
  const merged: DataUpdateFlowDeps = {
    dataDir: join(dir, 'data'),
    checkStatePath: join(dir, 'data-check.json'),
    hasLocalData: () => true,
    localDate: () => '20261004',
    notify: () => {},
    onPhaseChange: () => {},
    reload: async () => {},
    confirmUpdate: async () => true,
    showResult: async () => {},
    now: () => new Date('2026-11-02T10:00:00.000Z'),
    ...over,
  };
  // 统一记账（覆盖用例自己注入的实现也要记），用于断言"先 reload 再弹窗"
  const deps: DataUpdateFlowDeps = {
    ...merged,
    reload: async () => {
      order.push('reload');
      await merged.reload();
    },
    showResult: async (ok, text) => {
      order.push('showResult');
      await merged.showResult(ok, text);
    },
  };
  return { deps, dir, order };
}

/** 清掉可能从外部环境带进来的开关（否则"启动检查"用例会被跳过）。 */
function cleanEnv(): () => void {
  const keys = ['HEXBOX_SMOKE', 'HEXBOX_TRAY_AUTOTEST_MS', 'HEXBOX_DATA_CHECK'];
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/* ------------------------------------------------------------------ */
/* 首次运行（本地无数据）                                                */
/* ------------------------------------------------------------------ */

test('首次运行：本地无数据 → 后台静默下载（不弹确认框），完成后记检查时间', async () => {
  const restore = cleanEnv();
  try {
    let confirmed = 0;
    let upstreamCalls = 0;
    let ran = 0;
    let notice: { title: string; content: string } | null = null;
    const h = await harness({
      hasLocalData: () => false,
      confirmUpdate: async () => {
        confirmed++;
        return true;
      },
      notify: (title, content) => {
        notice = { title, content };
      },
    });
    const flow = createDataUpdateFlow({
      ...h.deps,
      runSync: async () => {
        ran++;
        return makeReport({ wrote: ['dataset', 'rankings', 'builds', 'templates'] });
      },
      checkUpstream: async () => {
        upstreamCalls++;
        return { dataDate: '20261005', tried: [] };
      },
    });
    flow.checkOnStartup();
    await waitFor(() => ran === 1, '自动下载');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(confirmed, 0, '启动路径不许弹确认框');
    assert.equal(upstreamCalls, 0, '没有数据时不必先探日期');
    const seen = notice! as { title: string; content: string };
    assert.equal(seen.title, 'hexbox 数据已更新');
    assert.match(seen.content, /2026-10-05/);
    const state = JSON.parse(await readFile(h.deps.checkStatePath, 'utf8')) as {
      lastCheckAt?: string;
      upstreamDate?: string | null;
    };
    assert.equal(state.lastCheckAt, '2026-11-02T10:00:00.000Z');
    assert.equal(state.upstreamDate, '20261005');
  } finally {
    restore();
  }
});

test('首次运行：自动下载失败 → 只发气泡、不写检查时间（下次启动会再试）', async () => {
  const restore = cleanEnv();
  try {
    let notice: { title: string; content: string } | null = null;
    const h = await harness({
      hasLocalData: () => false,
      notify: (title, content) => {
        notice = { title, content };
      },
    });
    const flow = createDataUpdateFlow({
      ...h.deps,
      runSync: async () =>
        makeReport({
          ok: false,
          wrote: [],
          failures: [{ stage: 'static', label: 'CommunityDragon', message: '断网' }],
        }),
    });
    flow.checkOnStartup();
    await waitFor(() => notice !== null, '失败气泡');
    const seen = notice! as { title: string; content: string };
    assert.equal(seen.title, 'hexbox 自动更新失败');
    assert.match(seen.content, /现有数据未被改动/);
    assert.equal(existsSync(h.deps.checkStatePath), false, '失败不写状态 → 下次启动仍会尝试');
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ */
/* 启动检查                                                            */
/* ------------------------------------------------------------------ */

test('启动检查：24h 内已检查过 → 一个请求都不发', async () => {
  const restore = cleanEnv();
  try {
    const h = await harness();
    let checks = 0;
    await writeFile(
      h.deps.checkStatePath,
      JSON.stringify({ lastCheckAt: '2026-11-02T09:00:00.000Z', upstreamDate: '20261004' }),
      'utf8',
    );
    const flow = createDataUpdateFlow({
      ...h.deps,
      checkUpstream: async () => {
        checks++;
        return { dataDate: '20261005', tried: ['20261004'] };
      },
    });
    flow.checkOnStartup();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(checks, 0);
    assert.deepEqual(flow.phase(), { kind: 'idle' });
  } finally {
    restore();
  }
});

test('启动检查：上游有更新的统计日期 → 后台自动下载 + 成功气泡（不弹确认框）', async () => {
  const restore = cleanEnv();
  try {
    let notice: { title: string; content: string } | null = null;
    let confirmed = 0;
    let ran = 0;
    const h = await harness({
      notify: (title, content) => {
        notice = { title, content };
      },
      confirmUpdate: async () => {
        confirmed++;
        return true;
      },
    });
    const flow = createDataUpdateFlow({
      ...h.deps,
      checkUpstream: async () => ({ dataDate: '20261005', tried: ['20261004'] }),
      runSync: async () => {
        ran++;
        return makeReport({ dataDate: '20261005' });
      },
    });
    flow.checkOnStartup();
    await waitFor(() => ran === 1, '自动下载');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(confirmed, 0, '自动更新不许弹确认框');
    const seen = notice! as { title: string; content: string };
    assert.equal(seen.title, 'hexbox 数据已更新');
    assert.match(seen.content, /2026-10-05/);
    const state = JSON.parse(await readFile(h.deps.checkStatePath, 'utf8')) as {
      lastCheckAt?: string;
      upstreamDate?: string | null;
    };
    assert.equal(state.lastCheckAt, '2026-11-02T10:00:00.000Z');
    assert.equal(state.upstreamDate, '20261005');
    assert.deepEqual(flow.phase(), { kind: 'idle' });
  } finally {
    restore();
  }
});

test('启动检查：没探到上游日期 → 不弹"有新数据"（断网 ≠ 已是最新）', async () => {
  const restore = cleanEnv();
  try {
    let notified = 0;
    const h = await harness({
      notify: () => {
        notified++;
      },
    });
    const flow = createDataUpdateFlow({
      ...h.deps,
      checkUpstream: async () => ({ dataDate: null, tried: ['20261005'], error: 'ENOTFOUND' }),
    });
    flow.checkOnStartup();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(notified, 0);
    const state = JSON.parse(await readFile(h.deps.checkStatePath, 'utf8')) as {
      lastCheckAt?: string;
    };
    assert.equal(state.lastCheckAt, '2026-11-02T10:00:00.000Z');
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ */
/* 手动更新                                                            */
/* ------------------------------------------------------------------ */

test('手动更新：确认框点取消 → 不发请求、不弹结果', async () => {
  const h = await harness({ confirmUpdate: async () => false });
  let ran = 0;
  const flow = createDataUpdateFlow({
    ...h.deps,
    runSync: async () => {
      ran++;
      return makeReport();
    },
  });
  flow.update();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(ran, 0);
  assert.equal(h.order.length, 0);
  assert.deepEqual(flow.phase(), { kind: 'idle' });
});

test('手动更新：成功 → 先 reload 再弹成功框，阶段回到 idle 且带统计日期', async () => {
  const restore = cleanEnv();
  try {
    const phases: string[] = [];
    let prompt: DataUpdatePromptText | null = null;
    let result: { ok: boolean; text: DataUpdateDialogText } | null = null;
    const h = await harness({
      confirmUpdate: async (text) => {
        prompt = text;
        return true;
      },
      showResult: async (ok, text) => {
        result = { ok, text };
      },
      onPhaseChange: () => {
        phases.push('change');
      },
    });
    let progressSeen: SyncProgress | null = null;
    const flow = createDataUpdateFlow({
      ...h.deps,
      runSync: async (options) => {
        assert.equal(options.storeRoot, h.deps.dataDir);
        progressSeen = { stage: 'details', label: '单英雄详情', done: 3, total: 173 };
        options.onProgress(progressSeen);
        assert.deepEqual(flow.phase(), {
          kind: 'syncing',
          label: '单英雄详情',
          done: 3,
          total: 173,
        });
        return makeReport({ wrote: ['dataset', 'rankings', 'builds'] });
      },
    });
    flow.update();
    await waitFor(() => result !== null, '结果弹窗');
    const shown = result! as { ok: boolean; text: DataUpdateDialogText };
    assert.equal(shown.ok, true);
    assert.match(shown.text.message, /数据已更新（官方统计 2026-10-05）/);
    assert.equal(prompt!.message, '要更新本地数据吗？');
    assert.match(prompt!.detail, /单英雄详情/);
    // 顺序：reload 必须早于 showResult（"已生效"不能先于真的读进来）
    assert.deepEqual(h.order, ['reload', 'showResult']);
    assert.ok(phases.length >= 2, '阶段变化要驱动托盘刷新');
    await waitFor(() => flow.phase().kind === 'idle', '回到 idle');
  } finally {
    restore();
  }
});

test('手动更新：失败 → 弹失败框、说明现有数据未改动、不 reload', async () => {
  const restore = cleanEnv();
  try {
    let result: { ok: boolean; text: DataUpdateDialogText } | null = null;
    let reloaded = 0;
    const h = await harness({
      reload: async () => {
        reloaded++;
      },
      showResult: async (ok, text) => {
        result = { ok, text };
      },
    });
    const flow = createDataUpdateFlow({
      ...h.deps,
      runSync: async () =>
        makeReport({
          ok: false,
          wrote: [],
          dataDate: '',
          failures: [{ stage: 'rankings', label: '腾讯 101 数据站', message: 'HTTP 503' }],
          skipped: [{ stage: 'rankings', reason: '上游无数据' }],
        }),
    });
    flow.update();
    await waitFor(() => result !== null, '结果弹窗');
    const shown = result! as { ok: boolean; text: DataUpdateDialogText };
    assert.equal(shown.ok, false);
    assert.equal(shown.text.message, '更新失败');
    assert.match(shown.text.detail, /腾讯 101 数据站：HTTP 503/);
    assert.match(shown.text.detail, /现有数据未被改动/);
    assert.match(shown.text.detail, /没有探测到上游统计日期/);
    assert.equal(reloaded, 0);
  } finally {
    restore();
  }
});

test('手动更新：同步抛异常 → 也走失败框（不让 reject 逃逸）', async () => {
  const restore = cleanEnv();
  try {
    let result: { ok: boolean; text: DataUpdateDialogText } | null = null;
    const h = await harness({
      showResult: async (ok, text) => {
        result = { ok, text };
      },
    });
    const flow = createDataUpdateFlow({
      ...h.deps,
      runSync: async () => {
        throw new Error('磁盘只读');
      },
    });
    flow.update();
    await waitFor(() => result !== null, '结果弹窗');
    const shown = result! as { ok: boolean; text: DataUpdateDialogText };
    assert.equal(shown.ok, false);
    assert.match(shown.text.detail, /磁盘只读/);
    assert.match(shown.text.detail, /现有数据未被改动/);
    assert.deepEqual(flow.phase(), { kind: 'idle' });
  } finally {
    restore();
  }
});

test('手动更新：运行中 cancel() → AbortSignal 被触发，结果如实说"已取消"', async () => {
  const restore = cleanEnv();
  try {
    let captured: AbortSignal | null = null;
    let result: { ok: boolean; text: DataUpdateDialogText } | null = null;
    const h = await harness({
      showResult: async (ok, text) => {
        result = { ok, text };
      },
    });
    const flow = createDataUpdateFlow({
      ...h.deps,
      runSync: (options) =>
        new Promise<SyncReport>((resolve) => {
          captured = options.signal;
          options.signal.addEventListener('abort', () => {
            resolve(makeReport({ ok: false, aborted: true, wrote: ['dataset'] }));
          });
        }),
    });
    flow.update();
    await waitFor(() => captured !== null, '拿到 abort signal');
    flow.cancel('测试取消');
    await waitFor(() => result !== null, '结果弹窗');
    const shown = result! as { ok: boolean; text: DataUpdateDialogText };
    assert.equal(shown.ok, false);
    assert.equal(shown.text.message, '已取消更新');
    assert.match(shown.text.detail, /取消前已写入：图鉴/);
    assert.equal(captured!.aborted, true);
  } finally {
    restore();
  }
});
