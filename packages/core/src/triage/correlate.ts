/**
 * Cross-failure signature correlation — a deterministic post-pass over a
 * run's ALREADY-triaged failures (rule-based + AI-enriched).
 *
 * Every failure is escalated to AI now (no cap), but two structural gaps
 * remain: (1) a per-item AI call can still fail (provider error, timeout, an
 * unparseable reply) and fall back to the rule baseline (verdictSource:
 * 'rule_fallback'), leaving it under-evidenced even though a sibling with the
 * IDENTICAL signature got a real, confident AI verdict; (2) batching gives
 * the model zero visibility across batches, so two failures sharing a
 * signature but landing in different 5-item batches have no structural
 * guarantee of agreeing.
 *
 * This pass groups failures by a coarse, deterministic fingerprint of WHAT
 * was missing (a locator description, a data-testid, or a getBy* call), and
 * when a group has a confident, non-ambiguous verdict on ANY member, applies
 * it to every OTHER member that is itself still on a rule_fallback verdict.
 *
 * Deliberately narrow: an 'ai_reviewed' member is NEVER overridden, even by a
 * higher-confidence sibling in the same group — two independently-reached AI
 * verdicts that disagree (e.g. one test_is_wrong @0.6, another app_is_wrong
 * @0.7) is a real disagreement worth surfacing as-is, not evidence the lower
 * one was wrong. Only a rule_fallback verdict (which never got a genuine AI
 * opinion at all) is fair game to rescue with a confident sibling's verdict.
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

// Never propagate a group's confident verdict onto a member that already got
// a genuine AI opinion — that's an independently-reached verdict, not
// something under-evidenced, even if its confidence is lower than a
// sibling's. Only a rule_fallback member (no real AI opinion at all, because
// the call errored/timed out/returned an unparseable reply) is fair game to
// rescue with a confident sibling's verdict.
const CONFIDENT_VERDICTS: readonly Verdict[] = ['test_is_wrong', 'app_is_wrong', 'environment', 'flaky'];

/**
 * Returns a NEW array (input untouched) where any failure sharing a
 * 2+-member signature group with a confident verdict elsewhere in the group
 * has its own verdict/confidence/rationale upgraded to match — only when its
 * own current verdictSource is 'rule_fallback' (never got a genuine AI
 * opinion). An 'ai_reviewed' member is NEVER overridden, regardless of how
 * its confidence compares to the group's best — two independently-reached AI
 * verdicts that disagree is a real disagreement worth surfacing as-is, not
 * evidence the lower-confidence one was wrong. Entries with no extractable
 * signature, or whose group has no confident member, pass through with their
 * triage unchanged (same object reference, so callers can cheaply detect "did
 * this one change").
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
    // Pick the anchor ONLY among members with a confident verdict — an
    // ambiguous rule_fallback member can carry a numerically high confidence
    // score without ever having a real opinion, and must never "win" the
    // anchor slot and block a group that DOES have a genuine confident
    // sibling elsewhere.
    const candidates = group.filter((m) => CONFIDENT_VERDICTS.includes(m.triage!.verdict));
    if (candidates.length === 0) continue;
    const best = candidates.reduce((a, b) => (b.triage!.confidence > a.triage!.confidence ? b : a));

    const sig = extractFailureSignature(best.error ?? '');
    for (const member of group) {
      if (member === best) continue;
      const current = member.triage!;
      const isWeaker = current.verdictSource === 'rule_fallback';
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
