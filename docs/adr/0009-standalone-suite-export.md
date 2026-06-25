# ADR-0009: Standalone runnable suite export

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Anurag

## Context
A core promise is that generated suites are **immediately usable** outside Healix — people should be able to take them straight into their own repo/CI. The old stack kept results in a cloud dashboard; Healix must produce a portable artifact.

## Decision
Export a **self-contained, runnable Playwright project** (folder + zip):

```
healix-suite-<project>-<run>/
├── package.json            # pinned @playwright/test
├── playwright.config.ts    # projects = tiers (public / auth-<role> / api)
├── tests/                  # REQ-tagged specs (UI + API)
├── fixtures/               # helpers, request contexts
├── auth/                   # storageState templates (secrets stripped)
└── README.md               # `npm install && npx playwright test`
```

- **Zero Healix dependency** — clone and `npm test` anywhere.
- Secrets are **never** exported (carry over the old `auth-state-*.json` deny-list); auth files ship as templates with placeholders.

## Consequences
- Export must pin Playwright versions for reproducibility.
- Sanitization is mandatory and tested (no credentials, no local absolute paths).
- Optional later: raw-specs-only export and direct CI-recipe export ([ADR-0015](./0015-ci-export-integration.md)).
