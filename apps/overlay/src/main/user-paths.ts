/**
 * **打包后**的用户级路径（日志 / 数据覆盖 / 自测产物）。
 *
 * 为什么单独一个模块：
 *   打包后程序运行在**安装目录**（NSIS 每用户安装默认落在
 *   `%LOCALAPPDATA%\Programs\hexbox`），而仓库里的口径是"什么都写在仓库根下"
 *   （`debug/`、`data/`…）。安装目录不是仓库根，也**不该**往里写东西
 *   （升级/卸载会整个删掉；Program Files 布局下甚至不可写）。
 *   所以打包后统一改写到用户目录 `%LOCALAPPDATA%\hexbox\`：
 *
 *     %LOCALAPPDATA%\hexbox\
 *       logs\overlay.log      运行日志（无控制台的 GUI 进程只能靠它）
 *       logs\selftest\…       覆盖窗自测产物（截图/结论）
 *       data\…                用户放进去的数据快照（可覆盖安装目录里的那份）
 *
 * ⚠️ 开发（`pnpm dev:overlay`）时这些函数**不生效** —— 一切照旧写在仓库里，
 *    否则"跑一次开发版就往 LOCALAPPDATA 里塞东西"，排查时会看到两份数据。
 */

import { app } from 'electron'
import { join } from 'node:path'

/** 打包后的用户根目录：`%LOCALAPPDATA%\hexbox`（拿不到就退回 Electron 的 userData）。 */
export function userHexboxDir(): string {
  const local = process.env['LOCALAPPDATA']
  return local ? join(local, 'hexbox') : app.getPath('userData')
}

/** 打包后的日志文件：`%LOCALAPPDATA%\hexbox\logs\overlay.log`。 */
export function packagedLogFile(): string {
  return join(userHexboxDir(), 'logs', 'overlay.log')
}

/** 打包后的**数据覆盖目录**：`%LOCALAPPDATA%\hexbox\data`（放了 `dataset.json` 就整套用它）。 */
export function packagedDataDir(): string {
  return join(userHexboxDir(), 'data')
}

/**
 * 打包后的自测/诊断产物目录：`%LOCALAPPDATA%\hexbox\logs\selftest`。
 *
 * 开发时是 `<仓库根>\debug`，打包后绝不能再往 `process.cwd()` 下写 ——
 * 双击 exe 时 cwd 可能是 `C:\Windows\System32` 之类。
 */
export function packagedArtifactDir(): string {
  return join(userHexboxDir(), 'logs', 'selftest')
}
