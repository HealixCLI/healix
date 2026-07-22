import type { ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import spawn from 'cross-spawn';

import type { Tier, TestStatus } from '../../storage/types.js';
import type {
  ExecOutcome,
  ExecResultItem,
  ExecStepItem,
  GeneratedSpec,
  TestingScope,
  TestModeContext,
} from '../types.js';
import { tiersForScope } from '../types.js';

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
 * plus every HEALIX_* var already in the host env (our own config, by
 * default non-secret) and the HEALIX_BASE_URL / HEALIX_TIERB_* injections
 * below, which the scaffolded playwright.config / fixtures/auth.setup.ts
 * (see templates.ts) read. The test credentials ARE secrets — unlike the
 * rest of this allowlist they're deliberately exposed to the spec process
 * because the user configured them on the project for exactly this: logging
 * the generated Tier B tests in. They are never sent to the AI provider (see
 * generate.ts, which only ever tells the model to assume storageState, never
 * references the literal values).
 */
export function suiteEnv(ctx: TestModeContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SUITE_ENV_ALLOWLIST.has(key.toLowerCase()) || key.startsWith('HEALIX_')) {
      env[key] = value;
    }
  }
  if (ctx.baseUrl) env.HEALIX_BASE_URL = ctx.baseUrl;
  const credentials = ctx.credentials ?? [];
  if (credentials.length > 0) {
    // Every credential, passed as one JSON blob so the auth fixture can log
    // each one in and save its OWN storageState (see authSetupContents() in
    // templates.ts) — this is what lets generated tests pick a specific
    // role's session via test.use({ storageState: ... }). The default
    // (roleless, or first) credential is ALSO exposed as the plain
    // EMAIL/PASSWORD pair for the fixture's single-credential fallback path.
    env.HEALIX_TIERB_CREDENTIALS_JSON = JSON.stringify(
      credentials.map((c) => ({
        authType: c.authType,
        username: c.username,
        password: c.password,
        role: c.role,
        token: c.token,
        urlTemplate: c.urlTemplate,
        extraParams: c.extraParams,
        authCheckText: c.authCheckText,
      })),
    );
    const defaultCredential = credentials.find((c) => c.role === null) ?? credentials[0];
    env.HEALIX_TIERB_EMAIL = defaultCredential.username;
    env.HEALIX_TIERB_PASSWORD = defaultCredential.password;
    // The auth fixture requires all three of email/password/loginUrl to
    // attempt a real login (see authSetupContents() in templates.ts). Prefer
    // EXPLORE's discovered/scored login candidate (hash- and region-prefix
    // aware — see browser/crawler.ts scoreLoginCandidates) over the naive
    // `/login` path join, which 404s or falls back to the app's default
    // route on a HashRouter + region-prefixed app (the RCA's Branch 2).
    const discovered = ctx.exploration?.loginCandidates?.[0]?.url;
    if (discovered) {
      env.HEALIX_TIERB_LOGIN_URL = discovered;
    } else if (ctx.baseUrl) {
      env.HEALIX_TIERB_LOGIN_URL = new URL('/login', ctx.baseUrl).toString();
    }
  }
  return env;
}

/**
 * Playwright --project flags restricting execution to the tiers in scope.
 * Omitted entirely for 'both' (or when scope is unset) so Playwright runs
 * every project — current default behavior. tierB-auth's `auth-setup`
 * dependency (see playwrightConfigContents in templates.ts) runs
 * automatically whenever tierB-auth is selected, even though it's never
 * listed here explicitly — that's Playwright's own dependency semantics for
 * `--project`, not something this needs to reproduce.
 */
export function playwrightProjectArgs(scope: TestingScope | undefined): string[] {
  if (!scope || scope === 'both') return [];
  return tiersForScope(scope).flatMap((tier) => ['--project', tier]);
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
function runPlaywright(ctx: TestModeContext, onlyTier?: Tier): Promise<RawCommand> {
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
    // onlyTier (resume's per-tier batching — see execute()'s opts) restricts
    // to exactly that one tier, overriding the scope-wide project selection.
    const projectArgs = onlyTier ? ['--project', onlyTier] : playwrightProjectArgs(ctx.testingScope);
    const args = ['playwright', 'test', ...projectArgs];
    // Allowlisted env only — generated specs are untrusted; see suiteEnv().
    const env = suiteEnv(ctx);

    let child: ChildProcess;
    try {
      // cross-spawn resolves npx.cmd on Windows without cmd.exe shell:true
      // string-concatenation (the args+shell:true combo Node's DEP0190 warns
      // about — see run-cli.ts for the full rationale).
      child = spawn('npx', args, {
        cwd: ctx.projectDir,
        env,
        detached: process.platform !== 'win32',
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

/**
 * Run a one-off command (npm install / browser install / `playwright test
 * --list` parse-check) in the suite dir, with the same allowlisted env as
 * runPlaywright() — see SUITE_ENV_ALLOWLIST. Exported for validate.ts's
 * pre-execution spec parse-check, which must never hand generated specs a
 * broader env than the run they're eventually executed in.
 */
export function runCommand(
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
      // cross-spawn resolves npm/npx .cmd shims on Windows without shell:true
      // (see runPlaywright above / run-cli.ts for the DEP0190 rationale).
      child = spawn(command, args, {
        cwd: ctx.projectDir,
        // Allowlisted env only — same rationale as runPlaywright: install
        // scripts run arbitrary code and must not inherit host secrets.
        env: suiteEnv(ctx),
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
 *
 * Exported so validate.ts's parse-check gate can call it too — that gate runs
 * `npx playwright test --list` right after generation, before execute() ever
 * gets a chance to install deps, so without this it fails identically for
 * every spec (misreported as "fails to parse") whenever a suite is freshly
 * scaffolded.
 */
export async function ensureSuiteDeps(ctx: TestModeContext): Promise<void> {
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
  // Playwright's JSON reporter only sets `file` on the outermost per-file
  // suite — a nested test.describe() block (exactly what generated specs use)
  // has no `file` of its own. Inherit the nearest ancestor's file rather than
  // passing only the immediate parent's (usually-undefined, for a nested
  // suite) `file` down — otherwise specs living inside a describe() block
  // silently lose their file identity.
  const walk = (suite: PwSuite, inheritedFile: string | undefined): void => {
    const suiteFile = suite.file ?? inheritedFile;
    for (const spec of suite.specs ?? []) visitSpec(spec, suiteFile);
    for (const child of suite.suites ?? []) walk(child, suiteFile);
  };
  for (const suite of report.suites ?? []) walk(suite, undefined);
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

/**
 * `result.error` and `result.errors[]` usually describe the SAME failure —
 * Playwright's `errors` array typically repeats `error` verbatim, or with
 * only a slightly different captured call-log frame — so concatenating them
 * used to print near-duplicate "Test timeout of 60000ms exceeded." blocks
 * two or three times in a row. Show a single, clearest error (the richest
 * field of the first candidate) instead of joining every entry; a wall of
 * repeated call logs is noise, not diagnosis.
 */
function errorText(result: PwResult | undefined): string {
  if (!result) return '';
  const candidates: PwError[] = [];
  if (result.error) candidates.push(result.error);
  for (const e of result.errors ?? []) candidates.push(e);

  for (const err of candidates) {
    const text = stripAnsi(err.stack || err.message || err.value || '').trim();
    if (text) return text;
  }
  return '';
}

const VIDEO_EXT = /\.(webm|mp4|mov)$/i;
// Playwright still writes a video file when the page never repainted before
// the context closed (a very fast test, or one that only ever saw about:blank)
// — the result is a valid webm with a real duration but no visible content.
// Real recorded frames push a webm well past this size even for a couple of
// seconds of ordinary web content; empirically these blank ones land under 4KB.
const MIN_VIDEO_BYTES = 8 * 1024;

/** A video artifact whose file is implausibly small to contain any real recorded frames. */
function isBlankVideo(path: string): boolean {
  if (!VIDEO_EXT.test(path)) return false;
  try {
    return statSync(path).size < MIN_VIDEO_BYTES;
  } catch {
    return false; // can't verify (e.g. already cleaned up) — keep it rather than silently drop evidence
  }
}

function collectArtifactPaths(attachments: PwAttachment[] | undefined): string[] {
  return (attachments ?? [])
    .map((a) => a.path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .filter((p) => !isBlankVideo(p));
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

  const processSpec = (spec: PwSpec, suiteTitle: string, suiteFile: string | undefined): void => {
    const tests = spec.tests ?? [];
    if (tests.length === 0) return;
    // The auth-setup project's own fixture "test" (fixtures/auth.setup.ts) is
    // Healix-internal plumbing, not a user-facing test case. A PASSING setup
    // is uninteresting and must never appear in the report/results or get
    // persisted as a test row — it can never be matched back to a generated
    // spec, which used to inflate the total and silently poison future
    // top-up/reuse's "which tests passed" accounting with an uncarryable
    // phantom "passed" row every Tier B run. A FAILING setup, however, is
    // kept — it's the reason Tier B got blocked and must stay visible for
    // diagnosis (see the AuthSignals classification below), so the isAuthSetup
    // check happens after `worst` is known, not as an early return here.
    const isSetupSpec = tests.every((t) => isAuthSetup(t.projectName, spec.file ?? suiteFile));
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

    // Suppress only a passing (uninteresting) setup phantom; a failed one
    // stays visible below since it's the actual root cause of a blocked Tier B.
    if (isSetupSpec && worst !== 'failed') return;

    const item: ExecResultItem = {
      title,
      status: worst,
      durationMs: totalDuration || undefined,
      error: worstError || undefined,
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      specFile: spec.file ?? suiteFile,
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

  // Same reasoning as findAuthSetupOutcome's walk() above: a nested
  // test.describe() suite (what every generated spec uses) has no `file` of
  // its own in Playwright's JSON reporter — inherit the nearest ancestor's
  // file instead of only ever passing the immediate parent's (often
  // undefined) one down, so specFile below is populated reliably regardless
  // of how deeply nested the spec's suite is.
  const walk = (suite: PwSuite, parentTitle: string, inheritedFile: string | undefined): void => {
    const suiteTitle = parentTitle ? `${parentTitle} > ${suite.title ?? ''}` : (suite.title ?? '');
    const suiteFile = suite.file ?? inheritedFile;
    for (const spec of suite.specs ?? []) processSpec(spec, suiteTitle, suiteFile);
    for (const child of suite.suites ?? []) walk(child, suiteTitle, suiteFile);
  };

  for (const suite of report.suites ?? []) walk(suite, '', undefined);
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

interface RawStepsEntry {
  title?: string;
  retry?: number;
  steps?: Array<{ title?: string; durationMs?: number; error?: string }>;
}

/**
 * steps.json is written by the custom reporter (see templates.ts's
 * stepsReporterContents()) — a supplementary file alongside results.json,
 * since Playwright's own json reporter drops step-level detail entirely.
 * Keyed by title (same key parseReport groups results by); a retried test's
 * LAST attempt's steps win, since that's the outcome that's actually reported.
 */
async function readStepsByTitle(
  projectDir: string,
  startedAt: number,
): Promise<Map<string, ExecStepItem[]>> {
  const byTitle = new Map<string, ExecStepItem[]>();
  try {
    const candidate = join(projectDir, 'steps.json');
    const st = await stat(candidate);
    if (st.mtimeMs + 50 < startedAt) return byTitle;
    const raw = await readFile(candidate, 'utf-8');
    const entries = JSON.parse(raw) as RawStepsEntry[];
    const retrySeen = new Map<string, number>();
    for (const entry of entries) {
      if (!entry.title || !Array.isArray(entry.steps)) continue;
      const retry = entry.retry ?? 0;
      if (retry < (retrySeen.get(entry.title) ?? -1)) continue;
      retrySeen.set(entry.title, retry);
      byTitle.set(
        entry.title,
        entry.steps
          .filter((s): s is { title: string; durationMs?: number; error?: string } => typeof s.title === 'string')
          .map((s) => ({ title: s.title, durationMs: Math.round(s.durationMs ?? 0), error: s.error })),
      );
    }
  } catch {
    // absent or unreadable — steps are best-effort, never block the real outcome
  }
  return byTitle;
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
  opts?: { onlyTier?: Tier },
): Promise<ExecOutcome> {
  const onlyTier = opts?.onlyTier;
  emit(ctx, `Executing ${specs.length} spec(s) via Playwright${onlyTier ? ` (${onlyTier} only)` : ''}`, {
    count: specs.length,
    onlyTier,
  });

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
  let cmd = await runPlaywright(ctx, onlyTier);

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
    cmd = await runPlaywright(ctx, onlyTier);

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
  if (report) {
    const setup = findAuthSetupOutcome(report);
    const performedLogin = await readSetupMeta(ctx.projectDir);
    const auth: AuthSignals = { setupFailed: setup.failed, setupError: setup.error, performedLogin };
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

  // Best-effort: attach the step-by-step breakdown (see stepsReporterContents()
  // in templates.ts) to each result by title — steps.json is written
  // regardless of whether results.json parsed, so this runs unconditionally.
  const stepsByTitle = await readStepsByTitle(ctx.projectDir, startedAt);
  if (stepsByTitle.size > 0) {
    for (const r of parsed.results) {
      const steps = stepsByTitle.get(r.title);
      if (steps) r.steps = steps;
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
