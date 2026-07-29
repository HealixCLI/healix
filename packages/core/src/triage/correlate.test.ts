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

  it('upgrades an ambiguous entry to match a confident sibling sharing the same signature', () => {
    const entries = [
      { error: testIdError(1), triage: mkTriage('app_is_wrong', 0.7, 'A') },
      { error: testIdError(1), triage: mkTriage('app_is_wrong', 0.7, 'B') },
      { error: testIdError(1), triage: mkTriage('ambiguous', 0.45, 'C') },
    ];
    const result = correlateBySignature(entries);
    expect(result[2]!.triage!.verdict).toBe('app_is_wrong');
    expect(result[2]!.triage!.confidence).toBe(0.7);
    expect(result[2]!.triage!.rationale).toMatch(/Corroborated: 3 failures/);
    // Original array/objects untouched.
    expect(entries[2]!.triage!.verdict).toBe('ambiguous');
  });

  it('does NOT change anything when the group has fewer than 2 members', () => {
    const entries = [{ error: testIdError(1), triage: mkTriage('ambiguous', 0.45, 'C') }];
    const result = correlateBySignature(entries);
    expect(result[0]).toBe(entries[0]);
  });

  it('does NOT change anything when the whole group is ambiguous (nothing confident to propagate)', () => {
    const entries = [
      { error: testIdError(1), triage: mkTriage('ambiguous', 0.5, 'A') },
      { error: testIdError(1), triage: mkTriage('ambiguous', 0.45, 'B') },
    ];
    const result = correlateBySignature(entries);
    expect(result[0]).toBe(entries[0]);
    expect(result[1]).toBe(entries[1]);
  });

  it('does NOT touch a member whose confidence already meets/exceeds the group best', () => {
    const entries = [
      { error: testIdError(1), triage: mkTriage('app_is_wrong', 0.7, 'A') },
      { error: testIdError(1), triage: mkTriage('app_is_wrong', 0.7, 'B') },
    ];
    const result = correlateBySignature(entries);
    expect(result[1]).toBe(entries[1]);
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

  it('carries the anchor verdict\'s own verdictSource forward onto upgraded members', () => {
    const entries = [
      { error: testIdError(1), triage: mkTriage('app_is_wrong', 0.7, 'A', 'rule_fallback') },
      { error: testIdError(1), triage: mkTriage('ambiguous', 0.45, 'B') },
    ];
    const result = correlateBySignature(entries);
    expect(result[1]!.triage!.verdictSource).toBe('rule_fallback');
  });
});
