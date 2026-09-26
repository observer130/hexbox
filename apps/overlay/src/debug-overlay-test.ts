#!/usr/bin/env node
/**
 * S2 覆盖层渲染自测（不需要游戏/选人）
 *
 * 创建与主进程同配置的覆盖窗口 → 加载 overlay.html →
 * 推送假标签 → capturePage 截图 → debug/overlay-test.png
 *
 * 用途：验收反馈"完全没显示"时,区分「渲染端坏了」还是「主进程没推送」。
 */

import { app, BrowserWindow, screen } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const OUT_DIR = join(dirname(__dirname), '..', '..', 'debug');
// __dirname = apps/overlay/dist → renderer 在 dist/renderer
const RENDERER_DIR = join(__dirname, 'renderer');

app.whenReady().then(async () => {
  mkdirSync(OUT_DIR, { recursive: true });

  const display = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    x: display.workArea.x,
    y: display.workArea.y,
    width: 1200,
    height: 800,
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
  const fakeLabels = [
    { x: 300, y: 300, w: 240, h: 34, text: '55.5%', sub: '测试英雄A', hasData: true, championId: 1 },
    { x: 600, y: 300, w: 240, h: 34, text: '暂无数据', sub: '测试英雄B', hasData: false, championId: 2 },
  ];
  win.webContents.send('overlay:vision', { active: true, labels: fakeLabels, diag: 'self-test' });
  await new Promise((r) => setTimeout(r, 500));

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
