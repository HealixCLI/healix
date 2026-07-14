import { spawn, type ChildProcess } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { TestStatus } from '../../storage/types.js';
import type { ExecOutcome, ExecResultItem, GeneratedSpec, TestModeContext } from '../types.js';

const EXEC_TIMEOUT_MS = 30 * 60_000; // generous: full suite across three tiers
const INSTALL_TIMEOUT_MS = 300_000; // generous: npm install for the scaffolded suite
const MAX_BUFFER = 64 * 1024 * 1024; // 64MB — JSON reporter on stdout can be large

const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function emit(ctx: TestModeContext, message: string, data?: unknown): void {
  ctx.emit?.('execute', message, data);
}

function stripAnsi(text: string): string {
  return (text ?? '').replace(ANSI_RE, '');
}

/**
 * Env var names the suite subprocesses (npx/npm/playwright) are allowed to see.
 * Matching is case-insensitive because Windows env names are case-insensitive
 * (`Path` vs `PATH`). Everything NOT listed here — API keys, cloud creds,
 * tokens, database URLs — is dropped.
 */
const SUITE_ENV_ALLOWLIST = new Set(
  [
    // Process basics — node/npm/npx cannot resolve or run without these.
    'PATH',
    'HOME',
    'USERPROFILE',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SHELL',
    'LANG',
    'LC_ALL',
    'TERM',
    'CI',
    'NODE_ENV',
    // npm / Playwright caches so installs and browser lookups keep working.
    'npm_config_cache',
    'PLAYWRIGHT_BROWSERS_PATH',
    // Corporate proxies (npm install / browser download go through them).
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    // Windows needs these for cmd.exe, .cmd shims, and npm/node to function.
    'SystemRoot',
    'ComSpec',
    'PATHEXT',
    'APPDATA',
    'LOCALAPPDATA',
    'ProgramFiles',
  ].map((k) => k.toLowerCase()),
);

/**
 * Build the environment for suite subprocesses from an explicit allowlist.
 *
 * WHY: the specs we execute are UNTRUSTED MODEL OUTPUT. The previous
 * `{ ...process.env }` spread handed every host secret (API keys, cloud
 * credentials, tokens) to whatever code the model generated — one
 * `process.env` read plus one fetch() inside a spec exfiltrates them all.
 * Only what node/npm/Playwright genuinely need to run is passed through,
 * plus every HEALIX_* var (our own config, by definition non-secret) and the
 * HEALIX_BASE_URL injection the scaffolded playwright.config reads.
 */
export function suiteEnv(ctx: TestModeContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SUITE_ENV_ALLOWLIST.has(key.toLowerCase()) || key.startsWith('HEALIX_')) {
      env[key] = value;
    }
  }
  // Config-resolved additions (e.g. Tier-B credentials from .healix/config.json).
  // HEALIX_-prefixed only, so the allowlist's security posture is unchanged.
  for (const [key, value] of Object.entries(ctx.extraEnv ?? {})) {
    if (key.startsWith('HEALIX_')) env[key] = value;
  }
  if (ctx.baseUrl) env.HEALIX_BASE_URL = ctx.baseUrl;
  return env;
}

interface RawCommand {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when ctx.signal cancelled the run (before spawn or mid-flight). */
  aborted: boolean;
}

/** Spawn the Playwright CLI; capture everything; never reject on test failure. */
function runPlaywright(
  ctx: TestModeContext,
  only: string[] = [],
  projects: string[] = [],
): Promise<RawCommand> {
  return new Promise<RawCommand>((resolve) => {
    // Cancelled before we even spawned — return immediately; nothing to kill.
    if (ctx.signal?.aborted) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '[aborted before start]',
        timedOut: false,
        aborted: true,
      });
      return;
    }

    // No --reporter flag: it would OVERRIDE the scaffolded config's reporter
    // list, which is what writes results.json (json) and playwright-report/
    // (html). The config's reporters are the artifact source of truth.
    // A targeted pass (repair re-runs) appends spec paths as Playwright file
    // filters and/or --project selectors; project dependencies (auth-setup)
    // still run automatically for selected projects.
    const args = ['playwright', 'test', ...only];
    for (const p of projects) args.push('--project', p);
    // Allowlisted env only — generated specs are untrusted; see suiteEnv().
    const env = suiteEnv(ctx);

    let child: ChildProcess;
    try {
      child = spawn('npx', args, {
        cwd: ctx.projectDir,
        env,
        detached: process.platform !== 'win32',
        shell: process.platform === 'win32', // npx resolves to npx.cmd on Windows
      });
    } catch (err) {
      // A synchronous spawn failure (e.g. ENOENT) is NOT a timeout; reserve
      // timedOut:true for the real setTimeout path so it isn't mislabeled.
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: String(err),
        timedOut: false,
        aborted: false,
      });
      return;
    }

    // Accumulate raw chunks and decode ONCE on settle — per-chunk toString()
    // can split a multi-byte UTF-8 sequence and corrupt the JSON report.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let aborted = false;
    const decoded = (): { stdout: string; stderr: string } => ({
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
    });

    const kill = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') {
          child.kill(signal);
        } else {
          process.kill(-child.pid, signal);
        }
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already exited */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      emit(ctx, `Execution exceeded ${EXEC_TIMEOUT_MS}ms; terminating`, { pid: child.pid });
      kill('SIGTERM');
    }, EXEC_TIMEOUT_MS);
    const hardKill = setTimeout(() => {
      if (timedOut) kill('SIGKILL');
    }, EXEC_TIMEOUT_MS + 5_000);

    // Cooperative cancellation: abort takes the SAME kill path as the timeout
    // (SIGTERM the process group, then SIGKILL if it lingers). We do not
    // resolve here — the child's 'close' event settles the promise so partial
    // output is still decoded and no double-resolve is possible.
    let abortHardKill: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      aborted = true;
      emit(ctx, 'Execution aborted by caller; terminating', { pid: child.pid });
      kill('SIGTERM');
      abortHardKill = setTimeout(() => kill('SIGKILL'), 5_000);
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      clearTimeout(timer);
      clearTimeout(hardKill);
      if (abortHardKill) clearTimeout(abortHardKill);
      // Remove the listener on settle so a long-lived AbortSignal (reused
      // across phases) does not accumulate dead listeners / leak the closure.
      ctx.signal?.removeEventListener('abort', onAbort);
    };

    child.stdout?.on('data', (d: Buffer) => {
      stdoutBytes += d.length;
      if (stdoutBytes <= MAX_BUFFER) stdoutChunks.push(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderrBytes += d.length;
      if (stderrBytes <= MAX_BUFFER) stderrChunks.push(d);
    });

    child.on('error', (err) => {
      cleanup();
      const { stdout, stderr } = decoded();
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr: `${stderr}${String(err)}`,
        timedOut,
        aborted,
      });
    });
    child.on('close', (code, signal) => {
      cleanup();
      resolve({ code, signal: signal as NodeJS.Signals | null, ...decoded(), timedOut, aborted });
    });
  });
}

interface CmdResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when ctx.signal cancelled the command (before spawn or mid-flight). */
  aborted: boolean;
}

/** Run a one-off command (npm install / browser install) in the suite dir. */
function runCommand(
  ctx: TestModeContext,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<CmdResult> {
  return new Promise<CmdResult>((resolve) => {
    // Cancelled before we even spawned — return immediately; nothing to kill.
    if (ctx.signal?.aborted) {
      resolve({ code: null, stdout: '', stderr: '[aborted before start]', aborted: true });
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: ctx.projectDir,
        // Allowlisted env only — same rationale as runPlaywright: install
        // scripts run arbitrary code and must not inherit host secrets.
        env: suiteEnv(ctx),
        shell: process.platform === 'win32', // npm/npx resolve to .cmd on Windows
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: String(err), aborted: false });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const decoded = (): { stdout: string; stderr: string } => ({
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
    });

    const finish = (res: CmdResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Remove the abort listener on settle so a reused AbortSignal does not
      // accumulate dead listeners across commands.
      ctx.signal?.removeEventListener('abort', onAbort);
      resolve(res);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
      const { stdout, stderr } = decoded();
      finish({
        code: null,
        stdout,
        stderr: `${stderr}\n[timed out after ${timeoutMs}ms]`,
        aborted: false,
      });
    }, timeoutMs);

    // Cooperative cancellation: same kill-and-finish path as the timeout above.
    const onAbort = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
      const { stdout, stderr } = decoded();
      finish({ code: null, stdout, stderr: `${stderr}\n[aborted]`, aborted: true });
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (d: Buffer) => {
      stdoutBytes += d.length;
      if (stdoutBytes <= MAX_BUFFER) stdoutChunks.push(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderrBytes += d.length;
      if (stderrBytes <= MAX_BUFFER) stderrChunks.push(d);
    });

    child.on('error', (err) => {
      const { stdout, stderr } = decoded();
      finish({ code: null, stdout, stderr: `${stderr}${String(err)}`, aborted: false });
    });
    child.on('close', (code) => finish({ code, ...decoded(), aborted: false }));
  });
}

/**
 * Ensure the scaffolded suite has its node_modules. The Playwright browser
 * binaries live in the shared global cache, so only the npm deps need
 * installing here; browsers are handled lazily on a missing-browser failure.
 */
async function ensureSuiteDeps(ctx: TestModeContext): Promise<void> {
  const marker = join(ctx.projectDir, 'node_modules', '@playwright');
  try {
    await access(marker);
    return; // deps already present
  } catch {
    /* fall through to install */
  }

  emit(ctx, '[execute] installing suite deps…');
  const res = await runCommand(
    ctx,
    'npm',
    ['install', '--no-audit', '--no-fund', '--silent'],
    INSTALL_TIMEOUT_MS,
  );
  if (res.code === 0) {
    emit(ctx, '[execute] suite deps installed');
  } else {
    const tail = stripAnsi(res.stderr || res.stdout)
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-8)
      .join(' | ');
    emit(ctx, '[execute] npm install did not exit cleanly; continuing', { code: res.code, tail });
  }
}

/** Heuristic: did the run fail because a Playwright browser binary is missing? */
function looksLikeMissingBrowser(cmd: RawCommand): boolean {
  const text = stripAnsi(`${cmd.stderr}\n${cmd.stdout}`);
  return /Executable doesn't exist|playwright install|browserType\.launch|Failed to launch|please run the following command/i.test(
    text,
  );
}

// ---- Playwright JSON report shapes (only the fields we read) ----------------

interface PwAttachment {
  name?: string;
  path?: string;
  contentType?: string;
}
interface PwError {
  message?: string;
  stack?: string;
  value?: string;
}
interface PwResult {
  status?: string;
  duration?: number;
  error?: PwError;
  errors?: PwError[];
  attachments?: PwAttachment[];
}
interface PwTest {
  status?: string;
  projectName?: string;
  results?: PwResult[];
}
interface PwSpec {
  title?: string;
  file?: string;
  tests?: PwTest[];
}
interface PwSuite {
  title?: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}
interface PwReport {
  suites?: PwSuite[];
}

const STATUS_PRIORITY: Record<string, number> = {
  failed: 5,
  blocked: 4,
  flaky: 3,
  skipped: 2,
  passed: 1,
  unknown: 0,
};

function normalizeStatus(raw: string | undefined): TestStatus {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'expected' || s === 'passed') return 'passed';
  if (s === 'unexpected' || s === 'failed' || s === 'timedout' || s === 'interrupted') return 'failed';
  if (s === 'flaky') return 'flaky';
  if (s === 'skipped' || s === 'pending') return 'skipped';
  return 'pending';
}

function projectIsTierB(projectName: string | undefined): boolean {
  return /tierb/i.test(String(projectName ?? ''));
}

/** The auth-setup project/spec that produces the Tier B storageState. */
function isAuthSetup(projectName: string | undefined, file: string | undefined): boolean {
  return (
    /auth[-._ ]?setup/i.test(String(projectName ?? '')) ||
    /auth\.setup\.[cm]?[jt]sx?$/i.test(String(file ?? ''))
  );
}

/**
 * Structural signals for classifying Tier B outcomes. Derived from the run
 * itself (the auth-setup project's result + the setup's sidecar meta file),
 * NEVER from matching error text: Playwright errors embed the failing source
 * snippet, so a spec merely *mentioning* auth words in a comment used to be
 * enough to downgrade a genuine failure to `blocked` (defect-leakage bug).
 */
export interface AuthSignals {
  /** The auth-setup project itself failed (Tier B dependants were skipped). */
  setupFailed: boolean;
  /** Error text from the failed auth-setup, attached to blocked Tier B rows. */
  setupError: string;
  /**
   * Whether the setup performed a REAL login (from setup-meta.json).
   * null = unknown (older suite template without the sidecar): in that case
   * Tier B failures are NEVER downgraded — honest failure beats false block.
   */
  performedLogin: boolean | null;
}

const NO_AUTH_SIGNALS: AuthSignals = { setupFailed: false, setupError: '', performedLogin: null };

/** Pre-pass: find the auth-setup spec's outcome in the raw Playwright report. */
export function findAuthSetupOutcome(report: PwReport): { failed: boolean; error: string } {
  let failed = false;
  let error = '';
  const visitSpec = (spec: PwSpec, suiteFile: string | undefined): void => {
    for (const test of spec.tests ?? []) {
      if (!isAuthSetup(test.projectName, spec.file ?? suiteFile)) continue;
      const last = (test.results ?? [])[(test.results ?? []).length - 1];
      const status = normalizeStatus(last?.status ?? test.status);
      if (status === 'failed') {
        failed = true;
        if (!error) error = errorText(last);
      }
    }
  };
  const walk = (suite: PwSuite): void => {
    for (const spec of suite.specs ?? []) visitSpec(spec, suite.file);
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return { failed, error };
}

/** Read the auth setup's sidecar meta (best-effort; null when absent/invalid). */
async function readSetupMeta(projectDir: string): Promise<boolean | null> {
  try {
    const raw = await readFile(join(projectDir, 'fixtures', '.auth', 'setup-meta.json'), 'utf-8');
    const meta: unknown = JSON.parse(raw);
    if (
      meta &&
      typeof meta === 'object' &&
      typeof (meta as { performedLogin?: unknown }).performedLogin === 'boolean'
    ) {
      return (meta as { performedLogin: boolean }).performedLogin;
    }
  } catch {
    /* absent or unreadable — signal unknown */
  }
  return null;
}

function errorText(result: PwResult | undefined): string {
  if (!result) return '';
  const parts: string[] = [];
  if (result.error)
    parts.push(result.error.message ?? '', result.error.stack ?? '', result.error.value ?? '');
  for (const e of result.errors ?? []) parts.push(e.message ?? '', e.stack ?? '', e.value ?? '');
  return stripAnsi(parts.filter(Boolean).join('\n')).trim();
}

function collectArtifactPaths(attachments: PwAttachment[] | undefined): string[] {
  return (attachments ?? [])
    .map((a) => a.path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
}

interface ParsedReport {
  results: ExecResultItem[];
  passed: number;
  failed: number;
  blocked: number;
  flaky: number;
}

export function parseReport(report: PwReport, auth: AuthSignals = NO_AUTH_SIGNALS): ParsedReport {
  const results: ExecResultItem[] = [];
  let passed = 0;
  let failed = 0;
  let blocked = 0;
  let flaky = 0;

  const processSpec = (spec: PwSpec, suiteTitle: string): void => {
    const tests = spec.tests ?? [];
    if (tests.length === 0) return;
    const title = stripAnsi(spec.title ?? suiteTitle ?? 'Unnamed test').trim();

    let worst: TestStatus = 'pending';
    let worstError = '';
    let totalDuration = 0;
    let artifacts: string[] = [];
    let isFlaky = false;

    for (const test of tests) {
      const testResults = test.results ?? [];
      const last = testResults[testResults.length - 1];
      totalDuration += last?.duration ?? 0;

      const statuses = testResults.map((r) => String(r.status ?? '').toLowerCase());
      const hadPass = statuses.some((s) => s === 'passed' || s === 'expected');
      const hadFail = statuses.some((s) => s === 'failed' || s === 'unexpected' || s === 'timedout');
      const testLevelFlaky = String(test.status ?? '').toLowerCase() === 'flaky';
      if (testLevelFlaky || (hadPass && hadFail)) isFlaky = true;

      let status = normalizeStatus(last?.status ?? test.status);
      let errText = errorText(last);

      // Structural Tier B classification (see AuthSignals). Three cases:
      //  1. Auth setup FAILED → Playwright skipped its dependants; those skips
      //     (and any failures from a partial run) are `blocked` prerequisites,
      //     carrying the setup's own error so the cause is visible.
      //  2. Setup passed WITHOUT a real login (performedLogin === false: no
      //     credentials configured) → Tier B ran anonymous; its failures were
      //     doomed in advance and are `blocked`, not app defects.
      //  3. Setup performed a real login (or is unknown) → every failure is
      //     honest. NEVER downgraded — this was the defect-leakage bug.
      if (projectIsTierB(test.projectName)) {
        if (auth.setupFailed && (status === 'failed' || status === 'skipped')) {
          status = 'blocked';
          errText =
            errText ||
            `Auth setup failed — Tier B prerequisite not met.${auth.setupError ? `\n${auth.setupError}` : ''}`;
        } else if (status === 'failed' && auth.performedLogin === false) {
          status = 'blocked';
          errText = `Tier B ran without credentials (no HEALIX_TIERB_* configured; anonymous session).\n${errText}`;
        }
      }

      if ((STATUS_PRIORITY[status] ?? 0) >= (STATUS_PRIORITY[worst] ?? 0)) {
        worst = status;
        if (status === 'failed' || status === 'blocked') worstError = errText;
        const a = collectArtifactPaths(last?.attachments);
        if (a.length > 0) artifacts = a;
      }
    }

    if (isFlaky && worst !== 'failed' && worst !== 'blocked') {
      worst = 'flaky';
    }

    const item: ExecResultItem = {
      title,
      status: worst,
      durationMs: totalDuration || undefined,
      error: worstError || undefined,
      artifacts: artifacts.length > 0 ? artifacts : undefined,
    };
    results.push(item);

    switch (worst) {
      case 'passed':
        passed += 1;
        break;
      case 'flaky':
        flaky += 1;
        passed += 1; // flaky eventually passed — count toward passed headline
        break;
      case 'blocked':
        blocked += 1;
        break;
      case 'failed':
        failed += 1;
        break;
      default:
        // skipped/pending do not move pass/fail headline counters
        break;
    }
  };

  const walk = (suite: PwSuite, parentTitle: string): void => {
    const suiteTitle = parentTitle ? `${parentTitle} > ${suite.title ?? ''}` : (suite.title ?? '');
    for (const spec of suite.specs ?? []) processSpec(spec, suiteTitle);
    for (const child of suite.suites ?? []) walk(child, suiteTitle);
  };

  for (const suite of report.suites ?? []) walk(suite, '');
  return { results, passed, failed, blocked, flaky };
}

/** Read results.json if present and newer than the run start. */
async function readResultsJson(projectDir: string, startedAt: number): Promise<PwReport | null> {
  const candidate = join(projectDir, 'results.json');
  try {
    const st = await stat(candidate);
    // Allow small clock skew; stale file from a prior run is ignored.
    if (st.mtimeMs + 50 < startedAt) return null;
    const raw = await readFile(candidate, 'utf-8');
    return JSON.parse(raw) as PwReport;
  } catch {
    return null;
  }
}

/** Last-ditch: try to JSON-parse stdout (the json reporter prints to stdout too). */
function parseStdoutJson(stdout: string): PwReport | null {
  const text = stdout.trim();
  // Fast path: stdout is pure JSON.
  if (text.startsWith('{')) {
    try {
      return JSON.parse(text) as PwReport;
    } catch {
      // fall through to the embedded-brace search
    }
  }
  // Fallback: the json blob may be preceded by list-reporter lines; locate it.
  // Match tolerantly — whitespace/newlines differ between Playwright versions.
  const m = stdout.match(/\{\s*"config"\s*:/);
  if (m && m.index !== undefined) {
    try {
      return JSON.parse(stdout.slice(m.index)) as PwReport;
    } catch {
      return null;
    }
  }
  return null;
}

/** Fallback summary parse from human-readable reporter lines. */
function parseSummaryText(combined: string): ParsedReport {
  const text = stripAnsi(combined);
  const num = (re: RegExp): number => {
    const m = text.match(re);
    return m ? parseInt(m[1], 10) : 0;
  };
  const passed = num(/(\d+)\s+passed/i);
  const failed = num(/(\d+)\s+failed/i);
  const flaky = num(/(\d+)\s+flaky/i);
  return { results: [], passed, failed, blocked: 0, flaky };
}

/** Outcome returned when the caller cancelled the run — never a throw. */
function abortedOutcome(exitCode: number | null = null): ExecOutcome {
  return { passed: 0, failed: 0, blocked: 0, flaky: 0, results: [], raw: { aborted: true, exitCode } };
}

/**
 * Run the scaffolded suite and parse results into an ExecOutcome. Tier B login
 * failures become `blocked`. Never throws on test failure — only the outcome
 * object is returned; infrastructure errors are surfaced via raw + a warning.
 * Cancellation (ctx.signal) also never throws: the run is killed and an
 * aborted outcome (raw.aborted) is returned so callers can distinguish
 * "cancelled" from "ran and everything failed".
 */
export async function execute(
  ctx: TestModeContext,
  specs: GeneratedSpec[],
  opts: { only?: string[]; projects?: string[] } = {},
): Promise<ExecOutcome> {
  emit(ctx, `Executing ${specs.length} spec(s) via Playwright`, { count: specs.length });

  if (specs.length === 0) {
    emit(ctx, 'No specs to execute; returning empty outcome');
    return { passed: 0, failed: 0, blocked: 0, flaky: 0, results: [] };
  }

  // Already cancelled? Return before ANY subprocess (npm install / npx) spawns.
  if (ctx.signal?.aborted) {
    emit(ctx, 'Execution aborted before start; returning aborted outcome', { aborted: true });
    return abortedOutcome();
  }

  await ensureSuiteDeps(ctx);

  emit(ctx, '[execute] running Playwright suite…');
  let startedAt = Date.now();
  let cmd = await runPlaywright(ctx, opts.only ?? [], opts.projects ?? []);

  // Cancelled during (or right before) the run: partial results are
  // meaningless and would mislabel interrupted tests as failures — discard
  // them and surface the abort via a warning event + raw.aborted instead.
  if (cmd.aborted || ctx.signal?.aborted) {
    emit(ctx, 'Execution aborted; discarding partial results', { exitCode: cmd.code, aborted: true });
    return abortedOutcome(cmd.code);
  }

  // The browser binaries normally come from the shared global cache; if a run
  // fails because one is missing, install chromium into the cache and retry once.
  if (cmd.code !== 0 && looksLikeMissingBrowser(cmd)) {
    emit(ctx, '[execute] missing browser binary; running npx playwright install chromium…');
    const browserInstall = await runCommand(
      ctx,
      'npx',
      ['playwright', 'install', 'chromium'],
      INSTALL_TIMEOUT_MS,
    );
    emit(ctx, '[execute] browser install complete; re-running suite', { code: browserInstall.code });
    startedAt = Date.now();
    cmd = await runPlaywright(ctx, opts.only ?? [], opts.projects ?? []);

    // The retry run can be cancelled too (as can the install before it).
    if (cmd.aborted || ctx.signal?.aborted) {
      emit(ctx, 'Execution aborted; discarding partial results', { exitCode: cmd.code, aborted: true });
      return abortedOutcome(cmd.code);
    }
  }
  emit(ctx, '[execute] Playwright run finished', { exitCode: cmd.code, timedOut: cmd.timedOut });

  let report = await readResultsJson(ctx.projectDir, startedAt);
  if (!report) report = parseStdoutJson(cmd.stdout);

  let parsed: ParsedReport;
  let authSignals: AuthSignals | null = null;
  if (report) {
    const setup = findAuthSetupOutcome(report);
    const performedLogin = await readSetupMeta(ctx.projectDir);
    const auth: AuthSignals = { setupFailed: setup.failed, setupError: setup.error, performedLogin };
    authSignals = auth;
    if (setup.failed) {
      emit(ctx, '[execute] auth setup failed; Tier B outcomes classified as blocked', {
        setupError: setup.error.split('\n')[0] ?? '',
      });
    } else if (performedLogin === false) {
      emit(ctx, '[execute] auth setup ran without credentials; Tier B failures classified as blocked');
    }
    parsed = parseReport(report, auth);
  } else {
    parsed = parseSummaryText(`${cmd.stdout}\n${cmd.stderr}`);
    if (parsed.results.length === 0 && parsed.passed === 0 && parsed.failed === 0) {
      const tail = stripAnsi(cmd.stderr || cmd.stdout)
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-8)
        .join(' | ');
      emit(ctx, 'Could not parse Playwright results; suite may have failed to start', {
        exitCode: cmd.code,
        timedOut: cmd.timedOut,
        tail,
      });
    }
  }

  const outcome: ExecOutcome = {
    passed: parsed.passed,
    failed: parsed.failed,
    blocked: parsed.blocked,
    flaky: parsed.flaky,
    results: parsed.results,
    raw: {
      exitCode: cmd.code,
      signal: cmd.signal,
      timedOut: cmd.timedOut,
      hadJsonReport: report !== null,
      stderrTail: stripAnsi(cmd.stderr).split(/\r?\n/).filter(Boolean).slice(-20),
      // Structural auth signals for the orchestrator's HEAL phase: a failed
      // setup with credentials configured is a healable root cause.
      authSetupFailed: authSignals?.setupFailed ?? false,
      authSetupError: authSignals?.setupError ?? '',
      performedLogin: authSignals?.performedLogin ?? null,
    },
  };

  emit(ctx, 'Execution complete', {
    passed: outcome.passed,
    failed: outcome.failed,
    blocked: outcome.blocked,
    flaky: outcome.flaky,
  });
  return outcome;
}
