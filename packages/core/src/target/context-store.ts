import fs from 'node:fs';
import path from 'node:path';
import type { SourceContext } from './source-context.js';

/** Where the compacted source-context artifact lives, matching the `.healix/` convention already used for team-shared suite state (see suite/canonical.ts, suite/config.ts). */
const RELATIVE_PATH = path.join('.healix', 'source-context.json');

/** Caps applied only at persistence time — indexSource's own `maxUnits` already bounds `units`. */
const MAX_PERSISTED_FORMS = 50;
const MAX_PERSISTED_AUTH_PATTERNS = 50;
const MAX_PERSISTED_SELECTOR_HINTS = 200;

/** Persisted envelope: `hash` is computeRepoSourceHash()'s fingerprint of the repo at persist time — a
 * later caller compares it against a freshly-computed hash to decide whether indexSource()'s
 * full-repo walk can be skipped in favor of `context`. */
export interface PersistedSourceContext {
  hash: string;
  context: SourceContext;
}

/** Compact a SourceContext to a bounded slice safe to persist and later reload for triage/generation grounding. */
function compact(ctx: SourceContext): SourceContext {
  return {
    ...ctx,
    forms: ctx.forms.slice(0, MAX_PERSISTED_FORMS),
    authPatterns: ctx.authPatterns.slice(0, MAX_PERSISTED_AUTH_PATTERNS),
    selectorHints: ctx.selectorHints.slice(0, MAX_PERSISTED_SELECTOR_HINTS),
  };
}

/**
 * Persist a compacted slice of the source context, alongside the repo-fingerprint hash it was
 * computed from, to `<repoPath>/.healix/source-context.json` — so later stages of the SAME run,
 * a resumed run, or a later run's TRIAGE pass reloading a previous run's context can reference it
 * as grounding without re-running static analysis. Best-effort: a write failure (read-only repo,
 * disk full, ...) is swallowed rather than failing the caller — this is a convenience artifact,
 * not something any phase strictly depends on to function.
 */
export function persistSourceContext(repoPath: string, hash: string, ctx: SourceContext): void {
  const abs = path.join(repoPath, RELATIVE_PATH);
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const envelope: PersistedSourceContext = { hash, context: compact(ctx) };
    fs.writeFileSync(abs, JSON.stringify(envelope, null, 2), 'utf-8');
  } catch {
    /* best-effort — see doc comment above */
  }
}

/**
 * Load a previously persisted {hash, context} envelope, or null when none exists yet or the file
 * is unreadable/malformed (including a pre-envelope legacy file predating this shape — never
 * throws, never returns a value missing either field).
 */
export function loadSourceContext(repoPath: string): PersistedSourceContext | null {
  const abs = path.join(repoPath, RELATIVE_PATH);
  try {
    const raw = fs.readFileSync(abs, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Partial<PersistedSourceContext>;
    if (typeof obj.hash !== 'string' || !obj.context || typeof obj.context !== 'object') return null;
    return { hash: obj.hash, context: obj.context };
  } catch {
    return null;
  }
}
