# ADR-0008: Pluggable test-mode architecture (Playwright first)

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Anurag

## Context

Healix must support multiple engines over time — **Healix Playwright**, **Healix Selenium**, **Healix XYZ** — switchable per project without re-authoring test intent. The intent (requirements, flows, AC) should be engine-independent; only generation/execution/export differ.

## Decision

Define a common **`TestMode`** plugin interface that every engine implements:

```ts
interface TestMode {
  id: string; // "playwright" | "selenium" | ...
  scaffold(ctx): Promise<void>; // create a runnable project skeleton
  generate(plan): Promise<Spec[]>; // intent → engine specs (REQ-tagged)
  execute(specs): Promise<RunResult>;
  collectArtifacts(): Promise<Artifacts>;
  export(): Promise<SuiteBundle>; // standalone runnable project
}
```

- The orchestrator owns engine-independent intent (plan, flows, AC, roles); the mode owns engine specifics.
- **`PlaywrightMode` ships first.** Selenium/XYZ are added behind the same interface.

## Consequences

- Switching engines reuses the approved plan; no intent rewrite.
- The interface must be expressive enough for both browser engines and API testing.
- Shared concepts (tiers, REQ tags, artifacts) standardized at the orchestrator level so reports/exports are uniform across modes.
