# Healix

**Local-first, AI-led testing platform** — an Electron desktop app and a `healix` CLI over one shared core. Healix scans a target app (white-box repo or black-box URL), generates and runs regression suites (UI + API) via pluggable engines (**Playwright first**, then Selenium, then others), and keeps **all data local**. AI is driven by **Claude and OpenAI/Codex** through their **subscription CLIs** (plan mode) with **SDK fallback** — **no API keys, ever**.

> Status: **Usable end-to-end** — both the `healix` CLI and the desktop app drive the full AI-led pipeline. `healix run` plans (real Claude), detects + launches a white-box app, generates REQ-tagged Playwright specs, executes them for real (recording a screenshot + video for every test, pass or fail), triages failures, writes a local report, and exports a standalone runnable suite. The desktop app (Providers / Projects / Runs) does the same with a plan-approval gate, streamed run console, live browser view, run history, a per-test media gallery (screenshots, recordings, lightbox), and one-click suite download — and packages into a green-leaf-branded `Healix.app`. 239 tests, CI (Linux + Windows, format-checked, desktop smoke), lint/format green. See [`docs/`](./docs/README.md).

## Monorepo layout

```
healix/
├── apps/desktop     # Electron app (electron-vite + React + Tailwind/shadcn)
├── packages/core    # @healix/core — orchestrator, providers, storage, modes
├── packages/cli     # healix CLI (commander)
└── docs/            # plan, architecture (PNG/SVG/Excalidraw), ADRs
```

## Requirements

- **Node ≥ 22.5** (uses the built-in `node:sqlite`; this repo targets Node 24 — see `.nvmrc`)
- **pnpm 9+**
- For the AI provider: the **Claude Code CLI** (`claude`) and/or the **OpenAI Codex CLI** (`codex`), logged in to your subscription.

## Quickstart

```bash
pnpm install        # install all workspaces
pnpm build          # build core → cli → desktop (Turborepo)

# CLI — verify environment, storage, and provider health (live Claude round-trip)
pnpm healix doctor
pnpm healix doctor --no-probe      # detection only, no token cost
pnpm healix providers list

# CLI — full run loop
pnpm healix project add --name MyApp --repo /path/to/app   # white-box (or --url for black-box)
pnpm healix run --project <id> --mode codegen              # plan → approve → generate → run → report → export
pnpm healix runs list                                      # run history
pnpm healix runs show <runId>                              # results + report path
pnpm healix export <runId> --out ./suite                  # standalone runnable Playwright project

# Desktop app (Codex-style UI: Providers / Projects / Runs)
pnpm dev:desktop    # launches the Electron app in dev
pnpm build:desktop  # production build → apps/desktop/out
pnpm --filter @healix/desktop package   # build a local .app/dir via electron-builder (release/)
```

`pnpm healix doctor` resolves the `claude` binary, runs a real authenticated round-trip, initializes the local SQLite DB at the OS app-data dir, and reports provider readiness. The desktop app packages into an ad-hoc-signed `Healix.app` (Developer-ID signing/notarization not wired yet — see [ADR-0017](./docs/adr/0017-update-distribution.md)).

## What works today (M1)

- `@healix/core`:
  - **Providers** — real `ClaudeProvider` (detect + live auth probe + `plan()`/`complete()`), `OpenAIProvider` (real Codex CLI adapter), `ProviderRouter` (best-for-task + fallback).
  - **Storage** — `node:sqlite` projects/runs/tests/results/events with transactional cascade delete.
  - **Target adapter** — repo detect (framework/port/start-cmd) + index + launch (white-box) + URL probe (black-box).
  - **Browser surface** — one Playwright/CDP Chromium for computer-use + browser-use + live mirror.
  - **Playwright mode** — scaffold standalone project → AI codegen of REQ-tagged specs → execute (auto-install + run + parse) → artifacts (screenshot + video per test; trace on failure) → suite.
  - **Orchestrator** — plan → approve → launch → generate → execute → triage → report → export, with every phase checkpointed to SQLite (state is persisted; resuming interrupted runs is not implemented yet).
  - **Export** — sanitized, standalone runnable Playwright project + zip.
  - **Triage** — deterministic classifier + two-hypothesis AI analysis.
- `healix` CLI: `doctor`, `providers`, `project add/list/show/rm/archive/unarchive`, `scan`, `run` (streamed + plan approval), `runs list/show/cancel/rm`, `report`, `export`. `project rm` also removes the project's on-disk runs/media (`--keep-assets` to skip).
- Desktop: Codex-style **Providers / Projects / Runs** views — create/archive/delete projects (delete confirms, then removes all runs + media from disk), start runs, stream events, approve the plan, see results and a per-test media gallery, export — over typed IPC.

## Docs

- [Feature plan](./docs/feature-plan.md) · [Architecture](./docs/architecture/high-level-architecture.md) ([diagram](./docs/architecture/healix-architecture.png)) · [ADRs](./docs/adr/README.md)
