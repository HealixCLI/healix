/**
 * End-of-run AI grouping summary — one extra, cheap AI call over the
 * already-assembled per-failure triage entries, synthesizing CROSS-failure
 * patterns (e.g. "3 of these 5 failures share the same broken endpoint")
 * that classify()/analyze() never see, since each of those triages exactly
 * ONE failure independently. No new data collection: this reads the same
 * ReportTriageEntry[] the report already has by the time TRIAGE finishes.
 */
import type { ProviderAdapter } from '../providers/types.js';
import type { UsageRecorder } from '../providers/usage.js';
import type { TriageResult } from './types.js';

/**
 * Structurally identical to orchestrator/report.ts's ReportTriageEntry —
 * defined locally so triage/ doesn't import from orchestrator/ (the
 * dependency should only ever run the other way).
 */
export interface GroupingTriageEntry {
  title: string;
  error: string;
  triage: TriageResult;
}

const MAX_ENTRIES = 30;
const MAX_ERROR_CHARS = 300;

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/**
 * Build the grouping prompt: a numbered digest of every triaged failure
 * (verdict + title + a short error/rationale fingerprint, not the full
 * evidence individual analyze() calls already got), capped at MAX_ENTRIES so
 * a run with an unusually large failure count still gets a bounded prompt.
 */
export function buildGroupingPrompt(entries: GroupingTriageEntry[]): string {
  const shown = entries.slice(0, MAX_ENTRIES);
  const rows = shown
    .map(
      (e, i) =>
        `${i + 1}. [${e.triage.verdict}] "${e.title}" — ${truncate(e.error || e.triage.rationale, MAX_ERROR_CHARS)}`,
    )
    .join('\n');
  const omittedNote =
    entries.length > shown.length
      ? `\n(${entries.length - shown.length} more failure(s) omitted from this digest for length.)`
      : '';

  return [
    'You are summarizing a batch of already-triaged test failures for a human',
    'reading a test report. Each failure below was ALREADY classified independently',
    '(verdict, confidence, rationale) — your job is different: look ACROSS all of',
    'them and identify whether several share the SAME underlying root cause (e.g.',
    'the same broken endpoint, the same missing selector, the same outage), and',
    'call that out explicitly. Do not re-litigate any individual verdict.',
    '',
    '--- TRIAGED FAILURES ---',
    rows + omittedNote,
    '',
    '--- INSTRUCTIONS ---',
    'Reply with 2-4 sentences of plain prose (no JSON, no markdown headers, no',
    'bullet list) — a short paragraph a reader can skim in a few seconds. If you',
    'find a real shared root cause, name it and reference which failures (by',
    'their number above) share it. If the failures look genuinely unrelated, say',
    "so briefly instead of forcing a pattern that isn't there.",
    '',
    'Be conservative about naming a SPECIFIC unverified infrastructure cause',
    '(e.g. "the backend crashed", "the service is down", "a startup failure") —',
    'that is a strong, falsifiable claim, and asserting it wrongly is worse than',
    'not asserting it at all. Before naming one, check whether any failure above',
    'contradicts it — in particular, a PASSING test elsewhere in the same run',
    'that required a successful call to the same dependency/origin means the',
    'dependency was not actually down, and a "crashed backend" theory is wrong.',
    'When you are not certain of the underlying MECHANISM, describe the',
    'observable SYMPTOM PATTERN instead (e.g. "most requests to this origin',
    'return an unexpected status code") rather than asserting an unverified',
    'root cause.',
  ].join('\n');
}

/**
 * F-23: why summarizeTriageGroups came back without a summary — surfaced in
 * the report instead of a silent `null` indistinguishable from "nothing to
 * summarize". `null` itself means it succeeded (a summary IS present).
 * `'timeout'` is set by the ORCHESTRATOR's own withTimeoutAbort wrapper
 * around this call (see orchestrator/index.ts's grouping-summary block) —
 * this function has no timeout of its own, so it never produces that reason
 * itself.
 */
export type GroupingSummaryUnavailableReason = 'empty-batch' | 'provider-error' | 'timeout';

export interface GroupingSummaryResult {
  summary: string | null;
  /** Set only when `summary` is null; explains why. */
  reason: GroupingSummaryUnavailableReason | null;
}

/**
 * One AI call summarizing cross-failure patterns across every triaged entry.
 * Returns `{ summary: null, reason: 'empty-batch' }` when there's nothing
 * worth summarizing (fewer than 2 failures — a single failure has no
 * cross-failure pattern to find), or `{ summary: null, reason:
 * 'provider-error' }` when the call fails/is aborted/returns empty text —
 * this is best-effort prose, not something report-writing can't proceed
 * without, but the reason is worth showing rather than silently omitting.
 */
export async function summarizeTriageGroups(
  entries: GroupingTriageEntry[],
  provider: ProviderAdapter,
  opts: { signal?: AbortSignal; onUsage?: UsageRecorder; cwd?: string } = {},
): Promise<GroupingSummaryResult> {
  if (entries.length < 2) return { summary: null, reason: 'empty-batch' };

  const prompt = buildGroupingPrompt(entries);
  try {
    const reply = await provider.complete(prompt, {
      cwd: opts.cwd,
      signal: opts.signal,
      taskType: 'triage-summary',
    });
    opts.onUsage?.('triage-summary', 'grouping', provider.id, reply.raw);
    if (!reply.ok || !reply.text || !reply.text.trim()) {
      return { summary: null, reason: 'provider-error' };
    }
    return { summary: reply.text.trim(), reason: null };
  } catch {
    return { summary: null, reason: 'provider-error' };
  }
}
