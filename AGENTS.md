# AGENTS.md

A README for AI coding agents working on **hexbox**. Read this alongside
[README.md](README.md).

## Project overview

`hexbox` is a League of Legends **海克斯乱斗 (Hextech Mayhem / Brawl rotation mode)**
helper with two surfaces:

- A **data query site** (`apps/web`, Vue 3 + Vite) that shows hextech augments and the
  official CN win-rate / pick-rate rankings for the mode.
- An **in-game overlay** (`apps/overlay`, Electron) that assists the player: champ-select
  win-rate labels on the champion cards, in-game augment tier badges (S/A/B/C + pick rate),
  and item-set writes into the client.

Hard product constraint (do **not** skip it):

> **No memory reading, no injection, no packet parsing.** The overlay never
> opens a handle to the game process, never injects, never inspects memory or
> network traffic. It may only use official/public data surfaces (CommunityDragon,
> Data Dragon, Tencent first-party public data for the CN server, the LCU local
> REST API, and the game's own **Live Client Data API** at `127.0.0.1:2999`),
> plus **screenshot recognition of the official UI**.

## Data sourcing (guidance, not a gate)

There is **no compliance gate and no policy table in code** — they were removed.
Do not reintroduce an `assert*Allowed()` style blocker.

`ProviderInfo.dataClass` (see `packages/core/src/provider.ts`) is a plain
descriptive label used to attribute data in the UI. It carries no allow/deny
semantics.

**Use only fields the official UI actually shows.** A real mistake: the upstream
`itemover_rec` field was used to invent a "six-item build" slot that the official
101 page never displays, so the user could not verify where it came from. If a
field is not surfaced officially, either skip it or label its provenance
explicitly — do not present it as official.

What this means in practice:

- Prefer official / first-party sources (CommunityDragon, Data Dragon, Tencent
  CN official such as `101.qq.com`, `mlol.qt.qq.com`, `game.gtimg.cn`, and the
  local LCU REST API). Label the source in the UI.
- Screenshot + OCR of the official game UI is a **normal, acceptable** technique.
  It reads only on-screen pixels and is not an invasive method.
- **Do not** read game memory, inject, hook the game process, or parse packets.
  That is the one hard technical line, and it is a product decision — not a
  policy engine. If a task seems to need it, ask the user.
- A `live-session`-labelled source (in-game augment offers) is fine; label it in
  the UI as "read from screen" rather than an API value.

## Repository layout

pnpm workspace monorepo (10 projects: 8 packages + 2 apps).

```
packages/
  core/                       domain models + Provider iface
                              + overlay-view.ts (per-stage view models)
                              + itemset.ts (build → LCU item set)
  vision/                     screenshot recognition — pure functions:
                              geometry / grid (card location) / match / ocr
                              / png / templates (build-time pack) / card-overlay
                              / confirmed (top-bar per-slot) / label-memory
                              / visibility (panel + vision-loop gating)
                              / win-geometry + panel-geometry + augment-region
                                (window rect → capture coordinates)
                              / augment-panel (panel open/close gating)
                              / augment-cadence (idle/active throttling policy
                                + apiCaptureInterval: api-mode interval, panel
                                state outranks the trigger state machine)
                              / augment-trigger (API trigger state machine)
                              / augment-reroll + augment-reroll-retry (single-card
                                reroll: fingerprints/thresholds + retry-once
                                bookkeeping and the non-regressing baseline)
                              / augment-ocr (augment-name OCR)
                              / augment-label (label geometry presets)
                              / augment-tier-label (cards × tier table → labels)
                              / label-draw (shared draw plan: radius/font/colors)
                              / label-raster + label-glyph (pure-Node rasterizer)
                              / label-letter + label-letter-outlines (real A–Z font
                                outlines, generated) + label-cjk (选取率 bitmaps)
                              / label-overlay-coords + label-selftest
  provider-communitydragon/  static data source (global static definitions)
  provider-tencent/           CN first-party source (statics + rankings + hero detail)
  provider-registry/          registry (all enabled providers registered here)
  data-store/                 local FS cache (atomic write, offline fallback)
  data-cli/                   sync / status / templates CLI
  lcu/                        LCU probe + REST client + item-set CLI
                              + live-data.ts (Live Client Data API, port 2999)
                              + champion-identity.ts / my-champion.ts
                                ("which champion am I this game", pure + tested)
apps/
  web/                        data query site (Vue 3 + Vite)
  overlay/                    Electron overlay: champ-select labels + in-game augment
                              labels + record/verify tools
                              src/capture/worker.ts    (renderer: screen stream →
                                panel gating + full-resolution recognition)
                              src/main/augment-stream.ts, label-overlay.ts,
                              label-selftest.ts, vision-loop.ts
                              src/debug-augment.ts / debug-capture.ts /
                              debug-overlay-test.ts
data/                         generated data (gitignored): dataset / rankings /
                              builds / templates (by `pnpm sync` / `pnpm templates`)
                              + augment-names.json (scripts/render-augment-name-fingerprints.ps1)
scripts/                      one-off diagnostic scripts + the game-free augment
                              label preview (preview-augment-labels.mts) + frame
                              replay (diag-augment-frames.mts)
docs/                         ROADMAP / OVERLAY-STAGES / build-slots / SCREENSHOT-DEV
                              / SESSION-NOTES / AUGMENT-PANEL (in-game augment
                              recognition: plan + calibration)
```

## First-time setup

```bash
pnpm install        # pnpm 11.7.0 (see packageManager field)
pnpm sync           # all providers → ./data/*.json (dataset + rankings + hero details)
pnpm templates      # champion portraits + name fingerprints → ./data/templates.json
pnpm dev:web        # data site → http://localhost:5273
```

> **Environment notes**
> - pnpm is **not** vendored in the repo. On this machine pnpm 11.7.0 is installed
>   globally and *is* on the user PATH (`C:\Users\13199\AppData\Roaming\npm\pnpm.cmd`);
>   a bundled copy also exists inside the DSH runtime
>   (`...\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs`) for shells where the
>   global one is missing. Use whichever resolves; do not add a package manager to the repo.
> - If `pnpm` is unavailable, run the TS entry points directly with the system Node
>   (`C:\Program Files\nodejs\node.exe`, v24 verified):
>   `node --experimental-strip-types packages/data-cli/src/cli.ts sync`
>   (all `pnpm <script>` commands in `package.json` have such an equivalent — the
>   scripts are plain `node --experimental-strip-types <file>` invocations).
> - Running Electron **from the DSH harness**: the harness exports `ELECTRON_RUN_AS_NODE=1`,
>   which makes `electron` behave as plain Node and never open a window - clear it for the
>   child process. In this environment the real Chromium sandbox also fails to start, so the
>   recorder/self-test need `--no-sandbox --disable-gpu`; without them the process exits
>   silently (0x80000003). A normal user terminal needs neither.
> - The overlay needs **admin privileges + a real desktop session** to run; it
>   cannot be exercised in a headless CI (the CI only typechecks and builds it).

## Build, typecheck, test

From the repo root:

```bash
pnpm typecheck     # pnpm -r typecheck (10 projects: 8 packages + 2 apps)
pnpm test          # pnpm -r test
pnpm build         # pnpm -r build (web + overlay bundles)
pnpm dev:web       # web dev server
pnpm dev:overlay   # overlay (admin + desktop required)
```

Run a single package (faster iteration):

```bash
pnpm --filter @hexbox/core test
pnpm --filter @hexbox/web typecheck
```

Tests use Node's built-in runner: `node --experimental-strip-types --test ...`.
**Make the suite green before committing.** New behavior should include tests.

Current tests: **775** — `core` 55 / `vision` 551 / `lcu` 87 /
`provider-communitydragon` 12 / `provider-tencent` 43 / `data-store` 17 /
`data-cli` 10 (measured locally; **treat `pnpm test` output as the source of
truth** — this number moves whenever a suite is touched). `provider-registry`
has no tests (pure registry wiring).
CI (`.github/workflows/ci.yml`) runs `typecheck` → `test` → `build` on every push/PR,
on `windows-latest`, with `pnpm install --frozen-lockfile`.

> **The overlay cannot be tested in CI** (needs admin + a real desktop session).
> Keep its logic in pure functions under `packages/core` **or `packages/vision`**
> where tests can reach it — see `core/src/overlay-view.ts` (per-stage view models),
> `core/src/itemset.ts` (build → LCU item set), `vision/src/visibility.ts`
> (when the panel/overlay/vision loop should be active) and the whole
> `vision/augment-*.ts` family. A real bug came from keeping that visibility
> decision inline in the main process: the diagnostic panel only ever appeared
> on cold start.

> **Read the matching doc before changing a feature area.** They encode decisions
> that were expensive to derive (and re-deriving them has produced real bugs):
> `docs/OVERLAY-STAGES.md` (what to show at each game stage — showing augment data
> during champ select was a real mistake), `docs/AUGMENT-PANEL.md` (in-game augment
> panel recognition/calibration), `docs/SCREENSHOT-DEV.md` (champ-select screenshot
> overlay), `docs/build-slots.md` (build slots vs. upstream fields).

## In-game augment pipeline (S5)

**The chain, in one line:** screenshot gating (panel open/close edge) → optional API
trigger (Live Client Data API: death + level + the not-yet-picked set) → renderer-side
**full-resolution** recognition (augment-name OCR against the fingerprint library) →
join each card with the **per-champion** official strength table → draw the tier letter
(and the pick-rate line, when the caller passes that table) on the shared transparent
overlay canvas. With the API trigger the normal state takes **zero frames**; while the panel is
open it samples at `HEXBOX_AUGMENT_REROLL_POLL_MS` so that a **single-card reroll** (each card can be
refreshed once, with the panel still open) is detected by a cheap per-card fingerprint, re-recognized
**for that card only**, and its label replaced — a card that no longer resolves **loses its label**
(never keep a stale letter). See §十五 of `docs/AUGMENT-PANEL.md`.

Data path (`packages/vision/src/augment-tier-label.ts` → renderer):

```
2999 liveclientdata ─(death/level/pending)→ vision/augment-trigger.ts
screen stream (getDisplayMedia) → capture/worker.ts
   → vision/augment-panel.ts (gating, 1/4-scale)  → open edge
   → worker recognize(): native-resolution cards + vision/augment-ocr.ts
   → main: findDetail(builds, me) → augmentTierTable() (+ augmentPickRateTable())
   → vision/augment-tier-label.ts (labels) → main/label-overlay.ts → overlay:vision
   → renderer/overlay-canvas.ts draws via vision/label-draw.ts (labelBoxPlan)
```

Wiring status: **both** entry points run the **same** controller —
`apps/overlay/src/main/augment-controller.ts`: the record/verify tool
(`debug-augment.ts`, which keeps only artifacts / forensics / duration / sentinel
duties) and the **resident** overlay (`pnpm dev:overlay`, S5.4d done). The resident
overlay owns the stage decision through `vision/src/visibility.ts` —
`labelProducerFor()`, `augmentChainActive()` and `augmentChainTransition()` keep
champ-select labels and in-game augment labels **mutually exclusive** (a handover
clears the leftovers of the other producer) and start/stop the augment chain with
the match; `HEXBOX_OVERLAY_AUGMENT=0` disables just the in-game chain.

> **The resident overlay has no visible window: the tray is its only entry point
> and the only way to quit** (`main/tray.ts`). Closing a window **hides it**
> (`attachCloseToTrayHide()` → `preventDefault()` + `hide()`); the single real exit
> is the tray menu's 退出 → `quitApp()` (sets `quitting`, then `app.quit()` →
> the **existing** `before-quit` cleanup — never write a second cleanup path).
> `app.requestSingleInstanceLock()` is mandatory: two `hexbox.exe` processes each
> drew their own labels and computed **different** strength tables (the user
> reported "multiple labels and win rates overlapping"). A rejected second instance
> builds **nothing**; the first one only shows a balloon (never `show()`/`focus()`).
> The "no LCU credentials" balloon fires **once per connection session**
> (3 consecutive failures; re-armed only after 6 consecutive successes) — the rule
> is a pure function in `vision/credential-notice.ts`, the tray status text in
> `vision/overlay-status.ts`.

> **Window-rect probing can pick the wrong window — always search a fallback region.**
> `win-geometry` + `augment-region.ts` map a window-normalized region to capture
> coordinates, but a real game (fullscreen, HUD across the whole frame) was once
> probed as a `1600×900 @ (347,6)` window of something else, which cropped the card
> borders off and produced **0 hits for the whole game**. The worker therefore
> searches **two** regions (primary + full-frame identity) and `detectAugmentPanelInRegions`
> accepts either. Do not "fix" this by guessing whether the probe is trustworthy —
> a small non-square rect is also exactly what a windowed game reports.

> **Never capture full-resolution frames with `desktopCapturer` during a match.**
> `desktopCapturer.getSources` + `toBitmap`/`toPNG` stalled the **system cursor for
> ~1 s** (measured 3 times in one game, timestamps aligned with the captures) — it is
> a DWM/compositor-level stall, so async does not help. Forensic frames are therefore
> **off by default** (`HEXBOX_AUGMENT_FORENSICS=1` to opt in); the correct path is to
> take the native frame from the **already-running screen stream** in the renderer
> (`drawImage` + crop), which is what `capture/worker.ts` does.

> **The overlay canvas sizes itself from the window — never from a message.**
> `canvas.width/height` are **physical pixels**, so the renderer must set
> `innerWidth × dpr` / `innerHeight × dpr` on load, on `window.resize`, **and
> before every draw** (`renderer/overlay-canvas.ts`, pure math in
> `vision/src/label-overlay-coords.ts`). The in-game path pushes **once per
> panel** and `overlay:resize` only fires on a display change, so tying the size
> to any one message leaves the canvas at the HTML default **300×150** — every
> label coordinate is then outside the canvas and the screen stays empty
> ("drawn" in the log, nothing visible). Related traps, all hit for real:
> the renderer bundles must land in `dist/renderer/*.js`, not
> `dist/renderer/renderer/` (esbuild infers `outbase` from the entry points — the
> browser builds now set an explicit `out` per entry, and `build.mjs` fails the
> build if an HTML `src`/`href` points at a missing file, because a missing
> renderer script is **silent** — that is how a whole game came back empty); and
> `pushLabelOverlay` is the **only** place that converts screen-absolute DIP →
> window-relative DIP (a secondary display with a non-zero `workArea` origin
> otherwise shifts every label, while the primary display at `0,0` hides the bug).

> **The transparent label canvas must be re-raised, not just created.**
> `apps/overlay/src/main/label-overlay.ts` re-asserts `alwaysOnTop('screen-saver')`
> + `moveTop()` on every push and keeps a 1 s heartbeat that re-pushes the last
> message while labels are on screen — the in-game path pushes **once per panel**,
> so a single unpresented frame means "nothing on screen" forever (the game keeps
> re-raising itself, and Chromium throttles occluded windows: hence
> `backgroundThrottling: false`). Window visibility has its own game-free
> self-test: `HEXBOX_LABEL_OVERLAY_TEST=1` (see `apps/overlay/README.md`).

> **Ctrl+C does not reach Electron — use the launcher sentinel.** Electron is a GUI
> subsystem process with no console, so Windows never delivers `CTRL_C_EVENT` to it
> (`process.on('SIGINT')` there is dead code) and a whole game's artifacts were lost
> once. `apps/overlay/run-electron.mjs` receives the signal, writes the
> `debug/augment/.stop` sentinel, and the recorder polls it to finish cleanly
> (it also writes `checkpoint.json` so a hard kill still leaves results).
> Keep every Electron entry point launched through that launcher.

> **"Which champion am I" has exactly one source: `me`.** Never derive it by
> scanning a list — a real bug returned a *teammate* (Master Yi → 154 Zac,
> Gragas (79) → 43 Karma) because the code took "the first `championId` in
> `myTeam`" and then searched the 10-player gameflow list; the whole game showed
> someone else's strength table. Use `@hexbox/lcu`'s `resolveChampionIdentity()` /
> `resolveMyChampionIdentity()`: 2999 `activePlayer.rawChampionName` →
> `activePlayer.championName` → champ-select **my cell** → gameflow **located by my
> puuid/summonerId** → `none` (**draw nothing**). Both entry points require an
> explicit `SelfIdentity`, and `pickMyChampionIdFromGameflow(session, me)` returns
> `null` without one, so guessing does not type-check. Record the source
> (`activePlayer-raw` / `activePlayer-name` / `lcu-champsession` /
> `gameflow-self` / `none`) in the artifact — it is the only cheap way to tell
> "wrong champion" from "no data". ⚠️ A high hit count is **not** evidence of a
> correct identity: 31 of 173 tables contain the same common augments, so a wrong
> champion can still hit 9/9.

> **The strength table covers only ~211 of 248 augments — never invent a tier.**
> The official per-champion table (`augment_json_irank`) has 95–162 rows per
> champion (the union over the 173 synced champions is 211 IDs; the other 37 have
> no official tier anywhere). If a card's augment id is not in that champion's
> table (or OCR is unsure), **draw nothing** — no fallback by rarity, no guessed
> letter. The in-game UI wording must stay "what the official stats say about this
> **champion**", never "what you were offered", and the number shown is the
> **pick rate** (官方表的登场率列, rendered as 「选取率 x%」), not a win rate.

> **Label geometry/colors/text have exactly one source** —
> `vision/src/augment-label.ts` (`AUGMENT_BADGE_PRESETS`; the default preset is a
> centered label in the card's blank bottom area), `vision/src/augment-tier-label.ts`
> (`augmentTierLabels()`: "S/A/B/C only, plus a pick-rate line when the official
> table has one") and `vision/src/label-draw.ts` (`labelBoxPlan()`: radius,
> stroke, font, anchor). **Do not re-implement any of it in
> `renderer/overlay-canvas.ts`** — the offline preview
> (`scripts/preview-augment-labels.mts` → `debug/label-preview.png`, all three
> presets on one image, no game required) shares those same pure functions, so a
> second implementation silently makes the preview lie. The only intentional
> difference is the rasterizer: the preview draws the **real font outlines** of A–Z
> (`label-letter.ts` + `label-letter-outlines.ts`, generated from the very same
> font stack by `scripts/render-tier-letter-glyphs.ps1`) through a pure-Node software
> rasterizer (`label-raster.ts`), while the game uses Chromium's text renderer. The
> typography cannot drift: the font stack's first family must equal the one the outlines
> were generated from, `LABEL_CAP_RATIO` *is* `TIER_LETTERS_CAP_RATIO`, and unit
> tests lock ink height / baseline / stroke + glow reach on both sides.

### Environment variables (all real; the chain knobs default in `apps/overlay/src/main/augment-controller.ts`, the recording-only ones in `apps/overlay/src/debug-augment.ts`)

| Group | Variable | Meaning |
|---|---|---|
| Trigger | `HEXBOX_AUGMENT_TRIGGER` | `api` = no frames in the normal state, open capture on death + level + not-yet-picked; anything else = `pixel` cadence (default) |
| Trigger | `HEXBOX_AUGMENT_API_POLL_MS` | Live Client Data polling interval (default 1000) |
| Capture | `HEXBOX_AUGMENT_CAPTURE` | `stream` (default) or `oneshot` (comparison / fallback path) |
| Capture | `HEXBOX_AUGMENT_THUMB_SCALE` | gating canvas scale, clamped to a 0.25 floor (default 0.25) |
| Capture | `HEXBOX_AUGMENT_OPEN_SAMPLE_MS` | re-sample interval while the panel stays open (default 4000) |
| Capture | `HEXBOX_AUGMENT_REROLL_POLL_MS` | sampling interval **while the panel stays open** (default 400) — catches a single-card **reroll**; closing the panel returns to the trigger's normal state (API mode = zero frames) |
| Capture | `HEXBOX_AUGMENT_FORENSICS` | `1` = also grab native full-res frames (cursor stall; off by default) |
| Capture | `HEXBOX_AUGMENT_CLOSED_SAMPLES` | how many closed-state samples to keep (default 0) |
| Cadence | `HEXBOX_AUGMENT_IDLE_MS` / `_ACTIVE_MS` / `_PROBE_MS` / `_TAIL_MS` | throttling intervals (1000 / 250 / 6000 / 20000) |
| Cadence | `HEXBOX_AUGMENT_CLOSE_HEAL_PROBE` | `1` = enable the low-frequency **post-close self-heal probe** in api mode (1 frame / 6 s for 20 s after a confirmed close). **Off by default**: the user chose strict zero frames; see §十七 of `docs/AUGMENT-PANEL.md` |
| Cadence | `HEXBOX_AUGMENT_PENDING_PROBE_MS` | `>0` = while an augment offer is still unpicked, sample one frame every N ms (verifies whether a panel can appear **outside** a death window). **Off by default (0)** = strict zero frames; see `pendingProbeMs` in `vision/augment-cadence.ts` |
| Diagnosis | `HEXBOX_AUGMENT_API_TRACE` | `1` = log **every** 2999 poll sample (gameTime / level / isDead / respawnTimer / capture / pending) — non-changed trigger decisions are otherwise invisible. Off by default |
| Recording | `HEXBOX_AUGMENT_SECONDS` | fixed recording length; `0` = follow the game (default) |
| Recording | `HEXBOX_AUGMENT_MAX_MINUTES` | follow-mode cap in minutes (default 45) |
| Recording | `HEXBOX_AUGMENT_OUT` | artifact subdirectory under `debug/`, or an absolute path |
| Recording | `HEXBOX_AUGMENT_BENCH` | `1` = ~30 s capture benchmark (`bench.json`) |
| Labels | `HEXBOX_AUGMENT_DRAW` | `0` = recognize/print/persist only, draw nothing (default draws) |
| Labels | `HEXBOX_AUGMENT_BADGE` | `small` / `medium` / `large` preset (unknown value → default preset) |
| Self-test | `HEXBOX_AUGMENT_SELFTEST_CADENCE` | `1` = verify the cadence IPC round-trip (no game needed) |
| Self-test | `HEXBOX_LABEL_OVERLAY_TEST` | `1` = overlay-window self-test (L/C/R letters, no game needed) |
| Self-test | `HEXBOX_LABEL_OVERLAY_TEST_MS` | how long that self-test stays (default 5000 ms) |
| Self-test | `HEXBOX_DEBUG_FORCE` | `1` = skip the LCU phase check in the debug tools |
| Overlay | `HEXBOX_OVERLAY_AUGMENT` | `0` / `false` / `off` = disable the in-game augment chain in the **resident** overlay (champ-select labels keep working); anything else = enabled |
| Overlay | `HEXBOX_DATA_DIR` | explicit `data/` directory (otherwise resolved by walking up to `dataset.json`) |
| Overlay | `HEXBOX_LOG_FILE` | tee console output to this file as UTF-8 (never via PowerShell redirection) |
| Overlay | `HEXBOX_SMOKE` | `1` = auto-quit after 4 s (smoke run) |
| Tray | `HEXBOX_TRAY_AUTOTEST_MS` | `>0` = tray/exit self-test: after N ms simulate "close window" (must hide to tray, process stays alive), 3 s later simulate the tray menu's 退出; CLI `--tray-autotest <ms>` |
| Tray | `HEXBOX_TRAY_ICON` | explicit tray-icon **directory** (troubleshooting; defaults to packaged `resources/tray` / dev `apps/overlay/build/tray`) |
| Tray | `HEXBOX_NOTICE_TEST` | `1` = **verification injection**: feed "no LCU credentials" into the one-shot balloon decision (only the decision input changes) |
| LCU | `HEXBOX_LCU_CREDENTIALS` | `<port>:<token>` (or a lockfile line); highest priority, no-admin channel |
| LCU | `HEXBOX_LCU_CREDENTIALS_FILE` | path to a credentials file (default `~/.hexbox/lcu-credentials`) |

### Game-free checks (no game, no match required)

```powershell
# Overlay window visibility only (needs a desktop, not a game):
$env:HEXBOX_LABEL_OVERLAY_TEST='1'; pnpm --filter @hexbox/overlay debug:augment
$env:HEXBOX_LABEL_OVERLAY_TEST='1'; pnpm dev:overlay          # same canvas/window code

# Label appearance, pure Node offline preview → debug/label-preview.png:
node --experimental-strip-types scripts/preview-augment-labels.mts
node --experimental-strip-types scripts/preview-augment-labels.mts <帧.png> --full --out debug/x.png

# Replay real machine frames through the online gating code:
node --experimental-strip-types scripts/diag-augment-frames.mts <帧.png...> --annotate

# Cadence IPC round-trip self-test (prints the measured frame intervals):
$env:HEXBOX_DEBUG_FORCE='1'; $env:HEXBOX_AUGMENT_SELFTEST_CADENCE='1'; pnpm --filter @hexbox/overlay debug:augment
```

> ⚠️ **`$env:` assignments are session-scoped — unset them after verifying**
> (`Remove-Item Env:\HEXBOX_LABEL_OVERLAY_TEST`) or open a new terminal, otherwise a
> later `pnpm dev:overlay` still runs the self-test and exits on its own (that exit is
> by design, not a crash). The self-test prints this reminder — plus the currently
> effective self-test variable values — right before it exits.

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

## Commit / PR guidelines

- Conventional, descriptive commit messages in English or Chinese summaries.
- Keep `pnpm test` and `pnpm typecheck` green before committing.
- Never commit: `node_modules/`, `dist/`, `data/` (regenerated by `pnpm sync` /
  `pnpm templates`), `debug/` (real-machine screenshots and recordings, they
  contain personal information), `.env*`, `*.log` — all covered by `.gitignore`.
- Do not commit local LCU tokens/paths; the LCU client reads them at runtime.

## Out of scope

- Memory injection, game-process hooking, or packet inspection — the one hard
  technical line. If a feature seems to need it, ask the user instead.
- Data scraped/repackaged from third-party sites. Prefer first-party surfaces:
  CommunityDragon / Data Dragon / Tencent CN official
  (`101.qq.com`, `mlol.qt.qq.com`, `game.gtimg.cn`).
