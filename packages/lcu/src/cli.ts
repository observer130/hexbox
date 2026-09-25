#!/usr/bin/env node
/**
 * LCU 探测 CLI
 *
 * 验证内容：
 *   - LeagueClientUx.exe 命令行是否含 --app-port / --remoting-auth-token
 *     （需管理员权限；非管理员下 Windows 会屏蔽 CommandLine）
 *   - LCU REST 是否可访问
 *   - 当前游戏流阶段与模式识别
 *
 * 用法:
 *   node --experimental-strip-types packages/lcu/src/cli.ts
 *   node --experimental-strip-types packages/lcu/src/cli.ts --install-dir <安装目录>
 */

import { LcuClient, LcuEndpoints, isBrawlSession, type GameflowSession } from './client.ts';
import {
  detectCredentials,
  detectPortByListener,
  findLcuPort,
  findValidLockfile,
} from './detect.ts';

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(24)} ${value}`);
}

async function main(): Promise<void> {
  console.log('hexbox · LCU 探测\n');

  const dirs: string[] = [];
  const idx = process.argv.indexOf('--install-dir');
  if (idx >= 0 && process.argv[idx + 1]) dirs.push(process.argv[idx + 1]!);

  console.log('[1] 探测凭证');

  // 三级回退：命令行 → 有效 lockfile → lockfile(指定目录)
  let creds = await detectCredentials(dirs);
  let portOnly: { port: number; pid: number } | null = null;

  if (!creds && dirs.length > 0) {
    creds = await findValidLockfile(dirs);
    if (creds) console.log('     （通过递归查找 lockfile 得到）');
  }

  if (!creds) {
    const candidates = await detectPortByListener();
    portOnly = await findLcuPort(candidates);
    if (portOnly) {
      console.log(`  ⚠ 未取到密码，但确认 LCU 端口: ${portOnly.port} (pid ${portOnly.pid})`);
      if (candidates.length > 1) {
        console.log(`     （候选 ${candidates.map((c) => c.port).join(', ')} 中，该端口返回 401 = 需鉴权）`);
      }
      console.log('     原因：非管理员无法读进程命令行；且国服 lockfile 可能被清空。');
      console.log('     建议：以管理员身份重跑本探测以取得密码。\n');
      process.exitCode = 1;
      return;
    }
    console.log('  ✗ 未找到 LCU。请确认英雄联盟客户端已启动。');
    console.log('    可用 --install-dir 指定安装目录以启用 lockfile 回退。');
    process.exitCode = 1;
    return;
  }

  line('port', String(creds.port));
  line('来源', creds.source === 'cmdline' ? `进程命令行 (pid ${creds.pid ?? '?'})` : 'lockfile');
  if (creds.lockfilePath) line('lockfile', creds.lockfilePath);
  console.log('  ✓ 凭证可用\n');

  // LCU 自签名证书：官方要求忽略校验
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const client = new LcuClient(creds);

  console.log('[2] 连通性 —— /lol-summoner/v1/current-summoner');
  try {
    const me = await client.get<{ displayName?: string; gameName?: string; tagLine?: string }>(
      LcuEndpoints.currentSummoner,
    );
    const name = me.gameName ? `${me.gameName}#${me.tagLine ?? '?'}` : (me.displayName ?? '?');
    line('当前召唤师', name);
    console.log('  ✓ LCU 可访问\n');
  } catch (e) {
    console.log(`  ✗ 失败: ${e instanceof Error ? e.message : String(e)}`);
    console.log('     若超时/401，通常说明密码不对。\n');
    process.exitCode = 1;
    return;
  }

  console.log('[3] 游戏流状态');
  const session = await client.get<GameflowSession>(LcuEndpoints.gameflowSession).catch(() => null);
  if (session) {
    line('phase', String(session.phase ?? '未知'));
    line('gameMode', String(session.map?.gameMode ?? '—'));
    line('queueId', String(session.gameData?.queue?.id ?? '—'));
    line('是否海克斯乱斗', isBrawlSession(session) ? '✓ 是' : '否');
  } else {
    console.log('  （无进行中的对局/会话）');
  }

  console.log('\n[4] 复核：局内 swagger 是否含 augment 字段');
  console.log('     需在**真实对局中**执行（2999 端口仅在游戏中存在）:');
  console.log('       curl --insecure https://127.0.0.1:2999/swagger/v3/openapi.json');
  console.log('     检索: augment / cherry / kiwi');

  console.log('\n完成。');
}

main().catch((e: unknown) => {
  console.error('未捕获错误:', e);
  process.exitCode = 1;
});
