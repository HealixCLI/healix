import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { access, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import spawn from 'cross-spawn';

import type { TestStatus } from '../../storage/types.js';
import type {
  ExecOutcome,
  ExecResultItem,
  ExecStepItem,
  GeneratedSpec,
  TestingScope,
  TestModeContext,
} from '../types.js';
import { tiersForScope, UNEXPLAINED_MISSING_VIDEO_REASON } from '../types.js';
import {
  API_EVIDENCE_LOG_FILENAME,
  EXEC_CHECKPOINT_FILENAME,
  EXEC_CHECKPOINT_INVERT_FILENAME,
  MOCK_PASSTHROUGH_LOG_FILENAME,
  MOCK_REQUEST_LOG_FILENAME,
} from './templates.js';

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
    // attempt a real login (see authSetupContents() in templates.ts). Prefer,
    // in order: (1) the exact page/selectors EXPLORE's own login attempt
    // PROVED work (crawl/verifiedLogin — see browser/crawler.ts crawlWithAuth),
    // since it demonstrably worked and a re-derived score can't see that;
    // (2) EXPLORE's discovered/scored login candidate (hash- and
    // region-prefix aware — see browser/crawler.ts scoreLoginCandidates) over
    // the naive `/login` path join, which 404s or falls back to the app's
    // default route on a HashRouter + region-prefixed app (the RCA's Branch 2).
    const verified = ctx.exploration?.crawl?.verifiedLogin;
    const discovered = verified?.pageUrl ?? ctx.exploration?.loginCandidates?.[0]?.url;
    if (discovered) {
      env.HEALIX_TIERB_LOGIN_URL = discovered;
    } else if (ctx.baseUrl) {
      env.HEALIX_TIERB_LOGIN_URL = new URL('/login', ctx.baseUrl).toString();
    }
    // Grounds the generated fixture's field/submit locators in the selectors EXPLORE actually
    // typed into/clicked, rather than letting it re-guess independently (see loginForm() in
    // templates.ts, which falls back to its own guessing when these are unset).
    if (verified) {
      env.HEALIX_TIERB_LOGIN_IDENTIFIER_SELECTOR = verified.identifierSelector;
      env.HEALIX_TIERB_LOGIN_PASSWORD_SELECTOR = verified.passwordSelector;
      if (verified.submitSelector) env.HEALIX_TIERB_LOGIN_SUBMIT_SELECTOR = verified.submitSelector;
      if (verified.toggleSelector) env.HEALIX_TIERB_LOGIN_TOGGLE_SELECTOR = verified.toggleSelector;
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
function runPlaywright(ctx: TestModeContext, invertFilePath?: string | null): Promise<RawCommand> {
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
    // All in-scope tiers run together in ONE invocation (Playwright's own
    // scheduler runs tierA/tierC concurrently and sequences tierB after
    // auth-setup via each project's own `dependencies` — see
    // playwrightConfigContents in templates.ts) rather than one process per
    // tier. invertFilePath (resume's test-level skip-list — see execute()'s
    // checkpoint handling below) excludes exactly the tests that already
    // finished in an earlier, interrupted attempt, regardless of which tier
    // they belonged to.
    const projectArgs = playwrightProjectArgs(ctx.testingScope);
    const args = [
      'playwright',
      'test',
      ...projectArgs,
      ...(invertFilePath ? [`--test-list-invert=${invertFilePath}`] : []),
    ];
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

    // Kill the whole process tree, not just the direct `npx` process. On
    // POSIX the child is its own process-group leader (detached: true above)
    // so `-pid` signals the group. Windows has no process-group signal, so
    // `taskkill /T` walks and force-kills the tree by PID/PPID instead —
    // otherwise only the top-level npx process dies, leaving the node process
    // actually running Playwright (and the browsers it launched) running to
    // real completion in the background. Same pattern as target/launcher.ts's
    // and exec/run-cli.ts's own killTree().
    const kill = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        try {
          nodeSpawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
        } catch {
          try {
            child.kill(signal);
          } catch {
            /* already exited */
          }
        }
        return;
      }
      try {
        process.kill(-child.pid, signal);
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
        // POSIX: own process-group leader so killTree() below can signal the
        // whole group (install scripts / browser downloaders spawn their own
        // children) — see runPlaywright's identical rationale.
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: String(err), aborted: false });
      return;
    }

    // Kill the whole process tree, not just the direct npm/npx process — same
    // pattern as runPlaywright's kill() above (and target/launcher.ts's /
    // exec/run-cli.ts's own killTree()). Without this, a killed install
    // leaves its actual install script or browser-downloader process running.
    const killTree = (): void => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        try {
          nodeSpawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
          return;
        } catch {
          /* fall through to plain kill below */
        }
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          /* fall through to plain kill below */
        }
      }
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    };

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
      killTree();
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
      killTree();
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
 * installing here; browsers are handled lazily on a missing-browser failure
 * (see looksLikeMissingBrowser's retry below) rather than checked proactively
 * on every call — the only local, network-free way to know a browser binary
 * is missing is to actually try to launch it.
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

/** Heuristic: did the run fail because some OTHER npm package (not a browser
 * binary) the scaffolded suite depends on was never installed, or a prior
 * `npm install` here silently failed partway (ensureSuiteDeps logs and
 * continues rather than hard-failing on that, see above) — e.g. a corrupted
 * node_modules, or a package that only resolves once install actually runs to
 * completion. Same signatures orchestrator/index.ts's looksLikeMissingDeps
 * uses for the TARGET app's own dependencies; not shared code because this
 * one reads a RawCommand (stdout+stderr) instead of a plain error message. */
function looksLikeMissingSuiteDeps(cmd: RawCommand): boolean {
  const text = stripAnsi(`${cmd.stderr}\n${cmd.stdout}`);
  return /Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/i.test(text);
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
interface PwAnnotation {
  type?: string;
  description?: string;
}
interface PwTest {
  status?: string;
  projectName?: string;
  results?: PwResult[];
  /** Playwright's own `test.skip(condition, 'reason')`/`test.fixme(...)` annotations, when the test/suite provided one. */
  annotations?: PwAnnotation[];
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

/**
 * A syntactically valid but structurally empty report — Playwright loaded its config fine
 * but discovered zero specs anywhere (as opposed to legitimately discovering specs that are
 * simply all skipped/pending). Distinct from `!report` (no report at all): a broken/partial
 * `node_modules` can let Playwright start, write an empty JSON reporter file, and exit
 * "successfully" from its own CLI's perspective — which previously took the `if (report)`
 * branch straight into `parseReport`, producing a silent, legitimate-looking `0 passed / 0
 * failed` with no indication anything was ever wrong (see
 * docs/design/execute-suite-deps-silent-failure-fix.md). Recurses into nested `suites` so a
 * real, non-empty report (including one where every individual tier/project happens to have
 * no specs) is never misclassified — only a report with literally zero specs ANYWHERE counts
 * as structurally empty.
 */
function reportIsStructurallyEmpty(report: PwReport): boolean {
  const hasAnySpec = (suites: PwSuite[] | undefined): boolean =>
    (suites ?? []).some((s) => (s.specs?.length ?? 0) > 0 || hasAnySpec(s.suites));
  return !hasAnySpec(report.suites);
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

function projectIsTierC(projectName: string | undefined): boolean {
  return /tierc/i.test(String(projectName ?? ''));
}

/** The auth-setup project/spec that produces the Tier B storageState. */
function isAuthSetup(projectName: string | undefined, file: string | undefined): boolean {
  return (
    /auth[-._ ]?setup/i.test(String(projectName ?? '')) ||
    /auth\.setup\.[cm]?[jt]sx?$/i.test(String(file ?? ''))
  );
}

/**
 * Prefix stamped onto the auth-setup row's OWN error text. Triage's
 * RE_BLOCKED_TIERB matches it (see triage/rules.ts) so this row classifies as the
 * run-configuration problem it is.
 *
 * Stamped HERE, where `isAuthSetup` has already established the row's identity
 * structurally, precisely so that triage never has to guess it back out of error text.
 * Triage sees only a title and an error string — and a bare Playwright timeout from the
 * fixture ("Test timeout of 60000ms exceeded.") carries no auth signal whatsoever, so it
 * used to land on the generic timeout rule as `environment` @0.55 with the rationale "a
 * timeout fired with no selector or assertion context", burying the actual cause of 45
 * blocked tests. Guessing instead from the row's title (`authenticate`) or from auth-ish
 * words in the error would reintroduce exactly the defect-leakage bug AuthSignals documents
 * below — Playwright embeds the failing source snippet in its errors, so any generated spec
 * quoting an auth word could match. A marker Healix writes itself has no such ambiguity.
 */
const AUTH_SETUP_FAILURE_MARKER = 'Tier B auth setup failed';

/** Stamp the marker onto the auth-setup row's own error, tolerating an empty/absent error
 * (a timeout with no message still needs to classify correctly). */
function withAuthSetupMarker(error: string): string {
  const text = error.trim();
  if (text.startsWith(AUTH_SETUP_FAILURE_MARKER)) return text;
  return text ? `${AUTH_SETUP_FAILURE_MARKER}.\n${text}` : `${AUTH_SETUP_FAILURE_MARKER}.`;
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

/**
 * Recovers WHY a test was skipped, from Playwright's own `test.skip(cond,
 * 'reason')` / `test.fixme(cond, 'reason')` annotations — QA-requested
 * visibility for a 'skipped' Results row, which otherwise shows no
 * indication of why the test never actually ran. Returns undefined when the
 * test carries no skip/fixme annotation, or the annotation has no
 * description (a bare `test.skip()` with no reason given).
 */
function extractSkipReason(test: PwTest): string | undefined {
  // Picks the first skip/fixme annotation that actually HAS a description, not simply the first
  // one: a declaration-form `test.fixme(title, ...)` gets a description-less `fixme` annotation
  // from Playwright itself, which would otherwise shadow the described annotation the generator
  // attaches alongside it (see generate.ts's escapeHatchDetails) and leave every escape-hatch
  // skip reporting no reason at all.
  for (const annotation of test.annotations ?? []) {
    if (annotation.type !== 'skip' && annotation.type !== 'fixme') continue;
    const description = annotation.description?.trim();
    if (description) return description;
  }
  return undefined;
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
  const paths = (attachments ?? [])
    .map((a) => a.path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .filter((p) => !isBlankVideo(p));
  // Two attachments can point at the exact same file (e.g. the default
  // context's own "video" attachment and a manual-context video attachment
  // for that same context) — dedupe so the same recording is never listed
  // twice.
  return [...new Set(paths)];
}

/** The raw video attachment (before blank-filtering), if Playwright reported one at all. */
function findVideoAttachment(attachments: PwAttachment[] | undefined): PwAttachment | undefined {
  return (attachments ?? []).find((a) => typeof a.path === 'string' && VIDEO_EXT.test(a.path));
}

/**
 * Why no usable video is present for a result, when one isn't — three
 * distinct, identifiable causes rather than a silent gap:
 *  1. tierC-api tests never open a browser page (request-fixture only), so a
 *     video is structurally impossible regardless of the `video: 'on'` config
 *     — expected, not a defect.
 *  2. A video attachment exists but is blank (see isBlankVideo) — the test
 *     finished before anything rendered; the file is real but useless.
 *  3. No video attachment at all for a browser-based (tierA/tierB) test —
 *     genuinely anomalous; worth surfacing as a possible artifact-retention
 *     gap rather than looking identical to case 1 or 2.
 * Returns undefined when a real, non-blank video is present (nothing to explain).
 */
function computeVideoUnavailableReason(
  attachments: PwAttachment[] | undefined,
  projectName: string | undefined,
): string | undefined {
  const video = findVideoAttachment(attachments);
  if (video?.path) {
    if (!isBlankVideo(video.path)) return undefined;
    return 'No video recorded — the test finished too quickly for anything to be captured.';
  }
  if (projectIsTierC(projectName)) {
    return 'Video not applicable — this is an API test and did not involve a browser session.';
  }
  return UNEXPLAINED_MISSING_VIDEO_REASON;
}

interface ParsedReport {
  results: ExecResultItem[];
  passed: number;
  failed: number;
  blocked: number;
  flaky: number;
  skipped: number;
  /** Operational warnings surfaced by the caller (e.g. an anomalous missing-video case). */
  videoWarnings: string[];
}

// ---- Write-through per-test checkpoint (see templates.ts's checkpointReporterContents()) ----

/**
 * One test's identity + FINAL outcome, restored from the write-through
 * checkpoint for a test that finished in an EARLIER, interrupted execute()
 * attempt and was therefore skipped THIS run via `--test-list-invert`. The
 * reporter only ever appends once a test's fate is truly final (see its own
 * doc comment), so `status` here is always Playwright's own settled
 * `test.outcome()` value ('expected' | 'unexpected' | 'flaky' | 'skipped'),
 * never a mid-retry snapshot.
 */
export interface CheckpointEntry {
  key: string;
  title: string;
  project?: string;
  specFile?: string;
  status: string;
  durationMs?: number;
  error?: string;
  /** Why a 'skipped' entry was skipped (see ExecResultItem.skipReason's own doc comment). */
  skipReason?: string;
}

function checkpointFilePath(projectDir: string): string {
  return join(projectDir, EXEC_CHECKPOINT_FILENAME);
}
function invertFilePath(projectDir: string): string {
  return join(projectDir, EXEC_CHECKPOINT_INVERT_FILENAME);
}

/**
 * Best-effort read of the mock fixture's write-through request log (see
 * MOCK_REQUEST_LOG_FILENAME's doc comment in templates.ts) — tallies hits by
 * dependency id. A missing file (mocking disabled, or nothing was ever
 * intercepted) just means "no browser-level mock hits" (`{}`), same
 * "best-effort, never fail the run" contract as readCheckpointEntries above.
 * See F-15: this is what lets the report's mockedRequestCounts reflect
 * fixture-level (page.route()/`request` override) mocking, which the
 * pre-existing counter — built only from the separate launch-time mock HTTP
 * server — had no visibility into at all.
 */
export async function readMockRequestCounts(projectDir: string): Promise<Record<string, number>> {
  let raw: string;
  try {
    raw = await readFile(join(projectDir, MOCK_REQUEST_LOG_FILENAME), 'utf-8');
  } catch {
    return {};
  }
  const counts: Record<string, number> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as { id?: unknown };
      const id = typeof entry.id === 'string' && entry.id ? entry.id : 'override';
      counts[id] = (counts[id] ?? 0) + 1;
    } catch {
      // one malformed line (e.g. a write truncated by a crash) must not lose every other entry
    }
  }
  return counts;
}

interface ApiEvidenceLogEntry {
  key: string;
  method: string;
  url: string;
  status: number;
  mocked: boolean;
  body: string;
}

/** How many of a test's own logged API calls get folded into its evidence string — the LAST few (most likely the one whose response a failing assertion was checking), bounded so a chatty test doesn't blow up the triage prompt. */
const API_EVIDENCE_MAX_CALLS_PER_TEST = 3;

/**
 * Best-effort read of the request-fixture's write-through call log (see
 * API_EVIDENCE_LOG_FILENAME's doc comment in templates.ts) — groups entries by
 * key (`${specFile}#${title}`, same identity as this file's own checkpoint
 * keyOf()) and formats the LAST few calls per key into a compact, prompt-ready
 * evidence string: which backend actually answered (Healix's own mock, or the
 * real one), the status, and a truncated body. This is what lets triage see
 * the ACTUAL response a failing API-tier assertion was checking against,
 * instead of just the one field Playwright's own error text happened to
 * print. A missing file (no tierC-api tests ran this invocation, or nothing
 * called through `request` at all) just means "no evidence" (`{}`), same
 * best-effort contract as readMockRequestCounts.
 */
export async function readApiEvidence(projectDir: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(join(projectDir, API_EVIDENCE_LOG_FILENAME), 'utf-8');
  } catch {
    return {};
  }
  const byKey = new Map<string, ApiEvidenceLogEntry[]>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as Partial<ApiEvidenceLogEntry>;
      if (typeof entry.key !== 'string' || !entry.key) continue;
      const list = byKey.get(entry.key) ?? [];
      list.push({
        key: entry.key,
        method: typeof entry.method === 'string' && entry.method ? entry.method : 'GET',
        url: typeof entry.url === 'string' ? entry.url : '',
        status: typeof entry.status === 'number' ? entry.status : 0,
        mocked: entry.mocked === true,
        body: typeof entry.body === 'string' ? entry.body : '',
      });
      byKey.set(entry.key, list);
    } catch {
      // one malformed line (e.g. a write truncated by a crash) must not lose every other entry
    }
  }
  const out: Record<string, string> = {};
  for (const [key, entries] of byKey) {
    out[key] = entries
      .slice(-API_EVIDENCE_MAX_CALLS_PER_TEST)
      .map(
        (e) =>
          `[${e.mocked ? 'HEALIX MOCK' : 'REAL BACKEND'}] ${e.method} ${e.url} -> status ${e.status}\nBody: ${e.body || '(empty)'}`,
      )
      .join('\n\n');
  }
  return out;
}

interface MockPassthroughLogEntry {
  key: string;
  method: string;
  url: string;
  at: string;
}

/** How many of a test's own unintercepted passthrough calls get folded into its evidence
 * string — same bound/rationale as API_EVIDENCE_MAX_CALLS_PER_TEST. */
const MOCK_PASSTHROUGH_MAX_CALLS_PER_TEST = 3;

/**
 * Best-effort read of the mock fixture's write-through passthrough log (see
 * MOCK_PASSTHROUGH_LOG_FILENAME's doc comment in templates.ts) — groups entries by key
 * (`${specFile}#${title}`, same identity as readApiEvidence/this file's own checkpoint
 * keyOf()) and formats the LAST few unintercepted calls per key into a compact,
 * prompt-ready string. This is the concrete evidence that lets triage tell "this test's own
 * request fell through the mock fixture and hit the real, unreachable backend" apart from "the
 * app is just slow" for an otherwise-unexplained bare timeout. A missing file (no fixture-level
 * mocking enabled, or nothing ever fell through) just means "no evidence" (`{}`), same
 * best-effort contract as readApiEvidence/readMockRequestCounts.
 */
export async function readMockPassthroughLog(projectDir: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(join(projectDir, MOCK_PASSTHROUGH_LOG_FILENAME), 'utf-8');
  } catch {
    return {};
  }
  const byKey = new Map<string, MockPassthroughLogEntry[]>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as Partial<MockPassthroughLogEntry>;
      if (typeof entry.key !== 'string' || !entry.key) continue;
      const list = byKey.get(entry.key) ?? [];
      list.push({
        key: entry.key,
        method: typeof entry.method === 'string' && entry.method ? entry.method : 'GET',
        url: typeof entry.url === 'string' ? entry.url : '',
        at: typeof entry.at === 'string' ? entry.at : '',
      });
      byKey.set(entry.key, list);
    } catch {
      // one malformed line (e.g. a write truncated by a crash) must not lose every other entry
    }
  }
  const out: Record<string, string> = {};
  for (const [key, entries] of byKey) {
    out[key] = entries
      .slice(-MOCK_PASSTHROUGH_MAX_CALLS_PER_TEST)
      .map((e) => `${e.method} ${e.url} — fell through the mock fixture unintercepted (${e.at})`)
      .join('\n');
  }
  return out;
}

/** Best-effort read of the write-through checkpoint; a missing/corrupt file just means "nothing finished yet". */
export async function readCheckpointEntries(projectDir: string): Promise<CheckpointEntry[]> {
  let raw: string;
  try {
    raw = await readFile(checkpointFilePath(projectDir), 'utf-8');
  } catch {
    return [];
  }
  const byKey = new Map<string, CheckpointEntry>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as CheckpointEntry;
      // A test only ever gets ONE final-attempt line (see the reporter's
      // isFinal gate), so collisions aren't expected — Map still protects
      // against a theoretical duplicate by keeping the last line for a key.
      if (entry && typeof entry.key === 'string') byKey.set(entry.key, entry);
    } catch {
      // One malformed line (e.g. a write truncated by the same crash this
      // file exists to survive) must not lose every other entry in it.
    }
  }
  return [...byKey.values()];
}

/**
 * Writes the file `--test-list-invert` reads to skip already-finished tests.
 * Returns null (no flag needed) when there is nothing to skip, so the caller
 * can omit `--test-list-invert` entirely on a fresh, non-resumed attempt.
 */
export async function writeInvertFile(
  projectDir: string,
  entries: CheckpointEntry[],
): Promise<string | null> {
  if (entries.length === 0) return null;
  const target = invertFilePath(projectDir);
  await writeFile(target, entries.map((e) => e.key).join('\n'), 'utf-8');
  return target;
}

/** Best-effort cleanup once execute() completes without being interrupted — nothing left to resume. */
export async function clearExecCheckpoint(projectDir: string): Promise<void> {
  await Promise.all([
    unlink(checkpointFilePath(projectDir)).catch(() => {}),
    unlink(invertFilePath(projectDir)).catch(() => {}),
    // See F-15: cleared here too (not at the start of execute()) for the SAME
    // reason as the two files above — an interrupted attempt's mock hits must
    // survive into the resumed attempt's count (readMockRequestCounts is read
    // BEFORE this runs), but a genuinely later, unrelated execute() call
    // reusing this projectDir (next coverage-loop gap-fill iteration) must
    // start counting fresh rather than inheriting this phase's hits.
    unlink(join(projectDir, MOCK_REQUEST_LOG_FILENAME)).catch(() => {}),
    // Same rationale as MOCK_REQUEST_LOG_FILENAME above: cleared here (after
    // readApiEvidence has already run for THIS invocation) so a later,
    // unrelated execute() call reusing this projectDir starts fresh.
    unlink(join(projectDir, API_EVIDENCE_LOG_FILENAME)).catch(() => {}),
    // Same rationale again: cleared here (after readMockPassthroughLog has already run for
    // THIS invocation) so a later, unrelated execute() call reusing this projectDir starts fresh.
    unlink(join(projectDir, MOCK_PASSTHROUGH_LOG_FILENAME)).catch(() => {}),
  ]);
}

/** Same auth-setup detection as findAuthSetupOutcome above, over checkpoint-restored entries instead of a fresh report's suite tree. */
export function findAuthSetupOutcomeFromEntries(entries: CheckpointEntry[]): {
  failed: boolean;
  error: string;
} {
  for (const entry of entries) {
    if (!isAuthSetup(entry.project, entry.specFile)) continue;
    if (normalizeStatus(entry.status) === 'failed') return { failed: true, error: entry.error ?? '' };
  }
  return { failed: false, error: '' };
}

/**
 * Converts checkpoint-restored entries into the same shape parseReport()
 * produces from a fresh report, so the two can be merged (see
 * mergeParsedReports below). Applies the SAME Tier B blocked-reclassification
 * parseReport does (see its own doc comment) — a checkpointed Tier B failure
 * is just as much a victim of a failed/credential-less auth setup as a
 * freshly-observed one.
 */
export function checkpointEntriesToOutcome(entries: CheckpointEntry[], auth: AuthSignals): ParsedReport {
  const results: ExecResultItem[] = [];
  let passed = 0;
  let failed = 0;
  let blocked = 0;
  let flaky = 0;
  let skipped = 0;

  for (const entry of entries) {
    let status = normalizeStatus(entry.status);
    // Suppress only a passing setup phantom — a failing one stays visible as
    // the root cause (mirrors parseReport's isSetupSpec handling).
    const isSetupEntry = isAuthSetup(entry.project, entry.specFile);
    if (isSetupEntry && status !== 'failed') continue;

    // Same marker parseReport stamps, so a resumed run classifies this row identically to a
    // fresh one rather than falling back to the generic timeout rule.
    let errText = isSetupEntry ? withAuthSetupMarker(entry.error ?? '') : (entry.error ?? '');
    if (projectIsTierB(entry.project)) {
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

    results.push({
      title: entry.title,
      status,
      durationMs: entry.durationMs,
      error: errText || undefined,
      specFile: entry.specFile,
      skipReason: status === 'skipped' ? entry.skipReason : undefined,
    });
    switch (status) {
      case 'passed':
        passed += 1;
        break;
      case 'flaky':
        flaky += 1;
        passed += 1;
        break;
      case 'blocked':
        blocked += 1;
        break;
      case 'failed':
        failed += 1;
        break;
      case 'skipped':
        skipped += 1;
        break;
      default:
        break;
    }
  }

  return { results, passed, failed, blocked, flaky, skipped, videoWarnings: [] };
}

/**
 * Merges a freshly-parsed report with checkpoint-restored entries from an
 * earlier, interrupted attempt. Dedupes by the same specFile+title identity
 * mergeExecOutcomes uses in the orchestrator, keeping `b`'s result on a
 * collision — shouldn't normally happen (the invert-list excludes exactly
 * what's already checkpointed), but a fresh result is preferred over a
 * checkpointed one if it somehow does.
 */
export function mergeParsedReports(a: ParsedReport, b: ParsedReport): ParsedReport {
  const keyOf = (r: ExecResultItem): string => (r.specFile ? `${r.specFile}#${r.title}` : r.title);
  const byKey = new Map<string, ExecResultItem>();
  for (const r of a.results) byKey.set(keyOf(r), r);
  for (const r of b.results) byKey.set(keyOf(r), r);
  const results = [...byKey.values()];
  return {
    results,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    blocked: results.filter((r) => r.status === 'blocked').length,
    flaky: results.filter((r) => r.status === 'flaky').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    videoWarnings: [...a.videoWarnings, ...b.videoWarnings],
  };
}

export function parseReport(report: PwReport, auth: AuthSignals = NO_AUTH_SIGNALS): ParsedReport {
  const results: ExecResultItem[] = [];
  let passed = 0;
  let failed = 0;
  let blocked = 0;
  let flaky = 0;
  let skipped = 0;
  const videoWarnings: string[] = [];

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
    let worstSkipReason: string | undefined;
    let totalDuration = 0;
    let artifacts: string[] = [];
    let videoUnavailableReason: string | undefined;
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
        worstSkipReason = status === 'skipped' ? extractSkipReason(test) : undefined;
        const a = collectArtifactPaths(last?.attachments);
        if (a.length > 0) artifacts = a;
        videoUnavailableReason =
          status === 'skipped'
            ? undefined
            : computeVideoUnavailableReason(last?.attachments, test.projectName);
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
      error: isSetupSpec ? withAuthSetupMarker(worstError) : worstError || undefined,
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      specFile: spec.file ?? suiteFile,
      skipReason: worstSkipReason,
      videoUnavailableReason,
    };
    results.push(item);

    // Only the genuinely-anomalous case (browser-based test, no video
    // attachment at all — not the expected tierC-api/blank-recording cases)
    // is worth an operational warning; distinguish it by message content
    // rather than re-deriving the classification here.
    if (videoUnavailableReason === UNEXPLAINED_MISSING_VIDEO_REASON) {
      videoWarnings.push(`No video captured for "${title}" and the cause is unclear — worth a closer look.`);
    }

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
      case 'skipped':
        skipped += 1;
        break;
      default:
        // pending does not move any headline counter
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
  return { results, passed, failed, blocked, flaky, skipped, videoWarnings };
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

interface RawStep {
  title?: string;
  durationMs?: number;
  error?: string;
  steps?: RawStep[];
}

interface RawStepsEntry {
  title?: string;
  retry?: number;
  steps?: RawStep[];
}

/** Recursively validates + normalizes a raw step (and its nested test.step children, if any). */
function toExecStepItem(s: RawStep): ExecStepItem | null {
  if (typeof s.title !== 'string') return null;
  const children = Array.isArray(s.steps)
    ? s.steps.map(toExecStepItem).filter((c): c is ExecStepItem => c !== null)
    : undefined;
  return {
    title: s.title,
    durationMs: Math.round(s.durationMs ?? 0),
    error: s.error,
    steps: children && children.length > 0 ? children : undefined,
  };
}

/**
 * steps.json is written by the custom reporter (see templates.ts's
 * stepsReporterContents()) — a supplementary file alongside results.json,
 * since Playwright's own json reporter drops step-level detail entirely.
 * Keyed by title (same key parseReport groups results by); a retried test's
 * LAST attempt's steps win, since that's the outcome that's actually reported.
 */
async function readStepsByTitle(projectDir: string, startedAt: number): Promise<Map<string, ExecStepItem[]>> {
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
        entry.steps.map(toExecStepItem).filter((s): s is ExecStepItem => s !== null),
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
  const skipped = num(/(\d+)\s+skipped/i);
  return { results: [], passed, failed, blocked: 0, flaky, skipped, videoWarnings: [] };
}

/** Outcome returned when the caller cancelled the run — never a throw. */
function abortedOutcome(exitCode: number | null = null): ExecOutcome {
  return {
    passed: 0,
    failed: 0,
    blocked: 0,
    flaky: 0,
    skipped: 0,
    results: [],
    raw: { aborted: true, exitCode },
  };
}

/**
 * Run the scaffolded suite and parse results into an ExecOutcome. Tier B login
 * failures become `blocked`. Never throws on test failure — only the outcome
 * object is returned; infrastructure errors are surfaced via raw + a warning.
 * Cancellation (ctx.signal) also never throws: the run is killed and an
 * aborted outcome (raw.aborted) is returned so callers can distinguish
 * "cancelled" from "ran and everything failed".
 */
export async function execute(ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ExecOutcome> {
  emit(ctx, `Executing ${specs.length} spec(s) via Playwright`, { count: specs.length });

  if (specs.length === 0) {
    emit(ctx, 'No specs to execute; returning empty outcome');
    return { passed: 0, failed: 0, blocked: 0, flaky: 0, skipped: 0, results: [] };
  }

  // Already cancelled? Return before ANY subprocess (npm install / npx) spawns.
  if (ctx.signal?.aborted) {
    emit(ctx, 'Execution aborted before start; returning aborted outcome', { aborted: true });
    return abortedOutcome();
  }

  await ensureSuiteDeps(ctx);

  // Tests that already finished in an EARLIER, interrupted attempt at this
  // same execute() call — see templates.ts's checkpointReporterContents().
  // Skipped via --test-list-invert so a resume only redoes what's actually
  // left, regardless of which tier(s) they belonged to: all in-scope tiers
  // now run together in one Playwright invocation rather than one process
  // per tier, so a crash mid-run no longer has to lose an entire tier's
  // worth of progress just to get a safe resume point.
  const priorEntries = await readCheckpointEntries(ctx.projectDir);
  const invertFile = await writeInvertFile(ctx.projectDir, priorEntries);
  if (priorEntries.length > 0) {
    emit(ctx, `Resuming: ${priorEntries.length} test(s) already finished; skipping them this run.`, {
      alreadyFinished: priorEntries.length,
    });
  }

  emit(ctx, '[execute] running Playwright suite…');
  let startedAt = Date.now();
  let cmd = await runPlaywright(ctx, invertFile);

  // Cancelled during (or right before) the run: the write-through checkpoint
  // already has everything that finished before the abort — left in place
  // (not cleared) so the NEXT execute() call resumes from it instead of
  // redoing this work. This return value only represents THIS interrupted
  // call, so it stays zeroed exactly as before; the durable state lives on
  // disk, not in what gets returned here.
  if (cmd.aborted || ctx.signal?.aborted) {
    emit(ctx, 'Execution aborted; discarding partial results', { exitCode: cmd.code, aborted: true });
    return abortedOutcome(cmd.code);
  }

  // Self-heal missing dependencies and retry ONCE, rather than surfacing a raw
  // "module not found" / "browser not found" crash as if it were a real test
  // failure. Two independent kinds, each gets its own install command:
  //  - a Playwright browser binary (shared global cache, outside node_modules)
  //  - any OTHER npm package the scaffolded suite depends on (node_modules) —
  //    covers a prior ensureSuiteDeps() install that exited non-zero but was
  //    allowed to continue (see its own comment), or a corrupted node_modules.
  if (cmd.code !== 0 && (looksLikeMissingBrowser(cmd) || looksLikeMissingSuiteDeps(cmd))) {
    if (looksLikeMissingBrowser(cmd)) {
      // No browser name is passed: newer Playwright versions can fail on a
      // binary (e.g. the separately-downloaded chrome-headless-shell) that a
      // targeted `install chromium` does not cover, so this runs the same
      // bare `playwright install` the tool's own error message recommends,
      // which installs whatever the project's config actually needs.
      emit(ctx, '[execute] missing browser binary; running npx playwright install…');
      const browserInstall = await runCommand(ctx, 'npx', ['playwright', 'install'], INSTALL_TIMEOUT_MS);
      emit(ctx, '[execute] browser install complete', { code: browserInstall.code });
    }
    // Tracks whether a suite-deps reinstall was attempted and genuinely failed —
    // previously this exit code was captured but never checked, so a broken/no-op
    // `npm install` was reported as "complete" and Playwright was unconditionally
    // re-invoked against still-broken dependencies, eventually surfacing as a
    // silent "0 passed, 0 failed" instead of a real error (see
    // docs/design/execute-suite-deps-silent-failure-fix.md).
    let depsInstallFailed = false;
    if (looksLikeMissingSuiteDeps(cmd)) {
      emit(ctx, '[execute] missing suite dependency; re-running npm install…');
      const depsInstall = await runCommand(
        ctx,
        'npm',
        ['install', '--no-audit', '--no-fund', '--silent'],
        INSTALL_TIMEOUT_MS,
      );
      if (depsInstall.code === 0) {
        emit(ctx, '[execute] npm install complete');
      } else {
        depsInstallFailed = true;
        const tail = stripAnsi(depsInstall.stderr || depsInstall.stdout)
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-8)
          .join(' | ');
        emit(
          ctx,
          '[execute] npm install failed; suite dependencies remain broken — not re-running against them',
          {
            code: depsInstall.code,
            tail,
          },
        );
      }
    }
    // Only retry Playwright when we have real reason to believe it can now
    // succeed — re-running against dependencies we KNOW are still broken can
    // only fail the same way, and previously masked that failure as a clean
    // empty result instead of a visible error.
    if (!depsInstallFailed) {
      emit(ctx, '[execute] re-running suite after dependency install');
      startedAt = Date.now();
      cmd = await runPlaywright(ctx, invertFile);

      // The retry run can be cancelled too (as can the install(s) before it).
      if (cmd.aborted || ctx.signal?.aborted) {
        emit(ctx, 'Execution aborted; discarding partial results', { exitCode: cmd.code, aborted: true });
        return abortedOutcome(cmd.code);
      }
    }
  }
  emit(ctx, '[execute] Playwright run finished', { exitCode: cmd.code, timedOut: cmd.timedOut });

  let report = await readResultsJson(ctx.projectDir, startedAt);
  if (!report) report = parseStdoutJson(cmd.stdout);

  // Auth-setup may have run THIS invocation (fresh report has it) or in an
  // earlier interrupted attempt (checkpoint entries have it instead) — check
  // both; exactly one will ever have a real signal, since a checkpointed
  // auth-setup is excluded from this run's --test-list-invert-filtered set.
  const freshSetup = report ? findAuthSetupOutcome(report) : { failed: false, error: '' };
  const checkpointSetup = findAuthSetupOutcomeFromEntries(priorEntries);
  const performedLogin = await readSetupMeta(ctx.projectDir);
  const auth: AuthSignals = {
    setupFailed: freshSetup.failed || checkpointSetup.failed,
    setupError: freshSetup.error || checkpointSetup.error,
    performedLogin,
  };
  if (auth.setupFailed) {
    emit(ctx, '[execute] auth setup failed; Tier B outcomes classified as blocked', {
      setupError: auth.setupError.split('\n')[0] ?? '',
    });
  } else if (performedLogin === false) {
    emit(ctx, '[execute] auth setup ran without credentials; Tier B failures classified as blocked');
  }

  let parsed: ParsedReport;
  if (report && !reportIsStructurallyEmpty(report)) {
    parsed = parseReport(report, auth);
  } else {
    parsed = parseSummaryText(`${cmd.stdout}\n${cmd.stderr}`);
    if (
      parsed.results.length === 0 &&
      parsed.passed === 0 &&
      parsed.failed === 0 &&
      priorEntries.length === 0
    ) {
      const tail = stripAnsi(cmd.stderr || cmd.stdout)
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-8)
        .join(' | ');
      emit(ctx, 'Could not parse Playwright results; suite may have failed to start', {
        exitCode: cmd.code,
        timedOut: cmd.timedOut,
        // Distinguishes "Playwright produced a valid report with literally nothing in it"
        // (e.g. broken deps let it start but discover zero specs) from "no report at all"
        // (e.g. it crashed before writing anything) — same underlying diagnostic either way.
        structurallyEmptyReport: !!report,
        tail,
      });
    }
  }

  // Fold in whatever finished during an earlier, interrupted attempt (and was
  // therefore skipped this run) so the returned outcome covers the WHOLE
  // execute phase, not just what this particular invocation ran.
  if (priorEntries.length > 0) {
    parsed = mergeParsedReports(parsed, checkpointEntriesToOutcome(priorEntries, auth));
  }

  // Surface the genuinely-anomalous missing-video case operationally (not
  // just in the report) — a browser-based test with no video attachment at
  // all may indicate a real artifact-retention gap worth investigating.
  // (A manually-created browser context, previously the dominant cause of
  // this, no longer reaches here — templates.ts's page fixture now patches
  // browser.newContext() to record and attach video automatically.)
  for (const warning of parsed.videoWarnings) {
    emit(ctx, `[execute] ${warning}`);
  }

  // Best-effort: attach the step-by-step breakdown (see stepsReporterContents()
  // in templates.ts) to each result by title — steps.json is written
  // regardless of whether results.json parsed, so this runs unconditionally.
  // Only ever has data for tests that actually ran THIS invocation; a
  // checkpoint-restored result simply keeps no step detail, same as any
  // result whose title didn't match an entry in steps.json today.
  const stepsByTitle = await readStepsByTitle(ctx.projectDir, startedAt);
  if (stepsByTitle.size > 0) {
    for (const r of parsed.results) {
      const steps = stepsByTitle.get(r.title);
      if (steps) r.steps = steps;
    }
  }

  // See F-15: tallies the mock fixture's OWN write-through log, independent
  // of results.json/steps.json — present regardless of whether the report
  // parsed, since the fixture logs a hit the moment it fulfills a request.
  const mockedRequestCounts = await readMockRequestCounts(ctx.projectDir);
  // Same rationale as mockedRequestCounts above: present regardless of
  // whether results.json parsed, since the request fixture logs a call the
  // moment it resolves.
  const apiEvidence = await readApiEvidence(ctx.projectDir);
  // Same rationale again: present regardless of whether results.json parsed, since the
  // page.route() handler logs a passthrough the moment it decides not to intercept.
  const mockPassthrough = await readMockPassthroughLog(ctx.projectDir);

  const outcome: ExecOutcome = {
    passed: parsed.passed,
    failed: parsed.failed,
    blocked: parsed.blocked,
    flaky: parsed.flaky,
    skipped: parsed.skipped,
    results: parsed.results,
    ...(Object.keys(mockedRequestCounts).length > 0 ? { mockedRequestCounts } : {}),
    ...(Object.keys(apiEvidence).length > 0 ? { apiEvidence } : {}),
    ...(Object.keys(mockPassthrough).length > 0 ? { mockPassthrough } : {}),
    raw: {
      exitCode: cmd.code,
      signal: cmd.signal,
      timedOut: cmd.timedOut,
      hadJsonReport: report !== null,
      stderrTail: stripAnsi(cmd.stderr).split(/\r?\n/).filter(Boolean).slice(-20),
    },
  };

  // Completed without interruption — nothing left to resume. Cleared so a
  // LATER, unrelated execute() call reusing this same projectDir (e.g. the
  // coverage-feedback loop's next gap-fill iteration) never inherits stale
  // "already finished" entries from this one.
  await clearExecCheckpoint(ctx.projectDir);

  emit(ctx, 'Execution complete', {
    passed: outcome.passed,
    failed: outcome.failed,
    blocked: outcome.blocked,
    flaky: outcome.flaky,
    skipped: outcome.skipped,
  });
  return outcome;
}
