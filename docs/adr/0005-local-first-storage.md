# ADR-0005: Local-first storage (SQLite + filesystem)

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Anurag

## Context

The old stack used Supabase (Postgres) + Supabase Storage + Vercel + Inngest. Healix must keep **all data local**: videos, screenshots, traces, API/UI reports, and generated suites. No cloud backend.

## Decision

Persist everything locally:

- **SQLite** (`better-sqlite3`) for structured data: projects, runs, tests, results, tier results, triage verdicts.
- **Filesystem** for artifacts under the OS app-data dir:
  ```
  <app-data>/Healix/healix.db
  <app-data>/Healix/projects/<projectId>/runs/<runId>/{plan,suite,artifacts,reports,auth}/
  ```
- Run state is **checkpointed** to SQLite so runs are resumable (local replacement for Inngest).
- A migration tool manages the SQLite schema (single source of truth).

## Consequences

- Zero server cost / no network dependency for core flows; strong privacy story.
- No multi-device sync out of the box (acceptable; could add later via export/import).
- Artifact disk growth needs retention/cleanup policies.
- Backups are the user's local filesystem responsibility.
