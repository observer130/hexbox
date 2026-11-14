# `apps/web` —— hexbox 数据站

纯静态的**海克斯乱斗数据查询站**（Vue 3 + Vite）：海克斯图鉴（国服口径优先）、
官方胜率/选取率排行榜、英雄详情。没有后端、没有登录、不需要联网（数据在构建时打进
`dist/data`），可部署到任意静态托管（GitHub Pages / OSS / Nginx 子路径均可）。

> 仓库总体说明见 [README.md](../../README.md)，硬约束（不读内存/不注入/不解析封包）
> 与开发约定见 [AGENTS.md](../../AGENTS.md)；数据口径与流水线见
> [docs/ROADMAP.md](../../docs/ROADMAP.md)。

## 本地开发

```bash
# 1) 先准备数据（仓库根执行；生成 data/dataset.json + data/rankings.json）
pnpm sync

# 2) 起开发服务器（http://localhost:5273）
pnpm dev:web
```

`apps/web/vite.config.ts` 在 **dev** 阶段用中间件把仓库根 `data/*.json` 挂到
`/data/*.json`，所以改完数据刷新页面即可，不需要重启 Vite。**没有数据文件时页面会
显示加载失败**——先 `pnpm sync`。

## 构建与部署

```bash
pnpm --filter @hexbox/web build     # 产物在 apps/web/dist/
```

- `base: './'`（相对路径）→ 产物可以部署到任意子路径，不需要改配置；
- 构建时会把 `data/dataset.json`、`data/rankings.json` 拷到 `dist/data/`
  （`copyDataToDist`）—— **部署时 `dist/` 整个目录一起上传**，不要只传 `index.html`；
- 本地预览可用 `pnpm --filter @hexbox/web preview`；
- 数据更新 = 在仓库根重新 `pnpm sync` 后再构建、重新部署（数据站没有运行时后端）。

## 目录结构

| 路径 | 作用 |
|---|---|
| `src/App.vue` | 图鉴页：搜索/筛选/排序、模式与品质表、国服图标 |
| `src/components/RankView.vue` | 官方排行榜：海克斯榜/英雄榜、排序、统计日期 |
| `src/useDataset.ts` | 拉取两份数据 + 独立容错（图鉴失败整页报错、榜单失败只影响榜单区） |
| `src/validate.ts` | 运行时形状校验：旧/坏数据给「请重新 `pnpm sync`」而不是白屏 |
| `src/format.ts` | 展示口径：模式中文名、百分比、统计日期 `YYYY-MM-DD` |
| `src/augment-catalog.ts` | 图鉴合并（国服图鉴优先，CommunityDragon 只补缺） |
| `src/rarity.ts` | 品质标签/配色 |
| `src/styles.css` | 全局样式（含最小 `.sr-only`） |

## 测试与类型检查

```bash
pnpm --filter @hexbox/web typecheck   # vue-tsc
pnpm --filter @hexbox/web test        # node:test（纯函数：校验/格式化/合并）
```

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 页面「加载失败：未找到数据文件」 | 仓库根还没跑 `pnpm sync`，或部署时漏传 `dist/data/` |
| 页面「数据文件格式不兼容」 | 本地 `data/` 是旧版本产物 → 重新 `pnpm sync` 后刷新/重建 |
| 图鉴正常、排行榜显示加载失败 | `rankings.json` 缺失或上游当天无数据；图鉴不受影响，重新 `pnpm sync` 即可 |
| 部署到子路径后图片/数据 404 | 产物已用相对 `base`，请确认部署在**同一目录**下且 `dist/data` 一起上传 |
| 端口 5273 被占用 | Vite 会提示实际端口；或先关掉占用进程（默认端口见 `vite.config.ts`） |
