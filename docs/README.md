# Healix — Documentation

**Healix** is a local-first, AI-led testing platform that ships as an **Electron desktop app** and a **`healix` CLI** over one shared core. It scans a target app (white-box repo or black-box URL), generates and runs regression suites (UI + API) via pluggable engines (**Playwright first**), and keeps **all data local**. AI is driven by **Claude and OpenAI/Codex** through their **subscription CLIs** (plan mode) with **SDK fallback** — **no API keys, ever**.

## Start here

| Doc                                                                                            | What it covers                                                             |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [`feature-plan.md`](./feature-plan.md)                                                         | Vision, confirmed decisions, components, milestones, risks                 |
| [`architecture/high-level-architecture.md`](./architecture/high-level-architecture.md)         | System diagrams, run lifecycle, provider routing, browser surface          |
| [`architecture/healix-architecture.excalidraw`](./architecture/healix-architecture.excalidraw) | Editable high-level diagram (open in Excalidraw / VS Code Excalidraw ext.) |
| [`adr/`](./adr/README.md)                                                                      | Architecture Decision Records — decided + placeholder stubs                |

## Confirmed at a glance

- **Orchestration:** Claude Code CLI + Codex CLI in _plan mode_ (primary), SDK fallback.
- **Auth:** subscription only — never API keys; in-app login health-check.
- **UI testing:** computer-use _and_ codegen, selectable per run.
- **Routing:** best-for-task with automatic fallback.
- **Storage:** local-first — SQLite + filesystem.
- **Browser:** one embedded Playwright/CDP Chromium for computer-use + browser-use.
- **Stack:** electron-vite + React + TS, shared `@healix/core`.
- **Modes:** pluggable; Healix Playwright first, then Selenium, then XYZ.
- **Export:** standalone runnable Playwright project.
- **UX:** Codex-inspired (calm, monochrome/dark, keyboard-first, approval gates).
- **Target:** white-box (repo) and/or black-box (URL), per project.

## Repository layout

```
healix/
├── apps/desktop        # Electron app (electron-vite + React/TS)
├── packages/core       # @healix/core — orchestrator, providers, modes, storage
├── packages/cli        # healix CLI
├── docs/               # this folder
└── TestBot_MCP/        # reference implementation (read-only)
```
