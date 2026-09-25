# AGENTS.md

A README for AI coding agents working on **hexbox**. Read this alongside
[README.md](README.md), [COMPLIANCE.md](COMPLIANCE.md), and the docs under
`docs/`.

## Project overview

`hexbox` is a League of Legends **海克斯乱斗 (Hextech Mayhem / "Hexakill" arena
mode)** helper with two surfaces:

- A **data query site** (`apps/web`, Vue 3 + Vite) that shows official public
  static data: hextech augments, champions, items.
- An **in-game overlay** (`apps/overlay`, Electron) that assists the player.

Hard product constraint (see COMPLIANCE.md, do **not** skip it):

> **No memory reading, no injection, no packet parsing.** The overlay never
> opens a handle to the game process, never injects, never inspects memory or
> network traffic. It may only use official/legal surfaces (CommunityDragon
> static data, and the LCU local REST API when available).

## ⚠️ Compliance boundary — load-bearing, not optional

This is the single most important rule for this repo. The compliance boundary
is **enforced in code** at `packages/core/src/compliance.ts`
(`DATA_POLICY` + `assertDataClassAllowed()`), locked by tests in
`packages/core/src/compliance.test.ts`.

- Only show **official public static data** (`static-definition`,
  `static-numeric`, `pregame-visible`).
- We **deliberately do not** display augment / arena win rates
  (`augment-performance` is a policy red line per Riot's developer policy),
  nor live in-session data (`live-session`), nor (by default) mode win rates
  (`mode-performance`).
- `packages/provider-registry` `createPerformanceProviders()` **intentionally
  returns an empty array** — that is the reserved slot, not a TODO to fill.
- Do **not** "fix" the empty array, do **not** flip any `DATA_POLICY` entry to
  `allowed`, and do **not** wire up the Tencent 一方 win-rate endpoint
  (`docs/101qq-api-findings.md`). Tests will fail by design, and that is correct.
- Enabling any statistics class requires **explicit written approval from Riot**
  first. Until then, treat the boundary as immutable.

If a task seems to require crossing this boundary, stop and ask the user rather
than working around it.

## Repository layout

pnpm workspace monorepo.

```
packages/
  core/                       domain models + compliance gate + Provider iface
  provider-communitydragon/  static data source (v1, only one enabled)
  provider-registry/          registry (reserved stats slots intentionally empty)
  data-store/                 local FS cache (offline fallback)
  data-cli/                   sync / status CLI
  lcu/                        LCU probe + REST client (local API only)
apps/
  web/                        data query site (Vue 3 + Vite)
  overlay/                    in-game overlay (Electron)
docs/                         research + findings
```

## First-time setup

```bash
pnpm install        # pnpm 11.7.0 (see packageManager field)
pnpm sync           # pull CommunityDragon static data → ./data/dataset.json
pnpm dev:web        # data site → http://localhost:5273
```

> **Environment notes**
> - On this machine `pnpm` lives only inside the DSH bundled runtime, not on the
>   system PATH. In an external terminal, run TS scripts directly with the system
>   Node (`C:\Program Files\nodejs\node.exe`, v24):
>   `node --experimental-strip-types packages/data-cli/src/cli.ts sync`
> - The overlay needs **admin privileges + a real desktop session** to run; it
>   cannot be exercised in a headless CI.

## Build, typecheck, test

From the repo root:

```bash
pnpm typecheck     # pnpm -r typecheck (full project)
pnpm test          # pnpm -r test     (compliance 7 + lcu 8 + others)
pnpm build         # pnpm -r build
pnpm dev:web       # web dev server
pnpm dev:overlay   # overlay (admin + desktop required)
```

Run a single package (faster iteration):

```bash
pnpm --filter @hexbox/core test
pnpm --filter @hexbox/web typecheck
```

Tests use Node's built-in runner: `node --experimental-strip-types --test ...`.
**Make the suite green before committing.** New behavior must include/extend
tests, especially anything touching `compliance.ts`.

## TypeScript conventions (enforced in tsconfig.base.json)

The project runs TS **as source** via `node --experimental-strip-types`
(strip-only, no type stripping of runtime semantics). Follow these or it won't
run:

- `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`.
- Imports **must include the `.ts` extension** (`allowImportingTsExtensions`).
- `erasableSyntaxOnly: true` — **forbidden**: `enum`, parameter properties,
  `namespace`. Use `const` objects / `as const` / union types instead.
- `verbatimModuleSyntax: true` — use `import type` for type-only imports.
- `isolatedModules: true` — re-export types with `export type`.
- Prefer functional patterns and explicit types; no semicolons, single quotes.

## Code style

- TypeScript, strict mode, functional where reasonable.
- Single quotes, no trailing semicolons.
- Comments in Chinese are fine and consistent with the rest of the repo.
- Keep `COMPLIANCE.md` and the code gate in sync: if policy intent changes,
  update both the markdown and `DATA_POLICY`.

## Commit / PR guidelines

- Conventional, descriptive commit messages in English or Chinese summaries.
- Keep `pnpm test` and `pnpm typecheck` green before committing.
- Never commit: `node_modules/`, `dist/`, `data/` (regenerated by `pnpm sync`),
  `.env*`, `*.log` — already covered by `.gitignore`.
- Do not commit local LCU tokens/paths; the LCU client reads them at runtime.

## Out of scope (do not add without explicit approval)

- Any memory injection, game-process hooking, or packet inspection.
- Win-rate / performance statistics for augments, arena items, or modes.
- New data sources that aren't official/public under Riot's "Legal Jibber
  Jabber" policy without prior written Riot approval.
