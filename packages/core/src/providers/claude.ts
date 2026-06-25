import { runCli, which } from '../exec/run-cli.js';
import type {
  Capability,
  CompleteOptions,
  CompletionResult,
  DetectResult,
  HealthOptions,
  HealthResult,
  PlanResult,
  ProviderAdapter,
} from './types.js';

const PING = 'Reply with exactly this token and nothing else: HEALIX_OK';

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  modelUsage?: Record<string, unknown>;
}

/**
 * Real adapter for the Claude Code CLI (subscription auth — no API keys).
 * Primary path is the CLI; the Agent SDK fallback is wired in a later milestone.
 */
export class ClaudeProvider implements ProviderAdapter {
  readonly id = 'claude' as const;
  readonly label = 'Claude (Claude Code CLI)';
  readonly capabilities: Capability[] = ['computer-use', 'codegen', 'plan', 'triage'];
  private readonly bin = 'claude';

  async detect(): Promise<DetectResult> {
    const binPath = await which(this.bin);
    if (!binPath) return { installed: false, binPath: null, version: null };
    const r = await runCli(this.bin, ['--version'], { timeoutMs: 8_000 });
    const version = r.code === 0 ? r.stdout.trim().split(/\s+/)[0] || null : null;
    return { installed: true, binPath, version };
  }

  async health(opts: HealthOptions = {}): Promise<HealthResult> {
    const probe = opts.probe ?? true;
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
      return { ...base, detail: 'claude CLI not found on PATH. Install Claude Code, then log in.' };
    }
    if (!probe) {
      return { ...base, status: 'ready', detail: 'CLI detected (auth not probed).' };
    }

    const r = await runCli(this.bin, ['-p', PING, '--output-format', 'json'], {
      timeoutMs: opts.timeoutMs ?? 60_000,
    });
    if (r.timedOut) {
      return { ...base, status: 'error', detail: `Auth probe timed out after ${opts.timeoutMs ?? 60_000}ms.` };
    }

    try {
      const json = JSON.parse(r.stdout.trim()) as ClaudeJsonResult;
      const ok = json.is_error === false && json.subtype === 'success';
      const model = json.modelUsage ? Object.keys(json.modelUsage)[0] ?? null : null;
      if (ok) {
        return {
          ...base,
          status: 'ready',
          authenticated: true,
          model,
          latencyMs: json.duration_ms ?? r.durationMs,
          detail: `Authenticated. Model replied "${String(json.result).slice(0, 32)}".`,
        };
      }
      return { ...base, status: 'error', detail: `Probe returned an error (subtype: ${json.subtype ?? 'unknown'}).` };
    } catch {
      const out = `${r.stderr}\n${r.stdout}`.toLowerCase();
      if (out.includes('login') || out.includes('not authenticated') || out.includes('unauthorized')) {
        return { ...base, status: 'not-authenticated', detail: 'Not authenticated. Run `claude` once and log in to your subscription.' };
      }
      return { ...base, status: 'error', detail: `Unexpected CLI output: ${(r.stderr || r.stdout).slice(0, 160).trim()}` };
    }
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<CompletionResult> {
    const args = ['-p', prompt, '--output-format', 'json'];
    if (opts.mode === 'plan') args.push('--permission-mode', 'plan');
    const r = await runCli(this.bin, args, { timeoutMs: opts.timeoutMs ?? 180_000, cwd: opts.cwd });
    if (r.timedOut) {
      return { provider: this.id, ok: false, text: '', raw: r, detail: 'Completion timed out.' };
    }
    try {
      const json = JSON.parse(r.stdout.trim()) as ClaudeJsonResult;
      const ok = json.is_error === false;
      return {
        provider: this.id,
        ok,
        text: String(json.result ?? ''),
        raw: json,
        detail: ok ? 'ok' : `error (subtype: ${json.subtype ?? 'unknown'})`,
      };
    } catch {
      return {
        provider: this.id,
        ok: false,
        text: '',
        raw: r,
        detail: `Could not parse output: ${(r.stderr || r.stdout).slice(0, 200).trim()}`,
      };
    }
  }

  async plan(task: string, opts: { timeoutMs?: number } = {}): Promise<PlanResult> {
    const r = await runCli(
      this.bin,
      ['-p', task, '--permission-mode', 'plan', '--output-format', 'json'],
      { timeoutMs: opts.timeoutMs ?? 120_000 },
    );
    try {
      const json = JSON.parse(r.stdout.trim()) as ClaudeJsonResult;
      const ok = json.is_error === false;
      return {
        provider: this.id,
        ok,
        plan: String(json.result ?? ''),
        raw: json,
        detail: ok ? 'Plan generated in plan mode.' : 'Plan generation failed.',
      };
    } catch {
      return {
        provider: this.id,
        ok: false,
        plan: '',
        raw: r,
        detail: `Could not parse plan output: ${(r.stderr || r.stdout).slice(0, 160).trim()}`,
      };
    }
  }
}
