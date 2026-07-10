import { ClaudeProvider } from './claude.js';
import { OpenAIProvider } from './openai.js';
import type { Capability, HealthOptions, HealthResult, ProviderAdapter, ProviderId } from './types.js';

/** Best-for-task preference order per capability (first healthy wins → automatic fallback). */
const PREFERENCE: Record<Capability, ProviderId[]> = {
  'computer-use': ['claude', 'openai'],
  codegen: ['claude', 'openai'],
  plan: ['claude', 'openai'],
  triage: ['claude', 'openai'],
};

/**
 * Short-TTL health cache. A probing health() call is EXPENSIVE: it is a live,
 * paid AI round-trip through the provider CLI (real prompt, real tokens,
 * seconds of latency). Callers hit select()/firstReady()/healthAll() in quick
 * bursts — a single user action can trigger a status render, a provider pick
 * and a preflight check back to back — and without a cache each of those pays
 * a fresh round-trip per provider. 60s is short enough that auth/install state
 * is still trustworthy for routing, and long enough to collapse a burst into
 * one probe per provider.
 *
 * Module-level (not per-router) so every router instance in the process shares
 * the same probe results. Keyed by `${providerId}:${probe}` because a
 * probe:false result (CLI detected, auth unverified) must never satisfy a
 * probe:true request.
 */
const HEALTH_TTL_MS = 60_000;
const healthCache = new Map<string, { at: number; result: HealthResult }>();

/** Reset the module-level health cache so hermetic tests don't leak state. */
export function clearHealthCacheForTests(): void {
  healthCache.clear();
}

export class ProviderRouter {
  private readonly providers: Map<ProviderId, ProviderAdapter>;

  constructor(providers?: ProviderAdapter[]) {
    const list = providers ?? [new ClaudeProvider(), new OpenAIProvider()];
    this.providers = new Map(list.map((p) => [p.id, p]));
  }

  list(): ProviderAdapter[] {
    return [...this.providers.values()];
  }

  get(id: ProviderId): ProviderAdapter | undefined {
    return this.providers.get(id);
  }

  /**
   * Cached wrapper around adapter.health() — see HEALTH_TTL_MS for the cost
   * rationale. All router entry points route through this so a burst of
   * routing decisions reuses one fresh probe instead of paying a new live
   * round-trip per call.
   */
  private async health(provider: ProviderAdapter, opts?: HealthOptions): Promise<HealthResult> {
    const probe = opts?.probe ?? true;
    const key = `${provider.id}:${probe}`;
    const hit = healthCache.get(key);
    if (hit && Date.now() - hit.at < HEALTH_TTL_MS) return hit.result;
    const result = await provider.health(opts);
    healthCache.set(key, { at: Date.now(), result });
    return result;
  }

  healthAll(opts?: HealthOptions): Promise<HealthResult[]> {
    return Promise.all(this.list().map((p) => this.health(p, opts)));
  }

  /** Pick the first healthy provider for a capability (best-for-task with fallback). */
  async select(
    cap: Capability,
    opts?: HealthOptions,
  ): Promise<{ provider: ProviderAdapter; health: HealthResult } | null> {
    for (const id of PREFERENCE[cap]) {
      const provider = this.providers.get(id);
      if (!provider || !provider.capabilities.includes(cap)) continue;
      const health = await this.health(provider, opts);
      if (health.status === 'ready' && health.authenticated) {
        return { provider, health };
      }
    }
    return null;
  }

  /**
   * First ready+authenticated provider for a capability, or null. Optionally skip
   * a provider id (e.g. the one that just failed) so callers get a *different* fallback.
   */
  async firstReady(
    cap: Capability,
    opts?: HealthOptions & { exclude?: ProviderId },
  ): Promise<ProviderAdapter | null> {
    for (const id of PREFERENCE[cap]) {
      if (opts?.exclude && id === opts.exclude) continue;
      const provider = this.providers.get(id);
      if (!provider || !provider.capabilities.includes(cap)) continue;
      const health = await this.health(provider, opts);
      if (health.status === 'ready' && health.authenticated) {
        return provider;
      }
    }
    return null;
  }
}
