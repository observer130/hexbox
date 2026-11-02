/**
 * 「数据放哪儿 / 「更新数据」写到哪儿」的解析（纯函数，可单测）
 *
 * ── 为什么要解耦（2026-11 用户决策）──────────────────────────────────────
 *   数据不再跟着安装包走：安装包只装程序，数据放在**用户的文档目录**
 *   （`文档\hexbox\data`，OneDrive 重定向时由 Electron 的 known-folder 跟随）。
 *   好处：安装包更小；升级/卸载不会连带删掉数据；用户能直接打开、备份、拷走。
 *   代价：**首次运行自动联网下载一次**（安装包不再内置快照，后台静默完成）。
 *
 * ── 读取优先级（从高到低）────────────────────────────────────────────────
 *   1. `HEXBOX_DATA_DIR` / `--data-dir`  —— 显式指定，读写都用它；
 *   2. `文档\hexbox\data`                —— **默认位置（开发版也一样）**；
 *   3. `%LOCALAPPDATA%\hexbox\data`      —— 0.2 及以前的手动覆盖目录（打包版只读回退）；
 *   4. `<安装目录>\resources\data`        —— 旧安装包内置快照（打包版只读回退）；
 *   5. 开发仓库 `data/`                   —— 仅开发版，且只有文档目录还没有数据时。
 *   都读不到 → `source: 'none'`：首次运行，`update` 会往文档目录下载。
 *
 * ── 写入目标（永远与安装目录无关）────────────────────────────────────────
 *   **永远是 `文档\hexbox\data`**（或显式指定）。开发版也写这里 ——
 *   否则"开发时写仓库、装完写文档"会让两条路径的行为不一致（用户实测到的正是这个坑：
 *   对话框里显示写入 `D:\Projects\hexbox\data`）。
 *   仓库 `data/` 只在文档目录还没有数据时作为**只读基线**。
 *
 * ⚠️ 这里只做"路径 + 存在性 → 决策"，不碰 fs / Electron：
 *   主进程负责 `existsSync`，这样判据本身在 CI 里可测（overlay 在 CI 跑不起来）。
 */

/** 这次读的是哪儿（写进启动日志，用户问"数据在哪"时看它）。 */
export type DataDirSource =
  /** `HEXBOX_DATA_DIR` / `--data-dir`（读写都用它）。 */
  | 'explicit'
  /** 默认：`文档\hexbox\data`。 */
  | 'documents'
  /** 0.2 及以前：`%LOCALAPPDATA%\hexbox\data`（打包版只读回退）。 */
  | 'legacy-localappdata'
  /** 旧安装包内置快照：`resources\data`（打包版只读回退）。 */
  | 'install-snapshot'
  /** 开发仓库 `data/`（仅开发版，文档目录无数据时）。 */
  | 'dev-repo'
  /** 还没有任何数据（首次运行）。 */
  | 'none';

export interface DataLocationInput {
  readonly isPackaged: boolean;
  /** `HEXBOX_DATA_DIR` / `--data-dir`；没有则 null。 */
  readonly explicit: string | null;
  /** 默认数据目录（`<文档>\hexbox\data`）。 */
  readonly documentsDir: string;
  readonly documentsExists: boolean;
  /** 0.2 及以前的用户覆盖目录（`%LOCALAPPDATA%\hexbox\data`）。 */
  readonly legacyDir: string;
  readonly legacyExists: boolean;
  /** 旧安装包内置快照（`<安装目录>\resources\data`）。 */
  readonly installSnapshotDir: string;
  readonly installSnapshotExists: boolean;
  /** 开发仓库的 `data/`（打包版传 null）。 */
  readonly devRepoDir: string | null;
  readonly devRepoExists: boolean;
}

export interface DataLocation {
  /** 读哪个目录（可能是旧位置）。 */
  readonly dir: string;
  /** 「更新数据」写哪个目录（**永远**是文档目录或显式指定，不写安装目录）。 */
  readonly writeDir: string;
  readonly source: DataDirSource;
  /** 读到的是旧位置 → 启动日志要说明"更新会写到文档目录"。 */
  readonly legacyRead: boolean;
}

/** `DataDirSource` → 日志里的一句人话。 */
export const DATA_DIR_SOURCE_LABEL: Record<DataDirSource, string> = {
  explicit: '显式指定（HEXBOX_DATA_DIR / --data-dir）',
  documents: '用户文档目录（文档\\hexbox\\data）',
  'legacy-localappdata': '旧版用户目录（%LOCALAPPDATA%\\hexbox\\data，只读回退）',
  'install-snapshot': '旧安装包内置快照（resources\\data，只读回退）',
  'dev-repo': '开发仓库 data/（文档目录还没有数据）',
  none: '尚未下载（首次运行）',
};

/**
 * 解析数据目录。
 *
 * 纯函数：同样的输入永远给同样的输出，便于把"优先级/回退/迁移提示"钉在测试里。
 */
export function resolveDataLocation(input: DataLocationInput): DataLocation {
  // 写目标与"这次从哪儿读"无关：**永远**是显式目录或文档目录。
  const writeDir = input.explicit ?? input.documentsDir;

  if (input.explicit) {
    return { dir: input.explicit, writeDir: input.explicit, source: 'explicit', legacyRead: false };
  }

  if (input.documentsExists) {
    return { dir: input.documentsDir, writeDir, source: 'documents', legacyRead: false };
  }

  if (input.isPackaged) {
    if (input.legacyExists) {
      return {
        dir: input.legacyDir,
        writeDir,
        source: 'legacy-localappdata',
        legacyRead: true,
      };
    }
    if (input.installSnapshotExists) {
      return {
        dir: input.installSnapshotDir,
        writeDir,
        source: 'install-snapshot',
        legacyRead: true,
      };
    }
    // 首次运行：目录还不存在，但读写都指向它（下载时创建）
    return { dir: input.documentsDir, writeDir, source: 'none', legacyRead: false };
  }

  // 开发版：文档目录没数据时用仓库 data/ 作只读基线；写目标仍是文档目录。
  if (input.devRepoDir !== null && input.devRepoExists) {
    return { dir: input.devRepoDir, writeDir, source: 'dev-repo', legacyRead: false };
  }
  return {
    dir: input.documentsDir,
    writeDir,
    source: 'none',
    legacyRead: false,
  };
}
