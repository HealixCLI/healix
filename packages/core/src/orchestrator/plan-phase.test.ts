import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPlanPhase, attemptPlanCompletion, buildWeightedBatches, splitUnitsByWeight } from './index.js';
import type { OrchestratorEvent } from './types.js';
import type { PlanRepoContext } from './plan.js';
import type { Project } from '../storage/types.js';
import type {
  CompleteOptions,
  CompletionResult,
  DetectResult,
  HealthResult,
  PlanResult,
  ProviderAdapter,
} from '../providers/types.js';
import { estimateUnitWeight, type FunctionalityUnit } from '../target/functionality-index.js';

// ---------------------------------------------------------------------------
// Targeted, offline coverage of runPlanPhase/attemptPlanCompletion — the
// resilience/batching layer that sits between the model's raw plan
// completion and synthesizePlan()'s smoke-plan fallback. Every provider here
// is a fake (no CLI, no network); `overrides: { provider }` mirrors how the
// real orchestrator skips the (real, subprocess-spawning) ProviderRouter
// fallback whenever a provider was injected via DI — see resolveProvider in
// index.ts — so these tests never touch a real ProviderRouter/CLI.
// ---------------------------------------------------------------------------

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'prj_test',
    name: 'Demo',
    mode: 'playwright',
    repoPath: '/repo/demo',
    baseUrl: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    credentials: [],
    ...overrides,
  };
}

function noopEmit(): (
  phase: string,
  level: OrchestratorEvent['level'],
  message: string,
  data?: unknown,
) => void {
  return () => undefined;
}

type CapturedEmit = { phase: string; level: OrchestratorEvent['level']; message: string; data?: unknown };

function capturingEmit(): {
  emit: (phase: string, level: OrchestratorEvent['level'], message: string, data?: unknown) => void;
  events: CapturedEmit[];
} {
  const events: CapturedEmit[] = [];
  return {
    emit: (phase, level, message, data) => {
      events.push({ phase, level, message, data });
    },
    events,
  };
}

function fencedJson(value: unknown): string {
  return ['```json', JSON.stringify(value), '```'].join('\n');
}

/** A provider whose plan completion fails `failTimes` times, then succeeds. */
function makeFlakyProvider(
  failTimes: number,
  plan: unknown,
  failureDetail = 'transient failure',
): ProviderAdapter & { calls: number } {
  const adapter = {
    id: 'claude' as const,
    label: 'Flaky Fake',
    capabilities: ['plan' as const],
    calls: 0,
    async detect(): Promise<DetectResult> {
      return { installed: true, binPath: '/fake/claude', version: '1.0.0' };
    },
    async health(): Promise<HealthResult> {
      return {
        provider: 'claude',
        status: 'ready',
        installed: true,
        binPath: '/fake/claude',
        version: '1.0.0',
        authenticated: true,
        model: 'fake',
        latencyMs: 1,
        detail: 'OK',
      };
    },
    async plan(): Promise<PlanResult> {
      return { provider: 'claude', ok: true, plan: fencedJson(plan), raw: plan, detail: 'OK' };
    },
    async complete(_prompt: string, opts?: CompleteOptions): Promise<CompletionResult> {
      adapter.calls += 1;
      if (opts?.mode === 'plan' && adapter.calls <= failTimes) {
        return { provider: 'claude', ok: false, text: '', raw: null, detail: failureDetail };
      }
      return { provider: 'claude', ok: true, text: fencedJson(plan), raw: plan, detail: 'OK' };
    },
  };
  return adapter;
}

const SIMPLE_PLAN = {
  summary: 'A real plan.',
  items: [{ title: 'Home loads', tier: 'tierA-public', intent: 'Landing renders.' }],
};

describe('runPlanPhase resilience', () => {
  it('a transient failure that succeeds on the same-provider retry produces a real AI plan, not a fallback', async () => {
    const provider = makeFlakyProvider(1, SIMPLE_PLAN);
    const plan = await runPlanPhase(provider, makeProject(), { projectId: 'prj_test' }, noopEmit(), {
      provider,
    });
    expect(plan.planSource).toBe('ai');
    expect(plan.fallbackReason).toBeUndefined();
    expect(plan.items.map((it) => it.title)).toEqual(['Home loads']);
    // Attempt 1 (fails) + same-provider retry (succeeds) = 2 calls.
    expect(provider.calls).toBe(2);
  }, 10_000);

  it('exhausting the same-provider retry falls back to synthesizePlan with a recorded reason', async () => {
    const provider = makeFlakyProvider(Number.POSITIVE_INFINITY, SIMPLE_PLAN);
    const plan = await runPlanPhase(
      provider,
      makeProject({ baseUrl: 'https://app.example.test', repoPath: null }),
      { projectId: 'prj_test' },
      noopEmit(),
      { provider },
    );
    expect(plan.planSource).toBe('fallback');
    expect(plan.fallbackReason).toBeTruthy();
    // The literal synthesizePlan() smoke items — this IS the "few smoke tests" symptom.
    expect(plan.items.length).toBeGreaterThan(0);
    expect(provider.calls).toBe(2);
  }, 10_000);

  it('does NOT pause before a same-provider retry for an ordinary transient failure (only credits-exhausted warrants the delay)', async () => {
    const provider = makeFlakyProvider(1, SIMPLE_PLAN, 'transient failure');
    const start = Date.now();
    await runPlanPhase(provider, makeProject(), { projectId: 'prj_test' }, noopEmit(), { provider });
    // The gated delay is 2000ms — an ungated retry completes in a small fraction of that.
    expect(Date.now() - start).toBeLessThan(500);
  }, 10_000);

  it('pauses before a same-provider retry when the failure is classified credits-exhausted', async () => {
    const provider = makeFlakyProvider(1, SIMPLE_PLAN, 'Error: insufficient credits — quota exceeded');
    const start = Date.now();
    await runPlanPhase(provider, makeProject(), { projectId: 'prj_test' }, noopEmit(), { provider });
    expect(Date.now() - start).toBeGreaterThanOrEqual(1900);
  }, 10_000);

  describe('(fake timers) delay gating — deterministic, no real wall-clock wait', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('does NOT need any timer advance for an ordinary transient failure — the retry is not waiting on anything', async () => {
      vi.useFakeTimers();
      const provider = makeFlakyProvider(1, SIMPLE_PLAN, 'transient failure');
      const plan = await runPlanPhase(provider, makeProject(), { projectId: 'prj_test' }, noopEmit(), {
        provider,
      });
      // No vi.advanceTimersByTimeAsync(...) call anywhere above — if the retry were still
      // gated behind the 2s delay, this promise would never have resolved and the test would
      // time out, since fake timers never advance on their own.
      expect(plan.planSource).toBe('ai');
      expect(provider.calls).toBe(2);
    });

    it('needs the fake clock advanced by the full delay before a credits-exhausted retry resolves', async () => {
      vi.useFakeTimers();
      const provider = makeFlakyProvider(1, SIMPLE_PLAN, 'Error: insufficient credits — quota exceeded');
      const resultPromise = runPlanPhase(provider, makeProject(), { projectId: 'prj_test' }, noopEmit(), {
        provider,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      const plan = await resultPromise;
      expect(plan.planSource).toBe('ai');
      expect(provider.calls).toBe(2);
    });
  });

  it('attemptPlanCompletion requests taskType "plan-generate" (per-task-type model/effort routing)', async () => {
    let seenTaskType: string | undefined;
    const provider = makeFlakyProvider(0, SIMPLE_PLAN);
    const originalComplete = provider.complete.bind(provider);
    provider.complete = async (prompt, opts) => {
      seenTaskType = opts?.taskType;
      return originalComplete(prompt, opts);
    };
    await attemptPlanCompletion(
      provider,
      'irrelevant prompt text',
      makeProject(),
      { projectId: 'prj_test' },
      noopEmit(),
      {
        provider,
      },
    );
    expect(seenTaskType).toBe('plan-generate');
  }, 10_000);

  it('attemptPlanCompletion never calls synthesizePlan — it returns null with a reason instead', async () => {
    const provider = makeFlakyProvider(Number.POSITIVE_INFINITY, SIMPLE_PLAN);
    const result = await attemptPlanCompletion(
      provider,
      'irrelevant prompt text',
      makeProject(),
      { projectId: 'prj_test' },
      noopEmit(),
      { provider },
    );
    expect(result.plan).toBeNull();
    if (!result.plan) expect(result.reason).toBeTruthy();
  }, 10_000);
});

describe('runPlanPhase batching', () => {
  /** Extracts every `unitKey: "..."` token from a batch prompt and returns one plan item per unit. */
  function unitAwareProvider(): ProviderAdapter & { calls: number } {
    const adapter = {
      id: 'claude' as const,
      label: 'Unit-aware Fake',
      capabilities: ['plan' as const],
      calls: 0,
      async detect(): Promise<DetectResult> {
        return { installed: true, binPath: '/fake/claude', version: '1.0.0' };
      },
      async health(): Promise<HealthResult> {
        return {
          provider: 'claude',
          status: 'ready',
          installed: true,
          binPath: '/fake/claude',
          version: '1.0.0',
          authenticated: true,
          model: 'fake',
          latencyMs: 1,
          detail: 'OK',
        };
      },
      async plan(): Promise<PlanResult> {
        return {
          provider: 'claude',
          ok: true,
          plan: fencedJson(SIMPLE_PLAN),
          raw: SIMPLE_PLAN,
          detail: 'OK',
        };
      },
      async complete(prompt: string, opts?: CompleteOptions): Promise<CompletionResult> {
        adapter.calls += 1;
        if (opts?.mode !== 'plan') {
          return { provider: 'claude', ok: true, text: 'n/a', raw: null, detail: 'OK' };
        }
        const keys = [...prompt.matchAll(/unitKey: "([^"]+)"/g)].map((m) => m[1]);
        const body = {
          summary: `Batch covering ${keys.length} unit(s).`,
          items: keys.map((key) => ({
            title: `Covers ${key}`,
            tier: 'tierA-public',
            intent: `Exercises ${key}.`,
            unitKey: key,
          })),
        };
        return { provider: 'claude', ok: true, text: fencedJson(body), raw: body, detail: 'OK' };
      },
    };
    return adapter;
  }

  function makeUnits(count: number): FunctionalityUnit[] {
    return Array.from({ length: count }, (_, i) => ({
      key: `route:/page-${i}`,
      kind: 'route' as const,
      label: `page: /page-${i}`,
      file: `app/page-${i}/page.tsx`,
    }));
  }

  it('splits a large functionality inventory across multiple smaller planning calls and merges the items', async () => {
    const units = makeUnits(70);
    const provider = unitAwareProvider();
    const repoIndex: PlanRepoContext = { summary: 'Framework: next.', files: [], functionality: units };

    const plan = await runPlanPhase(
      provider,
      makeProject(),
      { projectId: 'prj_test' },
      noopEmit(),
      { provider },
      repoIndex,
    );

    expect(plan.planSource).toBe('ai');
    expect(plan.fallbackReason).toBeUndefined();
    // Every unit got exactly one item, across however many batches it took.
    expect(plan.items).toHaveLength(70);
    const coveredKeys = new Set(plan.items.map((it) => it.unitKey));
    expect(coveredKeys.size).toBe(70);
    // More than one planning call proves batching actually split the request.
    expect(provider.calls).toBeGreaterThan(1);
  }, 10_000);

  it('a single failed batch contributes zero items but does not sink the rest of the plan', async () => {
    const units = makeUnits(70);
    const good = unitAwareProvider();
    let calls = 0;
    const provider: ProviderAdapter & { calls: number } = {
      ...good,
      calls: 0,
      async complete(prompt: string, opts?: CompleteOptions): Promise<CompletionResult> {
        calls += 1;
        provider.calls = calls;
        // Fail every attempt for the SECOND batch only (both the first attempt
        // and its same-provider retry), succeed for every other batch.
        if (opts?.mode === 'plan' && prompt.includes('batch 2 of')) {
          return { provider: 'claude', ok: false, text: '', raw: null, detail: 'batch 2 unavailable' };
        }
        return good.complete(prompt, opts);
      },
    };
    const repoIndex: PlanRepoContext = { summary: '', files: [], functionality: units };

    const plan = await runPlanPhase(
      provider,
      makeProject(),
      { projectId: 'prj_test' },
      noopEmit(),
      { provider },
      repoIndex,
    );

    // Still an "ai" plan overall — most batches succeeded — but the partial
    // failure is recorded, not silently absorbed.
    expect(plan.planSource).toBe('ai');
    expect(plan.fallbackReason).toContain('batch 2');
    expect(plan.items.length).toBeGreaterThan(0);
    expect(plan.items.length).toBeLessThan(70);
  }, 10_000);
});

describe('runPlanPhase batch progress events', () => {
  function makeUnits(count: number): FunctionalityUnit[] {
    return Array.from({ length: count }, (_, i) => ({
      key: `route:/page-${i}`,
      kind: 'route' as const,
      label: `page: /page-${i}`,
      file: `app/page-${i}/page.tsx`,
    }));
  }

  function unitAwareProvider(): ProviderAdapter & { calls: number } {
    const adapter = {
      id: 'claude' as const,
      label: 'Unit-aware Fake',
      capabilities: ['plan' as const],
      calls: 0,
      async detect(): Promise<DetectResult> {
        return { installed: true, binPath: '/fake/claude', version: '1.0.0' };
      },
      async health(): Promise<HealthResult> {
        return {
          provider: 'claude',
          status: 'ready',
          installed: true,
          binPath: '/fake/claude',
          version: '1.0.0',
          authenticated: true,
          model: 'fake',
          latencyMs: 1,
          detail: 'OK',
        };
      },
      async plan(): Promise<PlanResult> {
        return {
          provider: 'claude',
          ok: true,
          plan: fencedJson(SIMPLE_PLAN),
          raw: SIMPLE_PLAN,
          detail: 'OK',
        };
      },
      async complete(prompt: string, opts?: CompleteOptions): Promise<CompletionResult> {
        adapter.calls += 1;
        if (opts?.mode !== 'plan') {
          return { provider: 'claude', ok: true, text: 'n/a', raw: null, detail: 'OK' };
        }
        const keys = [...prompt.matchAll(/unitKey: "([^"]+)"/g)].map((m) => m[1]);
        const body = {
          summary: `Batch covering ${keys.length} unit(s).`,
          items: keys.map((key) => ({
            title: `Covers ${key}`,
            tier: 'tierA-public',
            intent: `Exercises ${key}.`,
            unitKey: key,
          })),
        };
        return { provider: 'claude', ok: true, text: fencedJson(body), raw: body, detail: 'OK' };
      },
    };
    return adapter;
  }

  it('emits a kind:"plan-batch" event per successful batch, in order, each carrying only that batch\'s items', async () => {
    const units = makeUnits(40);
    const provider = unitAwareProvider();
    const repoIndex: PlanRepoContext = { summary: '', files: [], functionality: units };
    const { emit, events } = capturingEmit();

    const plan = await runPlanPhase(
      provider,
      makeProject(),
      { projectId: 'prj_test' },
      emit,
      { provider },
      repoIndex,
    );

    const batchEvents = events
      .filter((e) => (e.data as { kind?: string } | undefined)?.kind === 'plan-batch')
      .map((e) => e.data as { batchIndex: number; totalBatches: number; items: unknown[]; status: string });

    expect(batchEvents.length).toBeGreaterThan(1);
    batchEvents.forEach((e, idx) => {
      expect(e.batchIndex).toBe(idx);
      expect(e.status).toBe('ok');
      expect(e.totalBatches).toBe(batchEvents.length);
    });
    // Every batch's emitted items add up to the final merged plan — no batch's
    // items are double-counted or missing from the stream.
    const totalStreamed = batchEvents.reduce((sum, e) => sum + e.items.length, 0);
    expect(totalStreamed).toBe(plan.items.length);
  }, 10_000);

  it('emits a status:"failed" plan-batch event (with reason, zero items) for a batch that produced nothing', async () => {
    const units = makeUnits(40);
    const good = unitAwareProvider();
    const provider: ProviderAdapter & { calls: number } = {
      ...good,
      calls: 0,
      async complete(prompt: string, opts?: CompleteOptions): Promise<CompletionResult> {
        if (opts?.mode === 'plan' && prompt.includes('batch 2 of')) {
          return { provider: 'claude', ok: false, text: '', raw: null, detail: 'batch 2 unavailable' };
        }
        return good.complete(prompt, opts);
      },
    };
    const repoIndex: PlanRepoContext = { summary: '', files: [], functionality: units };
    const { emit, events } = capturingEmit();

    await runPlanPhase(provider, makeProject(), { projectId: 'prj_test' }, emit, { provider }, repoIndex);

    const batchEvents = events
      .filter((e) => (e.data as { kind?: string } | undefined)?.kind === 'plan-batch')
      .map((e) => e.data as { batchIndex: number; items: unknown[]; status: string; reason?: string });

    const failed = batchEvents.find((e) => e.status === 'failed');
    expect(failed).toBeDefined();
    expect(failed?.items).toHaveLength(0);
    expect(failed?.reason).toBeTruthy();
    expect(batchEvents.some((e) => e.status === 'ok')).toBe(true);
  }, 10_000);
});

describe('estimateUnitWeight', () => {
  function unit(overrides: Partial<FunctionalityUnit> = {}): FunctionalityUnit {
    return { key: 'route:/x', kind: 'route', label: 'page: /x', file: 'app/x/page.tsx', ...overrides };
  }

  it('gives a plain route the lowest weight', () => {
    expect(estimateUnitWeight(unit())).toBe(2);
  });

  it('weighs an endpoint higher than a plain route', () => {
    expect(estimateUnitWeight(unit({ kind: 'endpoint' }))).toBeGreaterThan(estimateUnitWeight(unit()));
  });

  it('adds weight for request/response schemas and auth requirements', () => {
    const bare = unit({ kind: 'endpoint' });
    const rich = unit({
      kind: 'endpoint',
      requestSchema: { type: 'object' },
      responseSchema: { type: 'object' },
      authRequired: true,
    });
    expect(estimateUnitWeight(rich)).toBe(estimateUnitWeight(bare) + 3);
  });
});

describe('buildWeightedBatches', () => {
  function makeUnits(count: number, overrides: Partial<FunctionalityUnit> = {}): FunctionalityUnit[] {
    return Array.from({ length: count }, (_, i) => ({
      key: `route:/page-${i}`,
      kind: 'route' as const,
      label: `page: /page-${i}`,
      file: `app/page-${i}/page.tsx`,
      ...overrides,
    }));
  }

  it('keeps every batch at or under the weight budget', () => {
    const units = makeUnits(50, { kind: 'endpoint', requestSchema: {}, authRequired: true });
    const batches = buildWeightedBatches(units);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const weight = batch.reduce((sum, u) => sum + estimateUnitWeight(u), 0);
      expect(weight).toBeLessThanOrEqual(45);
    }
    expect(batches.flat()).toHaveLength(50);
  });

  it('caps batch size at PLAN_BATCH_MAX_UNITS even when the weight budget would allow more', () => {
    const units = makeUnits(50); // weight 2 each — well under budget by weight alone
    const batches = buildWeightedBatches(units);
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(20);
    expect(batches.flat()).toHaveLength(50);
  });

  it('gives an over-budget single unit its own batch rather than dropping it', () => {
    const heavy: FunctionalityUnit = {
      key: 'endpoint:POST /checkout',
      kind: 'endpoint',
      label: 'POST /checkout',
      file: 'api/checkout.ts',
      requestSchema: {},
      responseSchema: {},
      authRequired: true,
    };
    const units = [heavy, ...makeUnits(3)];
    // heavy weighs 6 — pass a budget below that so it can't share a batch with anything.
    const batches = buildWeightedBatches(units, 5, 20);
    expect(batches.flat()).toHaveLength(4);
    expect(batches.some((b) => b.length === 1 && b[0] === heavy)).toBe(true);
  });
});

describe('splitUnitsByWeight', () => {
  function makeUnits(count: number): FunctionalityUnit[] {
    return Array.from({ length: count }, (_, i) => ({
      key: `route:/page-${i}`,
      kind: 'route' as const,
      label: `page: /page-${i}`,
      file: `app/page-${i}/page.tsx`,
    }));
  }

  it('splits evenly-weighted units into two non-empty halves covering every unit exactly once', () => {
    const units = makeUnits(10);
    const [left, right] = splitUnitsByWeight(units);
    expect(left.length).toBeGreaterThan(0);
    expect(right.length).toBeGreaterThan(0);
    expect([...left, ...right]).toEqual(units);
  });

  it('balances a heavy unit against several light ones rather than cutting by raw index', () => {
    const heavy: FunctionalityUnit = {
      key: 'endpoint:POST /checkout',
      kind: 'endpoint',
      label: 'POST /checkout',
      file: 'api/checkout.ts',
      requestSchema: {},
      responseSchema: {},
      authRequired: true,
    };
    // heavy weighs 6, two light routes weigh 2 each (10 total, half = 5) — heavy alone
    // already reaches half the total weight, so it lands alone in the left half. A naive
    // index-based half split of 3 units (cut at position ~1-2) would instead have paired
    // heavy with a light unit.
    const units = [heavy, ...makeUnits(2)];
    const [left] = splitUnitsByWeight(units);
    expect(left).toEqual([heavy]);
  });

  it('never leaves one half empty even when a single unit dominates the total weight', () => {
    const heavy: FunctionalityUnit = {
      key: 'endpoint:POST /checkout',
      kind: 'endpoint',
      label: 'POST /checkout',
      file: 'api/checkout.ts',
      requestSchema: {},
      responseSchema: {},
      authRequired: true,
    };
    const units = [heavy, makeUnits(1)[0]!];
    const [left, right] = splitUnitsByWeight(units);
    expect(left.length).toBeGreaterThan(0);
    expect(right.length).toBeGreaterThan(0);
  });
});

describe('runPlanPhase shrink-and-retry on truncation', () => {
  /** Returns unbalanced (never-closing) fenced JSON — parsePlanWithDiagnostics classifies this as 'truncated'. */
  function truncatedFencedJson(): string {
    return ['```json', '{ "summary": "cut off mid-response", "items": [ { "title": "partial"'].join('\n');
  }

  /** Truncates any plan completion whose batch has more than `threshold` units; otherwise succeeds. */
  function truncatingAboveThreshold(threshold: number): ProviderAdapter & { calls: number } {
    const adapter = {
      id: 'claude' as const,
      label: 'Truncates above threshold',
      capabilities: ['plan' as const],
      calls: 0,
      async detect(): Promise<DetectResult> {
        return { installed: true, binPath: '/fake/claude', version: '1.0.0' };
      },
      async health(): Promise<HealthResult> {
        return {
          provider: 'claude',
          status: 'ready',
          installed: true,
          binPath: '/fake/claude',
          version: '1.0.0',
          authenticated: true,
          model: 'fake',
          latencyMs: 1,
          detail: 'OK',
        };
      },
      async plan(): Promise<PlanResult> {
        return {
          provider: 'claude',
          ok: true,
          plan: fencedJson(SIMPLE_PLAN),
          raw: SIMPLE_PLAN,
          detail: 'OK',
        };
      },
      async complete(prompt: string, opts?: CompleteOptions): Promise<CompletionResult> {
        adapter.calls += 1;
        if (opts?.mode !== 'plan') {
          return { provider: 'claude', ok: true, text: 'n/a', raw: null, detail: 'OK' };
        }
        const keys = [...prompt.matchAll(/unitKey: "([^"]+)"/g)].map((m) => m[1]);
        if (keys.length > threshold) {
          return { provider: 'claude', ok: true, text: truncatedFencedJson(), raw: null, detail: 'OK' };
        }
        const body = {
          summary: `Batch covering ${keys.length} unit(s).`,
          items: keys.map((key) => ({
            title: `Covers ${key}`,
            tier: 'tierA-public',
            intent: `Exercises ${key}.`,
            unitKey: key,
          })),
        };
        return { provider: 'claude', ok: true, text: fencedJson(body), raw: body, detail: 'OK' };
      },
    };
    return adapter;
  }

  function makeUnits(count: number): FunctionalityUnit[] {
    return Array.from({ length: count }, (_, i) => ({
      key: `route:/page-${i}`,
      kind: 'route' as const,
      label: `page: /page-${i}`,
      file: `app/page-${i}/page.tsx`,
    }));
  }

  it('splits a batch that keeps truncating until sub-batches are small enough to succeed', async () => {
    const units = makeUnits(30);
    const provider = truncatingAboveThreshold(5);
    const repoIndex: PlanRepoContext = { summary: '', files: [], functionality: units };
    const { emit, events } = capturingEmit();

    const plan = await runPlanPhase(
      provider,
      makeProject(),
      { projectId: 'prj_test' },
      emit,
      { provider },
      repoIndex,
    );

    expect(plan.planSource).toBe('ai');
    expect(plan.fallbackReason).toBeUndefined();
    expect(plan.items).toHaveLength(30);
    expect(new Set(plan.items.map((it) => it.unitKey)).size).toBe(30);
    expect(events.some((e) => e.message.includes('splitting'))).toBe(true);
  }, 20_000);

  it('gives up and leaves units uncovered once split depth is exhausted for a batch that never succeeds', async () => {
    // Just over the 20-unit batch cap — enough to force one 20-unit batch through the
    // full split tree (kept minimal since every failing node pays a real 2s retry delay).
    const units = makeUnits(21);
    // Always truncates, no matter how small the batch gets — split retries eventually exhaust.
    const provider = truncatingAboveThreshold(0);
    const repoIndex: PlanRepoContext = { summary: '', files: [], functionality: units };

    const plan = await runPlanPhase(
      provider,
      makeProject(),
      { projectId: 'prj_test' },
      noopEmit(),
      { provider },
      repoIndex,
    );

    expect(plan.planSource).toBe('fallback');
    expect(plan.fallbackReason).toBeTruthy();
  }, 45_000);
});
