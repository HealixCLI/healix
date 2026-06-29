# Healix

**Local-first, AI-led testing platform** — an Electron desktop app and a `healix` CLI over one shared core. Healix scans a target app (white-box repo or black-box URL), generates and runs regression suites (UI + API) via pluggable engines (**Playwright first**, then Selenium, then others), and keeps **all data local**. AI is driven by **Claude and OpenAI/Codex** through their **subscription CLIs** (plan mode) with **SDK fallback** — **no API keys, ever**.

> Status: **M1 shipped** — the full AI-led pipeline runs end-to-end. `healix run` plans (real Claude), detects + launches a white-box app, generates REQ-tagged Playwright specs, executes them for real, triages failures, writes a local report, and exports a standalone runnable suite. See [`docs/`](./docs/README.md).

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
- For the AI provider: the **Claude Code CLI** (`claude`) logged in to your subscription. (Codex CLI support is stubbed.)

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

`pnpm healix doctor` resolves the `claude` binary, runs a real authenticated round-trip, initializes the local SQLite DB at the OS app-data dir, and reports provider readiness. The desktop app packages into a signed `Healix.app` (notarization/signed installers need release certs — see [ADR-0017](./docs/adr/0017-update-distribution.md)).

## What works today (M1)

- `@healix/core`:
  - **Providers** — real `ClaudeProvider` (detect + live auth probe + `plan()`/`complete()`), `OpenAIProvider` (Codex stub), `ProviderRouter` (best-for-task + fallback).
  - **Storage** — `node:sqlite` projects/runs/tests/results/events with transactional cascade delete.
  - **Target adapter** — repo detect (framework/port/start-cmd) + index + launch (white-box) + URL probe (black-box).
  - **Browser surface** — one Playwright/CDP Chromium for computer-use + browser-use + live mirror.
  - **Playwright mode** — scaffold standalone project → AI codegen of REQ-tagged specs → execute (auto-install + run + parse) → artifacts → suite.
  - **Orchestrator** — resumable plan → approve → launch → generate → execute → triage → report → export.
  - **Export** — sanitized, standalone runnable Playwright project + zip.
  - **Triage** — deterministic classifier + two-hypothesis AI analysis.
- `healix` CLI: `doctor`, `providers`, `project add/list/show/rm`, `scan`, `run` (streamed + plan approval), `report`, `export`.
- Desktop: Codex-style **Providers / Projects / Runs** views — create projects, start runs, stream events, approve the plan, see results, export — over typed IPC.

## Docs

- [Feature plan](./docs/feature-plan.md) · [Architecture](./docs/architecture/high-level-architecture.md) ([diagram](./docs/architecture/healix-architecture.png)) · [ADRs](./docs/adr/README.md)
