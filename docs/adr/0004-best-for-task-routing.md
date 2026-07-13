# ADR-0004: Best-for-task provider routing with automatic fallback

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Anurag

## Context

When both Claude and OpenAI/Codex are connected, Healix must choose which to use. Options: pin one default, route by task capability with fallback, or race both. The user wants "whatever is best, or acts as a fallback."

## Decision

Route **by task capability with automatic fallback**:

- A capability map picks the preferred provider per task (e.g. **computer-use → Claude** by default; **codegen/structured → either**, configurable).
- Before dispatch, the Provider Router checks provider **health** ([ADR-0002](./0002-subscription-auth-no-api-keys.md)).
- On error, rate-limit, or unhealthy session, the router **automatically falls back** to the other provider for that task.
- The user may **override** the provider per run.

## Consequences

- Requires per-task capability metadata and a health/heartbeat probe per provider.
- Fallback must be idempotent at the task boundary (retry without duplicating side effects).
- "Race both" is intentionally **not** the default (cost); it can be added later as an opt-in for high-value tasks.
