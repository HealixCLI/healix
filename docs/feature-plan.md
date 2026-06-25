# Healix — Feature Plan

> **Status:** Draft for review · **Owner:** Anurag · **Date:** 2026-06-25
> **Reference implementation:** `../TestBot_MCP` (`@healix/mcp` v2 — MCP server + Vercel webapp). Healix is a ground-up, **local-first** redesign of that idea.

---

## 1. One-line summary

**Healix** is a local-first, AI-led testing platform that scans a target app, generates and runs regression suites (UI + API) through pluggable engines (**Playwright first**, then Selenium, then others), and ships as **both an Electron desktop app and a `healix` CLI** over one shared core. It is driven by **Claude and OpenAI/Codex** via their subscription CLIs (with SDK fallback) — **no API keys, ever** — and keeps **all data local** (videos, screenshots, traces, reports, generated suites).

---

## 2. What changes vs. the old TestBot_MCP

| Dimension | Old (TestBot_MCP / `@healix/mcp` v2) | New (Healix) |
|---|---|---|
| Form factor | MCP server inside an IDE + Next.js webapp on Vercel | **Electron app + `healix` CLI**, one shared core |
| AI calls | Proxied server-side through the webapp (OpenAI, API-key billing) | **Local orchestrator** drives **Claude Code CLI + Codex CLI** (plan mode) with **SDK fallback**; subscription auth, **no API keys** |
| Persistence | Supabase (Postgres) + Supabase Storage | **Local: SQLite + filesystem** |
| Async pipeline | Inngest background jobs | **Local orchestrator state machine** (resumable runs) |
| Test engines | Playwright only | **Pluggable modes** — Playwright → Selenium → XYZ |
| Exploration | browser-use (Python subprocess) + Playwright fallback | **Single embedded Playwright/CDP browser** for both computer-use and browser-use, **selectable per run** |
| Output | Dashboard run page (cloud) | **Local dashboard + downloadable standalone suites** |

Concepts worth carrying over from the reference: **tiered execution** (public / per-role auth / backend), **requirement-tagged tests** (`[REQ:F#.S#.AC#]`), **credential injection via Playwright `storageState`**, and the **failure-triage classifier → AI** pipeline.

---

## 3. Confirmed decisions (from clarifying rounds)

These are locked and recorded as ADRs in [`adr/`](./adr/README.md):

1. **Orchestration** — CLI subprocess **primary** (Claude Code CLI + Codex CLI in *plan mode*), **SDK fallback** (Claude Agent SDK; OpenAI has no keyless SDK, so its fallback is effectively Codex CLI). → [ADR-0001](./adr/0001-cli-primary-sdk-fallback.md)
2. **Auth** — **Subscription only, never API keys.** The app exposes a "Login / health-check" action that triggers the provider CLI login and verifies the session. → [ADR-0002](./adr/0002-subscription-auth-no-api-keys.md)
3. **UI testing model** — **Both** computer-use (agentic) and codegen, **selectable per run**. → [ADR-0003](./adr/0003-dual-mode-ui-testing.md)
4. **Provider routing** — **Best-for-task with automatic fallback** on error/rate-limit. → [ADR-0004](./adr/0004-best-for-task-routing.md)
5. **Storage** — **Local-first: SQLite + filesystem.** No cloud backend. → [ADR-0005](./adr/0005-local-first-storage.md)
6. **Browser surface** — **One embedded Playwright/CDP Chromium** for both computer-use and browser-use, mirrored live into the UI. → [ADR-0006](./adr/0006-embedded-browser-surface.md)
7. **App stack** — **electron-vite + React + TypeScript**, shared **`@healix/core`** package, packaged with electron-builder. → [ADR-0007](./adr/0007-electron-vite-react-shared-core.md)
8. **Test-mode plugins** — pluggable engine interface, **Playwright first**. → [ADR-0008](./adr/0008-pluggable-test-modes.md)
9. **Suite export** — **standalone runnable Playwright project** (clone & `npm test`). → [ADR-0009](./adr/0009-standalone-suite-export.md)
10. **UX** — **Codex-inspired** design language (calm, monochrome/dark, monospace-leaning, keyboard-first, plan-mode approval gates, streaming output). → [ADR-0010](./adr/0010-codex-inspired-ux.md)
11. **Target access** — **Both white-box (repo index + auto-launch) and black-box (URL only)**, configurable per project.

---

## 4. Personas & top user stories

- **App developer / QA** — "Point Healix at my repo or URL, let it explore, approve the plan, get a passing/failing regression suite I can download and run in CI."
- **Team lead** — "Switch engines (Playwright → Selenium) without re-authoring intent; keep all evidence local for compliance."
- **CI engineer** — "Run the exact same flow headless via `healix run` in a pipeline."

Core stories:
1. Connect a provider via subscription and see a green health-check.
2. Create a project (attach repo and/or URL), pick mode = **Healix Playwright**.
3. Run **plan mode** → review the AI's proposed test plan → approve.
4. Healix explores (computer-use or codegen), generates requirement-tagged specs.
5. Healix executes tiered (public / auth / API), captures artifacts locally.
6. Review local dashboard (pass/fail/blocked, screenshots, video, trace, triage).
7. **Download** the standalone suite; run it anywhere with zero Healix dependency.

---

## 5. Architecture overview

See [`architecture/high-level-architecture.md`](./architecture/high-level-architecture.md) for diagrams and data flow. In brief:

```
Electron App ─┐                         ┌─ Claude Code CLI (plan mode) ─┐
              ├─► @healix/core ──Provider─┤                              ├─► Subscriptions
Healix CLI  ───┘   (orchestrator)  Router └─ Codex CLI (plan mode)  ─────┘   (no API keys)
                       │
        ┌──────────────┼───────────────────────────┐
        ▼              ▼                            ▼
  Test-Mode Plugins   Browser Surface          Local Storage
  (Playwright…)       (Playwright/CDP:          (SQLite + files:
                       computer-use +            artifacts, reports,
                       browser-use)              generated suites)
```

### 5.1 Components (`@healix/core`)

- **Orchestrator** — resumable state machine: `plan → explore → generate → execute → triage → report`. Plan-mode first; a human approval gate precedes any file writes or execution.
- **Provider Router** — capability-based routing (computer-use → Claude by default; codegen → either) + health checks + automatic fallback.
- **Provider Adapters** — `ClaudeProvider` (Claude Code CLI + Agent SDK fallback), `OpenAIProvider` (Codex CLI).
- **Auth / Session Manager** — triggers CLI login, parses/validates session state, surfaces status. Stores **no keys**.
- **Test-Mode Plugins** — common `TestMode` interface: `scaffold → generate → execute → collectArtifacts → export`. `PlaywrightMode` ships first.
- **Browser Surface** — one Playwright-controlled Chromium over CDP; serves both computer-use (vision/coordinates) and browser-use (DOM/AX-tree); streamed to the UI.
- **Target Adapter** — white-box (repo indexer + start-command auto-detect/launcher, ported from `auto-detector.js`) and/or black-box (URL).
- **Storage Layer** — SQLite (projects/runs/tests/results/triage) + filesystem (artifacts/reports/suites) under the OS app-data dir.
- **Suite Exporter** — emits a self-contained Playwright project (zip).
- **Failure Triage** — deterministic classifier → AI hypothesis (ported concept from `failure-triage/`). *(Post-MVP.)*

### 5.2 Front-ends

- **Electron app** (electron-vite + React/TS) — setup, provider health, project config, plan review/approval, **live browser view**, run console, local dashboard, artifact browser, suite download, mode switcher.
- **`healix` CLI** — full parity for headless/CI: `healix login`, `healix doctor`, `healix scan`, `healix plan`, `healix generate`, `healix run`, `healix report`, `healix export`.

---

## 6. Local storage layout

```
<app-data>/Healix/
├── healix.db                      # SQLite: projects, runs, tests, results, triage
└── projects/<projectId>/
    ├── project.json              # config (repo path, baseURL, mode, roles)
    └── runs/<runId>/
        ├── plan/                 # approved test plan + provider transcripts
        ├── suite/                # generated standalone Playwright project
        ├── artifacts/            # screenshots, videos, traces
        ├── reports/              # html + json report
        └── auth/                 # storageState per role (sanitized on export)
```
`<app-data>` = `~/Library/Application Support` (macOS), `%APPDATA%` (Windows), `$XDG_DATA_HOME` (Linux).

---

## 7. Milestones

### M0 — Foundations (scaffold)
- Monorepo: `apps/desktop` (electron-vite + React/TS), `packages/core` (`@healix/core`), `packages/cli` (`healix`).
- SQLite schema + filesystem layout; app-data resolver.
- electron-builder packaging; CI lint/typecheck/test.

### M1 — MVP (the confirmed first milestone)
**Healix Playwright, single provider, full loop:**
- Provider connect + **CLI login health-check** (one provider: Claude *or* OpenAI/Codex).
- Project create — **white-box (repo) or black-box (URL)**.
- **Plan mode** → human approval gate.
- **Both execution models** (computer-use explore / codegen) selectable per run.
- Generate **requirement-tagged** Playwright specs (UI + API via `APIRequestContext`).
- **Tiered execution** (public / auth-per-role / backend) with credential injection.
- Local artifacts (screenshots/video/trace) + local dashboard.
- **Download standalone runnable Playwright project.**
- **Codex-inspired UI** shell with live browser view + streaming console.

### M2 — Dual provider + routing
- Second provider; **best-for-task routing + automatic fallback**; per-run provider override.

### M3 — Failure triage
- Port deterministic classifier → AI hypothesis (test-wrong / app-wrong / env / flaky); evidence bundle (trace + source + AC); verdict chips in dashboard.

### M4 — More modes
- **Healix Selenium** behind the same `TestMode` interface; mode switch without re-authoring intent. Then "XYZ".

### M5 — Hardening & distribution
- Auto-update, code signing, telemetry (local/opt-in), CI export recipes (GitHub Actions/GitLab).

---

## 8. Open questions / risks

- **OpenAI keyless programmatic access** — without an API key, OpenAI's only subscription path is **Codex CLI**; there is no keyless OpenAI SDK. The "SDK fallback" therefore applies mainly to Claude (Agent SDK can ride the Claude subscription). Risk to flag if richer OpenAI structured calls are needed later.
- **CLI plan-mode interfaces** — Claude Code CLI and Codex CLI plan/approval modes and their machine-readable output formats must be pinned (versions) and wrapped behind the provider adapter.
- **Computer-use throughput/cost** — vision loops are slower/costlier than codegen; default to codegen for re-runs, computer-use for discovery.
- **Secret handling** — credentials for auth tiers must use OS keychain; never written to exported suites (carry over the old deny-list for `auth-state-*.json`).
- **Cross-platform browser** — bundling Playwright browsers in an Electron build (size, signing) needs an early spike.

---

## 9. Deliverables produced alongside this plan

- [`architecture/high-level-architecture.md`](./architecture/high-level-architecture.md) — diagrams + data flow.
- [`architecture/healix-architecture.excalidraw`](./architecture/healix-architecture.excalidraw) — editable Excalidraw diagram.
- [`adr/`](./adr/README.md) — Architecture Decision Records (decided + placeholder stubs for pending decisions).
