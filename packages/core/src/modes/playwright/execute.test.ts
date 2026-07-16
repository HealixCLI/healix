/**
 * Unit tests for the execute-phase security/cancellation surface:
 *   - suiteEnv: generated specs are untrusted model output, so the suite
 *     subprocess env must be an ALLOWLIST — host secrets (API keys, tokens)
 *     must never reach `npx playwright test`, while PATH/HEALIX_* survive.
 *   - execute() with a pre-aborted signal: returns an aborted outcome without
 *     spawning any subprocess (spawn is spied via a module mock) and without
 *     throwing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// Spy on spawn so the pre-abort test can prove NOTHING was executed. The
// actual implementation is preserved for any test that legitimately spawns.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

import { spawn } from 'node:child_process';
import type { GeneratedSpec, TestModeContext } from '../types.js';
import {
  execute,
  suiteEnv,
  parseReport,
  findAuthSetupOutcome,
  playwrightProjectArgs,
  type AuthSignals,
} from './execute.js';

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

  it('injects HEALIX_TIERB_EMAIL/PASSWORD and a /login default from baseUrl when both credentials are set', () => {
    const env = suiteEnv(
      makeCtx({ baseUrl: 'http://localhost:3000', testUsername: 'user@test.com', testPassword: 'hunter2' }),
    );
    expect(env.HEALIX_TIERB_EMAIL).toBe('user@test.com');
    expect(env.HEALIX_TIERB_PASSWORD).toBe('hunter2');
    expect(env.HEALIX_TIERB_LOGIN_URL).toBe('http://localhost:3000/login');
  });

  it('injects neither credential var when only one of username/password is set (fixture requires both)', () => {
    const withOnlyUsername = suiteEnv(makeCtx({ baseUrl: 'http://localhost:3000', testUsername: 'user' }));
    expect(withOnlyUsername.HEALIX_TIERB_EMAIL).toBeUndefined();
    expect(withOnlyUsername.HEALIX_TIERB_LOGIN_URL).toBeUndefined();

    const withOnlyPassword = suiteEnv(makeCtx({ baseUrl: 'http://localhost:3000', testPassword: 'hunter2' }));
    expect(withOnlyPassword.HEALIX_TIERB_PASSWORD).toBeUndefined();
    expect(withOnlyPassword.HEALIX_TIERB_LOGIN_URL).toBeUndefined();
  });

  it('does not inject a login URL when credentials are set but no baseUrl is configured', () => {
    const env = suiteEnv(makeCtx({ testUsername: 'user', testPassword: 'hunter2' }));
    expect(env.HEALIX_TIERB_EMAIL).toBe('user');
    expect(env.HEALIX_TIERB_PASSWORD).toBe('hunter2');
    expect(env.HEALIX_TIERB_LOGIN_URL).toBeUndefined();
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
