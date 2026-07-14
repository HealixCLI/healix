import type { RunStatus, TestStatus } from '@healix/core';
import type { BadgeTone } from '../components/ui/badge';

const RUN_STATUS_TONE: Partial<Record<RunStatus, BadgeTone>> = {
  pending: 'muted',
  planning: 'default',
  'awaiting-approval': 'warn',
  exploring: 'default',
  generating: 'default',
  executing: 'default',
  triaging: 'default',
  reporting: 'default',
  passed: 'ok',
  failed: 'err',
  blocked: 'warn',
  error: 'err',
  cancelled: 'muted',
};

export function runStatusTone(status: RunStatus): BadgeTone {
  return RUN_STATUS_TONE[status] ?? 'default';
}

/** Every run status, in pipeline order, for status-filter dropdowns. */
export const ALL_RUN_STATUSES: RunStatus[] = [
  'pending',
  'planning',
  'awaiting-approval',
  'exploring',
  'generating',
  'executing',
  'triaging',
  'reporting',
  'passed',
  'failed',
  'error',
  'cancelled',
];

/** Human-readable label for a run status, e.g. 'awaiting-approval' -> 'Awaiting Approval'. */
export function formatRunStatus(status: RunStatus): string {
  return status
    .split('-')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

/** A run is finished (terminal) when no further phase transitions are expected. */
export function isTerminalRun(status: RunStatus): boolean {
  return (
    status === 'passed' ||
    status === 'failed' ||
    status === 'blocked' ||
    status === 'error' ||
    status === 'cancelled'
  );
}

const TEST_STATUS_TONE: Record<TestStatus, BadgeTone> = {
  passed: 'ok',
  failed: 'err',
  blocked: 'warn',
  flaky: 'warn',
  skipped: 'muted',
  pending: 'muted',
};

export function testStatusTone(status: TestStatus | null): BadgeTone {
  if (!status) return 'muted';
  return TEST_STATUS_TONE[status] ?? 'default';
}

const EVENT_LEVEL_COLOR: Record<'debug' | 'info' | 'warn' | 'error', string> = {
  debug: 'text-muted',
  info: 'text-fg',
  warn: 'text-warn',
  error: 'text-err',
};

export function eventLevelColor(level: 'debug' | 'info' | 'warn' | 'error'): string {
  return EVENT_LEVEL_COLOR[level];
}

/** Compact, locale-aware timestamp for list rows; falls back to the raw value. */
export function formatCreatedAt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Just the time portion for the console gutter. */
export function formatTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour12: false });
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Trim a (possibly nested) artifact path to its leaf name for tidy lists. */
export function artifactLeaf(rel: string): string {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? rel;
}

// ---- Artifact media handling (screenshots / videos / traces) ----------------

export type ArtifactKind = 'image' | 'video' | 'trace' | 'other';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO_EXT = /\.(webm|mp4|mov)$/i;

/** Classify an artifact file so the gallery knows how to render it. */
export function artifactKind(path: string): ArtifactKind {
  if (IMAGE_EXT.test(path)) return 'image';
  if (VIDEO_EXT.test(path)) return 'video';
  if (/trace\.zip$/i.test(path)) return 'trace';
  return 'other';
}

/**
 * Renderer-loadable URL for an absolute artifact path. Served by the main
 * process's healix-artifact:// protocol (restricted to the projects dir).
 */
export function artifactUrl(abs: string): string {
  return `healix-artifact://run/${encodeURIComponent(abs)}`;
}

export interface ArtifactGroup {
  /** Test folder name under test-results ('' for loose files). */
  folder: string;
  images: string[];
  videos: string[];
  other: string[];
}

/** Slugify a test title the way Playwright names output folders: lowercase, non-alphanumerics → dashes. */
function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Best-effort match between a test title and a Playwright test-results folder.
 * Playwright folders are slugified "<file>-<title>[-<project>]", truncated for
 * long names with a short hash appended — so an exact comparison is hopeless.
 * We slugify the title the same way and accept the folder when it starts with
 * (or contains) a prefix of that slug. Heuristic by design; callers must cope
 * with "no match" (e.g. by falling back to the top of the artifacts tab).
 */
export function slugMatches(title: string, folder: string): boolean {
  const slug = slugifyTitle(title);
  if (!slug || !folder) return false;
  const f = folder.toLowerCase();
  // Compare on a bounded prefix because Playwright truncates + appends hashes.
  const probe = slug.slice(0, 32);
  return f.startsWith(probe) || f.includes(probe);
}

/** Group relative artifact paths by their test folder, media first. */
export function groupArtifacts(rels: string[]): ArtifactGroup[] {
  const byFolder = new Map<string, ArtifactGroup>();
  for (const rel of rels) {
    const slash = rel.indexOf('/');
    const folder = slash === -1 ? '' : rel.slice(0, slash);
    let group = byFolder.get(folder);
    if (!group) {
      group = { folder, images: [], videos: [], other: [] };
      byFolder.set(folder, group);
    }
    const kind = artifactKind(rel);
    if (kind === 'image') group.images.push(rel);
    else if (kind === 'video') group.videos.push(rel);
    else group.other.push(rel);
  }
  // Groups with media come first; loose files sink to the bottom.
  return [...byFolder.values()].sort((a, b) => {
    const aMedia = a.images.length + a.videos.length > 0 ? 0 : 1;
    const bMedia = b.images.length + b.videos.length > 0 ? 0 : 1;
    if (aMedia !== bMedia) return aMedia - bMedia;
    return a.folder.localeCompare(b.folder);
  });
}
