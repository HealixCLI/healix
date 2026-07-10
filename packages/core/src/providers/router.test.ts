/**
 * Unit tests for ProviderRouter — fully offline.
 *
 * The router is constructed with INJECTED fake adapters so no real CLI is ever
 * spawned. We assert:
 *   - list() exposes claude + openai with their expected capabilities,
 *   - get(id) resolves the right adapter (and undefined for unknowns),
 *   - select()/firstReady() pick the FIRST ready+authenticated provider in the
 *     fixed preference order (claude → openai),
 *   - an unhealthy / unauthenticated preferred provider is SKIPPED so the router
 *     falls back to the next candidate (or null when none qualify), and
 *   - the short-TTL health cache collapses bursts of routing calls into ONE
 *     probe per provider (probes are paid AI round-trips).
 *
 * The cache is module-level by design (shared across router instances), so
 * every test clears it up front to stay hermetic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHealthCacheForTests, ProviderRouter } from './router.js';
import type {
  Capability,
  CompleteOptions,
  CompletionResult,
  DetectResult,
  HealthOptions,
  HealthResult,
  PlanResult,
  ProviderAdapter,
  ProviderId,
} from './types.js';

/**
 * Deterministic fake adapter. health() returns a canned status/authenticated
 * pair (no I/O); every other method is a harmless stub so the type is satisfied.
 */
class FakeProvider implements ProviderAdapter {
  /** Number of times health() was invoked — lets us assert short-circuiting. */
  healthCalls = 0;

  constructor(
    readonly id: ProviderId,
    readonly label: string,
    readonly capabilities: Capability[],
    private readonly canned: { status: HealthResult['status']; authenticated: boolean },
  ) {}

  async detect(): Promise<DetectResult> {
    return { installed: true, binPath: `/fake/${this.id}`, version: '1.0.0' };
  }

  async health(_opts?: HealthOptions): Promise<HealthResult> {
    void _opts;
    this.healthCalls += 1;
    return {
      provider: this.id,
      status: this.canned.status,
      installed: true,
      binPath: `/fake/${this.id}`,
      version: '1.0.0',
      authenticated: this.canned.authenticated,
      model: this.canned.authenticated ? 'fake-model' : null,
      latencyMs: this.canned.authenticated ? 1 : null,
      detail: `fake ${this.id} (${this.canned.status})`,
    };
  }

  async plan(_task: string): Promise<PlanResult> {
    void _task;
    return { provider: this.id, ok: false, plan: '', raw: null, detail: 'fake plan' };
  }

  async complete(_prompt: string, _opts?: CompleteOptions): Promise<CompletionResult> {
    void _prompt;
    void _opts;
    return { provider: this.id, ok: false, text: '', raw: null, detail: 'fake complete' };
  }
}

const ready = (status: HealthResult['status'] = 'ready', authenticated = true) => ({ status, authenticated });

const CLAUDE_CAPS: Capability[] = ['computer-use', 'codegen', 'plan', 'triage'];
const OPENAI_CAPS: Capability[] = ['codegen', 'plan', 'triage'];

function makeClaude(canned: { status: HealthResult['status']; authenticated: boolean }) {
  return new FakeProvider('claude', 'Fake Claude', CLAUDE_CAPS, canned);
}
function makeOpenAI(canned: { status: HealthResult['status']; authenticated: boolean }) {
  return new FakeProvider('openai', 'Fake OpenAI', OPENAI_CAPS, canned);
}

// The health cache is module-level and keyed by provider ID, so canned results
// from one test's fakes would otherwise leak into the next test's routers.
beforeEach(() => {
  clearHealthCacheForTests();
});

describe('ProviderRouter.list / get', () => {
  it('lists both providers with the expected ids and capabilities', () => {
    const router = new ProviderRouter([makeClaude(ready()), makeOpenAI(ready())]);
    const list = router.list();

    expect(list.map((p) => p.id).sort()).toEqual(['claude', 'openai']);

    const claude = list.find((p) => p.id === 'claude');
    const openai = list.find((p) => p.id === 'openai');
    expect(claude?.capabilities).toEqual(CLAUDE_CAPS);
    expect(openai?.capabilities).toEqual(OPENAI_CAPS);
    // Claude is the only computer-use provider.
    expect(claude?.capabilities).toContain('computer-use');
    expect(openai?.capabilities).not.toContain('computer-use');
  });

  it('get(id) returns the matching adapter and undefined for an unknown id', () => {
    const claude = makeClaude(ready());
    const openai = makeOpenAI(ready());
    const router = new ProviderRouter([claude, openai]);

    expect(router.get('claude')).toBe(claude);
    expect(router.get('openai')).toBe(openai);
    // ProviderId is a closed union; cast through unknown to probe a miss.
    expect(router.get('nope' as unknown as ProviderId)).toBeUndefined();
  });

  it('healthAll() returns one health result per registered provider', async () => {
    const router = new ProviderRouter([makeClaude(ready()), makeOpenAI(ready())]);
    const results = await router.healthAll();
    expect(results.map((h) => h.provider).sort()).toEqual(['claude', 'openai']);
    expect(results.every((h) => h.status === 'ready' && h.authenticated)).toBe(true);
  });
});

describe('ProviderRouter.select', () => {
  it('picks the preferred provider (claude) when it is ready+authenticated', async () => {
    const router = new ProviderRouter([makeClaude(ready()), makeOpenAI(ready())]);
    const picked = await router.select('codegen');
    expect(picked).not.toBeNull();
    expect(picked?.provider.id).toBe('claude');
    expect(picked?.health.authenticated).toBe(true);
  });

  it('falls back to openai when claude is unhealthy (cli-missing)', async () => {
    const router = new ProviderRouter([makeClaude(ready('cli-missing', false)), makeOpenAI(ready())]);
    const picked = await router.select('codegen');
    expect(picked?.provider.id).toBe('openai');
  });

  it('skips a preferred provider that is detected but NOT authenticated', async () => {
    const router = new ProviderRouter([makeClaude(ready('not-authenticated', false)), makeOpenAI(ready())]);
    const picked = await router.select('plan');
    expect(picked?.provider.id).toBe('openai');
  });

  it('returns null when no provider for the capability is ready+authenticated', async () => {
    const router = new ProviderRouter([
      makeClaude(ready('error', false)),
      makeOpenAI(ready('not-authenticated', false)),
    ]);
    expect(await router.select('triage')).toBeNull();
  });

  it('only claude qualifies for computer-use; openai lacks the capability entirely', async () => {
    const router = new ProviderRouter([makeClaude(ready()), makeOpenAI(ready())]);
    const picked = await router.select('computer-use');
    expect(picked?.provider.id).toBe('claude');

    // If claude is unhealthy there is no fallback for computer-use → null.
    // Clear the shared cache first: router2's fake claude has a DIFFERENT
    // canned status, and the cached ready result would otherwise win.
    clearHealthCacheForTests();
    const router2 = new ProviderRouter([makeClaude(ready('error', false)), makeOpenAI(ready())]);
    expect(await router2.select('computer-use')).toBeNull();
  });

  it('short-circuits on the first healthy provider (does not probe openai)', async () => {
    const claude = makeClaude(ready());
    const openai = makeOpenAI(ready());
    const router = new ProviderRouter([claude, openai]);

    await router.select('codegen');
    expect(claude.healthCalls).toBe(1);
    expect(openai.healthCalls).toBe(0);
  });
});

describe('ProviderRouter.firstReady', () => {
  it('returns the first ready+authenticated provider in preference order', async () => {
    const router = new ProviderRouter([makeClaude(ready()), makeOpenAI(ready())]);
    const provider = await router.firstReady('codegen');
    expect(provider?.id).toBe('claude');
  });

  it('honours exclude to force a different fallback', async () => {
    const router = new ProviderRouter([makeClaude(ready()), makeOpenAI(ready())]);
    // Both healthy, but exclude the preferred one → next in order wins.
    const provider = await router.firstReady('codegen', { exclude: 'claude' });
    expect(provider?.id).toBe('openai');
  });

  it('falls back past an unhealthy preferred provider', async () => {
    const router = new ProviderRouter([makeClaude(ready('error', false)), makeOpenAI(ready())]);
    const provider = await router.firstReady('plan');
    expect(provider?.id).toBe('openai');
  });

  it('returns null when the only non-excluded candidate is unhealthy', async () => {
    const router = new ProviderRouter([makeClaude(ready()), makeOpenAI(ready('not-authenticated', false))]);
    // Exclude the healthy claude → openai is the only candidate but unauthenticated.
    expect(await router.firstReady('codegen', { exclude: 'claude' })).toBeNull();
  });

  it('returns null when no provider qualifies for the capability', async () => {
    const router = new ProviderRouter([
      makeClaude(ready('cli-missing', false)),
      makeOpenAI(ready('cli-missing', false)),
    ]);
    expect(await router.firstReady('triage')).toBeNull();
  });
});

describe('ProviderRouter health cache (probes are paid AI round-trips)', () => {
  it('serves a burst of routing calls from ONE probe per provider within the TTL', async () => {
    const claude = makeClaude(ready());
    const openai = makeOpenAI(ready());
    const router = new ProviderRouter([claude, openai]);

    await router.healthAll();
    expect(claude.healthCalls).toBe(1);
    expect(openai.healthCalls).toBe(1);

    // Typical burst: status render + provider pick + preflight — all of these
    // must reuse the fresh probes instead of paying new live round-trips.
    await router.healthAll();
    await router.select('codegen');
    await router.firstReady('plan');
    expect(claude.healthCalls).toBe(1);
    expect(openai.healthCalls).toBe(1);
  });

  it('shares the cache across router instances (module-level by design)', async () => {
    const claude = makeClaude(ready());
    const openai = makeOpenAI(ready());
    await new ProviderRouter([claude, openai]).select('codegen');
    await new ProviderRouter([claude, openai]).select('codegen');
    expect(claude.healthCalls).toBe(1);
  });

  it('caches probe:true and probe:false results under separate keys', async () => {
    const claude = makeClaude(ready());
    const router = new ProviderRouter([claude, makeOpenAI(ready())]);

    await router.select('codegen'); // probe defaults to true
    await router.select('codegen', { probe: false }); // different key → new call
    expect(claude.healthCalls).toBe(2);

    // Both keys are now warm — repeats of either shape stay cached.
    await router.select('codegen');
    await router.select('codegen', { probe: false });
    expect(claude.healthCalls).toBe(2);
  });

  it('re-probes once the TTL has expired', async () => {
    const claude = makeClaude(ready());
    const router = new ProviderRouter([claude, makeOpenAI(ready())]);

    await router.select('codegen');
    expect(claude.healthCalls).toBe(1);

    // Advance the wall clock past the 60s TTL without touching real timers.
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 61_000);
    try {
      await router.select('codegen');
      expect(claude.healthCalls).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('clearHealthCacheForTests() forces the next call to probe again', async () => {
    const claude = makeClaude(ready());
    const router = new ProviderRouter([claude, makeOpenAI(ready())]);

    await router.select('codegen');
    clearHealthCacheForTests();
    await router.select('codegen');
    expect(claude.healthCalls).toBe(2);
  });
});

describe('ProviderRouter default construction (no live calls)', () => {
  it('constructs the real claude + openai adapters when none are injected', () => {
    // No I/O here — we only touch static shape, never health()/detect().
    const router = new ProviderRouter();
    const ids = router
      .list()
      .map((p) => p.id)
      .sort();
    expect(ids).toEqual(['claude', 'openai']);
    expect(router.get('claude')?.capabilities).toContain('computer-use');
    expect(router.get('openai')?.capabilities).not.toContain('computer-use');
  });
});
