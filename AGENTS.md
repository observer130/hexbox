# AGENTS.md

Working notes for AI coding agents on **hexbox**. Read alongside
[README.md](README.md); deep detail lives in `docs/` — this file is the contract.

## Overview

`hexbox` is a League of Legends **海克斯乱斗 (Hextech Mayhem / Brawl rotation mode)**
helper with two surfaces: a **data site** (`apps/web`, Vue 3 + Vite: augments + official
CN win/pick rates) and an **overlay** (`apps/overlay`, Electron: champ-select win-rate
labels, in-game augment tier badges, item-set writes into the client).

> **Hard constraint (do not skip): no memory reading, no injection, no packet parsing.**
> The overlay never opens a handle to the game process and never inspects memory or
> traffic. Only official/public surfaces are allowed (CommunityDragon, Data Dragon,
> Tencent CN first-party, the LCU local REST API, the game's Live Client Data API at
> `127.0.0.1:2999`) plus **screenshot recognition of the official UI**.

## Data sourcing (guidance, not a gate)

No compliance gate and no policy table in code — do not reintroduce `assert*Allowed()`.
`ProviderInfo.dataClass` (`packages/core/src/provider.ts`) is a descriptive UI label, not
allow/deny semantics. **Only use fields the official UI actually shows** (a real mistake:
upstream `itemover_rec` was used to invent a "six-item build" slot the 101 page never
displays).

- Prefer first-party sources (`101.qq.com`, `mlol.qt.qq.com`, `game.gtimg.cn`,
  CommunityDragon, Data Dragon, LCU) and label them in the UI. Screenshot + OCR of the
  official UI is normal — it reads on-screen pixels only; if a task seems to need
  memory/injection/packets, ask the user instead.
- In-game augment offers are labelled "read from screen", never as an API value.

## Layout

pnpm monorepo (10 projects: 8 packages + 2 apps). One concern per file: the per-file map
lives in each file's header.

```
packages/  core      models + Provider iface + overlay-view + itemset
           vision    screenshot recognition — all pure functions (geometry … fixtures)
           provider-communitydragon, provider-tencent, provider-registry
           data-store, data-cli, lcu (probe/REST/itemset CLI/live-data 2999/identity)
apps/      web       data query site
           overlay   Electron: main/ (controller, windows, geometry, tray, recorder),
                     capture/worker.ts (gating + native-resolution recognition),
                     replay/ (frame-store driven closed-loop replay)
data/      generated + gitignored   scripts/  diagnostics + one-offs
docs/      ROADMAP, OVERLAY-STAGES, build-slots, SCREENSHOT-DEV, AUGMENT-PANEL,
           SESSION-REPLAY, RELEASE-WINDOWS, SESSION-NOTES
```

## Setup / environment

```bash
pnpm install && pnpm sync && pnpm templates   # data + templates
pnpm dev:web                                  # http://localhost:5273
```

- pnpm is not vendored; without it run TS directly with system Node, e.g.
  `node --experimental-strip-types packages/data-cli/src/cli.ts sync`.
- The overlay needs **admin + a real desktop**; it cannot run in headless CI.
- From the DSH harness, clear `ELECTRON_RUN_AS_NODE` for Electron children; the
  recorder/self-test additionally need `--no-sandbox --disable-gpu`.

## Gates

`pnpm typecheck` → `pnpm test` → `pnpm build` (CI runs the same on `windows-latest`).
Node's built-in runner; `pnpm --filter @hexbox/core test` is faster. **Keep them green
and add tests for new behavior.** Current: **1034** — core 55 / vision 707 / lcu 129 /
overlay 41 / provider-communitydragon 12 / provider-tencent 43 / data-store 17 /
data-cli 30 (`pnpm test` is the source of truth; the overlay's Electron runtime is not
testable — its tests cover replay-safe parts and the self-test scenario logic only).

## Rules that must not be broken

Read the doc named per area first; every rule below cost a real bug.

**Overlay / labels** — `docs/SCREENSHOT-DEV.md`, `docs/OVERLAY-STAGES.md`

- **Untestable in CI** → keep decisions in pure functions under `packages/core` or
  `packages/vision` (an inline "should the panel show" in the main process once made the
  diagnostic panel appear only on cold start).
- **No visible window: the tray is the only entry point and the only way to quit.**
  Closing hides (`attachCloseToTrayHide`); the only exit is the tray's 退出 → `quitApp()`.
  `requestSingleInstanceLock()` is mandatory (two processes = overlapping labels +
  different strength tables); the credentials balloon fires once per session.
- **The label canvas sizes itself from the window** — `innerWidth × dpr` on load, on
  resize and **before every draw**; tied to any message it stays 300×150 and every label
  lands off-canvas ("drawn" in the log, nothing on screen). It is re-raised and re-pushed
  (the game steals z-order), `pushLabelOverlay` is the **only** screen-absolute →
  window-relative conversion, and a missing `dist/renderer/*.js` is silent (`build.mjs`
  fails the build when an HTML src points nowhere).
- **Never trust a geometry probe — always search a fallback.** In-game: `region` +
  `altRegion`. Champ-select: the capture is a **window** snapshot, so `snapshotKind`'s
  tie-break (`winShare < 0.9 → display`) inverts on a 16:9 monitor with the default
  1600×900 client window — region `0.083 + 0.833`, layout off 90–130 px, **every card and
  top-bar identity lost**; `champ-select-capture-form.ts` tries **both** forms (top-bar
  identities > card criteria > primary) and `region` must stay paired with `geo`
  (`legacy`/`off` keep the old path) — `docs/SCREENSHOT-DEV.md` §9.7.
- **Never take full-resolution frames with `desktopCapturer` mid-match** (a DWM stall
  froze the system cursor ~1 s); use the already-running screen stream in the renderer.
- **Ctrl+C never reaches Electron** → launch via `apps/overlay/run-electron.mjs`, which
  writes the `debug/augment/.stop` sentinel.

**In-game augment chain** — `docs/AUGMENT-PANEL.md`, `docs/SESSION-REPLAY.md`

- Both entries run the **same** `AugmentController`, which must not import Electron
  (clock/capture/geometry/2999/identity injected) so replay can drive it; **replay
  drives, it never re-implements**, and `vision/augment-recognize.ts` is the single core.
- **Never invent a tier**: the official per-champion table covers ~211 of 248 augments —
  unknown, or unsure OCR → draw nothing. Show the **pick rate**, worded as this
  champion's official stats, never as "what you were offered".
- **"Which champion am I" has one source: `me`** (`resolveMyChampionIdentity`) — never
  scan a list (a real bug showed a teammate's table); a high hit count proves nothing.
- Label geometry/colors/text come only from `augment-label.ts`, `augment-tier-label.ts`
  and `label-draw.ts` (the offline preview shares them) — re-implementing them in
  `renderer/overlay-canvas.ts` makes that preview lie.
- The recorder persists the champion identity and starts before `controller.start()`;
  `atMs` is absolute everywhere; recordings keep the exact frames the gate saw.

**Data / LCU** — `docs/build-slots.md`

- **Always use `LcuClient`** (`withInsecureTls()`): a bare `fetch` fails with
  `SELF_SIGNED_CERT_IN_CHAIN` (hit three times), so never set
  `NODE_TLS_REJECT_UNAUTHORIZED` per entry point; `getOrNull()` for normal 404s,
  `LcuHttpError.isAuthFailure` before dropping credentials.
- Writing player data: only ever replace `hexbox…`-titled item sets (Brawl's map ID is
  **12**), and `itemone_json` lists **20** entries = 其余成装 with the top **5** = 出门装
  (we write only the top 1) — that overlap is official, not a bug.
- **No date-dependent tests** (stat dates come from the real clock); keep the
  `isDirectRun()` guard in `packages/data-cli/src/cli.ts`.
- **Data update = one pipeline**: the overlay calls `runDefaultSync()` (data-cli) only —
  never a second fetch path in `apps/overlay`; an empty/failed stage **never overwrites**
  an existing file (atomic per-file writes); cancel goes through the flow's `AbortSignal`
  so quitting never leaves hundreds of pending requests. The app writes to the **user**
  dir (`文档\hexbox\data`, resolved by `vision/data-location.ts`; legacy
  `%LOCALAPPDATA%\hexbox\data` and old `resources\data` are read-only fallbacks),
  never the install dir. The installer ships **no** data: **startup auto-syncs** silently
  (first run downloads it; later runs download only when the official date is newer).

**TypeScript / style**

- TS runs as source (`node --experimental-strip-types`): `.ts` extensions in imports;
  `erasableSyntaxOnly` forbids `enum`/parameter properties/`namespace`; `import type` and
  `export type` are required by `verbatimModuleSyntax`/`isolatedModules`.
- `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`; single quotes, no
  semicolons, functional where reasonable, Chinese comments are fine.

## Environment knobs

Chain defaults live in `apps/overlay/src/main/augment-controller.ts`, recording-only ones
in `debug-augment.ts`.

| Variable | Meaning |
|---|---|
| `HEXBOX_AUGMENT_TRIGGER` / `_CAPTURE` / `_THUMB_SCALE` / `_API_POLL_MS` | `api` = zero frames normally (opens on death/level-up) vs default `pixel` / `stream` / canvas scale ≥0.25 / 2999 poll 1000 |
| `HEXBOX_AUGMENT_REROLL_POLL_MS` / `_OPEN_SAMPLE_MS` / `_IDLE_MS` / `_ACTIVE_MS` / `_PROBE_MS` / `_TAIL_MS` | open-panel sampling (400 / 4000) and cadence (1000/250/6000/20000) |
| `HEXBOX_AUGMENT_FORENSICS` / `_CLOSED_SAMPLES` / `_API_TRACE` / `_CLOSE_HEAL_PROBE` / `_PENDING_PROBE_MS` | opt-in diagnostics; both probes are **off** (strict zero frames) |
| `HEXBOX_AUGMENT_RECORD` / `_RECORD_DIR` / `_OUT` / `_SECONDS` / `_MAX_MINUTES` / `_DRAW` / `_BADGE` | session recording (**off**), labels (on), badge size `small` / `medium` / `large` |
| `HEXBOX_OVERLAY_AUGMENT` / `HEXBOX_CHAMP_SELECT_CARDS` / `HEXBOX_DATA_DIR` / `HEXBOX_DATA_CHECK` / `HEXBOX_LOG_FILE` / `HEXBOX_SMOKE` / `HEXBOX_TRAY_*` / `HEXBOX_NOTICE_TEST` / `HEXBOX_LCU_CREDENTIALS(_FILE)` / `HEXBOX_LABEL_OVERLAY_TEST(_MS)` / `HEXBOX_DEBUG_FORCE` / `_SELFTEST_CADENCE` | chain toggle / card source `geometry` / `legacy` / `off` / data dir（默认 `文档\hexbox\data`） / `0` = 关闭启动数据检查 / log tee / smoke / tray self-test + icon / balloon test / LCU credentials / self-tests |

## Game-free checks (no game required)

```powershell
$env:HEXBOX_LABEL_OVERLAY_TEST='1'; pnpm dev:overlay   # overlay window only (needs a desktop)
node --experimental-strip-types scripts/preview-augment-labels.mts         # → debug/label-preview.png
node --experimental-strip-types scripts/diag-champ-select-cards.mts --ocr  # real frames, online code
node --experimental-strip-types scripts/diag-lcu-events.mts --all          # live LCU event subscription
node --experimental-strip-types scripts/replay-session.mts [debug/sessions/<dir>]
```
> The label-overlay self-test also runs three scenarios by itself (hover tooltip via the
> forwarded `mousemove`, no residue after a clear, canvas follows a window resize) and
> prints the failure taxonomy from `packages/vision/src/failure-taxonomy.ts`; it exits
> non-zero if any scenario fails (`debug/label-overlay-hover.png` shows the tooltip).
> `diag-lcu-events.mts` needs a running client with readable credentials (admin, or
> `HEXBOX_LCU_CREDENTIALS`); without them it proves only the handshake path (HTTP 401).
> `$env:` values are session-scoped: unset them, or `pnpm dev:overlay` runs that self-test
> and exits by itself (by design).

## Commits / out of scope

- Conventional messages (English or Chinese summaries); keep `pnpm test` and
  `pnpm typecheck` green before committing.
- Never commit `node_modules/`, `dist/`, `data/`, `debug/` (real-machine screenshots and
  recordings), `.env*`, `*.log`, or local LCU tokens/paths.
- Out of scope: memory injection, process hooking, packet inspection (ask the user);
  third-party scraped/repackaged data.
