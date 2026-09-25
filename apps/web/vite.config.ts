import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const dataDir = join(repoRoot, 'data');

/**
 * 把仓库根的 `data/*.json` 挂到 `/data/*.json`。
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

export default defineConfig({
  plugins: [vue(), serveDataFiles()],
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
