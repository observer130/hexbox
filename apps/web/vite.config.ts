import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { copyFileSync, createReadStream, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const dataDir = join(repoRoot, 'data');
/** 构建产物里的数据目录（`apps/web/dist/data`）。 */
const outDataDir = fileURLToPath(new URL('./dist/data', import.meta.url));

/**
 * 部署产物必须自带的数据文件（覆盖层专用的 builds/templates 不进站点）。
 * 数据由 `pnpm sync` 独立生成、不进仓库，所以只能在构建期拷贝。
 */
const PUBLIC_DATA_FILES = ['dataset.json', 'rankings.json'] as const;

/**
 * dev：把仓库根的 `data/*.json` 挂到 `/data/*.json`。
 *
 * 生产：由 `copyDataToDist()` 把同样的文件拷进 `dist/data/`，
 * 页面始终用**相对路径** `data/*.json` 加载（见 `useDataset.ts`）。
 *
 * 为什么不用 publicDir：数据由 `pnpm sync` 独立更新，
 * 不应进入前端源码目录，也不应在每次构建时被复制一遍。
 */
function serveDataFiles(): Plugin {
  const files = new Map([
    ['/data/dataset.json', join(dataDir, 'dataset.json')],
    ['/data/rankings.json', join(dataDir, 'rankings.json')],
  ]);
  return {
    name: 'hexbox-serve-data',
    configureServer(server) {
      for (const [route, file] of files) {
        server.middlewares.use(route, (_req, res) => {
          if (!existsSync(file)) {
            res.statusCode = 404;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: `${route} not found; run \`pnpm sync\`` }));
            return;
          }
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('cache-control', 'no-cache');
          createReadStream(file).pipe(res);
        });
      }
    },
  };
}

/**
 * build：把 `data/{dataset,rankings}.json` 拷进 `dist/data/`。
 *
 * 这是「数据站能真正部署」的关键一步：生产页面用相对路径加载数据，
 * 产物里没有数据 → 部署后整页 404。
 *
 * CI 不跑 `pnpm sync`（不联网、不依赖上游），因此缺少数据时**只警告不失败**；
 * 发布前请在仓库根先跑 `pnpm sync` 再构建（`README.md` 的「数据站部署」）。
 */
function copyDataToDist(): Plugin {
  return {
    name: 'hexbox-copy-data',
    apply: 'build',
    closeBundle() {
      mkdirSync(outDataDir, { recursive: true });
      let copied = 0;
      for (const file of PUBLIC_DATA_FILES) {
        const src = join(dataDir, file);
        if (!existsSync(src)) {
          console.warn(
            `[hexbox-web] ⚠ 缺少 ${src} → 产物不含 data/${file}（发布前先 pnpm sync）`,
          );
          continue;
        }
        copyFileSync(src, join(outDataDir, file));
        copied++;
      }
      if (copied > 0) {
        console.log(
          `[hexbox-web] 数据已拷入 dist/data（${copied}/${PUBLIC_DATA_FILES.length}）`,
        );
      }
    },
  };
}

export default defineConfig({
  // 相对基址：允许部署到子路径（GitHub Pages 项目页 / Nginx 子目录 / 内网路径）。
  base: './',
  plugins: [vue(), serveDataFiles(), copyDataToDist()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5273,
    fs: { allow: [repoRoot] },
  },
});
