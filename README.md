# Healix

**Local-first, AI-led testing platform** — an Electron desktop app and a `healix` CLI over one shared core. Healix scans a target app (white-box repo or black-box URL), generates and runs regression suites (UI + API) via pluggable engines (**Playwright first**, then Selenium, then others), and keeps **all data local**. AI is driven by **Claude and OpenAI/Codex** through their **subscription CLIs** (plan mode) with **SDK fallback** — **no API keys, ever**.

> Status: planning / pre-implementation. See [`docs/`](./docs/README.md).

## Docs

- [Feature plan](./docs/feature-plan.md)
- [High-level architecture](./docs/architecture/high-level-architecture.md) · [Excalidraw diagram](./docs/architecture/healix-architecture.excalidraw)
- [Architecture Decision Records](./docs/adr/README.md)

## Planned layout

```
healix/
├── apps/desktop     # Electron app (electron-vite + React/TS)
├── packages/core    # @healix/core — orchestrator, providers, modes, storage
├── packages/cli     # healix CLI
└── docs/            # plan, architecture, ADRs
```
