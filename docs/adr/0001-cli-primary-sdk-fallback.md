# ADR-0001: CLI-primary orchestration with SDK fallback

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Anurag

## Context

Healix's orchestrator must drive Claude and OpenAI/Codex for AI-led testing. Options were: CLI subprocess only, embedded SDK only, or a hybrid. A hard constraint (see [ADR-0002](./0002-subscription-auth-no-api-keys.md)) is that **no API keys** are ever used — auth must ride existing subscriptions. Both providers must run in **plan mode** so the user reviews intent before execution.

## Decision

Use a **hybrid** model with the **CLI as primary** and **SDK as fallback**:

- **Primary:** spawn **Claude Code CLI** and **Codex CLI** as subprocesses in **plan mode**. The orchestrator submits tasks, captures the proposed plan, gates on human approval, then runs.
- **Fallback:** **Claude Agent SDK** (subscription-backed, no key) when the CLI is unavailable or for programmatic/structured calls. OpenAI has **no keyless SDK**, so its only subscription path remains the **Codex CLI** — there is effectively no OpenAI SDK fallback.

A `ProviderAdapter` interface hides CLI-vs-SDK differences behind `plan()`, `execute()`, `health()`.

## Consequences

- Subscription auth "just works" via the CLIs; no key management.
- We depend on CLI plan-mode flags and machine-readable output; pin versions and wrap them.
- Asymmetry: Claude has a real SDK fallback, OpenAI does not — flagged as a risk in the feature plan.
- Subprocess lifecycle (timeouts, cancellation, streaming) must be managed by the core.
