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

import spawn from 'cross-spawn';
import type { GeneratedSpec, TestModeContext } from '../types.js';
import {
  execute,
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
  type AuthSignals,
} from './execute.js';
import { EXEC_CHECKPOINT_FILENAME, EXEC_CHECKPOINT_INVERT_FILENAME } from './templates.js';

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
    expect(outcome).toEqual({ passed: 0, failed: 0, blocked: 0, flaky: 0, results: [] });
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
});

describe('mergeParsedReports', () => {
  it('unions two disjoint result sets and recomputes counts from the union', () => {
    const a = {
      results: [{ title: 'a', status: 'passed' as const }],
      passed: 1,
      failed: 0,
      blocked: 0,
      flaky: 0,
    };
    const b = {
      results: [{ title: 'b', status: 'failed' as const }],
      passed: 0,
      failed: 1,
      blocked: 0,
      flaky: 0,
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
    };
    const b = {
      results: [{ title: 'a', specFile: 'x.spec.ts', status: 'passed' as const }],
      passed: 1,
      failed: 0,
      blocked: 0,
      flaky: 0,
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
      { key: 'k-a', title: 'a', project: 'tierA-public', specFile: 'tests/tierA-public/a.spec.ts', status: 'expected' },
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
      { key: 'k-a', title: 'a', project: 'tierA-public', specFile: 'tests/tierA-public/a.spec.ts', status: 'expected' },
      { key: 'k-b', title: 'b', project: 'tierA-public', specFile: 'tests/tierA-public/b.spec.ts', status: 'expected' },
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

  it('clears the checkpoint after a full, successful (non-aborted) completion', async () => {
    writeCheckpointEntries([
      { key: 'k-a', title: 'a', project: 'tierA-public', specFile: 'tests/tierA-public/a.spec.ts', status: 'expected' },
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
      { key: 'k-a', title: 'a', project: 'tierA-public', specFile: 'tests/tierA-public/a.spec.ts', status: 'expected' },
    ]);
    const controller = new AbortController();
    vi.mocked(spawn).mockImplementationOnce(() => {
      // Unlike fakeChildProcess(), this one only closes once killed — so the
      // abort (queued right after this mock returns, but processed by
      // runPlaywright's signal listener, which is attached synchronously
      // right after spawn() returns) reliably happens BEFORE any close event,
      // instead of racing an auto-close microtask scheduled at construction.
      const proc = new EventEmitter() as unknown as ChildProcess;
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

    const outcome = await execute(makeCtx({ projectDir: dir, signal: controller.signal }), SPECS);

    expect((outcome.raw as { aborted?: boolean } | undefined)?.aborted).toBe(true);
    const remaining = await readCheckpointEntries(dir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe('a');
  });
});
