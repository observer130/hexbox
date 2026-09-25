/**
 * LCU 本地客户端探测
 *
 * 官方依据：https://developer.riotgames.com/docs/lol → "League Client API"
 *   "This service is not officially supported for use with third party applications."
 *   即：允许使用，但不保证稳定。使用需注册产品。
 *
 * 两种取凭证方式（均来自官方文档与社区工具）：
 *   1. lockfile : 安装目录下 `lockfile`，格式 `Name:Pid:Port:Password:Protocol`
 *   2. 进程命令行: LeagueClientUx.exe 的 --app-port 与 --remoting-auth-token
 *
 * ⚠️ 安全边界：两种方式都**只读取进程元数据 / 本地文件**，
 *    **不会**打开游戏进程句柄、不读内存、不注入。
 *    这正是本项目"不碰游戏进程"承诺的落地。
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 解析 PowerShell 可执行文件的绝对路径。
 *
 * 不能依赖 `powershell.exe` 在 PATH 上 —— 实测用户环境中 PATH 不含它，
 * 导致 spawn ENOENT，且错误被静默吞掉，表现为"探测不到端口"却无报错。
 */
function resolvePowershell(): string {
  const candidates = [
    // 优先 Windows PowerShell 5.1（系统自带，路径固定）
    join(process.env['windir'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    join(process.env['windir'] ?? 'C:\\Windows', 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe', // 兜底：交给 PATH
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'powershell.exe';
}

const POWERSHELL = resolvePowershell();

/** 执行一段 PowerShell 脚本并返回 stdout。 */
async function runPs(script: string): Promise<string> {
  const { stdout } = await execFileAsync(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout.trim();
}

/** LCU 凭证。 */
export interface LcuCredentials {
  readonly port: number;
  readonly password: string;
  /** 凭证来源，便于诊断。 */
  readonly source: 'lockfile' | 'cmdline';
  /** lockfile 路径（仅 source=lockfile 时有值）。 */
  readonly lockfilePath?: string;
  /** 进程 PID（仅 cmdline 来源时有值）。 */
  readonly pid?: number;
}

/** 进程条目（仅使用元数据，不打开句柄）。 */
interface ProcessEntry {
  readonly ProcessId: number;
  readonly CommandLine: string | null;
  readonly Name: string;
}

/**
 * 通过 CIM 查询进程命令行。
 *
 * 注意：这里查询的是**进程元数据**（OS 提供），
 * 不是打开进程句柄，更不是读内存。
 */
async function queryProcesses(name: string): Promise<ProcessEntry[]> {
  try {
    const text = await runPs(
      `Get-CimInstance Win32_Process -Filter "Name='${name}'" |
         Select-Object ProcessId,CommandLine |
         ConvertTo-Json -Compress`,
    );
    if (!text) return [];

    const parsed: unknown = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];

    return list
      .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
      .map((p) => ({
        ProcessId: Number(p['ProcessId'] ?? 0),
        CommandLine: typeof p['CommandLine'] === 'string' ? p['CommandLine'] : null,
        Name: name,
      }))
      .filter((p) => p.CommandLine !== null);
  } catch {
    return [];
  }
}

/**
 * 通过监听端口发现 LCU 端口（无需 lockfile / 命令行权限）。
 *
 * 国服实测有效：即使 lockfile 被清空、命令行读不到，
 * 仍可通过 `LeagueClient.exe` 的高位监听端口定位 LCU。
 * 注意：该进程监听多个端口，需配合 findLcuPort() 逐个探测判定。
 */
export async function detectPortByListener(): Promise<Array<{ port: number; pid: number }>> {
  const ps = `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
      ForEach-Object {
        $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
        if ($p) { [PSCustomObject]@{ Port=$_.LocalPort; Pid=$_.OwningProcess; Name=$p.ProcessName } }
      } |
      Where-Object { $_.Name -eq 'LeagueClient' } |
      Sort-Object Port -Descending |
      ConvertTo-Json -Compress`;

  try {
    const text = await runPs(ps);
    if (!text) return [];
    const parsed: unknown = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
      .map((p) => ({ port: Number(p['Port']), pid: Number(p['Pid']) }))
      .filter((p) => Number.isFinite(p.port) && Number.isFinite(p.pid));
  } catch {
    return [];
  }
}

/**
 * 在候选端口中找出**真正提供 LCU 服务**的那个。
 *
 * 实测陷阱（国服）：`LeagueClient.exe` 会监听多个端口（如 13161 / 56695），
 * 其中只有部分提供 LCU REST。取"最大端口"是错的 —— 56695 会超时，13161 才是。
 *
 * 判定方法：无凭证请求 `/lol-summoner/v1/current-summoner`，
 * 返回 **401** 即说明是 LCU（鉴权失败但服务存在）。
 */
export async function findLcuPort(
  candidates: readonly { port: number; pid: number }[],
): Promise<{ port: number; pid: number } | null> {
  for (const c of candidates) {
    try {
      const res = await fetch(
        `https://127.0.0.1:${c.port}/lol-summoner/v1/current-summoner`,
        { signal: AbortSignal.timeout(2500) },
      );
      // 401 = 服务存在但缺凭证 → 就是 LCU
      if (res.status === 401) return c;
    } catch {
      // 超时/证书错误等 → 不是 LCU，或不可达，继续试下一个
    }
  }
  return null;
}

/**
 * 读取被占用的 lockfile（共享模式）。
 *
 * LCU 会独占打开 lockfile，直接读取会抛 "being used by another process"。
 * 必须用 FileShare.ReadWrite —— 这是所有 LCU 工具的标准做法。
 */
export async function readSharedText(path: string): Promise<string> {
  const { open } = await import('node:fs/promises');
  const handle = await open(path, 'r');
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/** 从命令行解析 port / token。 */
export function parseCmdline(cmd: string): { port?: number; token?: string } {
  const portMatch = /--app-port=(\d+)/.exec(cmd);
  const tokenMatch = /--remoting-auth-token=([\w-]+)/.exec(cmd);
  return {
    port: portMatch?.[1] ? Number(portMatch[1]) : undefined,
    token: tokenMatch?.[1],
  };
}

/** 解析 lockfile 内容。 */
export function parseLockfile(content: string): { port?: number; password?: string } {
  // 格式: LeagueClient:12345:54321:password:https
  const parts = content.trim().split(':');
  if (parts.length < 5) return {};
  const port = Number(parts[2]);
  const password = parts[3];
  return {
    port: Number.isFinite(port) && port > 0 ? port : undefined,
    password: password || undefined,
  };
}

/** 方式 1：从进程命令行探测。 */
export async function detectFromCmdline(): Promise<LcuCredentials | null> {
  const procs = await queryProcesses('LeagueClientUx.exe');
  for (const p of procs) {
    if (!p.CommandLine) continue;
    const { port, token } = parseCmdline(p.CommandLine);
    if (port && token) {
      return { port, password: token, source: 'cmdline', pid: p.ProcessId };
    }
  }
  return null;
}

/** 方式 2：从 lockfile 探测（共享读取，兼容文件被客户端占用的情况）。 */
export async function detectFromLockfile(installDir: string): Promise<LcuCredentials | null> {
  const path = join(installDir, 'lockfile');
  if (!existsSync(path)) return null;
  try {
    const { port, password } = parseLockfile(await readSharedText(path));
    if (!port || !password) return null;
    return { port, password, source: 'lockfile', lockfilePath: path };
  } catch {
    return null;
  }
}

/**
 * 在给定根目录内递归查找**有效**的 lockfile（内容非空）。
 *
 * 国服实测：WeGame 环境下 `LeagueClient\lockfile` 被清空为 0 字节，
 * 而 `Riot Client Data\...\lockfile` 有内容 —— 但那是 Riot Client 的。
 * 因此这里只接受**以 LeagueClient 开头**的有效锁文件。
 */
export async function findValidLockfile(
  roots: readonly string[],
  maxDepth = 4,
): Promise<LcuCredentials | null> {
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      const entries = await (async () => {
        const { readdir } = await import('node:fs/promises');
        return readdir(root, { recursive: true, withFileTypes: true });
      })();

      for (const e of entries) {
        if (!e.isFile() || e.name !== 'lockfile') continue;
        const depth = e.parentPath ? e.parentPath.split(/[\\/]/).length - root.split(/[\\/]/).length : 0;
        if (depth > maxDepth) continue;

        const full = join(e.parentPath ?? root, e.name);
        try {
          const text = await readSharedText(full);
          const { port, password } = parseLockfile(text);
          // 只接受 LCU 自己的锁文件，排除 Riot Client 的
          if (port && password && text.trimStart().startsWith('LeagueClient:')) {
            return { port, password, source: 'lockfile', lockfilePath: full };
          }
        } catch {
          /* 跳过读不了的 */
        }
      }
    } catch {
      /* 跳过无权访问的目录 */
    }
  }
  return null;
}

/**
 * 探测 LCU 凭证：先试进程命令行（无需知道安装路径），
 * 失败则回退到 lockfile（需提供安装目录）。
 */
export async function detectCredentials(
  installDirs: readonly string[] = [],
): Promise<LcuCredentials | null> {
  const fromCmd = await detectFromCmdline();
  if (fromCmd) return fromCmd;

  for (const dir of installDirs) {
    const fromLock = await detectFromLockfile(dir);
    if (fromLock) return fromLock;
  }
  return null;
}

/** 生成 Basic 认证头（用户名固定为 `riot`）。 */
export function basicAuthHeader(password: string): string {
  const raw = `riot:${password}`;
  const encoded = typeof Buffer !== 'undefined'
    ? Buffer.from(raw, 'utf8').toString('base64')
    : btoa(raw);
  return `Basic ${encoded}`;
}
