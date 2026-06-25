# ADR-0002: Subscription auth only — never API keys

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Anurag

## Context
The old TestBot_MCP proxied AI through a webapp and billed per-token via API keys. Healix is local-first and must avoid per-token billing and key handling entirely. Users already hold Claude (Max/Pro) and ChatGPT/Codex subscriptions.

## Decision
**Authenticate only via provider subscriptions; never read or store API keys.**

- The desktop app exposes a **"Connect / Login"** action per provider that triggers the provider CLI's login flow (e.g. `claude` / `codex` login) and a **health-check** that verifies the session is live.
- The Auth/Session Manager stores **only session metadata/status**, never secrets, and uses the OS keychain (`safeStorage`) where any local state is persisted.
- If a provider is not logged in, it is shown as unavailable and excluded from routing.

## Consequences
- No key input fields anywhere in the product; nothing to leak in exports or logs.
- Healix is coupled to each CLI's login/session model and its stability across versions.
- Headless CI must rely on a pre-authenticated CLI session on the runner.
- Capabilities are bounded by what subscription tiers expose (e.g. no keyless OpenAI SDK).
