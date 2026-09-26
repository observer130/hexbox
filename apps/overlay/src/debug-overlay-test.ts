#!/usr/bin/env node
/**
 * S2 覆盖层渲染自测（不需要游戏/选人）
 *
 * 两种模式:
 *   默认        —— 截屏验证(无人值守,输出 debug/overlay-test.png)
 *   VISIBLE=1  —— 窗口真实显示 12 秒,肉眼确认透明窗口能否显示。
 *                排查"覆盖层完全不可见": 若此模式也看不见,说明
 *                窗口/透明/置顶配置在用户机器上失效,与识别无关。
 */

import { app, BrowserWindow, screen } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const OUT_DIR = join(dirname(__dirname), '..', '..', 'debug');
// __dirname = apps/overlay/dist → renderer 在 dist/renderer
const RENDERER_DIR = join(__dirname, 'renderer');
const VISIBLE = process.env['OVERLAY_TEST_VISIBLE'] === '1';

app.whenReady().then(async () => {
  mkdirSync(OUT_DIR, { recursive: true });

  const display = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    x: display.workArea.x,
    y: display.workArea.y,
    width: display.workArea.width,
    height: display.workArea.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });

  const errors: string[] = [];
  win.webContents.on('console-message', (_e, level, message) => {
    errors.push(`[renderer L${level}] ${message}`);
  });
  win.webContents.on('preload-error', (_e, path, err) => {
    errors.push(`[preload-error] ${path}: ${err}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    errors.push(`[did-fail-load] ${code} ${desc}`);
  });

  await win.loadFile(join(RENDERER_DIR, 'overlay.html'));
  await new Promise((r) => setTimeout(r, 300));

  // 模拟主进程推送(直接走 ipcMain 通道的等价物: 用 webContents.send)
  // 标签放在屏幕四角+中部,肉眼模式一眼可见覆盖窗口是否生效
  const W = display.workArea.width;
  const H = display.workArea.height;
  const fakeLabels = [
    { x: W * 0.4, y: H * 0.45, w: 240, h: 34, text: '55.5%', sub: '测试英雄A', hasData: true, championId: 1 },
    { x: W * 0.4, y: H * 0.55, w: 240, h: 34, text: '暂无数据', sub: '测试英雄B', hasData: false, championId: 2 },
    { x: 24, y: 24, w: 240, h: 34, text: '左上角', sub: '可见性标记', hasData: true, championId: 3 },
    { x: W - 264, y: H - 58, w: 240, h: 34, text: '右下角', sub: '可见性标记', hasData: true, championId: 4 },
  ];
  win.webContents.send('overlay:vision', { active: true, labels: fakeLabels, diag: 'self-test' });
  await new Promise((r) => setTimeout(r, 500));

  if (VISIBLE) {
    win.showInactive();
    await new Promise((r) => setTimeout(r, 12_000));
  }

  const state = await win.webContents.executeJavaScript(
    `(() => ({
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      canvasW: document.getElementById('vision')?.width ?? -1,
      canvasH: document.getElementById('vision')?.height ?? -1,
      hasApi: typeof visionOverlayApi !== 'undefined',
      hasOverlay: typeof overlay !== 'undefined',
    }))()`,
  );

  const image = await win.webContents.capturePage();
  writeFileSync(join(OUT_DIR, 'overlay-test.png'), image.toPNG());

  console.log('=== 覆盖层自测结果 ===');
  console.log('窗口内尺寸:', state.innerW, 'x', state.innerH);
  console.log('画布尺寸:', state.canvasW, 'x', state.canvasH);
  console.log('visionOverlayApi:', state.hasApi, ' overlay:', state.hasOverlay);
  console.log('渲染端错误:', errors.length ? errors.join('\n') : '（无）');
  console.log('截图:', join(OUT_DIR, 'overlay-test.png'), image.isEmpty() ? '(空!)' : `(${image.getSize().width}x${image.getSize().height})`);

  win.destroy();
  app.quit();
});

app.on('window-all-closed', () => app.quit());
