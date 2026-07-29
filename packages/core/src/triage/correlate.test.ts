import { describe, it, expect } from 'vitest';
import { extractFailureSignature, correlateBySignature } from './correlate.js';

describe('extractFailureSignature', () => {
  it('extracts a data-testid signature', () => {
    expect(extractFailureSignature('Locator: locator(\'img[data-testid="headerbl-logo"]\')')).toBe(
      'data-testid=headerbl-logo',
    );
  });

  it('extracts a bare Locator: line when no data-testid is present', () => {
    expect(extractFailureSignature("Locator: getByText('Not found')")).toBe("getByText('Not found')");
  });

  it('extracts a getByText(...) call from free-form error text', () => {
    expect(extractFailureSignature("waiting for getByText('Spin').first()")).toContain("getByText('Spin'");
  });

  it('returns null when nothing recognizable is present', () => {
    expect(extractFailureSignature('some generic crash with no locator info')).toBeNull();
  });
});

describe('correlateBySignature', () => {
  const testIdError = (n: number) =>
    `Error: expect(locator).toBeVisible() failed\nLocator: locator('img[data-testid="headerbl-logo${n === 0 ? '' : ''}"]')\nTimeout: 3000ms`;

  const mkTriage = (
    verdict: 'app_is_wrong' | 'test_is_wrong' | 'environment' | 'flaky' | 'ambiguous',
    confidence: number,
    rationale: string,
    verdictSource: 'ai_reviewed' | 'rule_fallback' = 'ai_reviewed',
  ) => ({ verdict, confidence, rationale, verdictSource });

  it('upgrades a rule_fallback entry to match a confident ai_reviewed sibling sharing the same signature', () => {
    const entries = [
      { error: testIdError(1), triage: mkTriage('app_is_wrong', 0.7, 'A') },
      { error: testIdError(1), triage: mkTriage('app_is_wrong', 0.7, 'B') },
      { error: testIdError(1), triage: mkTriage('ambiguous', 0.45, 'C', 'rule_fallback') },
    ];
    const result = correlateBySignature(entries);
    expect(result[2]!.triage!.verdict).toBe('app_is_wrong');
    expect(result[2]!.triage!.confidence).toBe(0.7);
    expect(result[2]!.triage!.rationale).toMatch(/Corroborated: 3 failures/);
    // Original array/objects untouched.
    expect(entries[2]!.triage!.verdict).toBe('ambiguous');
  });

  it('does NOT change anything when the group has fewer than 2 members', () => {
    const entries = [{ error: testIdError(1), triage: mkTriage('ambiguous', 0.45, 'C', 'rule_fallback') }];
    const result = correlateBySignature(entries);
    expect(result[0]).toBe(entries[0]);
  });

  it('does NOT change anything when the whole group is ambiguous (nothing confident to propagate)', () => {
    const entries = [
      { error: testIdError(1), triage: mkTriage('ambiguous', 0.5, 'A', 'rule_fallback') },
      { error: testIdError(1), triage: mkTriage('ambiguous', 0.45, 'B', 'rule_fallback') },
    ];
    const result = correlateBySignature(entries);
    expect(result[0]).toBe(entries[0]);
    expect(result[1]).toBe(entries[1]);
  });

  it('does NOT override an ai_reviewed member even when its confidence is lower than the group best (two genuine, disagreeing AI verdicts)', () => {
    // The exact scenario this test guards: Failure A got "test_is_wrong" @0.6
    // from AI, Failure B got "app_is_wrong" @0.7 from AI, both sharing the
    // same signature. A must NOT be silently overwritten by B just because
    // B's confidence is higher — both are real, independently-reached
    // verdicts, and a disagreement between them should stay visible.
    const entries = [
      { error: testIdError(1), triage: mkTriage('test_is_wrong', 0.6, 'A is wrong') },
      { error: testIdError(1), triage: mkTriage('app_is_wrong', 0.7, 'B is wrong') },
    ];
    const result = correlateBySignature(entries);
    expect(result[0]).toBe(entries[0]);
    expect(result[0]!.triage!.verdict).toBe('test_is_wrong');
    expect(result[0]!.triage!.confidence).toBe(0.6);
  });

  it("does NOT override an ai_reviewed member even when the AI's OWN verdict was ambiguous", () => {
    // AI concluding "ambiguous" is still a genuine, considered opinion (not a
    // fallback) — it must be left alone just like any other ai_reviewed verdict.
    const entries = [
      { error: testIdError(1), triage: mkTriage('app_is_wrong', 0.7, 'A') },
      { error: testIdError(1), triage: mkTriage('ambiguous', 0.4, 'AI genuinely unsure') },
    ];
    const result = correlateBySignature(entries);
    expect(result[1]).toBe(entries[1]);
    expect(result[1]!.triage!.verdict).toBe('ambiguous');
  });

  it('upgrades a rule_fallback member even when its OWN confidence number is higher than the best (source gates eligibility, not confidence)', () => {
    const entries = [
      { error: testIdError(1), triage: mkTriage('app_is_wrong', 0.6, 'A') },
      { error: testIdError(1), triage: mkTriage('ambiguous', 0.9, 'B never reviewed', 'rule_fallback') },
    ];
    const result = correlateBySignature(entries);
    expect(result[1]!.triage!.verdict).toBe('app_is_wrong');
    expect(result[1]!.triage!.confidence).toBe(0.6);
  });

  it('does NOT correlate failures with different signatures', () => {
    const entries = [
      { error: "Locator: getByText('Not found')", triage: mkTriage('app_is_wrong', 0.7, 'A') },
      { error: "Locator: getByText('Spin')", triage: mkTriage('ambiguous', 0.45, 'B') },
    ];
    const result = correlateBySignature(entries);
    expect(result[1]).toBe(entries[1]);
  });

  it('skips entries with no triage result', () => {
    const entries = [
      { error: testIdError(1), triage: null },
      { error: testIdError(1), triage: mkTriage('app_is_wrong', 0.7, 'A') },
    ];
    expect(() => correlateBySignature(entries)).not.toThrow();
    expect(correlateBySignature(entries)[0]!.triage).toBeNull();
  });

  it("carries the anchor verdict's own verdictSource forward onto upgraded members", () => {
    const entries = [
      { error: testIdError(1), triage: mkTriage('app_is_wrong', 0.7, 'A', 'rule_fallback') },
      { error: testIdError(1), triage: mkTriage('ambiguous', 0.45, 'B', 'rule_fallback') },
    ];
    const result = correlateBySignature(entries);
    expect(result[1]!.triage!.verdictSource).toBe('rule_fallback');
  });
});
