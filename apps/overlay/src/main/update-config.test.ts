/**
 * 更新配置里的**安全判据**测试（不需要 Electron / 网络）
 *
 * 锁定的审查 P2：
 *   · token 只能发给 api.github.com（旧实现用 `url.includes(...)`，可被恶意 URL 骗过）；
 *   · "打开下载页"只允许本仓库的 GitHub 网页（`html_url` 来自外部 Release JSON）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GITHUB_REPO,
  isGitHubApiUrl,
  isTrustedReleasePageUrl,
  releasesPageUrl,
} from './update-config.ts';

test('isGitHubApiUrl：只认 https://api.github.com 主机', () => {
  assert.equal(isGitHubApiUrl('https://api.github.com/repos/x/y/releases/latest'), true);
  assert.equal(isGitHubApiUrl('https://API.GITHUB.COM/x'), true, 'hostname 大小写不敏感');
  assert.equal(isGitHubApiUrl('https://api.github.com.evil.test/x'), false);
  assert.equal(isGitHubApiUrl('https://evil.test/?next=api.github.com'), false);
  assert.equal(isGitHubApiUrl('http://api.github.com/x'), false, '必须 https');
  assert.equal(isGitHubApiUrl('not a url'), false);
});

test('isTrustedReleasePageUrl：只放行本仓库的 GitHub 网页', () => {
  assert.equal(isTrustedReleasePageUrl(releasesPageUrl()), true);
  assert.equal(isTrustedReleasePageUrl(`https://github.com/${GITHUB_REPO}/releases/tag/v0.1.0`), true);
  assert.equal(isTrustedReleasePageUrl('https://github.com/other/repo/releases'), false);
  assert.equal(isTrustedReleasePageUrl('https://evil.test/github.com/observer130/hexbox'), false);
  assert.equal(isTrustedReleasePageUrl(`http://github.com/${GITHUB_REPO}`), false, '必须 https');
  assert.equal(isTrustedReleasePageUrl(''), false);
});
