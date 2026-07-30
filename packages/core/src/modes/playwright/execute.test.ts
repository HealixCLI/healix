/**
 * Unit tests for the execute-phase security/cancellation surface:
 *   - suiteEnv: generated specs are untrusted model output, so the suite
 *     subprocess env must be an ALLOWLIST — host secrets (API keys, tokens)
 *     must never reach `npx playwright test`, while PATH/HEALIX_* survive.
 *   - execute() with a pre-aborted signal: returns an aborted outcome without
 *     spawning any subprocess (spawn is spied via a module mock) and without
 *     throwing.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Spy on spawn so the pre-abort test can prove NOTHING was executed. The
// actual implementation is preserved for any test that legitimately spawns.
// execute.ts spawns via cross-spawn (not node:child_process directly) so
// Windows .cmd shims resolve without a shell:true + args DEP0190 warning.
vi.mock('cross-spawn', async (importOriginal) => {
  // cross-spawn's .d.ts uses `export =`, so the static type has no `.default`
  // even though the real module — accessed here via Vite/Node ESM interop —
  // does; cast narrowly to the shape actually needed instead of `as any`.
  const actual = (await importOriginal()) as { default: (...args: never[]) => unknown };
  return { ...actual, default: vi.fn(actual.default) };
});

// execute.ts's killTree helpers spawn `taskkill` via node:child_process's own
// spawn (not cross-spawn) on Windows — see runPlaywright's/runCommand's kill
// logic. Spied the same way as cross-spawn above, so tests that fake a killed
// child process don't invoke a REAL taskkill against a made-up pid.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

import spawn from 'cross-spawn';
import { spawn as nodeSpawn } from 'node:child_process';
import type { GeneratedSpec, TestModeContext } from '../types.js';
import {
  execute,
  runCommand,
  suiteEnv,
  parseReport,
  findAuthSetupOutcome,
  findAuthSetupOutcomeFromEntries,
  checkpointEntriesToOutcome,
  mergeParsedReports,
  readCheckpointEntries,
  writeInvertFile,
  clearExecCheckpoint,
  playwrightProjectArgs,
  readMockRequestCounts,
  readApiEvidence,
  type AuthSignals,
} from './execute.js';
import {
  API_EVIDENCE_LOG_FILENAME,
  EXEC_CHECKPOINT_FILENAME,
  EXEC_CHECKPOINT_INVERT_FILENAME,
  MOCK_REQUEST_LOG_FILENAME,
} from './templates.js';

function makeCtx(overrides: Partial<TestModeContext> = {}): TestModeContext {
  return {
    // Nonexistent on purpose: the pre-abort path must return before it is used.
    projectDir: '/nonexistent/healix-suite-under-test',
    provider: {} as TestModeContext['provider'],
    target: {} as TestModeContext['target'],
    browser: {} as TestModeContext['browser'],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('suiteEnv — allowlisted environment for untrusted specs', () => {
  it('drops secret-looking host vars but keeps PATH and HEALIX_*', () => {
    vi.stubEnv('SECRET_TOKEN', 'super-secret');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'aws-cred');
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@host/db');
    vi.stubEnv('HEALIX_CUSTOM_FLAG', 'yes');

    const env = suiteEnv(makeCtx());

    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    // node/npm/npx are unrunnable without PATH — it must always pass through.
    expect(env.PATH ?? env.Path).toBeDefined();
    expect(env.HEALIX_CUSTOM_FLAG).toBe('yes');
  });

  it('injects HEALIX_BASE_URL from ctx.baseUrl (config source for the scaffolded suite)', () => {
    const env = suiteEnv(makeCtx({ baseUrl: 'http://localhost:4321' }));
    expect(env.HEALIX_BASE_URL).toBe('http://localhost:4321');
  });

  it('passes through only allowlisted names or HEALIX_* — nothing else leaks', () => {
    vi.stubEnv('SOME_RANDOM_COMPANY_TOKEN', 'leak-me-if-you-can');

    const env = suiteEnv(makeCtx({ baseUrl: 'http://localhost:3000' }));

    // Mirror of the allowlist contract in execute.ts; a new passthrough must
    // be added HERE too, which forces a deliberate decision about it.
    const allowed = new Set(
      [
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
        'npm_config_cache',
        'PLAYWRIGHT_BROWSERS_PATH',
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'NO_PROXY',
        'SystemRoot',
        'ComSpec',
        'PATHEXT',
        'APPDATA',
        'LOCALAPPDATA',
        'ProgramFiles',
      ].map((k) => k.toLowerCase()),
    );
    for (const key of Object.keys(env)) {
      const ok = allowed.has(key.toLowerCase()) || key.startsWith('HEALIX_');
      expect(ok, `unexpected env passthrough: ${key}`).toBe(true);
    }
    expect(env.SOME_RANDOM_COMPANY_TOKEN).toBeUndefined();
  });

  it('matches allowlisted names case-insensitively (Windows env semantics)', () => {
    vi.stubEnv('Path', 'C:\\Windows;C:\\node');
    const env = suiteEnv(makeCtx());
    // Original casing is preserved; the match itself is case-insensitive.
    expect(env.Path ?? env.PATH).toBeDefined();
  });

  it('injects HEALIX_TIERB_EMAIL/PASSWORD and a /login default from baseUrl when a credential is set', () => {
    const env = suiteEnv(
      makeCtx({
        baseUrl: 'http://localhost:3000',
        credentials: [
          {
            id: 'c1',
            username: 'user@test.com',
            password: 'hunter2',
            role: null,
            authType: 'form',
            token: null,
            urlTemplate: null,
            extraParams: null,
            authCheckText: null,
          },
        ],
      }),
    );
    expect(env.HEALIX_TIERB_EMAIL).toBe('user@test.com');
    expect(env.HEALIX_TIERB_PASSWORD).toBe('hunter2');
    expect(env.HEALIX_TIERB_LOGIN_URL).toBe('http://localhost:3000/login');
    expect(JSON.parse(env.HEALIX_TIERB_CREDENTIALS_JSON ?? '[]')).toEqual([
      {
        username: 'user@test.com',
        password: 'hunter2',
        role: null,
        authType: 'form',
        token: null,
        urlTemplate: null,
        extraParams: null,
        authCheckText: null,
      },
    ]);
  });

  it('prefers a discovered login candidate from EXPLORE over the naive /login default', () => {
    const env = suiteEnv(
      makeCtx({
        baseUrl: 'http://localhost:3000',
        credentials: [
          {
            id: 'c1',
            username: 'user@test.com',
            password: 'hunter2',
            role: null,
            authType: 'form',
            token: null,
            urlTemplate: null,
            extraParams: null,
            authCheckText: null,
          },
        ],
        exploration: {
          crawl: {
            routes: [],
            visitedCount: 0,
            budgetExhausted: false,
            redirectLoopsDetected: [],
            shellCollapsed: false,
            degenerateRedirectsSkipped: [],
            authAttempted: false,
            authVerified: false,
          },
          routing: { hashRouted: true, invariantPrefix: '#/SK' },
          loginCandidates: [
            { url: 'http://localhost:3000/#/SK/login', score: 5, source: 'crawled' },
            { url: 'http://localhost:3000/login', score: 1, source: 'common-path' },
          ],
          useful: true,
          observedEndpoints: [],
        },
      }),
    );
    expect(env.HEALIX_TIERB_LOGIN_URL).toBe('http://localhost:3000/#/SK/login');
  });

  it('falls back to the naive /login default when EXPLORE found no login candidates', () => {
    const env = suiteEnv(
      makeCtx({
        baseUrl: 'http://localhost:3000',
        credentials: [
          {
            id: 'c1',
            username: 'user@test.com',
            password: 'hunter2',
            role: null,
            authType: 'form',
            token: null,
            urlTemplate: null,
            extraParams: null,
            authCheckText: null,
          },
        ],
        exploration: {
          crawl: {
            routes: [],
            visitedCount: 0,
            budgetExhausted: false,
            redirectLoopsDetected: [],
            shellCollapsed: false,
            degenerateRedirectsSkipped: [],
            authAttempted: false,
            authVerified: false,
          },
          routing: { hashRouted: false },
          loginCandidates: [],
          useful: false,
          uselessReason: 'exploration crawled zero routes',
          observedEndpoints: [],
        },
      }),
    );
    expect(env.HEALIX_TIERB_LOGIN_URL).toBe('http://localhost:3000/login');
  });

  it('injects no credential vars when the project has zero credentials', () => {
    const env = suiteEnv(makeCtx({ baseUrl: 'http://localhost:3000', credentials: [] }));
    expect(env.HEALIX_TIERB_EMAIL).toBeUndefined();
    expect(env.HEALIX_TIERB_PASSWORD).toBeUndefined();
    expect(env.HEALIX_TIERB_LOGIN_URL).toBeUndefined();
    expect(env.HEALIX_TIERB_CREDENTIALS_JSON).toBeUndefined();
  });

  it('does not inject a login URL when credentials are set but no baseUrl is configured', () => {
    const env = suiteEnv(
      makeCtx({
        credentials: [
          {
            id: 'c1',
            username: 'user',
            password: 'hunter2',
            role: null,
            authType: 'form',
            token: null,
            urlTemplate: null,
            extraParams: null,
            authCheckText: null,
          },
        ],
      }),
    );
    expect(env.HEALIX_TIERB_EMAIL).toBe('user');
    expect(env.HEALIX_TIERB_PASSWORD).toBe('hunter2');
    expect(env.HEALIX_TIERB_LOGIN_URL).toBeUndefined();
  });

  it('prefers the roleless credential as the default EMAIL/PASSWORD when multiple credentials are configured', () => {
    const env = suiteEnv(
      makeCtx({
        baseUrl: 'http://localhost:3000',
        credentials: [
          {
            id: 'c1',
            username: 'admin@test.com',
            password: 'adminpw',
            role: 'admin',
            authType: 'form',
            token: null,
            urlTemplate: null,
            extraParams: null,
            authCheckText: null,
          },
          {
            id: 'c2',
            username: 'user@test.com',
            password: 'userpw',
            role: null,
            authType: 'form',
            token: null,
            urlTemplate: null,
            extraParams: null,
            authCheckText: null,
          },
        ],
      }),
    );
    expect(env.HEALIX_TIERB_EMAIL).toBe('user@test.com');
    expect(env.HEALIX_TIERB_PASSWORD).toBe('userpw');
    const parsed = JSON.parse(env.HEALIX_TIERB_CREDENTIALS_JSON ?? '[]');
    expect(parsed).toHaveLength(2);
  });
});

describe('playwrightProjectArgs — testing-scope --project restriction', () => {
  it('adds no --project flags for "both" (runs every Playwright project)', () => {
    expect(playwrightProjectArgs('both')).toEqual([]);
  });

  it('adds no --project flags when scope is undefined (current default behavior)', () => {
    expect(playwrightProjectArgs(undefined)).toEqual([]);
  });

  it('restricts to tierA-public and tierB-auth for frontend', () => {
    expect(playwrightProjectArgs('frontend')).toEqual([
      '--project',
      'tierA-public',
      '--project',
      'tierB-auth',
    ]);
  });

  it('restricts to tierC-api for backend', () => {
    expect(playwrightProjectArgs('backend')).toEqual(['--project', 'tierC-api']);
  });
});

describe('execute — cooperative cancellation', () => {
  it('returns an aborted outcome without spawning when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const events: Array<{ message: string; data?: unknown }> = [];
    const ctx = makeCtx({
      signal: controller.signal,
      emit: (_phase, message, data) => events.push({ message, data }),
    });
    const spec: GeneratedSpec = {
      path: '/nonexistent/tests/tierA-public/home.spec.ts',
      title: '[REQ:REQ-1] home',
      reqTag: 'REQ-1',
      tier: 'tierA-public',
      contents: '',
    };

    const startedAt = Date.now();
    const outcome = await execute(ctx, [spec]);

    // Short-circuit, not a 30-minute suite run — and never a throw.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(outcome).toMatchObject({ passed: 0, failed: 0, blocked: 0, flaky: 0, results: [] });
    expect((outcome.raw as { aborted?: boolean }).aborted).toBe(true);
    // The load-bearing assertion: no subprocess (npm install OR npx playwright)
    // was ever spawned for an aborted run.
    expect(spawn).not.toHaveBeenCalled();
    // The abort is surfaced as a warning event for the run log.
    expect(events.some((e) => /aborted/i.test(e.message))).toBe(true);
  });

  it('keeps the empty-specs early return ahead of the abort check', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await execute(makeCtx({ signal: controller.signal }), []);
    expect(outcome).toEqual({ passed: 0, failed: 0, blocked: 0, flaky: 0, skipped: 0, results: [] });
    expect(spawn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Structural Tier B classification (HLX-001 regression suite)
// ---------------------------------------------------------------------------

type PwReportArg = Parameters<typeof parseReport>[0];

function report(
  specs: Array<{
    title: string;
    file?: string;
    projectName: string;
    status: string;
    error?: string;
  }>,
): PwReportArg {
  return {
    suites: [
      {
        title: 'suite',
        specs: specs.map((s) => ({
          title: s.title,
          file: s.file ?? `tests/${s.projectName}/${s.title}.spec.ts`,
          tests: [
            {
              status: s.status,
              projectName: s.projectName,
              results: [
                {
                  status: s.status,
                  duration: 5,
                  ...(s.error ? { error: { message: s.error } } : {}),
                },
              ],
            },
          ],
        })),
      },
    ],
  };
}

const LOGGED_IN: AuthSignals = { setupFailed: false, setupError: '', performedLogin: true };

describe('parseReport — structural Tier B classification', () => {
  it('keeps a Tier B failure FAILED when login succeeded, even if the error text mentions auth words (the old text-heuristic leak)', () => {
    // Playwright embeds the failing source snippet in error output; a comment
    // saying "storageState" used to downgrade this genuine failure to blocked.
    const r = report([
      {
        title: 'badge shows count',
        projectName: 'tierB-auth',
        status: 'failed',
        error:
          'expect(locator).toHaveText failed\n' +
          '  4 | // Authenticated via storageState; confirms the session is active\n' +
          "  5 | await expect(badge).toHaveText('3');",
      },
    ]);
    const parsed = parseReport(r, LOGGED_IN);
    expect(parsed.failed).toBe(1);
    expect(parsed.blocked).toBe(0);
    expect(parsed.results[0]?.status).toBe('failed');
  });

  it('marks Tier B skips/failures BLOCKED with the setup error when the auth setup itself failed', () => {
    const auth: AuthSignals = {
      setupFailed: true,
      setupError: 'getByLabel(/email/i) not found on login page',
      performedLogin: false,
    };
    const r = report([
      {
        title: 'authenticate',
        file: 'fixtures/auth.setup.ts',
        projectName: 'auth-setup',
        status: 'failed',
        error: 'getByLabel(/email/i) not found on login page',
      },
      { title: 'dashboard greeting', projectName: 'tierB-auth', status: 'skipped' },
      { title: 'add task', projectName: 'tierB-auth', status: 'failed', error: 'timed out' },
    ]);
    const parsed = parseReport(r, auth);
    const byTitle = Object.fromEntries(parsed.results.map((x) => [x.title, x]));
    expect(byTitle['dashboard greeting']?.status).toBe('blocked');
    expect(byTitle['dashboard greeting']?.error).toContain('Auth setup failed');
    expect(byTitle['add task']?.status).toBe('blocked');
    expect(parsed.blocked).toBe(2);
    // the setup's own row stays an honest failure
    expect(byTitle['authenticate']?.status).toBe('failed');
  });

  it("stamps the auth-setup row's own error with a marker triage can classify structurally", () => {
    // A fixture that times out emits nothing of its own, so the row reaches triage as a bare
    // "Test timeout of 60000ms exceeded." — no auth signal at all, previously classified as a
    // low-confidence generic timeout. Triage sees only title+error, and matching auth-ish words
    // in Playwright's text would resurrect the defect-leakage bug AuthSignals guards against,
    // so the identity has to be stamped here, where isAuthSetup already established it.
    const auth: AuthSignals = {
      setupFailed: true,
      setupError: 'Test timeout of 60000ms exceeded.',
      performedLogin: false,
    };
    const r = report([
      {
        title: 'authenticate',
        file: 'fixtures/auth.setup.ts',
        projectName: 'auth-setup',
        status: 'failed',
        error: 'Test timeout of 60000ms exceeded.',
      },
    ]);
    const parsed = parseReport(r, auth);
    const row = parsed.results.find((x) => x.title === 'authenticate');
    expect(row?.error).toContain('Tier B auth setup failed');
    // The original Playwright text is preserved, not replaced — it's the actual diagnosis.
    expect(row?.error).toContain('Test timeout of 60000ms exceeded.');
  });

  it('stamps the same marker on a checkpoint-restored auth-setup failure', () => {
    const auth: AuthSignals = { setupFailed: true, setupError: 'boom', performedLogin: false };
    const parsed = checkpointEntriesToOutcome(
      [
        {
          key: 'k1',
          title: 'authenticate',
          project: 'auth-setup',
          specFile: 'fixtures/auth.setup.ts',
          status: 'failed',
          error: 'Test timeout of 60000ms exceeded.',
        },
      ],
      auth,
    );
    const row = parsed.results.find((x) => x.title === 'authenticate');
    expect(row?.error).toContain('Tier B auth setup failed');
  });

  it('excludes a PASSING auth-setup spec from results entirely (no phantom test row)', () => {
    // Regression: a passing auth-setup used to appear in `results` as a normal
    // "test" that can never be matched back to a generated spec — inflating
    // the total and, downstream, poisoning top-up/reuse's "which tests passed"
    // accounting with an uncarryable phantom row every Tier B run.
    const auth: AuthSignals = { setupFailed: false, setupError: '', performedLogin: true };
    const r = report([
      { title: 'authenticate', file: 'fixtures/auth.setup.ts', projectName: 'auth-setup', status: 'passed' },
      { title: 'dashboard greeting', projectName: 'tierB-auth', status: 'passed' },
    ]);
    const parsed = parseReport(r, auth);
    expect(parsed.results.map((x) => x.title)).toEqual(['dashboard greeting']);
    expect(parsed.results.some((x) => x.title === 'authenticate')).toBe(false);
    // Only the real test counts toward the headline — the setup phantom does not.
    expect(parsed.passed).toBe(1);
  });

  it('marks Tier B failures BLOCKED when the setup ran without credentials (anonymous session)', () => {
    const auth: AuthSignals = { setupFailed: false, setupError: '', performedLogin: false };
    const r = report([
      {
        title: 'dashboard greeting',
        projectName: 'tierB-auth',
        status: 'failed',
        error: 'expected /dashboard got /login',
      },
      { title: 'landing renders', projectName: 'tierA-public', status: 'passed' },
    ]);
    const parsed = parseReport(r, auth);
    expect(parsed.results[0]?.status).toBe('blocked');
    expect(parsed.results[0]?.error).toContain('without credentials');
    expect(parsed.passed).toBe(1);
  });

  it('never downgrades when login state is unknown (older suites without the sidecar)', () => {
    const auth: AuthSignals = { setupFailed: false, setupError: '', performedLogin: null };
    const r = report([
      {
        title: 'dashboard greeting',
        projectName: 'tierB-auth',
        status: 'failed',
        error: 'unauthorized 401 session storageState',
      },
    ]);
    const parsed = parseReport(r, auth);
    expect(parsed.results[0]?.status).toBe('failed');
    expect(parsed.blocked).toBe(0);
  });

  it('never touches non-Tier-B failures regardless of error text', () => {
    const auth: AuthSignals = { setupFailed: true, setupError: 'boom', performedLogin: false };
    const r = report([
      {
        title: 'login form present',
        projectName: 'tierA-public',
        status: 'failed',
        error: 'sign in button storageState 401',
      },
    ]);
    const parsed = parseReport(r, auth);
    expect(parsed.results[0]?.status).toBe('failed');
    expect(parsed.blocked).toBe(0);
  });
});

describe('parseReport — QA request: skip reason from test.skip(cond, "reason") annotations', () => {
  function skipReport(annotations: Array<{ type?: string; description?: string }> | undefined): PwReportArg {
    return {
      suites: [
        {
          title: 'suite',
          specs: [
            {
              title: 'staging-only check',
              file: 'tests/tierA-public/staging-only-check.spec.ts',
              tests: [
                {
                  status: 'skipped',
                  projectName: 'tierA-public',
                  results: [{ status: 'skipped', duration: 0 }],
                  annotations,
                },
              ],
            },
          ],
        },
      ],
    };
  }

  it('recovers the description from a real test.skip(cond, "reason") annotation', () => {
    const r = skipReport([{ type: 'skip', description: 'staging-only feature not enabled here' }]);
    const parsed = parseReport(r, LOGGED_IN);
    expect(parsed.results[0]?.status).toBe('skipped');
    expect(parsed.results[0]?.skipReason).toBe('staging-only feature not enabled here');
  });

  it('also recognizes a test.fixme(cond, "reason") annotation', () => {
    const r = skipReport([{ type: 'fixme', description: 'flaky pending investigation' }]);
    const parsed = parseReport(r, LOGGED_IN);
    expect(parsed.results[0]?.skipReason).toBe('flaky pending investigation');
  });

  it('leaves skipReason undefined for a bare skip with no description given', () => {
    const r = skipReport([{ type: 'skip' }]);
    const parsed = parseReport(r, LOGGED_IN);
    expect(parsed.results[0]?.skipReason).toBeUndefined();
  });

  // A declaration-form `test.fixme(title, { annotation: ... }, body)` — what generate.ts's
  // demoteEscapeHatchBlocks emits — yields TWO fixme annotations from Playwright: the described
  // one and its own bare one. Verified against Playwright 1.62's JSON reporter. Taking the first
  // by type alone would return whichever the runner happened to list first, so both orders must
  // resolve to the description.
  it('finds the description when Playwright also emits its own bare fixme annotation', () => {
    const described = { type: 'fixme', description: 'unobserved element — needs review' };
    const bare = { type: 'fixme' };

    expect(parseReport(skipReport([described, bare]), LOGGED_IN).results[0]?.skipReason).toBe(
      'unobserved element — needs review',
    );
    expect(parseReport(skipReport([bare, described]), LOGGED_IN).results[0]?.skipReason).toBe(
      'unobserved element — needs review',
    );
  });

  it('leaves skipReason undefined when there are no annotations at all', () => {
    const r = skipReport(undefined);
    const parsed = parseReport(r, LOGGED_IN);
    expect(parsed.results[0]?.skipReason).toBeUndefined();
  });

  it('ignores an unrelated annotation type (e.g. "slow")', () => {
    const r = skipReport([{ type: 'slow', description: 'this suite is known to be slow' }]);
    const parsed = parseReport(r, LOGGED_IN);
    expect(parsed.results[0]?.skipReason).toBeUndefined();
  });

  it('never attaches a skipReason to a non-skipped result, even if annotations are present', () => {
    const r: PwReportArg = {
      suites: [
        {
          title: 'suite',
          specs: [
            {
              title: 'x',
              file: 'tests/tierA-public/x.spec.ts',
              tests: [
                {
                  status: 'passed',
                  projectName: 'tierA-public',
                  results: [{ status: 'passed', duration: 5 }],
                  annotations: [{ type: 'skip', description: 'irrelevant leftover annotation' }],
                },
              ],
            },
          ],
        },
      ],
    };
    const parsed = parseReport(r, LOGGED_IN);
    expect(parsed.results[0]?.status).toBe('passed');
    expect(parsed.results[0]?.skipReason).toBeUndefined();
  });
});

describe('parseReport — drops blank-recording videos, keeps everything else', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'healix-video-test-'));
  const blankVideo = join(tmpDir, 'blank-video.webm');
  const realVideo = join(tmpDir, 'real-video.webm');
  const screenshot = join(tmpDir, 'test-failed-1.png');
  const trace = join(tmpDir, 'trace.zip');
  writeFileSync(blankVideo, Buffer.alloc(1024)); // well under the 8KB floor — Playwright's "nothing painted" case
  writeFileSync(realVideo, Buffer.alloc(20 * 1024)); // comfortably real recorded content
  writeFileSync(screenshot, Buffer.alloc(512)); // screenshots are never size-filtered, however small
  writeFileSync(trace, Buffer.alloc(256));

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("excludes an implausibly small .webm from a result's artifacts, keeps the rest", () => {
    const r: PwReportArg = {
      suites: [
        {
          title: 'suite',
          specs: [
            {
              title: 'fails fast, nothing ever painted',
              file: 'tests/tierA-public/fast.spec.ts',
              tests: [
                {
                  status: 'failed',
                  projectName: 'tierA-public',
                  results: [
                    {
                      status: 'failed',
                      duration: 300,
                      attachments: [
                        { name: 'screenshot', path: screenshot },
                        { name: 'video', path: blankVideo },
                        { name: 'trace', path: trace },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const parsed = parseReport(r, LOGGED_IN);
    const artifacts = parsed.results[0]?.artifacts ?? [];
    expect(artifacts).toContain(screenshot);
    expect(artifacts).toContain(trace);
    expect(artifacts).not.toContain(blankVideo);
  });

  it('keeps a video large enough to plausibly contain real recorded frames', () => {
    const r: PwReportArg = {
      suites: [
        {
          title: 'suite',
          specs: [
            {
              title: 'real interaction',
              file: 'tests/tierA-public/real.spec.ts',
              tests: [
                {
                  status: 'passed',
                  projectName: 'tierA-public',
                  results: [
                    {
                      status: 'passed',
                      duration: 5000,
                      attachments: [{ name: 'video', path: realVideo }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const parsed = parseReport(r, LOGGED_IN);
    expect(parsed.results[0]?.artifacts).toContain(realVideo);
  });

  it('keeps a video referenced by a nonexistent path rather than silently dropping evidence', () => {
    const missingVideo = join(tmpDir, 'already-cleaned-up.webm');
    const r: PwReportArg = {
      suites: [
        {
          title: 'suite',
          specs: [
            {
              title: 'video path no longer on disk',
              file: 'tests/tierA-public/gone.spec.ts',
              tests: [
                {
                  status: 'passed',
                  projectName: 'tierA-public',
                  results: [
                    {
                      status: 'passed',
                      duration: 1000,
                      attachments: [{ name: 'video', path: missingVideo }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const parsed = parseReport(r, LOGGED_IN);
    expect(parsed.results[0]?.artifacts).toContain(missingVideo);
  });
});

describe('parseReport — videoUnavailableReason: never a silent gap', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'healix-video-status-test-'));
  const blankVideo = join(tmpDir, 'blank-video.webm');
  const realVideo = join(tmpDir, 'real-video.webm');
  writeFileSync(blankVideo, Buffer.alloc(1024));
  writeFileSync(realVideo, Buffer.alloc(20 * 1024));

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets no reason when a real, non-blank video is present', () => {
    const r: PwReportArg = {
      suites: [
        {
          title: 'suite',
          specs: [
            {
              title: 'real interaction',
              file: 'tests/tierA-public/real2.spec.ts',
              tests: [
                {
                  status: 'passed',
                  projectName: 'tierA-public',
                  results: [
                    {
                      status: 'passed',
                      duration: 5000,
                      attachments: [{ name: 'video', path: realVideo }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const parsed = parseReport(r, LOGGED_IN);
    expect(parsed.results[0]?.videoUnavailableReason).toBeUndefined();
    expect(parsed.videoWarnings).toEqual([]);
  });

  it('explains a blank/discarded video with the blank-recording reason', () => {
    const r: PwReportArg = {
      suites: [
        {
          title: 'suite',
          specs: [
            {
              title: 'fails fast, nothing ever painted, again',
              file: 'tests/tierA-public/fast2.spec.ts',
              tests: [
                {
                  status: 'failed',
                  projectName: 'tierA-public',
                  results: [
                    {
                      status: 'failed',
                      duration: 300,
                      attachments: [{ name: 'video', path: blankVideo }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const parsed = parseReport(r, LOGGED_IN);
    expect(parsed.results[0]?.videoUnavailableReason).toMatch(/too quickly/);
    expect(parsed.videoWarnings).toEqual([]); // expected/explained case, not an operational anomaly
  });

  it('explains a tierC-api test (no browser page) with the api-only reason, no operational warning', () => {
    const r: PwReportArg = {
      suites: [
        {
          title: 'suite',
          specs: [
            {
              title: 'GET /api/x returns well-formed data',
              file: 'tests/tierC-api/x.spec.ts',
              tests: [
                {
                  status: 'passed',
                  projectName: 'tierC-api',
                  results: [{ status: 'passed', duration: 100, attachments: [] }],
                },
              ],
            },
          ],
        },
      ],
    };
    const parsed = parseReport(r, LOGGED_IN);
    expect(parsed.results[0]?.videoUnavailableReason).toMatch(/Video not applicable/);
    expect(parsed.videoWarnings).toEqual([]);
  });

  it('flags a browser-based test with NO video attachment at all as an anomaly, with an operational warning', () => {
    const r: PwReportArg = {
      suites: [
        {
          title: 'suite',
          specs: [
            {
              title: 'no video attachment somehow',
              file: 'tests/tierB-auth/gap.spec.ts',
              tests: [
                {
                  status: 'passed',
                  projectName: 'tierB-auth',
                  results: [{ status: 'passed', duration: 100, attachments: [] }],
                },
              ],
            },
          ],
        },
      ],
    };
    const parsed = parseReport(r, LOGGED_IN);
    expect(parsed.results[0]?.videoUnavailableReason).toBe('No video recorded.');
    expect(parsed.videoWarnings).toHaveLength(1);
    expect(parsed.videoWarnings[0]).toContain('no video attachment somehow');
  });

  it('does not set a reason for a skipped result (never executed at all)', () => {
    const r: PwReportArg = {
      suites: [
        {
          title: 'suite',
          specs: [
            {
              title: 'skipped test',
              file: 'tests/tierA-public/skip.spec.ts',
              tests: [
                {
                  status: 'skipped',
                  projectName: 'tierA-public',
                  results: [{ status: 'skipped', duration: 0, attachments: [] }],
                },
              ],
            },
          ],
        },
      ],
    };
    const parsed = parseReport(r, LOGGED_IN);
    expect(parsed.results[0]?.videoUnavailableReason).toBeUndefined();
  });
});

describe('parseReport — error text stays simple, not a wall of duplicates', () => {
  it('picks a single clear error instead of concatenating result.error and every result.errors[] entry', () => {
    const r: PwReportArg = {
      suites: [
        {
          title: 'suite',
          specs: [
            {
              title: 'click reveals greeting',
              file: 'tests/tierA-public/click.spec.ts',
              tests: [
                {
                  status: 'failed',
                  projectName: 'tierA-public',
                  results: [
                    {
                      status: 'failed',
                      duration: 11_235,
                      // Playwright commonly repeats the same failure in both
                      // `error` and `errors[]` (sometimes with a differing
                      // captured call-log frame) — this used to concatenate
                      // into 2-3x duplicated blocks in the report.
                      error: {
                        message: 'Test timeout of 60000ms exceeded.',
                        stack:
                          "Error: locator.click: Test timeout of 60000ms exceeded.\nCall log:\n  - waiting for getByRole('button')\nat click.spec.ts:8:31",
                      },
                      errors: [
                        {
                          message: 'Test timeout of 60000ms exceeded.',
                          stack:
                            "Error: locator.click: Test timeout of 60000ms exceeded.\nCall log:\n  - waiting for getByRole('button')\nat click.spec.ts:8:31",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const parsed = parseReport(r, LOGGED_IN);
    const error = parsed.results[0]?.error ?? '';
    // The message must appear exactly once, not two or three times back to back.
    const occurrences = error.split('Test timeout of 60000ms exceeded.').length - 1;
    expect(occurrences).toBe(1);
    expect(error).toContain('Call log:');
  });
});

describe('parseReport — F-24: counts skipped tests instead of leaving them invisible', () => {
  it('tallies a skipped test into outcome.skipped, distinct from passed/failed/blocked/flaky', () => {
    const r = report([
      { title: 'a', projectName: 'tierA-public', status: 'passed' },
      { title: 'b', projectName: 'tierA-public', status: 'failed' },
      { title: 'c', projectName: 'tierA-public', status: 'skipped' },
      { title: 'd', projectName: 'tierA-public', status: 'skipped' },
    ]);
    const parsed = parseReport(r, LOGGED_IN);
    expect(parsed.passed).toBe(1);
    expect(parsed.failed).toBe(1);
    expect(parsed.skipped).toBe(2);
    expect(parsed.blocked).toBe(0);
    expect(parsed.results.filter((x) => x.status === 'skipped')).toHaveLength(2);
  });
});

describe('parseReport — specFile inheritance through nested describe() suites', () => {
  it('inherits the file from an ancestor suite when the immediate (nested) suite and spec both lack one', () => {
    // Real shape: Playwright's JSON reporter sets `file` on the outermost
    // per-file suite, but a nested test.describe() block — exactly what
    // every generated spec wraps its scenarios in — has no `file` of its
    // own. Without inheriting from the ancestor, specFile would end up
    // undefined here, silently falling back to title-only merge identity
    // (see coverage.ts's mergeExecOutcomes) and reintroducing the exact
    // report-vs-Results-tab count mismatch the specFile field exists to fix.
    const r: PwReportArg = {
      suites: [
        {
          title: '',
          file: 'tests/tierA-public/REQ-1.spec.ts',
          specs: [],
          suites: [
            {
              // The test.describe('[REQ:REQ-1] ...') block: no `file` of its own.
              title: '[REQ:REQ-1] Widget list',
              specs: [
                {
                  title: '[REQ:REQ-1] positive: loads',
                  // No `file` on the spec either — the case that used to fall
                  // all the way back to undefined.
                  tests: [
                    {
                      status: 'passed',
                      projectName: 'tierA-public',
                      results: [{ status: 'passed', duration: 5 }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const parsed = parseReport(r, LOGGED_IN);
    expect(parsed.results[0]?.specFile).toBe('tests/tierA-public/REQ-1.spec.ts');
  });
});

describe('findAuthSetupOutcome', () => {
  it('detects a failed auth-setup by project name or file and captures its error', () => {
    const r = report([
      {
        title: 'authenticate',
        file: 'fixtures/auth.setup.ts',
        projectName: 'auth-setup',
        status: 'failed',
        error: 'no email field',
      },
      { title: 'other', projectName: 'tierA-public', status: 'passed' },
    ]);
    expect(findAuthSetupOutcome(r)).toEqual({ failed: true, error: 'no email field' });
  });

  it('reports failed:false when the setup passed', () => {
    const r = report([
      { title: 'authenticate', file: 'fixtures/auth.setup.ts', projectName: 'auth-setup', status: 'passed' },
    ]);
    expect(findAuthSetupOutcome(r)).toEqual({ failed: false, error: '' });
  });
});

describe('write-through checkpoint: readCheckpointEntries / writeInvertFile / clearExecCheckpoint', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'healix-exec-checkpoint-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty array when no checkpoint file exists', async () => {
    expect(await readCheckpointEntries(dir)).toEqual([]);
  });

  it('round-trips entries written by the reporter (one JSON object per line)', async () => {
    const a = { key: '[tierA] › a.spec.ts › t1', title: 't1', status: 'expected' };
    const b = { key: '[tierA] › a.spec.ts › t2', title: 't2', status: 'unexpected', error: 'boom' };
    writeFileSync(join(dir, EXEC_CHECKPOINT_FILENAME), `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`);
    const entries = await readCheckpointEntries(dir);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.key).sort()).toEqual([a.key, b.key].sort());
  });

  it('skips a malformed line instead of losing every other entry in the file', async () => {
    const good = { key: '[tierA] › a.spec.ts › t1', title: 't1', status: 'expected' };
    writeFileSync(join(dir, EXEC_CHECKPOINT_FILENAME), `${JSON.stringify(good)}\nnot valid json\n\n`);
    const entries = await readCheckpointEntries(dir);
    expect(entries).toEqual([good]);
  });

  it('writeInvertFile returns null (no flag needed) when there is nothing to skip', async () => {
    expect(await writeInvertFile(dir, [])).toBeNull();
  });

  it('writeInvertFile writes one key per line, readable back by the invert-list format', async () => {
    const entries = [
      { key: '[tierA] › a.spec.ts › t1', title: 't1', status: 'expected' },
      { key: '[tierC] › b.spec.ts › t2', title: 't2', status: 'expected' },
    ];
    const target = await writeInvertFile(dir, entries);
    expect(target).toBe(join(dir, EXEC_CHECKPOINT_INVERT_FILENAME));
    const content = readFileSync(target!, 'utf-8');
    expect(content.split('\n')).toEqual(entries.map((e) => e.key));
  });

  it('clearExecCheckpoint removes both files and never throws when they are already absent', async () => {
    await writeInvertFile(dir, [{ key: 'k', title: 't', status: 'expected' }]);
    writeFileSync(join(dir, EXEC_CHECKPOINT_FILENAME), '{}\n');
    await clearExecCheckpoint(dir);
    expect(await readCheckpointEntries(dir)).toEqual([]);
    // Second call: both files are already gone — must stay a no-op, not throw.
    await expect(clearExecCheckpoint(dir)).resolves.toBeUndefined();
  });

  it('F-15: clearExecCheckpoint also clears the mock-request log, so a later unrelated execute() call starts counting fresh', async () => {
    writeFileSync(join(dir, MOCK_REQUEST_LOG_FILENAME), `${JSON.stringify({ id: 'pkg:twilio' })}\n`);
    await clearExecCheckpoint(dir);
    expect(await readMockRequestCounts(dir)).toEqual({});
  });
});

describe("readMockRequestCounts — F-15: tallies the mock fixture's write-through hit log", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'healix-mock-request-log-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns {} when no log file exists (mocking disabled, or nothing was ever intercepted)', async () => {
    expect(await readMockRequestCounts(dir)).toEqual({});
  });

  it('tallies hits by dependency id across multiple lines', async () => {
    const lines = [{ id: 'pkg:twilio' }, { id: 'pkg:twilio' }, { id: 'env:VITE_API_BASE_URL' }]
      .map((e) => JSON.stringify(e))
      .join('\n');
    writeFileSync(join(dir, MOCK_REQUEST_LOG_FILENAME), `${lines}\n`);
    expect(await readMockRequestCounts(dir)).toEqual({ 'pkg:twilio': 2, 'env:VITE_API_BASE_URL': 1 });
  });

  it('attributes a hit with no resolvable dependency id to "override" instead of dropping it', async () => {
    writeFileSync(join(dir, MOCK_REQUEST_LOG_FILENAME), '{}\n{}\n');
    expect(await readMockRequestCounts(dir)).toEqual({ override: 2 });
  });

  it('skips a malformed line instead of losing every other entry in the file', async () => {
    writeFileSync(
      join(dir, MOCK_REQUEST_LOG_FILENAME),
      `${JSON.stringify({ id: 'pkg:twilio' })}\nnot valid json\n\n`,
    );
    expect(await readMockRequestCounts(dir)).toEqual({ 'pkg:twilio': 1 });
  });
});

describe('readApiEvidence — per-test summary of actual request-fixture calls', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'healix-api-evidence-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns {} when no log file exists (no tierC-api tests ran, or nothing called request)', async () => {
    expect(await readApiEvidence(dir)).toEqual({});
  });

  it('groups calls by key and formats a compact, mock-vs-real-labeled summary', async () => {
    const lines = [
      {
        key: 'tests/tierC-api/x.spec.ts#a',
        method: 'GET',
        url: '/lookup',
        status: 500,
        mocked: false,
        body: '{}',
      },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    writeFileSync(join(dir, API_EVIDENCE_LOG_FILENAME), `${lines}\n`);
    const out = await readApiEvidence(dir);
    const summary = out['tests/tierC-api/x.spec.ts#a'];
    expect(summary).toContain('[REAL BACKEND]');
    expect(summary).toContain('GET /lookup -> status 500');
    expect(summary).toContain('Body: {}');
  });

  it('labels a mocked call [HEALIX MOCK]', async () => {
    writeFileSync(
      join(dir, API_EVIDENCE_LOG_FILENAME),
      `${JSON.stringify({ key: 'f#t', method: 'POST', url: '/pay', status: 200, mocked: true, body: '{"ok":true}' })}\n`,
    );
    const out = await readApiEvidence(dir);
    expect(out['f#t']).toContain('[HEALIX MOCK]');
    expect(out['f#t']).toContain('POST /pay -> status 200');
  });

  it('keeps only the LAST few calls per key (bounded, so a chatty test cannot blow up the prompt)', async () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({ key: 'f#t', method: 'GET', url: `/call-${i}`, status: 200, mocked: false, body: '' }),
    ).join('\n');
    writeFileSync(join(dir, API_EVIDENCE_LOG_FILENAME), `${many}\n`);
    const summary = (await readApiEvidence(dir))['f#t'];
    // Bounded to the last 3 (API_EVIDENCE_MAX_CALLS_PER_TEST) — the earliest calls are dropped.
    expect(summary).not.toContain('/call-0');
    expect(summary).not.toContain('/call-2');
    expect(summary).toContain('/call-3');
    expect(summary).toContain('/call-5');
  });

  it('skips a malformed line instead of losing every other entry, and drops lines with no key', async () => {
    writeFileSync(
      join(dir, API_EVIDENCE_LOG_FILENAME),
      [
        JSON.stringify({ key: 'f#t', method: 'GET', url: '/ok', status: 200, mocked: false, body: '' }),
        'not valid json',
        JSON.stringify({ method: 'GET', url: '/nokey', status: 200, mocked: false, body: '' }),
        '',
      ].join('\n') + '\n',
    );
    const out = await readApiEvidence(dir);
    expect(Object.keys(out)).toEqual(['f#t']);
    expect(out['f#t']).toContain('/ok');
  });
});

describe('findAuthSetupOutcomeFromEntries', () => {
  it('detects a failed checkpoint-restored auth-setup entry', () => {
    const entries = [
      {
        key: 'k1',
        title: 'authenticate',
        project: 'auth-setup',
        specFile: 'fixtures/auth.setup.ts',
        status: 'unexpected',
        error: 'no email field',
      },
    ];
    expect(findAuthSetupOutcomeFromEntries(entries)).toEqual({ failed: true, error: 'no email field' });
  });

  it('reports failed:false when no entry is the auth-setup, or it passed', () => {
    expect(findAuthSetupOutcomeFromEntries([])).toEqual({ failed: false, error: '' });
    expect(
      findAuthSetupOutcomeFromEntries([
        { key: 'k1', title: 'authenticate', project: 'auth-setup', status: 'expected' },
      ]),
    ).toEqual({ failed: false, error: '' });
  });
});

describe('checkpointEntriesToOutcome', () => {
  it('counts passed/failed/flaky from Playwright outcome() values via normalizeStatus', () => {
    const parsed = checkpointEntriesToOutcome(
      [
        { key: 'k1', title: 'a', status: 'expected' },
        { key: 'k2', title: 'b', status: 'unexpected', error: 'boom' },
        { key: 'k3', title: 'c', status: 'flaky' },
      ],
      LOGGED_IN,
    );
    expect(parsed.passed).toBe(2); // flaky counts toward passed, same as parseReport
    expect(parsed.failed).toBe(1);
    expect(parsed.flaky).toBe(1);
    expect(parsed.results.map((r) => r.title)).toEqual(['a', 'b', 'c']);
  });

  it('suppresses a passing auth-setup phantom but keeps a failing one visible', () => {
    const passing = checkpointEntriesToOutcome(
      [{ key: 'k1', title: 'authenticate', project: 'auth-setup', status: 'expected' }],
      LOGGED_IN,
    );
    expect(passing.results).toEqual([]);

    const failing = checkpointEntriesToOutcome(
      [{ key: 'k1', title: 'authenticate', project: 'auth-setup', status: 'unexpected', error: 'bad' }],
      LOGGED_IN,
    );
    expect(failing.results).toHaveLength(1);
    expect(failing.failed).toBe(1);
  });

  it('reclassifies a Tier B failure as blocked when auth setup failed — same rule as parseReport', () => {
    const auth: AuthSignals = { setupFailed: true, setupError: 'no email field', performedLogin: false };
    const parsed = checkpointEntriesToOutcome(
      [{ key: 'k1', title: 'login works', project: 'tierB-auth', status: 'unexpected' }],
      auth,
    );
    expect(parsed.blocked).toBe(1);
    expect(parsed.failed).toBe(0);
    expect(parsed.results[0].error).toContain('Auth setup failed');
  });

  it('reclassifies a Tier B failure as blocked when setup ran without credentials', () => {
    const auth: AuthSignals = { setupFailed: false, setupError: '', performedLogin: false };
    const parsed = checkpointEntriesToOutcome(
      [{ key: 'k1', title: 'login works', project: 'tierB-auth', status: 'unexpected' }],
      auth,
    );
    expect(parsed.blocked).toBe(1);
    expect(parsed.results[0].error).toContain('without credentials');
  });

  it('QA request: carries a checkpoint-restored skip reason through to the resumed outcome', () => {
    const parsed = checkpointEntriesToOutcome(
      [
        {
          key: 'k1',
          title: 'staging-only check',
          status: 'skipped',
          skipReason: 'staging-only, disabled here',
        },
      ],
      LOGGED_IN,
    );
    expect(parsed.results[0]?.skipReason).toBe('staging-only, disabled here');
  });

  it('never attaches a skipReason to a non-skipped checkpoint entry', () => {
    const parsed = checkpointEntriesToOutcome(
      [{ key: 'k1', title: 'x', status: 'expected', skipReason: 'stale leftover value' }],
      LOGGED_IN,
    );
    expect(parsed.results[0]?.skipReason).toBeUndefined();
  });
});

describe('mergeParsedReports', () => {
  it('unions two disjoint result sets and recomputes counts from the union', () => {
    const a = {
      results: [{ title: 'a', status: 'passed' as const }],
      passed: 1,
      failed: 0,
      blocked: 0,
      flaky: 0,
      skipped: 0,
      videoWarnings: [],
    };
    const b = {
      results: [{ title: 'b', status: 'failed' as const }],
      passed: 0,
      failed: 1,
      blocked: 0,
      flaky: 0,
      skipped: 0,
      videoWarnings: [],
    };
    const merged = mergeParsedReports(a, b);
    expect(merged.results.map((r) => r.title).sort()).toEqual(['a', 'b']);
    expect(merged.passed).toBe(1);
    expect(merged.failed).toBe(1);
  });

  it('keeps b on a specFile+title collision, recomputing counts (never double-counts the same identity)', () => {
    const a = {
      results: [{ title: 'a', specFile: 'x.spec.ts', status: 'failed' as const }],
      passed: 0,
      failed: 1,
      blocked: 0,
      flaky: 0,
      skipped: 0,
      videoWarnings: [],
    };
    const b = {
      results: [{ title: 'a', specFile: 'x.spec.ts', status: 'passed' as const }],
      passed: 1,
      failed: 0,
      blocked: 0,
      flaky: 0,
      skipped: 0,
      videoWarnings: [],
    };
    const merged = mergeParsedReports(a, b);
    expect(merged.results).toHaveLength(1);
    expect(merged.results[0].status).toBe('passed');
    expect(merged.passed).toBe(1);
    expect(merged.failed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// execute() end-to-end: the checkpoint helpers ARE wired together correctly
// inside the real function, not just individually correct in isolation. Spawn
// is still mocked (no real Playwright process), but results.json/checkpoint
// files are real, on-disk, temp-dir state — exercising the same read/write
// paths a real run would.
// ---------------------------------------------------------------------------
describe('execute() — write-through checkpoint wired end-to-end', () => {
  let dir: string;

  function fakeChildProcess(exitCode: number | null = 0): ChildProcess {
    const proc = new EventEmitter() as unknown as ChildProcess & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    proc.stdout = new EventEmitter() as never;
    proc.stderr = new EventEmitter() as never;
    (proc as unknown as { pid: number }).pid = 4242;
    (proc as unknown as { kill: () => boolean }).kill = () => true;
    queueMicrotask(() => proc.emit('close', exitCode, null));
    return proc;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'healix-execute-e2e-'));
    // ensureSuiteDeps() only checks for this marker — skips a real `npm install`.
    mkdirSync(join(dir, 'node_modules', '@playwright'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const SPECS: GeneratedSpec[] = [
    { path: 'tests/tierA-public/a.spec.ts', title: 'a', tier: 'tierA-public', contents: '' },
    { path: 'tests/tierA-public/b.spec.ts', title: 'b', tier: 'tierA-public', contents: '' },
  ];

  function writeCheckpointEntries(entries: Array<Record<string, unknown>>): void {
    writeFileSync(
      join(dir, EXEC_CHECKPOINT_FILENAME),
      entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf-8',
    );
  }

  it('omits --test-list-invert on a fresh run with no checkpoint', async () => {
    let seenArgs: string[] = [];
    vi.mocked(spawn).mockImplementationOnce((_cmd, args) => {
      seenArgs = args as string[];
      writeFileSync(
        join(dir, 'results.json'),
        JSON.stringify(
          report([
            { title: 'a', projectName: 'tierA-public', status: 'passed' },
            { title: 'b', projectName: 'tierA-public', status: 'passed' },
          ]),
        ),
        'utf-8',
      );
      return fakeChildProcess(0);
    });

    const outcome = await execute(makeCtx({ projectDir: dir }), SPECS);

    expect(seenArgs.some((a) => a.startsWith('--test-list-invert'))).toBe(false);
    expect(outcome.passed).toBe(2);
    expect(outcome.failed).toBe(0);
  });

  it('resume: merges checkpoint-restored entries with a fresh partial report, passing --test-list-invert', async () => {
    writeCheckpointEntries([
      {
        key: 'k-a',
        title: 'a',
        project: 'tierA-public',
        specFile: 'tests/tierA-public/a.spec.ts',
        status: 'expected',
      },
    ]);

    let seenArgs: string[] = [];
    vi.mocked(spawn).mockImplementationOnce((_cmd, args) => {
      seenArgs = args as string[];
      writeFileSync(
        join(dir, 'results.json'),
        JSON.stringify(report([{ title: 'b', projectName: 'tierA-public', status: 'passed' }])),
        'utf-8',
      );
      return fakeChildProcess(0);
    });

    const outcome = await execute(makeCtx({ projectDir: dir }), SPECS);

    const invertArg = seenArgs.find((a) => a.startsWith('--test-list-invert='));
    expect(invertArg).toBeDefined();
    expect(outcome.passed).toBe(2); // 1 restored from checkpoint + 1 freshly run
    expect(outcome.results.map((r) => r.title).sort()).toEqual(['a', 'b']);
  });

  it('fully-resumed run with nothing left to execute does not emit a false "no results" error', async () => {
    writeCheckpointEntries([
      {
        key: 'k-a',
        title: 'a',
        project: 'tierA-public',
        specFile: 'tests/tierA-public/a.spec.ts',
        status: 'expected',
      },
      {
        key: 'k-b',
        title: 'b',
        project: 'tierA-public',
        specFile: 'tests/tierA-public/b.spec.ts',
        status: 'expected',
      },
    ]);

    const events: Array<{ message: string; data?: unknown }> = [];
    vi.mocked(spawn).mockImplementationOnce(() => fakeChildProcess(0)); // no stdout, no results.json written

    const outcome = await execute(
      makeCtx({ projectDir: dir, emit: (_phase, message, data) => events.push({ message, data }) }),
      SPECS,
    );

    expect(outcome.passed).toBe(2);
    expect(outcome.results.map((r) => r.title).sort()).toEqual(['a', 'b']);
    expect(events.some((e) => /no results found|failed to parse/i.test(e.message))).toBe(false);
  });

  it('classifies a checkpoint-restored Tier B failure as blocked using a checkpoint-restored (not fresh) auth-setup signal', async () => {
    writeCheckpointEntries([
      {
        key: 'k-setup',
        title: 'authenticate',
        project: 'auth-setup',
        specFile: 'fixtures/auth.setup.ts',
        status: 'unexpected',
        error: 'no email field',
      },
    ]);

    vi.mocked(spawn).mockImplementationOnce(() => {
      writeFileSync(
        join(dir, 'results.json'),
        JSON.stringify(report([{ title: 'login works', projectName: 'tierB-auth', status: 'failed' }])),
        'utf-8',
      );
      return fakeChildProcess(0);
    });

    const outcome = await execute(makeCtx({ projectDir: dir }), [
      { path: 'tests/tierB-auth/login.spec.ts', title: 'login works', tier: 'tierB-auth', contents: '' },
    ]);

    expect(outcome.blocked).toBe(1);
    // The failed auth-setup phantom itself also surfaces as a `failed` result
    // (root cause visibility — see checkpointEntriesToOutcome's doc comment),
    // alongside the Tier B test it blocked.
    expect(outcome.failed).toBe(1);
    const row = outcome.results.find((r) => r.title === 'login works');
    expect(row?.error).toContain('Auth setup failed');
  });

  /** A child process that emits `stderrText` on stderr, then closes with `exitCode`. */
  function fakeFailingProcess(exitCode: number, stderrText: string): ChildProcess {
    const proc = new EventEmitter() as unknown as ChildProcess & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    proc.stdout = new EventEmitter() as never;
    proc.stderr = new EventEmitter() as never;
    (proc as unknown as { pid: number }).pid = 4242;
    (proc as unknown as { kill: () => boolean }).kill = () => true;
    queueMicrotask(() => {
      proc.stderr.emit('data', Buffer.from(stderrText));
      proc.emit('close', exitCode, null);
    });
    return proc;
  }

  /** A child process that writes a passing results.json then exits 0 — a successful (retried) Playwright run. */
  function fakePassingRun(title: string): ChildProcess {
    writeFileSync(
      join(dir, 'results.json'),
      JSON.stringify(report([{ title, projectName: 'tierA-public', status: 'passed' }])),
      'utf-8',
    );
    return fakeChildProcess(0);
  }

  it('self-heals a missing Node module by re-running npm install and retrying once (not just missing browsers)', async () => {
    const spawnedCommands: string[] = [];

    // 1st spawn: `npx playwright test` fails with a "Cannot find module" signature.
    vi.mocked(spawn).mockImplementationOnce((cmd) => {
      spawnedCommands.push(String(cmd));
      return fakeFailingProcess(1, "Error: Cannot find module '@playwright/test'\n");
    });
    // 2nd spawn: the recovery `npm install`.
    vi.mocked(spawn).mockImplementationOnce((cmd) => {
      spawnedCommands.push(String(cmd));
      return fakeChildProcess(0);
    });
    // 3rd spawn: the retried `npx playwright test`, this time succeeding.
    vi.mocked(spawn).mockImplementationOnce((cmd) => {
      spawnedCommands.push(String(cmd));
      return fakePassingRun('a');
    });

    const outcome = await execute(makeCtx({ projectDir: dir }), [
      { path: 'tests/tierA-public/a.spec.ts', title: 'a', tier: 'tierA-public', contents: '' },
    ]);

    expect(spawnedCommands).toEqual(['npx', 'npm', 'npx']);
    expect(outcome.passed).toBe(1);
    expect(outcome.failed).toBe(0);
  });

  it('self-heals a missing Playwright browser binary by running a bare `npx playwright install` (no npm install)', async () => {
    const spawnedCommands: Array<{ cmd: string; args: unknown }> = [];

    // 1st spawn: `npx playwright test` fails with the real chrome-headless-shell signature.
    vi.mocked(spawn).mockImplementationOnce((cmd, args) => {
      spawnedCommands.push({ cmd: String(cmd), args });
      return fakeFailingProcess(
        1,
        "browserType.launch: Executable doesn't exist at ...chrome-headless-shell.exe\n" +
          'Please run the following command to download new browsers:\n\n    npx playwright install\n',
      );
    });
    // 2nd spawn: the recovery browser install.
    vi.mocked(spawn).mockImplementationOnce((cmd, args) => {
      spawnedCommands.push({ cmd: String(cmd), args });
      return fakeChildProcess(0);
    });
    // 3rd spawn: the retried `npx playwright test`, this time succeeding.
    vi.mocked(spawn).mockImplementationOnce((cmd, args) => {
      spawnedCommands.push({ cmd: String(cmd), args });
      return fakePassingRun('a');
    });

    const outcome = await execute(makeCtx({ projectDir: dir }), [
      { path: 'tests/tierA-public/a.spec.ts', title: 'a', tier: 'tierA-public', contents: '' },
    ]);

    expect(spawnedCommands.map((c) => c.cmd)).toEqual(['npx', 'npx', 'npx']);
    // No browser name filter — installs whatever the local Playwright version needs.
    expect(spawnedCommands[1]?.args).toEqual(['playwright', 'install']);
    expect(outcome.passed).toBe(1);
    expect(outcome.failed).toBe(0);
  });

  it('runs BOTH recovery installs when a failure carries both a missing-browser and a missing-module signature', async () => {
    const spawnedCommands: Array<{ cmd: string; args: unknown }> = [];

    vi.mocked(spawn).mockImplementationOnce((cmd, args) => {
      spawnedCommands.push({ cmd: String(cmd), args });
      return fakeFailingProcess(
        1,
        "browserType.launch: Executable doesn't exist at ...chrome-headless-shell.exe\n" +
          "Error: Cannot find module 'some-helper-package'\n",
      );
    });
    vi.mocked(spawn).mockImplementationOnce((cmd, args) => {
      spawnedCommands.push({ cmd: String(cmd), args });
      return fakeChildProcess(0);
    });
    vi.mocked(spawn).mockImplementationOnce((cmd, args) => {
      spawnedCommands.push({ cmd: String(cmd), args });
      return fakeChildProcess(0);
    });
    vi.mocked(spawn).mockImplementationOnce((cmd, args) => {
      spawnedCommands.push({ cmd: String(cmd), args });
      return fakePassingRun('a');
    });

    const outcome = await execute(makeCtx({ projectDir: dir }), [
      { path: 'tests/tierA-public/a.spec.ts', title: 'a', tier: 'tierA-public', contents: '' },
    ]);

    // Order matches the source: browser install (if applicable) runs before the npm install.
    expect(spawnedCommands.map((c) => c.cmd)).toEqual(['npx', 'npx', 'npm', 'npx']);
    expect(spawnedCommands[1]?.args).toEqual(['playwright', 'install']);
    expect(outcome.passed).toBe(1);
  });

  it('does NOT run any recovery install for a failure that matches neither signature (no spurious retry)', async () => {
    const spawnedCommands: string[] = [];

    vi.mocked(spawn).mockImplementationOnce((cmd) => {
      spawnedCommands.push(String(cmd));
      return fakeFailingProcess(1, 'Error: expect(locator).toHaveText(expected) failed\n');
    });

    const outcome = await execute(makeCtx({ projectDir: dir }), [
      { path: 'tests/tierA-public/a.spec.ts', title: 'a', tier: 'tierA-public', contents: '' },
    ]);

    // Exactly one spawn — the original run — no install, no retry.
    expect(spawnedCommands).toEqual(['npx']);
    expect(outcome.passed).toBe(0);
  });

  it('retries at most once: a still-failing retry does not loop or spawn a second recovery attempt', async () => {
    const spawnedCommands: string[] = [];

    vi.mocked(spawn).mockImplementationOnce((cmd) => {
      spawnedCommands.push(String(cmd));
      return fakeFailingProcess(1, "Error: Cannot find module 'still-missing'\n");
    });
    // Recovery npm install "succeeds"...
    vi.mocked(spawn).mockImplementationOnce((cmd) => {
      spawnedCommands.push(String(cmd));
      return fakeChildProcess(0);
    });
    // ...but the retried run fails with the SAME signature again.
    vi.mocked(spawn).mockImplementationOnce((cmd) => {
      spawnedCommands.push(String(cmd));
      return fakeFailingProcess(1, "Error: Cannot find module 'still-missing'\n");
    });

    await execute(makeCtx({ projectDir: dir }), [
      { path: 'tests/tierA-public/a.spec.ts', title: 'a', tier: 'tierA-public', contents: '' },
    ]);

    // Exactly 3 spawns total — original, one recovery install, one retry — never a second recovery round.
    expect(spawnedCommands).toEqual(['npx', 'npm', 'npx']);
  });

  it('clears the checkpoint after a full, successful (non-aborted) completion', async () => {
    writeCheckpointEntries([
      {
        key: 'k-a',
        title: 'a',
        project: 'tierA-public',
        specFile: 'tests/tierA-public/a.spec.ts',
        status: 'expected',
      },
    ]);
    vi.mocked(spawn).mockImplementationOnce(() => {
      writeFileSync(
        join(dir, 'results.json'),
        JSON.stringify(report([{ title: 'b', projectName: 'tierA-public', status: 'passed' }])),
        'utf-8',
      );
      return fakeChildProcess(0);
    });

    await execute(makeCtx({ projectDir: dir }), SPECS);

    expect(await readCheckpointEntries(dir)).toEqual([]);
  });

  it('preserves the checkpoint (does not clear it) when the run is aborted mid-flight', async () => {
    writeCheckpointEntries([
      {
        key: 'k-a',
        title: 'a',
        project: 'tierA-public',
        specFile: 'tests/tierA-public/a.spec.ts',
        status: 'expected',
      },
    ]);
    const controller = new AbortController();
    let proc!: ChildProcess;
    vi.mocked(spawn).mockImplementationOnce(() => {
      // Unlike fakeChildProcess(), this one only closes once killed — so the
      // abort (queued right after this mock returns, but processed by
      // runPlaywright's signal listener, which is attached synchronously
      // right after spawn() returns) reliably happens BEFORE any close event,
      // instead of racing an auto-close microtask scheduled at construction.
      proc = new EventEmitter() as unknown as ChildProcess;
      (proc as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
      (proc as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
      (proc as unknown as { pid: number }).pid = 4243;
      (proc as unknown as { kill: () => boolean }).kill = () => {
        queueMicrotask(() => proc.emit('close', null, 'SIGTERM'));
        return true;
      };
      queueMicrotask(() => controller.abort());
      return proc;
    });
    // On this (win32) platform, kill() shells out to `taskkill` via
    // node:child_process's spawn instead of calling child.kill() directly —
    // simulate a successful kill by emitting the fake child's own close
    // event, same effect a real taskkill terminating the tracked pid would have.
    vi.mocked(nodeSpawn).mockImplementationOnce(() => {
      queueMicrotask(() => proc.emit('close', null, 'SIGTERM'));
      return new EventEmitter() as unknown as ChildProcess;
    });

    const outcome = await execute(makeCtx({ projectDir: dir, signal: controller.signal }), SPECS);

    expect((outcome.raw as { aborted?: boolean } | undefined)?.aborted).toBe(true);
    const remaining = await readCheckpointEntries(dir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe('a');
  });
});

// The manually-created-browser-context case is no longer a distinct
// videoUnavailableReason — templates.ts's page fixture now patches
// browser.newContext() to record and attach video automatically, so a test
// using that pattern gets a real video (or, if something still goes wrong,
// falls through to the generic UNEXPLAINED_MISSING_VIDEO_REASON case covered
// above) rather than a dedicated explanatory message.

// ---------------------------------------------------------------------------
// Windows process-tree kill: an aborted/timed-out run must terminate the
// WHOLE process tree (npx -> node -> browsers), not just the top-level
// process — see runPlaywright's and runCommand's kill()/killTree() doc
// comments. platform is stubbed per-test so this is exercised identically on
// every CI OS, not just whichever one happens to run it.
// ---------------------------------------------------------------------------
describe('kill() / killTree() — Windows uses taskkill /F /T, not a bare child.kill()', () => {
  function stubPlatform(value: NodeJS.Platform): () => void {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value, configurable: true });
    return () => Object.defineProperty(process, 'platform', original);
  }

  function fakeChildProcess(): ChildProcess {
    const proc = new EventEmitter() as unknown as ChildProcess;
    (proc as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
    (proc as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    (proc as unknown as { pid: number }).pid = 9999;
    (proc as unknown as { kill: () => boolean }).kill = vi.fn(() => {
      queueMicrotask(() => proc.emit('close', null, 'SIGTERM'));
      return true;
    });
    return proc;
  }

  it('runPlaywright: aborting on a win32-stubbed platform shells out to taskkill /F /T /PID, not child.kill()', async () => {
    const restore = stubPlatform('win32');
    try {
      const controller = new AbortController();
      let proc!: ChildProcess;
      vi.mocked(spawn).mockImplementationOnce(() => {
        proc = fakeChildProcess();
        queueMicrotask(() => controller.abort());
        return proc;
      });
      vi.mocked(nodeSpawn).mockImplementationOnce(() => {
        queueMicrotask(() => proc.emit('close', null, 'SIGTERM'));
        return new EventEmitter() as unknown as ChildProcess;
      });

      const dir = mkdtempSync(join(tmpdir(), 'healix-killtree-'));
      try {
        mkdirSync(join(dir, 'node_modules', '@playwright'), { recursive: true });
        const outcome = await execute(makeCtx({ projectDir: dir, signal: controller.signal }), [
          { path: 'tests/tierA-public/a.spec.ts', title: 'a', tier: 'tierA-public', contents: '' },
        ]);
        expect((outcome.raw as { aborted?: boolean } | undefined)?.aborted).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      expect(nodeSpawn).toHaveBeenCalledWith(
        'taskkill',
        ['/F', '/T', '/PID', '9999'],
        expect.objectContaining({ stdio: 'ignore' }),
      );
      // The load-bearing regression check: the old buggy code called
      // child.kill() directly on Windows instead of tearing down the tree.
      expect(proc.kill).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('runCommand: spawns detached on POSIX but not on a win32-stubbed platform, and kills via taskkill on win32', async () => {
    const restorePosix = stubPlatform('linux');
    let seenOptions: Record<string, unknown> = {};
    vi.mocked(spawn).mockImplementationOnce((_cmd, _args, opts) => {
      seenOptions = opts as Record<string, unknown>;
      const proc = fakeChildProcess();
      queueMicrotask(() => proc.emit('close', 0, null));
      return proc;
    });
    await runCommand(makeCtx({ projectDir: '/nonexistent' }), 'npm', ['install'], 5_000);
    expect(seenOptions.detached).toBe(true);
    restorePosix();

    const restoreWin = stubPlatform('win32');
    try {
      const controller = new AbortController();
      let proc!: ChildProcess;
      vi.mocked(spawn).mockImplementationOnce((_cmd, _args, opts) => {
        seenOptions = opts as Record<string, unknown>;
        proc = fakeChildProcess();
        queueMicrotask(() => controller.abort());
        return proc;
      });
      vi.mocked(nodeSpawn).mockImplementationOnce(() => {
        queueMicrotask(() => proc.emit('close', null, 'SIGTERM'));
        return new EventEmitter() as unknown as ChildProcess;
      });

      const result = await runCommand(
        makeCtx({ projectDir: '/nonexistent', signal: controller.signal }),
        'npm',
        ['install'],
        5_000,
      );

      expect(seenOptions.detached).toBe(false);
      expect(result.aborted).toBe(true);
      expect(nodeSpawn).toHaveBeenCalledWith(
        'taskkill',
        ['/F', '/T', '/PID', '9999'],
        expect.objectContaining({ stdio: 'ignore' }),
      );
      expect(proc.kill).not.toHaveBeenCalled();
    } finally {
      restoreWin();
    }
  });
});
