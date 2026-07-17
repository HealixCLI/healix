import { extractSemver, runCli, which } from '../exec/run-cli.js';
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

/** Shape of a `codex exec --json` JSONL event (only the fields we read). */
interface CodexEvent {
  type?: string;
  message?: string;
  text?: string;
  delta?: string;
  item?: { text?: string; type?: string };
  error?: { message?: string };
}

/**
 * Real adapter for the OpenAI Codex CLI (subscription auth via ChatGPT — no API keys).
 * Codex is OpenAI's only keyless subscription path, so there is no SDK fallback.
 * Non-interactive work goes through `codex exec`; auth state via `codex login status`.
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
    // Regex-extract the semver: `codex --version` prints "codex-cli 0.142.4",
    // but update notices can append extra tokens, so the last whitespace token
    // is not reliably the version.
    const version = r.code === 0 ? extractSemver(r.stdout) : null;
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
      return {
        ...base,
        detail:
          'codex CLI not found on PATH. Install the OpenAI Codex CLI (npm i -g @openai/codex) to enable this provider.',
      };
    }

    // Cheap, local auth check first (no network / no token spend).
    const login = await runCli(this.bin, ['login', 'status'], { timeoutMs: 10_000, signal: opts.signal });
    // A timed-out (or aborted) status check produced NO verdict — reporting it
    // as "not authenticated" would send the user off to re-login for what is
    // actually a hung/slow CLI. Surface it as an error instead.
    if (login.timedOut) {
      return { ...base, status: 'error', detail: 'codex login status timed out — auth state unknown.' };
    }
    if (login.aborted) {
      return { ...base, status: 'error', detail: 'Auth check aborted.' };
    }
    const loggedIn = /logged in/i.test(login.stdout) && !/not logged in/i.test(login.stdout);
    if (!loggedIn) {
      return {
        ...base,
        status: 'not-authenticated',
        detail: 'Not authenticated. Run `codex login` to sign in with your ChatGPT subscription.',
      };
    }

    if (!probe) {
      return {
        ...base,
        status: 'ready',
        authenticated: true,
        detail: 'Codex CLI detected and logged in (auth not probed).',
      };
    }

    // Live round-trip: confirms the session token actually refreshes/works
    // (login status can read "logged in" while the refresh token is stale).
    const start = Date.now();
    const r = await runCli(this.bin, ['exec', '--skip-git-repo-check', '-s', 'read-only', '--json', PING], {
      timeoutMs: opts.timeoutMs ?? 60_000,
      signal: opts.signal,
    });
    const latencyMs = Date.now() - start;
    const parsed = parseCodexExec(r.stdout, r.stderr);

    if (r.timedOut) {
      return {
        ...base,
        status: 'error',
        authenticated: true,
        detail: `Auth probe timed out after ${opts.timeoutMs ?? 60_000}ms.`,
      };
    }
    if (r.aborted) {
      return { ...base, status: 'error', authenticated: true, detail: 'Auth probe aborted.' };
    }
    if (parsed.authError) {
      return {
        ...base,
        status: 'not-authenticated',
        detail: `Codex session expired — run \`codex login\` again. (${parsed.error ?? 'token refresh failed'})`,
      };
    }
    if (parsed.ok) {
      return {
        ...base,
        status: 'ready',
        authenticated: true,
        latencyMs,
        detail: `Authenticated. Model replied "${parsed.text.slice(0, 32)}".`,
      };
    }
    return {
      ...base,
      status: 'error',
      authenticated: true,
      detail: parsed.error
        ? `Probe error: ${parsed.error.slice(0, 160)}`
        : 'Probe returned no usable response.',
    };
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<CompletionResult> {
    const args = ['exec', '--skip-git-repo-check', '-s', 'read-only', '--json'];
    if (opts.cwd) args.push('-C', opts.cwd);
    args.push(prompt);
    const r = await runCli(this.bin, args, {
      timeoutMs: opts.timeoutMs ?? 300_000,
      cwd: opts.cwd,
      signal: opts.signal,
    });
    if (r.timedOut) {
      return { provider: this.id, ok: false, text: '', raw: r, detail: 'Completion timed out.' };
    }
    if (r.aborted) {
      return { provider: this.id, ok: false, text: '', raw: r, detail: 'Completion aborted.' };
    }
    const parsed = parseCodexExec(r.stdout, r.stderr);
    if (parsed.authError) {
      return {
        provider: this.id,
        ok: false,
        text: '',
        raw: r,
        detail: 'Codex session expired — run `codex login`.',
      };
    }
    return {
      provider: this.id,
      ok: parsed.ok,
      text: parsed.text,
      raw: r,
      detail: parsed.ok ? 'ok' : (parsed.error ?? 'no response'),
    };
  }

  async plan(task: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<PlanResult> {
    // Codex has no dedicated plan mode; the read-only sandbox in complete()
    // already prevents any file/system changes, so a plan request is safe.
    const res = await this.complete(`Produce a plan only — do not modify anything.\n\n${task}`, {
      mode: 'plan',
      timeoutMs: opts.timeoutMs ?? 120_000,
      signal: opts.signal,
    });
    return {
      provider: this.id,
      ok: res.ok,
      plan: res.text,
      raw: res.raw,
      detail: res.ok ? 'Plan generated (read-only).' : res.detail,
    };
  }
}

/** Parse `codex exec --json` JSONL output into a final-text / error / auth verdict. */
export function parseCodexExec(
  stdout: string,
  stderr = '',
): { ok: boolean; text: string; error: string | null; authError: boolean } {
  // Streamed deltas and completed items are tracked SEPARATELY: an
  // `item.completed` event carries the FULL final message, and the deltas that
  // streamed before it are partial copies of the same text — appending both
  // (the old behaviour) double-counted the reply ("HEALIX_OKHEALIX_OK").
  // Completed items win; deltas are only the fallback when no completed
  // message event ever arrives (e.g. truncated output).
  let deltaText = '';
  const completedTexts: string[] = [];
  let error: string | null = null;
  let authError = false;

  const consider = (msg: string | undefined) => {
    if (!msg) return;
    error = msg;
    if (/refresh|log ?out|sign in again|not authenticated|unauthor/i.test(msg)) authError = true;
  };

  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let evt: CodexEvent;
    try {
      evt = JSON.parse(t) as CodexEvent;
    } catch {
      continue;
    }
    const type = evt.type ?? '';
    if (type === 'error' || type === 'turn.failed') {
      consider(evt.error?.message ?? evt.message);
    }
    if (type === 'item.completed') {
      // Only message-ish items count as reply text — reasoning/command items
      // also carry `text` and must not pollute the answer. An absent item.type
      // (older CLI shapes) is accepted for backward compatibility.
      const itemType = evt.item?.type;
      if (itemType === undefined || /message/.test(itemType)) {
        const piece = evt.item?.text ?? evt.text;
        if (piece && typeof piece === 'string') completedTexts.push(piece);
      }
    } else if (/message/.test(type)) {
      // Streaming shapes (agent_message / message deltas) accumulate.
      const piece = evt.text ?? evt.delta ?? evt.message;
      if (piece && typeof piece === 'string') deltaText += piece;
    }
  }

  const text = completedTexts.length > 0 ? completedTexts.join('') : deltaText;

  if (!text && stderr && /refresh|sign in again|not authenticated|unauthor/i.test(stderr)) {
    authError = true;
    error = stderr.split('\n').find((l) => l.trim()) ?? error;
  }

  const ok = !authError && text.trim().length > 0;
  return { ok, text: text.trim(), error, authError };
}
