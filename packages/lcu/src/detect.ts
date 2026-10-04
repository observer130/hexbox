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
import { homedir } from 'node:os';
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
  /**
   * 凭证来源，便于诊断。
   *
   * `explicit` = 由环境变量 / 约定文件显式给出（免提权通道，
   * 见 `LCU_CREDENTIALS_ENV`）。
   */
  readonly source: 'lockfile' | 'cmdline' | 'explicit';
  /** 凭证文件路径（lockfile 或显式凭证文件来源时有值）。 */
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
 *
 * ⚠️ 必须自行关闭 TLS 校验：LCU 用自签证书，Node 的 fetch 会直接抛
 * `SELF_SIGNED_CERT_IN_CHAIN`（表现为 `TypeError: fetch failed`），
 * 于是**即使端口正确也判定不出来**。不能依赖调用方预先设置
 * `NODE_TLS_REJECT_UNAUTHORIZED` —— 那是全局副作用，设置时机不对或被
 * 其它代码重置就会静默失效（本项目真实踩过）。因此在函数内临时设置并还原。
 */
export async function findLcuPort(
  candidates: readonly { port: number; pid: number }[],
): Promise<{ port: number; pid: number } | null> {
  return await withInsecureTls(async () => {
    for (const c of candidates) {
      try {
        const res = await fetch(
          `https://127.0.0.1:${c.port}/lol-summoner/v1/current-summoner`,
          { signal: AbortSignal.timeout(2500) },
        );
        // 401 = 服务存在但缺凭证 → 就是 LCU
        if (res.status === 401) return c;
      } catch {
        // 超时/不可达 → 继续试下一个
      }
    }
    return null;
  });
}

/**
 * 在回调执行期间临时关闭 TLS 校验，结束后**无论成败都还原**。
 *
 * 为什么不用 undici.Agent：`undici` 在本仓库不是可解析的依赖
 * （Node 内置，但 `import 'undici'` 会 ERR_MODULE_NOT_FOUND），
 * 为一个探测函数引入新依赖不值得。环境变量方案零依赖、行为一致。
 *
 * 已知取舍：这是进程级开关，回调期间并发的 HTTPS 请求也会被一并豁免。
 * 本函数只用于探测本机 LCU 端口，调用点集中，风险可接受。
 *
 * ⚠️ `LcuClient` 内部也用它包裹每个请求 —— 因为「忘记关闭校验」
 * 这个坑在本项目已经踩过三次（findLcuPort、overlay、itemset-cli）。
 * 与其在每个入口重复设置，不如让客户端自己保证。
 */
export async function withInsecureTls<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = prev;
  }
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
 * 常见安装位置（国服 WeGame / 国际服）——用于 lockfile 自动发现。
 *
 * 国服实测路径形如 `E:\Games\WeGameApps\英雄联盟\LeagueClient\lockfile`，
 * 盘符与目录名都不可假定，因此这里只提供"可能的根"，真正定位靠递归查找。
 */
function commonInstallRoots(): string[] {
  const roots: string[] = [];
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    roots.push(
      `${drive}\\Program Files\\Tencent\\LeagueofLegends`,
      `${drive}\\Program Files (x86)\\Tencent\\LeagueofLegends`,
      `${drive}\\Games\\WeGameApps\\英雄联盟`,
      `${drive}\\WeGameApps\\英雄联盟`,
      `${drive}\\Tencent\\LeagueofLegends`,
      `${drive}\\Riot Games\\League of Legends`,
    );
  }
  return roots;
}

/** 探测结果：凭证 + 诊断信息（UI/日志据此给出可操作提示）。 */
export interface DetectResult {
  readonly credentials: LcuCredentials | null;
  /** 是否检测到客户端在运行（端口扫描有结果即为真）。 */
  readonly clientRunning: boolean;
  /** 探测阶段说明，供诊断展示。 */
  readonly detail: string;
}

/**
 * 显式凭证的**环境变量**名：`<端口>:<token>`。
 *
 * 为什么需要它：国服的 `LeagueClient\lockfile` 实测为 **0 字节**，
 * 于是**非管理员在这台机器上拿不到任何凭证**（命令行被 Windows 屏蔽、
 * lockfile 无内容）——开发与调试每次都要以管理员重开终端。
 * 由已提权的会话写入一次，之后的普通进程就能直接读：
 *
 *   ```powershell
 *   # 提权会话里执行一次（token 不在普通进程里打印）
 *   [Environment]::SetEnvironmentVariable('HEXBOX_LCU_CREDENTIALS', "$port`:$token", 'User')
 *   ```
 */
export const LCU_CREDENTIALS_ENV = 'HEXBOX_LCU_CREDENTIALS';

/** 显式凭证**文件**路径的环境变量名（内容为同一 `<端口>:<token>` 格式）。 */
export const LCU_CREDENTIALS_FILE_ENV = 'HEXBOX_LCU_CREDENTIALS_FILE';

/**
 * 约定凭证文件（用户级，**不随仓库提交**）。
 *
 * 与 lockfile 同格式：`LeagueClient:<pid>:<port>:<password>:<protocol>`。
 * 由使用者的提权会话写入一次，之后所有工具免提权可用。
 */
export function defaultCredentialsPath(): string {
  try {
    return join(homedir(), '.hexbox', 'lcu-credentials');
  } catch {
    return '';
  }
}

/**
 * 解析 `<端口>:<token>` 形式的显式凭证。
 *
 * 接受前缀 `riot:`（Basic 用户名），也接受锁定文件格式
 * （`LeagueClient:pid:port:password:protocol`），避免用户粘错格式。
 */
export function parseExplicitCredentials(raw: string | undefined): LcuCredentials | null {
  const s = (raw ?? '').trim();
  if (!s) return null;

  if (s.startsWith('LeagueClient:')) {
    const { port, password } = parseLockfile(s);
    if (!port || !password) return null;
    return { port, password, source: 'explicit' };
  }

  const body = s.startsWith('riot:') ? s.slice('riot:'.length) : s;
  const idx = body.indexOf(':');
  if (idx <= 0) return null;
  const port = Number.parseInt(body.slice(0, idx), 10);
  const password = body.slice(idx + 1).trim();
  if (!Number.isFinite(port) || port <= 0 || port > 65535 || !password) return null;
  return { port, password, source: 'explicit' };
}

/**
 * 读取显式凭证：环境变量优先，其次约定文件。
 *
 * ⚠️ 优先级**高于**命令行与 lockfile：显式给定的应当被尊重，
 * 否则用户在提权终端里设了值却被旧 lockfile 覆盖，会以为"设了没用"。
 */
export async function resolveExplicitCredentials(
  env: Record<string, string | undefined> = process.env,
): Promise<LcuCredentials | null> {
  const direct = parseExplicitCredentials(env[LCU_CREDENTIALS_ENV]);
  if (direct) return direct;

  const path = env[LCU_CREDENTIALS_FILE_ENV]?.trim() || defaultCredentialsPath();
  if (!path) return null;
  try {
    if (!existsSync(path)) return null;
    const parsed = parseExplicitCredentials(await readSharedText(path));
    if (!parsed) return null;
    return { ...parsed, lockfilePath: path };
  } catch {
    return null;
  }
}

/**
 * 完整探测：**显式凭证** → 命令行 → lockfile（显式目录 + 自动发现）→ 端口扫描。
 *
 * 返回**诊断信息**而不只是 null —— 「读不到凭证」有四种完全不同的原因
 * （客户端没开 / 命令行读不到 / lockfile 为空 / 端口不对），
 * 不给用户区分就只能是"程序在跑但什么都不显示"，极难排查。
 *
 * 注意：端口扫描只能定位端口，**拿不到 token**（token 只在命令行与
 * lockfile 里）。因此它不产出凭证，只用于区分"客户端没开"与"开了但读不到"。
 */
export async function detectCredentialsDetailed(
  installDirs: readonly string[] = [],
): Promise<DetectResult> {
  // 0) 显式凭证（免提权通道，见 LCU_CREDENTIALS_ENV）
  const explicit = await resolveExplicitCredentials();
  if (explicit) {
    return {
      credentials: explicit,
      clientRunning: true,
      detail: explicit.lockfilePath
        ? `来自显式凭证文件: ${explicit.lockfilePath}`
        : `来自环境变量 ${LCU_CREDENTIALS_ENV}`,
    };
  }

  // 1) 进程命令行（最可靠，但需管理员）
  const fromCmd = await detectFromCmdline();
  if (fromCmd) {
    return { credentials: fromCmd, clientRunning: true, detail: '来自进程命令行' };
  }

  // 2) 显式给定的安装目录
  for (const dir of installDirs) {
    const fromLock = await detectFromLockfile(dir);
    if (fromLock) {
      return { credentials: fromLock, clientRunning: true, detail: `来自 lockfile: ${dir}` };
    }
  }

  // 3) 自动发现 lockfile（覆盖国服 WeGame 的非常规路径）
  const auto = await findValidLockfile(commonInstallRoots());
  if (auto) {
    return {
      credentials: auto,
      clientRunning: true,
      detail: `来自 lockfile: ${auto.lockfilePath ?? '(自动发现)'}`,
    };
  }

  // 4) 端口扫描：仅用于诊断（无法取得 token）
  const ports = await detectPortByListener();
  if (ports.length === 0) {
    return { credentials: null, clientRunning: false, detail: '未检测到客户端进程' };
  }

  const lcu = await findLcuPort(ports);
  const detail = lcu
    ? `检测到客户端（LCU 端口 ${lcu.port}），但命令行不可读、lockfile 无有效内容`
    : `检测到客户端进程，但未找到 LCU 服务端口（候选: ${ports.map((p) => p.port).join(', ')}）`;
  return { credentials: null, clientRunning: true, detail };
}

/**
 * 探测 LCU 凭证：先试进程命令行（无需知道安装路径），
 * 失败则回退到 lockfile（显式目录 → 自动发现）。
 *
 * 需要诊断信息时请用 `detectCredentialsDetailed()`。
 */
export async function detectCredentials(
  installDirs: readonly string[] = [],
): Promise<LcuCredentials | null> {
  return (await detectCredentialsDetailed(installDirs)).credentials;
}

/** 生成 Basic 认证头（用户名固定为 `riot`）。 */
export function basicAuthHeader(password: string): string {
  const raw = `riot:${password}`;
  const encoded = typeof Buffer !== 'undefined'
    ? Buffer.from(raw, 'utf8').toString('base64')
    : btoa(raw);
  return `Basic ${encoded}`;
}
