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

  healthAll(opts?: HealthOptions): Promise<HealthResult[]> {
    return Promise.all(this.list().map((p) => p.health(opts)));
  }

  /** Pick the first healthy provider for a capability (best-for-task with fallback). */
  async select(
    cap: Capability,
    opts?: HealthOptions,
  ): Promise<{ provider: ProviderAdapter; health: HealthResult } | null> {
    for (const id of PREFERENCE[cap]) {
      const provider = this.providers.get(id);
      if (!provider || !provider.capabilities.includes(cap)) continue;
      const health = await provider.health(opts);
      if (health.status === 'ready' && health.authenticated) {
        return { provider, health };
      }
    }
    return null;
  }
}
