# ADR-0010: Codex-inspired UX / design language

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Anurag

## Context

Healix is an AI-led tool with plan-mode approval gates and streaming agent output. The UX should feel like a focused, developer-grade companion — the user asked to "follow a Codex-like design."

## Decision

Adopt a **Codex-inspired** design language:

- **Calm and minimal** — generous whitespace, few accents, content-first.
- **Monochrome / dark-first** palette with a single accent; **monospace-leaning** type for plans, logs, and code.
- **Keyboard-first** — command palette, shortcuts, fast navigation.
- **Plan → approve → run** as a first-class flow: the AI's proposed plan is shown as a reviewable diff/checklist with an explicit **approval gate** before any execution or file writes.
- **Streaming, legible output** — live agent/console stream and a **live browser view** panel ([ADR-0006](./0006-embedded-browser-surface.md)).
- **Progressive disclosure** — simple by default; advanced controls (tiers, provider override, mode toggle) tucked behind affordances.

## Consequences

- A small design-token set (color, type, spacing, motion) defined up front; shared across app surfaces.
- Approval-gate and streaming patterns become reusable components.
- CLI output mirrors the same calm, structured aesthetic (plain, well-spaced, color-restrained).
