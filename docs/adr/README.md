# Architecture Decision Records (ADRs)

Each ADR captures one decision: its context, the choice, and consequences. Format is lightweight (MADR-style). Decided records are filled; pending records are **placeholder stubs** to be written when the decision is made.

| # | Title | Status |
|---|---|---|
| [0001](./0001-cli-primary-sdk-fallback.md) | CLI-primary orchestration with SDK fallback | Accepted |
| [0002](./0002-subscription-auth-no-api-keys.md) | Subscription auth only — never API keys | Accepted |
| [0003](./0003-dual-mode-ui-testing.md) | Dual-mode UI testing (computer-use + codegen), per run | Accepted |
| [0004](./0004-best-for-task-routing.md) | Best-for-task provider routing with auto fallback | Accepted |
| [0005](./0005-local-first-storage.md) | Local-first storage (SQLite + filesystem) | Accepted |
| [0006](./0006-embedded-browser-surface.md) | Single embedded browser surface (Playwright/CDP) | Accepted |
| [0007](./0007-electron-vite-react-shared-core.md) | electron-vite + React + TS, shared `@healix/core` | Accepted |
| [0008](./0008-pluggable-test-modes.md) | Pluggable test-mode architecture (Playwright first) | Accepted |
| [0009](./0009-standalone-suite-export.md) | Standalone runnable suite export | Accepted |
| [0010](./0010-codex-inspired-ux.md) | Codex-inspired UX / design language | Accepted |
| [0011](./0011-selenium-mode-design.md) | Healix Selenium mode design | Proposed (stub) |
| [0012](./0012-credential-vault.md) | Credential vault / secret storage | Proposed (stub) |
| [0013](./0013-failure-triage-engine.md) | Failure triage engine | Proposed (stub) |
| [0014](./0014-test-data-management.md) | Test-data management & fixtures | Proposed (stub) |
| [0015](./0015-ci-export-integration.md) | CI export & integration | Proposed (stub) |
| [0016](./0016-telemetry-privacy.md) | Telemetry & privacy (local-first) | Proposed (stub) |
| [0017](./0017-update-distribution.md) | Auto-update & distribution | Proposed (stub) |

## Template

```markdown
# ADR-NNNN: Title

- **Status:** Proposed | Accepted | Superseded by ADR-XXXX
- **Date:** YYYY-MM-DD
- **Deciders:** …

## Context
What problem/forces are at play?

## Decision
What we chose.

## Consequences
Trade-offs, follow-ups, risks.
```
