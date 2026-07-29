/**
 * Cross-failure signature correlation — a deterministic post-pass over a
 * run's ALREADY-triaged failures (rule-based + AI-enriched).
 *
 * Neither classify() nor analyze()/analyzeBatch() ever sees more than one
 * failure's OWN evidence at a time, so two failures missing the exact same
 * element can end up with wildly different verdicts/confidence purely
 * because of which batch the AI happened to review them in, or because one
 * hit a provider error/timeout (verdictSource: 'rule_fallback') while its
 * twin got a real AI reply (verdictSource: 'ai_reviewed'). Identical evidence
 * should never produce different verdicts. This pass groups failures by a
 * coarse, deterministic fingerprint
 * of WHAT was missing (a locator description, a data-testid, or a getBy*
 * call), and when a group has a confident, non-ambiguous verdict on ANY
 * member, applies it consistently to every other member of that group that
 * is currently ambiguous or less confident.
 */
import type { TriageResult, Verdict } from './types.js';

const RE_LOCATOR_LINE = /Locator:\s*(.+)/;
const RE_TESTID = /data-testid=["']([^"']+)["']/;
const RE_GETBY = /(getByText|getByRole|getByLabel|getByPlaceholder|getByTestId)\(([^)]{0,120})\)/;

/**
 * A coarse fingerprint of WHAT a failure was looking for, read back out of
 * Playwright's own error text (never the free-form assertion message, which
 * varies test to test even for the same missing element). Returns null when
 * no recognizable locator/testid signal is present — those failures are
 * left out of every group rather than being fingerprinted on something as
 * weak as the raw error string.
 */
export function extractFailureSignature(error: string): string | null {
  const testid = RE_TESTID.exec(error);
  if (testid) return `data-testid=${testid[1]}`;
  const locator = RE_LOCATOR_LINE.exec(error);
  if (locator) return locator[1].trim();
  const getBy = RE_GETBY.exec(error);
  if (getBy) return `${getBy[1]}(${getBy[2]})`;
  return null;
}

export interface CorrelationEntry {
  error: string;
  triage: TriageResult | null;
}

// Never propagate a group's confident verdict onto members whose verdict was
// already something other than 'ambiguous' at a comparable confidence — this
// pass is meant to rescue failures the per-item process left under-evidenced,
// not to overwrite a different, independently-reached verdict.
const CONFIDENT_VERDICTS: readonly Verdict[] = ['test_is_wrong', 'app_is_wrong', 'environment', 'flaky'];

/**
 * Returns a NEW array (input untouched) where any failure sharing a
 * 2+-member signature group with a confident verdict elsewhere in the group
 * has its own verdict/confidence/rationale upgraded to match — only when its
 * own current verdict is 'ambiguous' or strictly less confident than the
 * group's best. Entries with no extractable signature, or whose group has no
 * confident member, pass through with their triage unchanged (same object
 * reference, so callers can cheaply detect "did this one change").
 */
export function correlateBySignature<T extends CorrelationEntry>(entries: readonly T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const e of entries) {
    if (!e.triage) continue;
    const sig = extractFailureSignature(e.error ?? '');
    if (!sig) continue;
    const list = groups.get(sig);
    if (list) list.push(e);
    else groups.set(sig, [e]);
  }

  const upgrades = new Map<T, TriageResult>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const best = group.reduce((a, b) => (b.triage!.confidence > a.triage!.confidence ? b : a));
    if (!CONFIDENT_VERDICTS.includes(best.triage!.verdict)) continue;

    const sig = extractFailureSignature(best.error ?? '');
    for (const member of group) {
      if (member === best) continue;
      const current = member.triage!;
      const isWeaker = current.verdict === 'ambiguous' || current.confidence < best.triage!.confidence;
      if (!isWeaker) continue;
      upgrades.set(member, {
        verdict: best.triage!.verdict,
        confidence: best.triage!.confidence,
        rationale:
          `${best.triage!.rationale} ` +
          `(Corroborated: ${group.length} failures in this run share the identical failure signature ` +
          `"${sig}" — the same verdict applies consistently across all of them.)`,
        verdictSource: best.triage!.verdictSource,
        ...(best.triage!.suggestedPatch ? { suggestedPatch: best.triage!.suggestedPatch } : {}),
      });
    }
  }

  return entries.map((e) => (upgrades.has(e) ? { ...e, triage: upgrades.get(e)! } : e));
}
