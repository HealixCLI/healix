# Healix

**Local-first, AI-led testing platform** — an Electron desktop app and a `healix` CLI over one shared core. Healix scans a target app (white-box repo or black-box URL), generates and runs regression suites (UI + API) via pluggable engines (**Playwright first**, then Selenium, then others), and keeps **all data local**. AI is driven by **Claude and OpenAI/Codex** through their **subscription CLIs** (plan mode) with **SDK fallback** — **no API keys, ever**.

> Status: **M0 foundations shipped** — monorepo builds; `healix doctor` runs a real Claude health-check; local SQLite storage initializes; Electron app builds. See [`docs/`](./docs/README.md).

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

# Desktop app (Codex-style UI)
pnpm dev:desktop    # launches the Electron app in dev
pnpm build:desktop  # production build → apps/desktop/out
```

`pnpm healix doctor` resolves the `claude` binary, runs a real authenticated round-trip, initializes the local SQLite DB at the OS app-data dir, and reports provider readiness.

## What works today (M0)

- `@healix/core`: app-data resolver · `node:sqlite` storage + migrations · provider adapter interface · **real `ClaudeProvider`** (detect + live auth probe + `plan()` via Claude plan mode) · `OpenAIProvider` (Codex stub) · `ProviderRouter` (best-for-task + fallback) · `doctor()`.
- `healix` CLI: `doctor`, `providers list|health`.
- Desktop: Electron main bundles `@healix/core`, typed IPC bridge, React + Tailwind + shadcn-style **providers/health dashboard**.

## Docs

- [Feature plan](./docs/feature-plan.md) · [Architecture](./docs/architecture/high-level-architecture.md) ([diagram](./docs/architecture/healix-architecture.png)) · [ADRs](./docs/adr/README.md)
