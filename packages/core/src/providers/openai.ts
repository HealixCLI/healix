import { runCli, which } from '../exec/run-cli.js';
import type {
  Capability,
  DetectResult,
  HealthOptions,
  HealthResult,
  PlanResult,
  ProviderAdapter,
} from './types.js';

/**
 * Codex CLI adapter (OpenAI subscription path). M0 stub: real detection is wired,
 * but the live health round-trip and plan() are implemented in a later milestone.
 * Note: OpenAI has no keyless SDK, so Codex CLI is its only subscription path.
 */
export class OpenAIProvider implements ProviderAdapter {
  readonly id = 'openai' as const;
  readonly label = 'OpenAI (Codex CLI)';
  readonly capabilities: Capability[] = ['codegen', 'plan', 'triage'];
  private readonly bin = 'codex';

  async detect(): Promise<DetectResult> {
    const binPath = await which(this.bin);
    if (!binPath) return { installed: false, binPath: null, version: null };
    const r = await runCli(this.bin, ['--version'], { timeoutMs: 8_000 });
    const version = r.code === 0 ? r.stdout.trim().split(/\s+/).pop() ?? null : null;
    return { installed: true, binPath, version };
  }

  async health(opts: HealthOptions = {}): Promise<HealthResult> {
    void opts;
    const det = await this.detect();
    const base: HealthResult = {
      provider: this.id,
      status: 'cli-missing',
      installed: det.installed,
      binPath: det.binPath,
      version: det.version,
      authenticated: false,
      model: null,
      latencyMs: null,
      detail: '',
    };
    if (!det.installed) {
      return { ...base, detail: 'codex CLI not found on PATH. Install the OpenAI Codex CLI to enable this provider.' };
    }
    return {
      ...base,
      status: 'ready',
      detail: 'Codex CLI detected. Live auth probe is not yet implemented (M0 stub).',
    };
  }

  async plan(): Promise<PlanResult> {
    return {
      provider: this.id,
      ok: false,
      plan: '',
      raw: null,
      detail: 'OpenAI/Codex plan() is not implemented yet (M0 stub).',
    };
  }
}
