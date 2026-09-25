import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const dataFile = join(repoRoot, 'data', 'dataset.json');

/**
 * 把仓库根的 `data/dataset.json` 挂到 `/data/dataset.json`。
 *
 * 为什么不用 publicDir：数据由 `pnpm sync` 独立更新，
 * 不应进入前端源码目录，也不应在每次构建时被复制一遍。
 */
function serveDataset(): Plugin {
  return {
    name: 'hexbox-serve-dataset',
    configureServer(server) {
      server.middlewares.use('/data/dataset.json', (_req, res) => {
        if (!existsSync(dataFile)) {
          res.statusCode = 404;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'dataset.json not found; run `pnpm sync`' }));
          return;
        }
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-cache');
        createReadStream(dataFile).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [vue(), serveDataset()],
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
