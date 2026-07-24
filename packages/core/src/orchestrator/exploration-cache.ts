import fs from 'node:fs';
import path from 'node:path';
import { projectsDir } from '../env/app-data.js';
import type { ExplorationArtifact } from '../modes/types.js';

/**
 * Per-project cache of the EXPLORE phase's crawl result, keyed by baseUrl — EXPLORE currently
 * rebuilds the whole ExplorationArtifact from scratch on every single run, even when the target
 * app hasn't changed since the last one, which is pure waste on a slow/large app. Deliberately
 * kept OUT of checkpoint.ts/ResumeCheckpoint: that mechanism is for resuming ONE interrupted run;
 * this is a cross-run, project-scoped cache with its own expiry policy, a different concern
 * entirely. Unlike the source-context cache (target/context-store.ts, trusted indefinitely until
 * its file-fingerprint hash changes), a LIVE app's real behavior drifts independently of
 * anything Healix can fingerprint — so this cache has an explicit staleness window and is never
 * trusted indefinitely, even if the baseUrl hasn't changed.
 *
 * V1 caches the whole artifact, not per-route — an intentional simplification, not a shortfall:
 * a cache hit skips the ENTIRE crawl, a miss (including a stale hit) re-runs the whole thing.
 * "Force a fresh crawl" = clearExplorationCache() (delete the file) — no separate API needed.
 */

const FILENAME = 'exploration-cache.json';
/** Default staleness window: unlike the source-context cache, this one must expire on its own. */
const DEFAULT_STALENESS_MS = 24 * 60 * 60 * 1000;

interface CachedExploration {
  baseUrl: string;
  /** ISO timestamp of when this artifact was captured. */
  cachedAt: string;
  artifact: ExplorationArtifact;
}

function cachePath(projectId: string): string {
  return path.join(projectsDir(), projectId, FILENAME);
}

/**
 * Persist an exploration artifact for later reuse. Best-effort: a write failure (read-only
 * disk, disk full, ...) is swallowed rather than failing the caller — same posture as
 * target/context-store.ts's persistSourceContext.
 */
export function persistExplorationCache(
  projectId: string,
  baseUrl: string,
  artifact: ExplorationArtifact,
): void {
  const abs = cachePath(projectId);
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const envelope: CachedExploration = { baseUrl, cachedAt: new Date().toISOString(), artifact };
    fs.writeFileSync(abs, JSON.stringify(envelope), 'utf-8');
  } catch {
    /* best-effort — see module doc comment */
  }
}

/**
 * Load a cached exploration artifact, or null when there is none, it's for a different baseUrl
 * (the project's app moved / the URL changed), it's outside the staleness window, or the file is
 * missing/unreadable/malformed. Never throws.
 */
export function loadExplorationCache(
  projectId: string,
  baseUrl: string,
  maxAgeMs: number = DEFAULT_STALENESS_MS,
): ExplorationArtifact | null {
  const abs = cachePath(projectId);
  try {
    const raw = fs.readFileSync(abs, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Partial<CachedExploration>;
    if (typeof obj.baseUrl !== 'string' || typeof obj.cachedAt !== 'string' || !obj.artifact) return null;
    if (obj.baseUrl !== baseUrl) return null;
    const cachedAtMs = Date.parse(obj.cachedAt);
    if (!Number.isFinite(cachedAtMs)) return null;
    const age = Date.now() - cachedAtMs;
    if (age < 0 || age >= maxAgeMs) return null;
    return obj.artifact;
  } catch {
    return null;
  }
}

/** "Force a fresh crawl" = delete the cache file. Best-effort; a missing file is not an error. */
export function clearExplorationCache(projectId: string): void {
  try {
    fs.rmSync(cachePath(projectId), { force: true });
  } catch {
    /* best-effort */
  }
}
