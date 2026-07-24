import { describe, expect, it } from 'vitest';
import { buildGroupingPrompt, summarizeTriageGroups } from './grouping.js';
import type { GroupingTriageEntry } from './grouping.js';
import type { ProviderAdapter } from '../providers/types.js';

function fakeProvider(complete: ProviderAdapter['complete']): ProviderAdapter {
  return {
    id: 'claude',
    label: 'fake',
    capabilities: ['triage'],
    async detect() {
      return { installed: true, binPath: '/fake', version: '0.0.0' };
    },
    async health() {
      return {
        provider: 'claude',
        status: 'ready',
        installed: true,
        binPath: '/fake',
        version: '0.0.0',
        authenticated: true,
        model: null,
        latencyMs: null,
        detail: '',
      };
    },
    async plan() {
      return { provider: 'claude', ok: true, plan: '', raw: null, detail: '' };
    },
    complete,
  };
}

const ENTRIES: GroupingTriageEntry[] = [
  {
    title: 'Checkout completes',
    error: '500 Internal Server Error at /api/checkout',
    triage: { verdict: 'app_is_wrong', confidence: 0.85, rationale: 'x' },
  },
  {
    title: 'Cart totals update',
    error: '500 Internal Server Error at /api/checkout',
    triage: { verdict: 'app_is_wrong', confidence: 0.8, rationale: 'x' },
  },
];

describe('buildGroupingPrompt', () => {
  it('includes every entry, numbered, with its verdict and a fingerprint of its error', () => {
    const prompt = buildGroupingPrompt(ENTRIES);
    expect(prompt).toContain('1. [app_is_wrong] "Checkout completes"');
    expect(prompt).toContain('2. [app_is_wrong] "Cart totals update"');
    expect(prompt).toContain('500 Internal Server Error');
  });

  it('asks for prose, not JSON — this is a synthesis task, not a structured verdict', () => {
    const prompt = buildGroupingPrompt(ENTRIES);
    expect(prompt).toContain('plain prose');
    expect(prompt).not.toContain('```json');
  });

  it('notes how many entries were omitted when capped', () => {
    const many: GroupingTriageEntry[] = Array.from({ length: 35 }, (_, i) => ({
      title: `Failure ${i}`,
      error: 'boom',
      triage: { verdict: 'ambiguous', confidence: 0.3, rationale: 'x' },
    }));
    const prompt = buildGroupingPrompt(many);
    expect(prompt).toContain('5 more failure(s) omitted');
  });
});

describe('summarizeTriageGroups', () => {
  it('SUCCESS: returns the trimmed prose from a successful completion', async () => {
    const provider = fakeProvider(async () => ({
      provider: 'claude',
      ok: true,
      text: '  Both failures share the same broken /api/checkout endpoint.  \n',
      raw: null,
      detail: '',
    }));

    const summary = await summarizeTriageGroups(ENTRIES, provider);
    expect(summary).toBe('Both failures share the same broken /api/checkout endpoint.');
  });

  it('passes taskType "triage-summary" so per-task model/effort routing applies', async () => {
    let seenTaskType: string | undefined;
    const provider = fakeProvider(async (_prompt, opts) => {
      seenTaskType = opts?.taskType;
      return { provider: 'claude', ok: true, text: 'summary', raw: null, detail: '' };
    });

    await summarizeTriageGroups(ENTRIES, provider);
    expect(seenTaskType).toBe('triage-summary');
  });

  it('TIMEOUT/THROW: returns null (never throws) when the provider call rejects', async () => {
    const provider = fakeProvider(async () => {
      throw new Error('timed out');
    });

    const summary = await summarizeTriageGroups(ENTRIES, provider);
    expect(summary).toBeNull();
  });

  it('MALFORMED: returns null when the provider replies ok:false', async () => {
    const provider = fakeProvider(async () => ({
      provider: 'claude',
      ok: false,
      text: '',
      raw: null,
      detail: 'provider error',
    }));

    const summary = await summarizeTriageGroups(ENTRIES, provider);
    expect(summary).toBeNull();
  });

  it('MALFORMED: returns null when the reply text is empty/whitespace-only', async () => {
    const provider = fakeProvider(async () => ({
      provider: 'claude',
      ok: true,
      text: '   \n  ',
      raw: null,
      detail: '',
    }));

    const summary = await summarizeTriageGroups(ENTRIES, provider);
    expect(summary).toBeNull();
  });

  it('SKIP: returns null and never calls the provider for fewer than 2 entries', async () => {
    let called = false;
    const provider = fakeProvider(async () => {
      called = true;
      return { provider: 'claude', ok: true, text: 'summary', raw: null, detail: '' };
    });

    const summary = await summarizeTriageGroups([ENTRIES[0]!], provider);
    expect(summary).toBeNull();
    expect(called).toBe(false);

    const summaryEmpty = await summarizeTriageGroups([], provider);
    expect(summaryEmpty).toBeNull();
    expect(called).toBe(false);
  });

  it('forwards the caller signal into provider.complete unchanged', async () => {
    let seenSignal: AbortSignal | undefined;
    const provider = fakeProvider(async (_prompt, opts) => {
      seenSignal = opts?.signal;
      return { provider: 'claude', ok: true, text: 'summary', raw: null, detail: '' };
    });
    const controller = new AbortController();

    await summarizeTriageGroups(ENTRIES, provider, { signal: controller.signal });
    expect(seenSignal).toBe(controller.signal);
  });
});
