/**
 * **打包后**的用户级路径（日志 / 数据 / 自测产物）。
 *
 * 两道口径：
 *   1. **数据**放在用户能看见、能备份的地方 —— `文档\hexbox\data`（2026-11 起，
 *      与安装目录解耦：升级/卸载不会连带删数据，安装包也不用再内置快照）；
 *   2. **日志/自测产物**放 `%LOCALAPPDATA%\hexbox\`（机器级排障产物，不该出现在文档里）：
 *
 *     文档\hexbox\
 *       data\…                 数据快照（图鉴/榜单/详情/模板）
 *       data-check.json        启动检查的节流状态（与数据一起备份/清理）
 *     %LOCALAPPDATA%\hexbox\
 *       logs\overlay.log       运行日志（无控制台的 GUI 进程只能靠它）
 *       logs\selftest\…        覆盖窗自测产物（截图/结论）
 *
 * ⚠️ 开发（`pnpm dev:overlay`）时日志/自测仍写在仓库里；数据目录由
 *    `resolveDataLocation()` 决定（默认仍是仓库 `data/`，见 `vision/data-location.ts`）。
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

/** 旧版数据覆盖目录（0.2 及以前）：`%LOCALAPPDATA%\hexbox\data`（现在只作只读回退）。 */
export function packagedDataDir(): string {
  return join(userHexboxDir(), 'data')
}

/**
 * 用户数据根目录：`文档\hexbox`。
 *
 * ⚠️ 必须用 `app.getPath('documents')`（Windows known folder），不能拼
 * `%USERPROFILE%\Documents`：文档目录可能被 OneDrive / 组策略重定向，
 * 拼字符串会把数据写到一个用户根本看不到的地方。
 */
export function documentsDataRoot(): string {
  try {
    return join(app.getPath('documents'), 'hexbox')
  } catch {
    // 极端情况（known folder 配置损坏）：退回 LOCALAPPDATA，保证程序还能跑
    return userHexboxDir()
  }
}

/** 数据目录：`文档\hexbox\data`（**不再随安装包走**）。 */
export function documentsDataDir(): string {
  return join(documentsDataRoot(), 'data')
}

/** 「有没有新数据」的节流状态：`文档\hexbox\data-check.json`。 */
export function dataCheckStatePath(): string {
  return join(documentsDataRoot(), 'data-check.json')
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
