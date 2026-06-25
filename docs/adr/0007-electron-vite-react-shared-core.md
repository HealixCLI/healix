# ADR-0007: electron-vite + React + TypeScript with a shared `@healix/core`

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Anurag

## Context
Healix ships as **both** an Electron desktop app and a `healix` CLI. To avoid divergence, business logic must live in one place. We need a modern, fast renderer toolchain and a clean main/renderer split.

## Decision
- **Desktop shell:** Electron, built with **electron-vite**, packaged via **electron-builder**.
- **Renderer:** **React + TypeScript**.
- **Shared core:** **`@healix/core`** — a framework-agnostic TypeScript package containing the orchestrator, provider adapters/router, auth manager, test-mode plugins, browser surface, storage, and exporter. Consumed by **both** the Electron main process and the CLI.
- **CLI:** `packages/cli` (`healix`) — a thin command layer over `@healix/core`.
- Monorepo: `apps/desktop`, `packages/core`, `packages/cli`.

## Consequences
- Single source of truth for behavior; app and CLI stay in parity.
- Core must stay UI-agnostic and Electron-agnostic (no `electron` imports in `@healix/core`); side effects (fs, child_process) injected or guarded for CLI use.
- Renderer talks to core only through the Electron main process (IPC) — keep a typed IPC contract.
