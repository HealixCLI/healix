# Healix — High-Level Architecture

> Companion to [`../feature-plan.md`](../feature-plan.md). Editable diagram: [`healix-architecture.excalidraw`](./healix-architecture.excalidraw).

Healix is **local-first**. One shared core (`@healix/core`) powers two front-ends (the Electron app and the `healix` CLI). The core orchestrates AI providers through their **subscription CLIs** (plan mode) with **SDK fallback**, drives a single embedded browser for exploration, runs pluggable test engines, and persists everything to **SQLite + the local filesystem**.

---

## 1. System context

```mermaid
flowchart TB
    subgraph FE["Front-ends"]
        APP["Electron App<br/>(electron-vite + React/TS)"]
        CLI["healix CLI"]
    end

    subgraph CORE["@healix/core (shared TypeScript)"]
        ORCH["Orchestrator<br/>plan → explore → generate → execute → triage → report"]
        ROUTER["Provider Router<br/>best-for-task + auto fallback"]
        AUTH["Auth / Session Manager<br/>CLI login + health-check (no API keys)"]
        MODES["Test-Mode Plugins<br/>Playwright · Selenium · XYZ"]
        BROWSER["Browser Surface<br/>Playwright/CDP Chromium<br/>computer-use + browser-use"]
        TARGET["Target Adapter<br/>repo (white-box) / URL (black-box)"]
        STORE["Storage<br/>SQLite + filesystem"]
        EXPORT["Suite Exporter<br/>standalone PW project"]
    end

    subgraph EXT["External processes"]
        CC["Claude Code CLI<br/>(plan mode)"]
        CX["Codex CLI<br/>(plan mode)"]
        SDK["Claude Agent SDK<br/>(fallback)"]
        CHROME["Chromium<br/>(headed/headless)"]
        SUT["Target App under test"]
    end

    APP --> ORCH
    CLI --> ORCH
    ORCH --> ROUTER
    ORCH --> MODES
    ORCH --> BROWSER
    ORCH --> TARGET
    ORCH --> STORE
    MODES --> EXPORT

    ROUTER --> CC
    ROUTER --> CX
    ROUTER --> SDK
    AUTH --> CC
    AUTH --> CX

    BROWSER --> CHROME
    TARGET --> SUT
    CHROME --> SUT

    EXPORT --> DL["Downloaded suite<br/>clone & npm test anywhere"]
```

---

## 2. Run lifecycle (orchestrator state machine)

```mermaid
flowchart LR
    START([New run]) --> PLAN[Plan mode:<br/>provider drafts test plan]
    PLAN --> APPROVE{Human<br/>approval}
    APPROVE -- reject/edit --> PLAN
    APPROVE -- approve --> EXPLORE[Explore<br/>computer-use OR codegen]
    EXPLORE --> GEN[Generate specs<br/>REQ-tagged]
    GEN --> EXEC[Execute tiered<br/>public / auth / API]
    EXEC --> TRIAGE[Triage failures<br/>classifier → AI]
    TRIAGE --> REPORT[Local report<br/>+ artifacts]
    REPORT --> EXP[Export<br/>standalone suite]
    EXP --> DONE([Done])
```

Every transition checkpoints to SQLite so a run is **resumable** (the local replacement for the old Inngest async pipeline).

---

## 3. Provider routing & fallback

```mermaid
flowchart TB
    TASK["Task: explore / generate / triage"] --> CAP{Capability?}
    CAP -- computer-use --> CLAUDE1["Claude (default)"]
    CAP -- codegen/structured --> PICK["Pinned-best provider"]
    CLAUDE1 --> HC1{Healthy?}
    PICK --> HC2{Healthy?}
    HC1 -- no --> FB1["Fallback → other provider"]
    HC2 -- no --> FB2["Fallback → other provider"]
    HC1 -- yes --> RUN1[Run via CLI plan mode]
    HC2 -- yes --> RUN2[Run via CLI plan mode]
    FB1 --> RUN3[Run via fallback]
    FB2 --> RUN3
```

- **Primary path:** provider **CLI** in plan mode → produces a plan → human gate → execution.
- **Fallback path:** Claude **Agent SDK** (subscription-backed). OpenAI has no keyless SDK, so its fallback is the **Codex CLI**.
- **Never** API keys (see [ADR-0002](../adr/0002-subscription-auth-no-api-keys.md)).

---

## 4. Browser surface (answers "do we need an embedded browser?")

**Yes — one controllable browser serves both modes.**

```mermaid
flowchart TB
    subgraph SURF["Browser Surface (single Chromium via Playwright/CDP)"]
        CU["computer-use<br/>screenshots → mouse/keyboard by coordinate"]
        BU["browser-use<br/>DOM / accessibility-tree actions"]
    end
    SURF --> MIRROR["Live mirror to Electron UI<br/>(screenshot stream + optional headed pop-out)"]
    SURF --> SPECS["Recorded flows → Playwright specs"]
    SPECS --> RERUN["Re-run headless (deterministic, downloadable)"]
```

Discovery uses computer-use **or** browser-use (per run); the *output* is always deterministic Playwright specs that re-run without the AI. See [ADR-0006](../adr/0006-embedded-browser-surface.md).

---

## 5. Module → reference mapping

Concepts to port from `../TestBot_MCP/testbot-mcp/src`:

| Healix module | Reference source | Note |
|---|---|---|
| Target Adapter (white-box launch) | `auto-detector.js`, `multi-service-starter.js`, `port-preflight.js` | Detect port/framework/start command |
| Browser Surface | `browser-use-driver.js`, `playwright-explorer.js`, `playwright-mcp-client.js` | Collapse into one CDP surface |
| Test-Mode (Playwright) | `playwright-integration.js`, `tier-isolation.js`, `results-merger.js` | Tiered execution + blocked status |
| Credential injection | `credentials-injector.js`, `auth-flow-utils.js` | `storageState` per role |
| Generation | `webapp .../test-generation`, `prd-chunked.js`, `qa-contracts.js` | Now local, provider-driven |
| Failure triage | `failure-triage/` (`classifier.js`, `agent-response.js`, `trace-parser.js`) | Classifier → AI hypothesis |
| Report | `report-generator.js` | Local HTML/JSON instead of ingest |

---

## 6. Tech stack

| Layer | Choice |
|---|---|
| Desktop shell | Electron + electron-vite, electron-builder |
| Renderer | React + TypeScript |
| Shared core | `@healix/core` (TypeScript, framework-agnostic) |
| CLI | Node/TS (`healix`), same core |
| Storage | SQLite (`better-sqlite3`) + filesystem |
| Browser automation | Playwright (CDP) |
| AI | Claude Code CLI + Codex CLI (plan mode) · Claude Agent SDK (fallback) |
| Secrets | OS keychain (`keytar`/`safeStorage`) — no keys, only session metadata |
