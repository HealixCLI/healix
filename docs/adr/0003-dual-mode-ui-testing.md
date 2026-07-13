# ADR-0003: Dual-mode UI testing (computer-use + codegen), selectable per run

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Anurag

## Context

UI exploration/generation can be done agentically (computer-use: the model drives a browser via screenshots) or by codegen (the model reads the app/repo and writes specs). Each has trade-offs: computer-use finds real runtime flows but is slow/costly; codegen is fast but can miss dynamic behavior. A core product goal is **downloadable, deterministic suites**.

## Decision

Support **both**, **selectable per run**:

- **Computer-use** — agentic discovery via the embedded browser ([ADR-0006](./0006-embedded-browser-surface.md)); best for first-time exploration of unfamiliar apps.
- **Codegen** — repo/URL-informed direct spec authoring; best for fast re-generation and CI.

Regardless of mode, the **output is always deterministic Playwright specs** that re-run without the AI.

## Consequences

- The run config carries a `mode` toggle; defaults: computer-use for first discovery, codegen for re-runs.
- Both paths must converge on the same spec/artifact format so reports and exports are uniform.
- Cost/latency guidance surfaced in the UI (computer-use is heavier).
