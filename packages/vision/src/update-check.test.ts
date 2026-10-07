/**
 * 「检查更新」判据测试：发布 JSON → 结论、资产挑选、菜单文案
 *
 * 为什么值得测：这条链路的每一段在真机上都很难造（GitHub 发布、断网、慢网），
 * 而判据错了就是**假更新/漏更新** —— 用户要么装了个旧版，要么永远看不到新版。
 * fixture 用的是 GitHub 真实响应的形状（`/repos/{owner}/{repo}/releases/latest`）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clipText,
  decideUpdate,
  formatBytes,
  parseUpdateSelfTestMode,
  pickInstallerAsset,
  readReleaseInfo,
  updateMenuEnabled,
  updateMenuText,
  type ReleaseAsset,
  type UpdatePhase,
} from './update-check.ts';

/** 真实的发布响应（截取更新用得到的字段）。 */
const RELEASE_JSON = {
  tag_name: 'v0.2.0',
  name: 'hexbox 0.2.0',
  html_url: 'https://github.com/observer130/hexbox/releases/tag/v0.2.0',
  body: '## 修复\n- 托盘菜单改造\n- 检查更新',
  prerelease: false,
  draft: false,
  assets: [
    {
      name: 'hexbox-setup-0.2.0-x64.exe',
      browser_download_url: 'https://github.com/observer130/hexbox/releases/download/v0.2.0/hexbox-setup-0.2.0-x64.exe',
      size: 81000263,
      digest: 'sha256:aa11',
    },
    {
      name: 'hexbox-setup-0.2.0-x64.exe.blockmap',
      browser_download_url: 'https://github.com/observer130/hexbox/releases/download/v0.2.0/hexbox-setup-0.2.0-x64.exe.blockmap',
      size: 85345,
    },
    {
      name: 'hexbox-portable-0.2.0-x64.exe',
      browser_download_url: 'https://github.com/observer130/hexbox/releases/download/v0.2.0/hexbox-portable-0.2.0-x64.exe',
      size: 80765332,
    },
  ],
};

test('readReleaseInfo：解析 tag / 说明 / 资产；缺 tag_name → null', () => {
  const info = readReleaseInfo(RELEASE_JSON);
  assert.ok(info !== null);
  assert.equal(info.tag, 'v0.2.0');
  assert.equal(info.assets.length, 3);
  assert.equal(info.assets[0]?.size, 81000263);
  assert.equal(info.assets[0]?.digest, 'sha256:aa11');
  assert.equal(info.assets[1]?.digest, '', '没有 digest 的老资产 → 空串（不是 undefined）');

  for (const bad of [null, undefined, 42, 'x', [], {}, { tag_name: '' }, { tag_name: 7 }]) {
    assert.equal(readReleaseInfo(bad), null, `应判为读不懂：${JSON.stringify(bad)}`);
  }
});

test('pickInstallerAsset：只认 hexbox-setup-*.exe（blockmap / 便携版都不算）；优先 x64', () => {
  const picked = pickInstallerAsset(readReleaseInfo(RELEASE_JSON)?.assets ?? []);
  assert.equal(picked?.name, 'hexbox-setup-0.2.0-x64.exe');

  const onlyPortable: ReleaseAsset[] = [
    { name: 'hexbox-portable-0.2.0-x64.exe', url: 'u', size: 1, digest: '' },
  ];
  assert.equal(pickInstallerAsset(onlyPortable), null, '只有便携版 → 不算可自助更新');

  const noX64: ReleaseAsset[] = [{ name: 'hexbox-setup-0.2.0-arm64.exe', url: 'u', size: 1, digest: '' }];
  assert.equal(pickInstallerAsset(noX64)?.name, 'hexbox-setup-0.2.0-arm64.exe', '没有 x64 就退到任意 setup');
});

test('decideUpdate：tag 更新且有安装包 → update（带上资产与说明）', () => {
  const d = decideUpdate('0.1.0', RELEASE_JSON);
  assert.equal(d.kind, 'update');
  if (d.kind !== 'update') return;
  assert.equal(d.latest, '0.2.0');
  assert.equal(d.current, '0.1.0');
  assert.equal(d.asset.name, 'hexbox-setup-0.2.0-x64.exe');
  assert.match(d.notes, /托盘菜单改造/);
  assert.match(d.htmlUrl, /^https:\/\/github\.com\//);
});

test('decideUpdate：同版本/更旧 → up-to-date（不打扰用户）', () => {
  for (const tag of ['v0.1.0', '0.1.0', 'v0.0.9', 'v0.1.0-beta.1']) {
    const d = decideUpdate('0.1.0', { ...RELEASE_JSON, tag_name: tag });
    assert.equal(d.kind, 'up-to-date', `${tag} 不该提示更新`);
  }
});

test('decideUpdate：有新版本但没有安装包资产 → error（不是"点了确认才发现下不了"）', () => {
  const d = decideUpdate('0.1.0', {
    ...RELEASE_JSON,
    assets: [{ name: 'hexbox-portable-0.2.0-x64.exe', browser_download_url: 'u', size: 1 }],
  });
  assert.equal(d.kind, 'error');
  if (d.kind !== 'error') return;
  assert.equal(d.reason, 'no-installer-asset');
  assert.match(d.detail, /v0\.2\.0/);
  assert.match(d.detail, /手动下载/);
});

test('decideUpdate：非法输入 → error，绝不判成"有更新"', () => {
  const badTag = decideUpdate('0.1.0', { ...RELEASE_JSON, tag_name: 'nightly-2026' });
  assert.equal(badTag.kind, 'error');
  if (badTag.kind === 'error') assert.equal(badTag.reason, 'tag-unparseable');

  const junk = decideUpdate('0.1.0', '<html>404</html>');
  assert.equal(junk.kind, 'error');
  if (junk.kind === 'error') assert.equal(junk.reason, 'release-unreadable');

  const badCurrent = decideUpdate('dev-build', RELEASE_JSON);
  assert.equal(badCurrent.kind, 'error');
  if (badCurrent.kind === 'error') assert.equal(badCurrent.reason, 'current-unparseable');
});

test('decideUpdate：预发布 tag 能被比较（v0.2.0-beta.1 > 0.1.0）', () => {
  const d = decideUpdate('0.1.0', { ...RELEASE_JSON, tag_name: 'v0.2.0-beta.1' });
  assert.equal(d.kind, 'update');
  if (d.kind === 'update') assert.equal(d.latest, '0.2.0-beta.1');
});

test('updateMenuText / updateMenuEnabled：用户点完立刻有反馈，且期间不可重复点', () => {
  const phases: UpdatePhase[] = [
    { kind: 'idle' },
    { kind: 'checking' },
    { kind: 'downloading', percent: null },
    { kind: 'downloading', percent: 42 },
    { kind: 'installing' },
  ];
  assert.deepEqual(phases.map(updateMenuText), [
    '检查更新',
    '正在检查更新…',
    '正在下载更新…',
    '正在下载更新… 42%',
    '正在启动安装程序…',
  ]);
  assert.deepEqual(phases.map(updateMenuEnabled), [true, false, false, false, false]);
});

test('formatBytes / clipText：弹窗里的体积与说明', () => {
  assert.equal(formatBytes(81000263), '77.2 MB');
  assert.equal(formatBytes(85345), '83 KB');
  assert.equal(formatBytes(0), '大小未知');
  assert.equal(clipText('  短说明  ', 100), '短说明');
  assert.equal(clipText('abcdef', 3), 'abc…（完整发布说明见发布页）');
});

test('parseUpdateSelfTestMode：四个档位；非法档绝不静默当默认', () => {
  assert.equal(parseUpdateSelfTestMode('offline'), 'offline');
  assert.equal(parseUpdateSelfTestMode(' UP-TO-DATE '), 'up-to-date');
  assert.equal(parseUpdateSelfTestMode('uptodate'), 'up-to-date');
  assert.equal(parseUpdateSelfTestMode('update'), 'update');
  assert.equal(parseUpdateSelfTestMode('download'), 'download');
  for (const bad of ['', '  ', 'off', '1', 'true', 'up-to-date-x']) {
    assert.equal(parseUpdateSelfTestMode(bad), null, `应判为非法档位：${bad}`);
  }
  assert.equal(parseUpdateSelfTestMode(undefined), null);
});
