import { extractSemver, runCli, which } from '../exec/run-cli.js';
import { readModelConfigOverrides, resolveModelAndEffort } from './model-config.js';
import type {
  Capability,
  CompleteOptions,
  CompletionResult,
  DetectResult,
  HealthOptions,
  HealthResult,
  PlanOptions,
  PlanResult,
  ProviderAdapter,
  TaskType,
} from './types.js';

const PING = 'Reply with exactly this token and nothing else: HEALIX_OK';

/**
 * Resolve `taskType` (against the user's global overrides) into the
 * `--model`/`--effort` argv pair, plus the resolved values themselves so
 * callers can surface "what actually ran" in the completion/plan result.
 * Returns empty args and undefined model/effort when no taskType was passed —
 * this keeps existing/test call sites that predate task-type routing working
 * unchanged (they simply ride the CLI's own default model).
 */
async function resolveModelArgs(
  taskType: TaskType | undefined,
): Promise<{ args: string[]; model?: string; effort?: string }> {
  if (!taskType) return { args: [] };
  const overrides = await readModelConfigOverrides();
  const { model, effort } = resolveModelAndEffort(taskType, overrides);
  return { args: ['--model', model, '--effort', effort], model, effort };
}

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  modelUsage?: Record<string, unknown>;
}

/**
 * Extract the balanced {...} object starting at `start`, respecting string
 * literals and escapes so braces inside JSON strings don't break the count.
 * Returns null when the object never closes (truncated output).
 */
function extractBalancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse the result object Claude Code prints with --output-format json,
 * tolerating noise around it. The CLI sometimes prefixes stdout with plain
 * text (update banners like "Update available! ...", npm notices); a strict
 * JSON.parse of the whole stream then throws and the caller misreads a
 * perfectly healthy reply as an auth error. Strategy: strict parse of the
 * trimmed output first (fast path), then locate the LAST balanced top-level
 * {...} object — the result object is the final thing the CLI prints, so we
 * scan line-start `{` candidates from the end backwards (with a first-`{`
 * fallback for same-line noise). Returns null when no candidate parses.
 * Exported for tests.
 */
export function parseClaudeJson(stdout: string): ClaudeJsonResult | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as ClaudeJsonResult;
  } catch {
    /* fall through to the balanced-object scan */
  }

  // Candidate starts: every '{' that begins a line (the result object is
  // printed on its own line after any banner). Try the LAST one first —
  // banners precede the result, never follow it.
  const lineStarts: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' && (i === 0 || text[i - 1] === '\n' || text[i - 1] === '\r')) {
      lineStarts.push(i);
    }
  }
  const candidates = [...lineStarts].reverse();
  // Fallback for noise on the SAME line as the JSON: the first '{' anywhere.
  const firstBrace = text.indexOf('{');
  if (firstBrace !== -1 && !lineStarts.includes(firstBrace)) candidates.push(firstBrace);

  for (const start of candidates) {
    const candidate = extractBalancedObject(text, start);
    if (candidate === null) continue;
    try {
      return JSON.parse(candidate) as ClaudeJsonResult;
    } catch {
      /* not valid JSON at this candidate; keep scanning earlier ones */
    }
  }
  return null;
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
    // Regex-extract the semver: `claude --version` decorates it ("2.1.6
    // (Claude Code)") and update banners can push extra tokens onto stdout,
    // so the first whitespace token is not reliably the version.
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
      return { ...base, detail: 'claude CLI not found on PATH. Install Claude Code, then log in.' };
    }
    if (!probe) {
      return { ...base, status: 'ready', detail: 'CLI detected (auth not probed).' };
    }

    const timeoutMs = opts.timeoutMs ?? 60_000;
    const { args: modelArgs } = await resolveModelArgs('health-probe');
    const r = await runCli(this.bin, ['-p', PING, '--output-format', 'json', ...modelArgs], {
      timeoutMs,
      signal: opts.signal,
    });
    // A killed process leaves partial/empty stdout — check the kill reasons
    // BEFORE parsing so they aren't misreported as parse/auth failures.
    if (r.timedOut) {
      return { ...base, status: 'error', detail: `Auth probe timed out after ${timeoutMs}ms.` };
    }
    if (r.aborted) {
      return { ...base, status: 'error', detail: 'Auth probe aborted.' };
    }

    const json = parseClaudeJson(r.stdout);
    if (json) {
      const ok = json.is_error === false && json.subtype === 'success';
      const model = json.modelUsage ? (Object.keys(json.modelUsage)[0] ?? null) : null;
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
      return {
        ...base,
        status: 'error',
        detail: `Probe returned an error (subtype: ${json.subtype ?? 'unknown'}).`,
      };
    }

    // No parseable result object at all — sniff the raw output for auth hints.
    const out = `${r.stderr}\n${r.stdout}`.toLowerCase();
    if (out.includes('login') || out.includes('not authenticated') || out.includes('unauthorized')) {
      return {
        ...base,
        status: 'not-authenticated',
        detail: 'Not authenticated. Run `claude` once and log in to your subscription.',
      };
    }
    return {
      ...base,
      status: 'error',
      detail: `Unexpected CLI output: ${(r.stderr || r.stdout).slice(0, 160).trim()}`,
    };
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<CompletionResult> {
    // Prompt travels via stdin, never argv: on Windows, runCli spawns through
    // cmd.exe (shell:true), which mangles/truncates multi-line strings and has
    // an ~8KB command-line limit — a large plan/triage prompt embedded as an
    // argv element can get corrupted before `claude` ever sees it, causing the
    // CLI to fall back to its interactive first screen instead of running
    // headless. See run-cli.ts's `input` option for the stdin-write path.
    const args = ['-p', '--output-format', 'json'];
    // readOnly and plan mode both map to --permission-mode plan: Claude Code's
    // plan permission mode is its no-writes mode — the model can read the repo
    // but every file-modifying tool is blocked, which is exactly the readOnly
    // contract (analysis over a user's working tree must never mutate it).
    if (opts.readOnly || opts.mode === 'plan') args.push('--permission-mode', 'plan');
    // Resolved once per call (not per retry attempt) — callers that retry the
    // same task type (e.g. generate.ts's 2-attempt loop) naturally reuse the
    // same model/effort every attempt since each attempt is its own complete()
    // call with the same fixed taskType, keeping the prompt-cache prefix
    // stable across the retry rather than switching models mid-task.
    const { args: modelArgs, model, effort } = await resolveModelArgs(opts.taskType);
    args.push(...modelArgs);
    const r = await runCli(this.bin, args, {
      timeoutMs: opts.timeoutMs ?? 300_000,
      cwd: opts.cwd,
      signal: opts.signal,
      input: prompt,
    });
    // Kill reasons first — see health() for why.
    if (r.timedOut) {
      return {
        provider: this.id,
        ok: false,
        text: '',
        raw: r,
        detail: 'Completion timed out.',
        model,
        effort,
      };
    }
    if (r.aborted) {
      return { provider: this.id, ok: false, text: '', raw: r, detail: 'Completion aborted.', model, effort };
    }
    const json = parseClaudeJson(r.stdout);
    if (json) {
      const ok = json.is_error === false;
      return {
        provider: this.id,
        ok,
        text: String(json.result ?? ''),
        raw: json,
        detail: ok ? 'ok' : `error (subtype: ${json.subtype ?? 'unknown'})`,
        model,
        effort,
      };
    }
    return {
      provider: this.id,
      ok: false,
      text: '',
      raw: r,
      detail: `Could not parse output: ${(r.stderr || r.stdout).slice(0, 200).trim()}`,
      model,
      effort,
    };
  }

  async plan(task: string, opts: PlanOptions = {}): Promise<PlanResult> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const { args: modelArgs, model, effort } = await resolveModelArgs(opts.taskType);
    // Same stdin-not-argv rationale as complete() above.
    const r = await runCli(
      this.bin,
      ['-p', '--permission-mode', 'plan', '--output-format', 'json', ...modelArgs],
      {
        timeoutMs,
        signal: opts.signal,
        input: task,
      },
    );
    // Kill reasons BEFORE parsing: a timed-out/aborted run leaves partial or
    // empty stdout, and reporting that as "could not parse" hides the real
    // cause from the user (who should raise the timeout, not debug JSON).
    if (r.timedOut) {
      return {
        provider: this.id,
        ok: false,
        plan: '',
        raw: r,
        detail: `Plan generation timed out after ${timeoutMs}ms.`,
        model,
        effort,
      };
    }
    if (r.aborted) {
      return {
        provider: this.id,
        ok: false,
        plan: '',
        raw: r,
        detail: 'Plan generation aborted.',
        model,
        effort,
      };
    }
    const json = parseClaudeJson(r.stdout);
    if (json) {
      const ok = json.is_error === false;
      return {
        provider: this.id,
        ok,
        plan: String(json.result ?? ''),
        raw: json,
        detail: ok ? 'Plan generated in plan mode.' : 'Plan generation failed.',
        model,
        effort,
      };
    }
    return {
      provider: this.id,
      ok: false,
      plan: '',
      raw: r,
      detail: `Could not parse plan output: ${(r.stderr || r.stdout).slice(0, 160).trim()}`,
      model,
      effort,
    };
  }
}
