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
import { execute, suiteEnv } from './execute.js';

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
