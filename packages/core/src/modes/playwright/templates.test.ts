import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  actionHighlighterFixtureContents,
  authSetupContents,
  checkpointReporterContents,
  EXEC_CHECKPOINT_FILENAME,
  mockFixtureContents,
  MOCK_PASSTHROUGH_LOG_FILENAME,
  MOCK_REQUEST_LOG_FILENAME,
  playwrightConfigContents,
  stepsReporterContents,
} from './templates.js';

/**
 * Pulls computeWorkers()'s body out of the generated config source and
 * re-evaluates it with fake cpus()/freemem() so its arithmetic is actually
 * exercised, not just grepped for as a substring.
 */
function evalComputeWorkers(cpuCount: number, freeMemBytes: number): number {
  const cfg = playwrightConfigContents();
  const match = /function computeWorkers\(\) \{[\s\S]*?\n\}/.exec(cfg);
  if (!match) throw new Error('computeWorkers() not found in generated config');
  const fn = new Function('cpus', 'freemem', `${match[0]}\nreturn computeWorkers();`) as (
    cpus: () => unknown[],
    freemem: () => number,
  ) => number;
  return fn(
    () => Array.from({ length: cpuCount }),
    () => freeMemBytes,
  );
}

describe('playwrightConfigContents — artifact capture policy', () => {
  it('records a screenshot, video, AND trace for every test, pass or fail', () => {
    const cfg = playwrightConfigContents();
    // 'on' (not 'retain-on-failure' / 'only-on-failure') is load-bearing: the
    // run detail must have full evidence to show for EVERY test, not just failures.
    expect(cfg).toContain("screenshot: 'on'");
    expect(cfg).toContain("video: 'on'");
    expect(cfg).toContain("trace: 'on'");
  });

  it('declares the json/html/list reporters that produce results.json and playwright-report/', () => {
    const cfg = playwrightConfigContents();
    expect(cfg).toContain("['json', { outputFile: 'results.json' }]");
    expect(cfg).toContain("['html', { open: 'never' }]");
    expect(cfg).toContain("['list']");
  });

  it('honors HEALIX_BASE_URL over any baked-in base URL', () => {
    expect(playwrightConfigContents({ baseUrl: 'http://example.test' })).toContain(
      'process.env.HEALIX_BASE_URL || "http://example.test"',
    );
    expect(playwrightConfigContents()).toContain("process.env.HEALIX_BASE_URL || 'http://localhost:3000'");
  });

  it('enables retries locally so flaky detection can trigger (overridable via HEALIX_RETRIES)', () => {
    const cfg = playwrightConfigContents();
    // Local default must be non-zero (1) or a fail-then-pass can never register
    // as flaky; CI gets 2; HEALIX_RETRIES overrides both.
    expect(cfg).toContain('process.env.HEALIX_RETRIES');
    expect(cfg).toContain('process.env.CI ? 2 : 1');
  });

  it('sizes workers dynamically off CPU/RAM locally, but keeps a fixed count on CI, unless HEALIX_WORKERS overrides both', () => {
    const cfg = playwrightConfigContents();
    expect(cfg).toContain('process.env.HEALIX_WORKERS');
    expect(cfg).toContain('process.env.CI');
    expect(cfg).toContain('computeWorkers()');
    expect(cfg).toContain('cpus().length');
    expect(cfg).toContain('freemem()');
    // Leaves one core free for the host OS/desktop app, never claims 0 workers.
    expect(cfg).toContain('Math.max(1, cpuCount - 1)');
  });

  describe('computeWorkers() — actual arithmetic, not just source text', () => {
    const GB = 1024 ** 3;

    it('is CPU-bound when RAM is plentiful: 8 cores, 8GB free -> 7 (cores - 1)', () => {
      expect(evalComputeWorkers(8, 8 * GB)).toBe(7);
    });

    it('is memory-bound when RAM is scarce: 8 cores, 1GB free -> 1 (floored, never 0)', () => {
      expect(evalComputeWorkers(8, 1 * GB)).toBe(1);
    });

    it('never claims 0 workers on a single-core machine, even with ample RAM', () => {
      expect(evalComputeWorkers(1, 8 * GB)).toBe(1);
    });

    it('rounds down to whole workers off free RAM: 8 cores, 2GB free -> 2 (2 / 0.75 floored)', () => {
      expect(evalComputeWorkers(8, 2 * GB)).toBe(2);
    });
  });

  it('registers the write-through checkpoint reporter alongside steps-reporter', () => {
    const cfg = playwrightConfigContents();
    expect(cfg).toContain("['./fixtures/steps-reporter.cjs']");
    expect(cfg).toContain("['./fixtures/checkpoint-reporter.cjs']");
  });

  describe('F-18 — auth-setup registration gated on the plan actually having tierB-auth items', () => {
    it('registers the auth-setup project by default (includeAuthSetup unset)', () => {
      const cfg = playwrightConfigContents();
      expect(cfg).toContain("name: 'auth-setup'");
      expect(cfg).toContain("dependencies: ['auth-setup']");
    });

    it('still registers auth-setup when includeAuthSetup is explicitly true', () => {
      const cfg = playwrightConfigContents({ includeAuthSetup: true });
      expect(cfg).toContain("name: 'auth-setup'");
      expect(cfg).toContain("dependencies: ['auth-setup']");
    });

    it("omits the auth-setup project AND tierB-auth's dependency on it when includeAuthSetup is false — an app with no auth surface must never get a phantom auth-setup failure", () => {
      const cfg = playwrightConfigContents({ includeAuthSetup: false });
      expect(cfg).not.toContain("name: 'auth-setup'");
      expect(cfg).not.toContain("dependencies: ['auth-setup']");
      // tierB-auth's project entry itself must still exist (harmless empty project).
      expect(cfg).toContain("name: 'tierB-auth'");
    });
  });
});

describe('actionHighlighterFixtureContents', () => {
  it('injects a passive, event-driven highlighter via addInitScript — no wrapping of Locator methods', () => {
    const src = actionHighlighterFixtureContents();
    expect(src).toContain("from '@playwright/test'");
    expect(src).toContain('page.addInitScript(healixActionHighlighter)');
    expect(src).toContain('export { expect };');
    // Reacts to real DOM events Playwright's own actions already dispatch —
    // never wraps click()/fill()/etc., since Locator isn't an exported class.
    for (const evt of ['mousemove', 'pointerdown', 'focusin', 'scroll']) {
      expect(src).toContain(`'${evt}'`);
    }
    expect(src.match(/addEventListener/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it('never calls waitForTimeout or sleeps — highlighting must add no artificial delay to the actual run', () => {
    const src = actionHighlighterFixtureContents();
    expect(src).not.toContain('waitForTimeout');
    expect(src).not.toContain('slowMo');
  });

  it('wraps the `request` fixture to log real (unmocked) API calls as evidence, tagged [REAL BACKEND]', () => {
    const src = actionHighlighterFixtureContents();
    // The mock-disabled path: request calls hit the real backend, and are logged.
    expect(src).toContain('request: async ({ request }, use, testInfo)');
    expect(src).toContain('logApiEvidence');
    expect(src).toContain('join(process.cwd(), "healix-api-evidence-log.ndjson")');
    // Every HTTP verb is wrapped so no call type escapes logging.
    for (const verb of ['get', 'post', 'put', 'patch', 'delete', 'fetch']) {
      expect(src).toContain(`${verb}:`);
    }
    // Logged as REAL (not a Healix mock) since nothing is intercepted here.
    expect(src).toContain(', false)'); // logApiEvidence(..., mocked=false)
  });

  it('patches browser.newContext() to record and attach video for manually-created contexts', () => {
    const src = actionHighlighterFixtureContents();
    // Guarded so the patch is only installed once per worker, not re-wrapped every test.
    expect(src).toContain('__healixVideoPatched');
    expect(src).toContain('browser.newContext.bind(browser)');
    // recordVideo is injected, but a caller's own options (if any) still win via the spread order.
    expect(src).toContain('recordVideo: { dir: info.outputDir }, ...options');
    // Every page opened in the manually-created context gets tracked and its video attached on close.
    expect(src).toContain("ctx.on('page'");
    expect(src).toContain("ctx.on('close'");
    expect(src).toContain('.video()?.path()');
    expect(src).toContain("contentType: 'video/webm'");
    // The default context/page fixture also routes through browser.newContext()
    // and already requests + attaches its own video — skip re-attaching it
    // here so every test doesn't get a duplicate (broken, mid-recording) video.
    expect(src).toContain('isDefaultContext');
  });
});

describe('evidenceKey — the shared test-identity used by apiEvidence/mockPassthrough/mockedRequestCountsByTest', () => {
  it('computes the key relative to testInfo.config.rootDir, NOT process.cwd() (regression: the two differ by testDir in every real run)', () => {
    // Root-cause regression: process.cwd() during a real Playwright run is the SUITE root
    // (execute.ts spawns with cwd: ctx.projectDir), but playwrightConfigContents() sets
    // testDir: './tests' — one path segment deeper — and Playwright's own JSON reporter
    // writes spec.file relative to THAT (rootDir), not cwd. Using process.cwd() here meant
    // every real run's key carried an extra 'tests/' prefix the orchestrator's lookup
    // (built from the JSON report's specFile, with no such prefix) could never match —
    // apiEvidence/mockPassthrough/mockedRequestCountsByTest silently found nothing, in
    // every real run, despite passing every existing test (which hand-construct both
    // sides of the identity consistently, so the mismatch never had a chance to surface).
    const src = actionHighlighterFixtureContents();
    expect(src).toContain(
      "return relative(testInfo.config.rootDir, testInfo.file).split(sep).join('/') + '#' + testInfo.title;",
    );
    expect(src).not.toContain('relative(process.cwd(), testInfo.file)');
  });

  it('is defined once and shared identically by BOTH actionHighlighterFixtureContents and mockFixtureContents (single source of truth)', () => {
    const actionSrc = actionHighlighterFixtureContents();
    const mockSrc = mockFixtureContents([]);
    const extract = (src: string) => /function evidenceKey\(testInfo\) \{[\s\S]*?\n\}/.exec(src)?.[0];
    const actionFn = extract(actionSrc);
    const mockFn = extract(mockSrc);
    expect(actionFn).toBeDefined();
    expect(actionFn).toBe(mockFn);
  });
});

describe('stepsReporterContents', () => {
  it('keeps test.step (human-authored step names) alongside pw:api/expect as a fallback', () => {
    const src = stepsReporterContents();
    expect(src).toContain("'test.step'");
    expect(src).toContain("'pw:api'");
    expect(src).toContain("'expect'");
  });

  it("strips ANSI color codes from a step error — verified live against a real failing step's raw message", () => {
    const src = stepsReporterContents();
    expect(src).toContain('stripAnsi(s.error.message');
    expect(src).toContain('ANSI_RE');
  });

  it("nests a test.step task's raw pw:api/expect actions underneath it, not flattened alongside it", () => {
    const src = stepsReporterContents();
    // A test.step wrapper's own .steps children are captured as nested
    // entries; a bare pw:api/expect step (no wrapper) gets no children of
    // its own — see toStepItem's category check.
    expect(src).toContain("s.category === 'test.step'");
    expect(src).toContain('.map(toStepItem)');
  });
});

describe('checkpointReporterContents', () => {
  it('only appends once a test is truly final (passed, or every configured retry used)', () => {
    const src = checkpointReporterContents();
    // Verified empirically against a real Playwright run: test.outcome() is
    // NOT reliable mid-retry (it reports 'unexpected' even on attempt 1 of a
    // 2-retry config) — result.retry >= test.retries is what's actually safe.
    expect(src).toContain("result.status === 'passed' || result.retry >= test.retries");
  });

  it('builds the key from test.titlePath(), matching --list/--test-list-invert format exactly', () => {
    const src = checkpointReporterContents();
    expect(src).toContain('test.titlePath()');
    expect(src).toContain("'[' + parts[0] + '] \\u203a '");
  });

  it('writes to the shared EXEC_CHECKPOINT_FILENAME constant, not a hardcoded string', () => {
    const src = checkpointReporterContents();
    expect(src).toContain(JSON.stringify(EXEC_CHECKPOINT_FILENAME));
  });

  it('strips ANSI color codes from a persisted error, same as steps-reporter.cjs', () => {
    const src = checkpointReporterContents();
    expect(src).toContain('stripAnsi(result.error.stack || result.error.message');
    expect(src).toContain('ANSI_RE');
  });

  it('never throws the test run over a write failure', () => {
    const src = checkpointReporterContents();
    expect(src).toMatch(/catch\s*\{/);
  });

  it("QA request: recovers a skip reason from test.skip(cond, 'reason')/test.fixme(...) annotations", () => {
    const src = checkpointReporterContents();
    expect(src).toContain("'skip'");
    expect(src).toContain("'fixme'");
    expect(src).toContain('skipReason:');
  });

  describe('live execution — the generated reporter actually run, not just grepped', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'healix-checkpoint-reporter-'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    function loadReporter(): new () => { onTestEnd(test: unknown, result: unknown): void } {
      const reporterPath = join(dir, 'checkpoint-reporter.cjs');
      writeFileSync(reporterPath, checkpointReporterContents(), 'utf-8');
      const req = createRequire(import.meta.url);
      delete req.cache[req.resolve(reporterPath)];
      return req(reporterPath);
    }

    function fakeTest(
      retries: number,
      titlePath: string[],
      outcome = 'expected',
      annotations?: Array<{ type?: string; description?: string }>,
    ) {
      return { retries, titlePath: () => ['', ...titlePath], outcome: () => outcome, annotations };
    }

    async function readCheckpointLines(): Promise<Array<Record<string, unknown>>> {
      let raw: string;
      try {
        raw = await readFile(join(dir, EXEC_CHECKPOINT_FILENAME), 'utf-8');
      } catch {
        return [];
      }
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    }

    it('does not append when a failing attempt still has retries left', async () => {
      const Reporter = loadReporter();
      const reporter = new Reporter();
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        reporter.onTestEnd(fakeTest(1, ['tierA-public', 'a.spec.ts', 'does a thing']), {
          status: 'failed',
          retry: 0,
          duration: 12,
        });
      } finally {
        process.chdir(cwd);
      }
      expect(await readCheckpointLines()).toEqual([]);
    });

    it('appends once every configured retry is exhausted', async () => {
      const Reporter = loadReporter();
      const reporter = new Reporter();
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        reporter.onTestEnd(fakeTest(1, ['tierA-public', 'a.spec.ts', 'does a thing'], 'unexpected'), {
          status: 'unexpected',
          retry: 1,
          duration: 34,
          error: { message: 'boom' },
        });
      } finally {
        process.chdir(cwd);
      }
      const lines = await readCheckpointLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        project: 'tierA-public',
        specFile: 'a.spec.ts',
        title: 'does a thing',
        key: '[tierA-public] › a.spec.ts › does a thing',
        durationMs: 34,
        error: 'boom',
      });
    });

    it('appends immediately on a first-attempt pass, even with retries configured', async () => {
      const Reporter = loadReporter();
      const reporter = new Reporter();
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        reporter.onTestEnd(fakeTest(2, ['tierC-api', 'b.spec.ts', 'passes']), {
          status: 'passed',
          retry: 0,
          duration: 5,
        });
      } finally {
        process.chdir(cwd);
      }
      const lines = await readCheckpointLines();
      expect(lines).toHaveLength(1);
      expect(lines[0].status).toBe('expected');
    });

    it('strips ANSI escapes from the persisted error text', async () => {
      const Reporter = loadReporter();
      const reporter = new Reporter();
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        reporter.onTestEnd(fakeTest(0, ['tierA-public', 'a.spec.ts', 'fails loudly'], 'unexpected'), {
          status: 'unexpected',
          retry: 0,
          duration: 1,
          error: { stack: '[31mExpected true, got false[0m' },
        });
      } finally {
        process.chdir(cwd);
      }
      const lines = await readCheckpointLines();
      expect(lines[0].error).toBe('Expected true, got false');
    });

    it("QA request: captures the skip reason from a real test.skip(cond, 'reason') annotation", async () => {
      const Reporter = loadReporter();
      const reporter = new Reporter();
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        reporter.onTestEnd(
          fakeTest(0, ['tierA-public', 'a.spec.ts', 'staging-only check'], 'skipped', [
            { type: 'skip', description: 'staging-only feature not enabled here' },
          ]),
          { status: 'skipped', retry: 0, duration: 0 },
        );
      } finally {
        process.chdir(cwd);
      }
      const lines = await readCheckpointLines();
      expect(lines[0]).toMatchObject({
        status: 'skipped',
        skipReason: 'staging-only feature not enabled here',
      });
    });

    it('omits skipReason for a bare skip with no annotation description', async () => {
      const Reporter = loadReporter();
      const reporter = new Reporter();
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        reporter.onTestEnd(fakeTest(0, ['tierA-public', 'a.spec.ts', 'bare skip'], 'skipped', []), {
          status: 'skipped',
          retry: 0,
          duration: 0,
        });
      } finally {
        process.chdir(cwd);
      }
      const lines = await readCheckpointLines();
      expect(lines[0].skipReason).toBeUndefined();
    });

    it('swallows a write failure instead of throwing (best-effort contract)', () => {
      const Reporter = loadReporter();
      const reporter = new Reporter();
      const cwd = process.cwd();
      // Make the checkpoint file's own path a directory, so appendFileSync
      // throws EISDIR — without touching cwd itself (deleting cwd is
      // unreliable across platforms, notably Windows).
      mkdirSync(join(dir, EXEC_CHECKPOINT_FILENAME));
      process.chdir(dir);
      try {
        expect(() =>
          reporter.onTestEnd(fakeTest(0, ['tierA-public', 'a.spec.ts', 'whatever']), {
            status: 'passed',
            retry: 0,
            duration: 1,
          }),
        ).not.toThrow();
      } finally {
        process.chdir(cwd);
      }
    });
  });
});

describe('mockFixtureContents', () => {
  it('embeds the given routes and re-exports test/expect from the action-highlighter fixture', () => {
    const src = mockFixtureContents([
      { id: 'pkg:twilio', hostnames: ['api.twilio.com'], response: { status: 200, body: { ok: true } } },
    ]);
    // Chains on top of the highlighter (not '@playwright/test' directly) so a
    // mocked run's recorded video still gets the visual action highlighter.
    expect(src).toContain("from './action-highlighter.js'");
    expect(src).toContain('"id": "pkg:twilio"');
    expect(src).toContain('"api.twilio.com"');
    expect(src).toContain('page.route(');
    expect(src).toContain('export { expect };');
  });

  it('produces a harmless no-op fixture for an empty route list', () => {
    const src = mockFixtureContents([]);
    expect(src).toContain('const MOCKED_ROUTES = []');
  });

  it('logs each mocked request-fixture call as evidence, tagged [HEALIX MOCK] (mocked=true)', () => {
    const src = mockFixtureContents([
      { id: 'pkg:stripe', hostnames: ['api.stripe.com'], response: { status: 200, body: { ok: true } } },
    ]);
    expect(src).toContain('logApiEvidence');
    expect(src).toContain('join(process.cwd(), "healix-api-evidence-log.ndjson")');
    // The fake request path logs with mocked=true (distinguishing it from the
    // real-backend path in action-highlighter.js).
    expect(src).toContain("await logApiEvidence(key, method, requestPath || '', canned.status, text, true)");
  });

  describe('F-13/F-14 — path-aware resolution across ALL mocked routes, not just the first one', () => {
    /** Pulls a named top-level function's source out of the generated fixture so its actual logic (not just a substring) is exercised. */
    function extractFunctionSource(src: string, name: string): string {
      const re = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`);
      const m = re.exec(src);
      if (!m) throw new Error(`${name} not found in generated fixture`);
      return m[0];
    }

    /** Re-evaluates the generated fixture's real pathMatches()/matchAnyRoute(), with a controllable `overrides` array closed over the same way the fixture's own module-scoped `let overrides` is. */
    function loadMatchAnyRoute(
      src: string,
      overrides: Array<{ method: string; pathPattern: string; response: unknown }>,
    ): (
      routes: unknown[],
      method: string,
      path: string,
      opts?: { allowGenericFallback?: boolean },
    ) => { id?: string; response?: unknown } {
      const pathMatchesSrc = extractFunctionSource(src, 'pathMatches');
      const matchSrc = extractFunctionSource(src, 'matchAnyRoute');
      const factory = new Function('overrides', `${pathMatchesSrc}\n${matchSrc}\nreturn matchAnyRoute;`) as (
        o: unknown,
      ) => (
        routes: unknown[],
        method: string,
        path: string,
        opts?: { allowGenericFallback?: boolean },
      ) => { id?: string; response?: unknown };
      return factory(overrides);
    }

    const depA = {
      id: 'dep-a',
      hostnames: ['a.example.com'],
      response: { status: 200, body: { from: 'a-default' } },
      endpoints: [
        {
          method: 'POST',
          pathPattern: '/v3/oauth/token/generate',
          response: { status: 200, body: { token: 'real-token' } },
        },
      ],
    };
    const depB = {
      id: 'dep-b',
      hostnames: ['b.example.com'],
      response: { status: 200, body: { from: 'b-default', customerProfile: true } },
    };

    it("F-13: a request-fixture-style call matches the CORRECT dependency's endpoint, not always the first registered route", () => {
      const src = mockFixtureContents([depB, depA]); // depB registered FIRST — the old bug always served this one
      const match = loadMatchAnyRoute(src, []);
      const result = match([depB, depA], 'POST', '/v3/oauth/token/generate');
      // Must resolve depA's specific endpoint response, not depB's generic default.
      expect(result.response).toEqual({ status: 200, body: { token: 'real-token' } });
      expect(result.id).toBe('dep-a');
    });

    it("falls back to the first route's generic default only when NO route anywhere has a matching endpoint", () => {
      const src = mockFixtureContents([depA, depB]);
      const match = loadMatchAnyRoute(src, []);
      const result = match([depA, depB], 'GET', '/unmatched/path');
      expect(result.response).toEqual(depA.response);
      expect(result.id).toBe('dep-a');
    });

    it("a per-test mockOverride still wins over every route's own endpoint/default response", () => {
      const src = mockFixtureContents([depA, depB]);
      const overrideResponse = { status: 500, body: { error: 'forced' } };
      const match = loadMatchAnyRoute(src, [
        { method: 'POST', pathPattern: '/v3/oauth/token/generate', response: overrideResponse },
      ]);
      const result = match([depA, depB], 'POST', '/v3/oauth/token/generate');
      expect(result.response).toEqual(overrideResponse);
      // The override still resolves against depA's own endpoint match, so the
      // hit is still attributable to the right dependency for F-15's counting.
      expect(result.id).toBe('dep-a');
    });

    it('the `request` fixture resolves via matchAnyRoute (all routes), not MOCKED_ROUTES[0] alone', () => {
      const src = mockFixtureContents([depB, depA]);
      expect(src).toContain('matchAnyRoute(MOCKED_ROUTES, method,');
      expect(src).not.toMatch(/const route = MOCKED_ROUTES\[0\]/);
    });

    describe('Cluster F — allowGenericFallback opt-out (page.route no-hostname-match branch)', () => {
      it('with allowGenericFallback: false, resolves a request matching an endpoint on a DIFFERENT route (known call, misdetected/stale host)', () => {
        const src = mockFixtureContents([depA, depB]);
        const match = loadMatchAnyRoute(src, []);
        const result = match([depA, depB], 'POST', '/v3/oauth/token/generate', {
          allowGenericFallback: false,
        });
        expect(result.response).toEqual({ status: 200, body: { token: 'real-token' } });
        expect(result.id).toBe('dep-a');
      });

      it('with allowGenericFallback: false, returns an undefined response (never a generic default) when NO route anywhere has a matching endpoint — the regression guard against wrongly mocking a genuinely different third-party host', () => {
        const src = mockFixtureContents([depA, depB]);
        const match = loadMatchAnyRoute(src, []);
        const result = match([depA, depB], 'GET', '/totally/unrelated/analytics/beacon', {
          allowGenericFallback: false,
        });
        expect(result.response).toBeUndefined();
      });

      it('with allowGenericFallback: false, an override still resolves (an explicitly-registered override is never "an unrelated third party")', () => {
        const src = mockFixtureContents([depA, depB]);
        const overrideResponse = { status: 500, body: { error: 'forced' } };
        const match = loadMatchAnyRoute(src, [
          { method: 'GET', pathPattern: '/x', response: overrideResponse },
        ]);
        const result = match([depA, depB], 'GET', '/x', { allowGenericFallback: false });
        expect(result.response).toEqual(overrideResponse);
      });

      it("omitting opts (the `request`-fixture call site) keeps today's behavior — generic fallback still allowed", () => {
        const src = mockFixtureContents([depA, depB]);
        const match = loadMatchAnyRoute(src, []);
        const result = match([depA, depB], 'GET', '/unmatched/path');
        expect(result.response).toEqual(depA.response);
      });
    });

    it('F-14: page.route() registers ONE catch-all interceptor and decides per-request whether a host OR an override matches, instead of one predicate per hostname', () => {
      const src = mockFixtureContents([depA]);
      expect(src).toContain("page.route('**/*', async (r) => {");
      // Must consult BOTH signals — a configured host, or an explicitly
      // registered override — since an override registered for a relative
      // path has no hostname to match against at all (a same-origin fetch).
      expect(src).toContain('const hostRoute = MOCKED_ROUTES.find(');
      expect(src).toContain('const overrideMatches = overrides.some(');
      // When there's no host match, resolution still goes through the
      // any-route resolver (which checks overrides) instead of skipping the
      // override-only, same-origin case — but (Cluster F) it must NOT allow
      // the any-route resolver's generic-default fallback unless an override
      // actually matched, so a genuinely unrelated third-party host isn't
      // wrongly mocked with some other dependency's default response.
      expect(src).toContain(
        'matchAnyRoute(MOCKED_ROUTES, method, requestPath, { allowGenericFallback: overrideMatches })',
      );
      // Only falls through to the real network (and logs it) when nothing resolved a response.
      expect(src).toContain('if (!response) {');
      expect(src).toContain('await r.continue();');
    });
  });

  describe('F-15 — every intercepted request is logged so mockedRequestCounts can reflect fixture-level mocking', () => {
    it('logs a hit (with the resolved dependency id, the test-identity key, the matched endpoint method/pathPattern, AND the actually-served status/body) whenever page.route() fulfills a mocked request', () => {
      const src = mockFixtureContents([
        { id: 'pkg:twilio', hostnames: ['api.twilio.com'], response: { status: 200, body: { ok: true } } },
      ]);
      expect(src).toContain(
        'await logMockHit(key, matchedId, matchedMethod, matchedPathPattern, response.status, contentType, text);',
      );
      expect(src).toContain("import { appendFile } from 'node:fs/promises';");
      expect(src).toContain('MOCK_REQUEST_LOG_PATH');
      expect(src).toContain(JSON.stringify(MOCK_REQUEST_LOG_FILENAME));
    });

    it('logs a hit (with the test-identity key, the matched endpoint method/pathPattern, AND the actually-served status/body) whenever the `request` fixture serves a mocked response', () => {
      const src = mockFixtureContents([
        { id: 'pkg:twilio', hostnames: ['api.twilio.com'], response: { status: 200, body: { ok: true } } },
      ]);
      expect(src).toContain(
        'await logMockHit(key, match.id, match.method, match.pathPattern, canned.status, contentType, text);',
      );
    });

    it('logs each hit against the SAME test-identity key evidenceKey(testInfo) computes for API evidence, so mock hits can be attributed to the test that caused them (test_mock_usage)', () => {
      const src = mockFixtureContents([
        { id: 'pkg:twilio', hostnames: ['api.twilio.com'], response: { status: 200, body: { ok: true } } },
      ]);
      // Both fixtures compute `key` from evidenceKey(testInfo) before ever calling logMockHit —
      // proves the key passed to logMockHit is the same identity used elsewhere for per-test
      // attribution (specFile#title), not a separately-invented one.
      const pageFixtureSrc = src.slice(
        src.indexOf('page: async ({ page, mockOverride }, use, testInfo) => {'),
        src.indexOf('await logMockHit(key, matchedId,'),
      );
      expect(pageFixtureSrc).toContain('const key = evidenceKey(testInfo);');
      const requestFixtureSrc = src.slice(
        src.indexOf('request: async ({ request, mockOverride }, use, testInfo) => {'),
        src.indexOf('await logMockHit(key, match.id,'),
      );
      expect(requestFixtureSrc).toContain('const key = evidenceKey(testInfo);');
    });

    it('logs the ACTUALLY-served status/body (post serializeBody), not the pre-generated mock_status/mock_body_json, so mock_responses.observed_* reflects what really shipped', () => {
      const src = mockFixtureContents([
        { id: 'pkg:twilio', hostnames: ['api.twilio.com'], response: { status: 200, body: { ok: true } } },
      ]);
      // Both call sites compute { contentType, text } via serializeBody(...) BEFORE calling
      // logMockHit, and pass those exact locals through — not the route's original response
      // object — so a per-test mockOverride() substitution is captured too.
      expect(src).toMatch(
        /const \{ contentType, text \} = serializeBody\(response\);\s*\n\s*await logMockHit\(key, matchedId, matchedMethod, matchedPathPattern, response\.status, contentType, text\);/,
      );
      expect(src).toMatch(
        /const \{ contentType, text \} = serializeBody\(canned\);\s*\n\s*await logMockHit\(key, match\.id, match\.method, match\.pathPattern, canned\.status, contentType, text\);/,
      );
    });

    it("logs the matched endpoint's own (method, pathPattern) — the SAME values seeded into mock_responses.method/path_pattern at generation time — so a hit can be resolved to its EXACT row, not just its dependency", () => {
      const src = mockFixtureContents([
        {
          id: 'pkg:twilio',
          hostnames: ['api.twilio.com'],
          response: { status: 200, body: { ok: true } },
          endpoints: [{ method: 'POST', pathPattern: '/v1/otp/send', response: { status: 200, body: {} } }],
        },
      ]);
      expect(src).toMatch(
        /return \{ response: endpoint\.response, method: endpoint\.method, pathPattern: endpoint\.pathPattern \};/,
      );
      expect(src).toMatch(
        /return \{\s*id: route\.id,\s*response: override \? override\.response : endpoint\.response,\s*method: endpoint\.method,\s*pathPattern: endpoint\.pathPattern,?\s*\};/,
      );
      // The generic per-dependency fallback (no specific endpoint matched) explicitly logs
      // null/null — there is no single mock_responses row it unambiguously belongs to among
      // several endpoint-level rows, so it must never be attributed to the WRONG one.
      expect(src).toContain('return { response: route.response, method: null, pathPattern: null };');
    });

    it("uses the override's OWN (method, pathPattern) rather than null, so a negative-test override (e.g. simulating a 500) still attributes to a real mock_responses row when one exists for that exact endpoint", () => {
      const src = mockFixtureContents([
        { id: 'pkg:twilio', hostnames: ['api.twilio.com'], response: { status: 200, body: { ok: true } } },
      ]);
      expect(src).toContain(
        'if (override) return { response: override.response, method: override.method, pathPattern: override.pathPattern };',
      );
    });

    it('a logging failure never blocks or throws through the actual mocked response (best-effort contract)', () => {
      const src = mockFixtureContents([]);
      const fnSrc =
        /async function logMockHit\(key, id, method, pathPattern, status, contentType, body\) \{[\s\S]*?\n\}/.exec(
          src,
        )?.[0];
      expect(fnSrc).toBeDefined();
      expect(fnSrc).toMatch(/catch\s*\{/);
    });
  });

  describe('Cluster F — unmocked-passthrough logging (mockPassthrough)', () => {
    it('logs a passthrough entry (key, method, url) right before falling through to the real network', () => {
      const src = mockFixtureContents([
        { id: 'pkg:twilio', hostnames: ['api.twilio.com'], response: { status: 200, body: { ok: true } } },
      ]);
      expect(src).toContain('await logMockPassthrough(key, method, url);');
      // Must be called BEFORE r.continue(), not after (order matters for the log to be
      // written even if the continued request itself later hangs).
      const idx = src.indexOf('if (!response) {');
      const block = src.slice(idx, idx + 200);
      expect(block.indexOf('logMockPassthrough')).toBeGreaterThan(-1);
      expect(block.indexOf('logMockPassthrough')).toBeLessThan(block.indexOf('r.continue()'));
    });

    it('writes to a dedicated sidecar file, distinct from the mock-hit log', () => {
      const src = mockFixtureContents([]);
      expect(src).toContain('MOCK_PASSTHROUGH_LOG_PATH');
      expect(src).toContain(JSON.stringify(MOCK_PASSTHROUGH_LOG_FILENAME));
      expect(MOCK_PASSTHROUGH_LOG_FILENAME).not.toBe(MOCK_REQUEST_LOG_FILENAME);
    });

    it('keys the passthrough entry the same way API evidence is keyed, so it can be joined back to a test', () => {
      const src = mockFixtureContents([]);
      expect(src).toContain('const key = evidenceKey(testInfo);');
      expect(src).toContain('page: async ({ page, mockOverride }, use, testInfo) => {');
    });

    it('a logging failure never blocks or throws through the passthrough itself (best-effort contract)', () => {
      const src = mockFixtureContents([]);
      const fnSrc = /async function logMockPassthrough\(key, method, url\) \{[\s\S]*?\n\}/.exec(src)?.[0];
      expect(fnSrc).toBeDefined();
      expect(fnSrc).toMatch(/catch\s*\{/);
    });
  });
});

describe('authSetupContents — locale-aware login fixture', () => {
  it('matches email/password fields and the submit button in both English and common Slovak forms', () => {
    const fixture = authSetupContents();
    // Email: plain "email" and hyphenated "e-mail"/"e-mailová" forms.
    expect(fixture).toContain('/e-?mail/i');
    // Password: English + Slovak "Heslo".
    expect(fixture).toContain('/heslo|password/i');
    // Submit/reveal: English + Slovak "Prihlásiť" (matched via the "prihl" stem).
    expect(fixture).toContain('prihl');
  });

  it('clicks through a login-reveal control before searching for the form when no identifier field is visible', () => {
    const fixture = authSetupContents();
    expect(fixture).toContain('hasIdentifierField');
    expect(fixture).toContain('submitButtonLocator(page, loginRevealRe)');
  });

  it('matches a plain "Username" field, not just "email" — a real timeout-with-no-selector-context bug found live', () => {
    const fixture = authSetupContents();
    // The identifier field isn't always an email; plenty of real apps label it
    // just "Username" with nothing "email"-ish in the label, placeholder, or
    // name/id attributes either. Matching only /e-?mail/i finds nothing and
    // hangs the auth-setup for the full 60s test timeout.
    expect(fixture).toContain('user\\s*name');
    expect(fixture).toContain('autocomplete="username"');
  });

  it('prefers native submit semantics and test-hint attributes over localized button text when finding the submit button', () => {
    const fixture = authSetupContents();
    // A button's visible text is locale-dependent (e.g. a Slovak app's submit
    // button reads "Pokračovať", not "continue"/"prihl") — native type="submit"
    // and data-testid/name/id hints must be tried first, with the text regex
    // only as a last-resort fallback.
    expect(fixture).toContain('function submitButtonLocator(page, textRe)');
    expect(fixture).toContain('button[type="submit"], input[type="submit"]');
    expect(fixture).toContain('[data-testid*="submit" i]');
    expect(fixture).toContain('submitButtonLocator(page, /prihl|sign in|log ?in|continue|submit/i)');
  });

  it('F-16: matches a plain "Submit" button label — the RBAC live-run gap (an MUI <Button> with no type="submit" and no data-testid)', () => {
    const fixture = authSetupContents();
    const match = /guessSubmitButton = await submitButtonLocator\(page, (\/[^/]+\/i)\)/.exec(fixture);
    expect(match).not.toBeNull();
    const re = new Function(`return ${match![1]}`)();
    for (const label of ['Submit', 'SUBMIT', 'submit']) {
      expect(re.test(label)).toBe(true);
    }
    // Must not regress the pre-existing supported labels.
    for (const label of ['Sign in', 'Log in', 'Continue', 'Prihlásiť']) {
      expect(re.test(label)).toBe(true);
    }
  });

  it('prefers EXPLORE-grounded login selectors over the generic guesses, falling back when unset', () => {
    const fixture = authSetupContents();
    expect(fixture).toContain('function preferGrounded(page, groundedSelector, fallbackLocator, timeoutMs)');
    expect(fixture).toContain('HEALIX_TIERB_LOGIN_TOGGLE_SELECTOR');
    expect(fixture).toContain(
      'const identifierField = await preferGrounded(\n    page,\n    process.env.HEALIX_TIERB_LOGIN_IDENTIFIER_SELECTOR,\n    guessIdentifierField,\n    3000,\n  );',
    );
    expect(fixture).toContain(
      'const passwordField = await preferGrounded(\n    page,\n    process.env.HEALIX_TIERB_LOGIN_PASSWORD_SELECTOR,\n    guessPasswordField,\n    3000,\n  );',
    );
    expect(fixture).toContain(
      'const submitButton = await preferGrounded(page, groundedSubmitSelector, guessSubmitButton, 3000);',
    );
  });

  it('presses Enter instead of guessing a submit button when the form is grounded but EXPLORE captured no submit selector (proven Enter-driven login)', () => {
    const fixture = authSetupContents();
    // A grounded form with no submit selector is a PROVEN fact (see login.ts's own Enter-key
    // fallback), not a gap to guess at — must not fall through to guessSubmitButton in that case.
    expect(fixture).toContain(
      'const hasGroundedForm = !!(\n    process.env.HEALIX_TIERB_LOGIN_IDENTIFIER_SELECTOR || process.env.HEALIX_TIERB_LOGIN_PASSWORD_SELECTOR\n  );',
    );
    const ifIdx = fixture.indexOf('if (hasGroundedForm && !groundedSubmitSelector) {');
    expect(ifIdx).toBeGreaterThan(-1);
    const enterIdx = fixture.indexOf("await page.keyboard.press('Enter');", ifIdx);
    expect(enterIdx).toBeGreaterThan(ifIdx);
    const elseIdx = fixture.indexOf('} else {', enterIdx);
    expect(elseIdx).toBeGreaterThan(enterIdx);
    const guessIdx = fixture.indexOf('guessSubmitButton', elseIdx);
    expect(guessIdx).toBeGreaterThan(elseIdx);
  });

  it('still writes performedLogin:false before attempting login and true only after storageState is captured', () => {
    const fixture = authSetupContents();
    const beforeIdx = fixture.indexOf('writeMeta(false)');
    const loginCallIdx = fixture.indexOf('await login(page, defaultCred, loginUrl, baseUrl, authFile)');
    const storageIdx = fixture.indexOf('storageState({ path });');
    const afterIdx = fixture.indexOf('writeMeta(true)');
    expect(beforeIdx).toBeGreaterThanOrEqual(0);
    expect(beforeIdx).toBeLessThan(loginCallIdx);
    expect(loginCallIdx).toBeLessThan(afterIdx);
    // storageState is captured inside the shared login()/loginForm()/loginUrlToken() helpers.
    expect(storageIdx).toBeGreaterThanOrEqual(0);
  });

  it('dispatches to url-token login when a credential is authType url-token', () => {
    const fixture = authSetupContents();
    expect(fixture).toContain("cred.authType === 'url-token'");
    expect(fixture).toContain('loginUrlToken(page, cred, baseUrl, path)');
  });

  it('logs in every additional role-tagged credential into its own storageState file without blocking the default session', () => {
    const fixture = authSetupContents();
    expect(fixture).toContain('HEALIX_TIERB_CREDENTIALS_JSON');
    expect(fixture).toContain('roleStorageStatePath');
    expect(fixture).toContain('browser.newContext()');
  });

  it('throws immediately when credentials/login URL are not fully resolved, instead of writing an anonymous storageState', () => {
    const fixture = authSetupContents();
    // No env var is missing an anonymous fallback anymore: an incomplete
    // email/password/loginUrl trio must throw, not silently produce
    // {"cookies": [], "origins": []} — that anonymous session used to let
    // every Tier B spec run to its own 60s timeout instead of failing fast.
    expect(fixture).not.toContain('cookies: []');
    expect(fixture).not.toContain('access(authFile)');
    const guardIdx = fixture.indexOf('if (!email || !password || !loginUrl)');
    const throwIdx = fixture.indexOf('throw new Error(', guardIdx);
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(throwIdx).toBeGreaterThan(guardIdx);
    expect(fixture).toContain('Tier B auth setup skipped');
    expect(fixture).toContain('testUsername/testPassword');
  });

  it('writes performedLogin:false before throwing on the missing-credentials path, so post-run triage can classify it as blocked', () => {
    const fixture = authSetupContents();
    const guardIdx = fixture.indexOf('if (!email || !password || !loginUrl)');
    const blockStart = fixture.indexOf('{', guardIdx);
    const blockEnd = fixture.indexOf('}', fixture.indexOf('throw new Error(', guardIdx));
    const block = fixture.slice(blockStart, blockEnd);
    expect(block).toContain('writeMeta(false)');
    expect(block.indexOf('writeMeta(false)')).toBeLessThan(block.indexOf('throw new Error('));
  });

  it('verifies the login form actually navigated away before capturing storageState, instead of trusting a networkidle wait', () => {
    const fixture = authSetupContents();
    // GAP-017-style regression guard: a click that "succeeds" without ever
    // authenticating (wrong credentials, async login chain still pending)
    // must not be captured as a real session.
    expect(fixture).toContain('function waitForLoginOutcome(page, beforeUrl)');
    expect(fixture).toContain('stillHasPasswordField && !navigatedAway');
    const verifyIdx = fixture.indexOf(
      'waitForLoginOutcome(page, beforeUrl)',
      fixture.indexOf('async function loginForm'),
    );
    const storageIdx = fixture.indexOf('storageState({ path })', fixture.indexOf('async function loginForm'));
    expect(verifyIdx).toBeGreaterThan(0);
    expect(verifyIdx).toBeLessThan(storageIdx);
  });

  it('throws on an empty captured session for url-token logins instead of silently succeeding', () => {
    const fixture = authSetupContents();
    expect(fixture).toContain('state.cookies.length === 0 && state.origins.length === 0');
  });

  it('never leaves the setup fixture with a no-op success path when credentials are missing', () => {
    // Regression guard for the old shape: the function used to `return;` after
    // the anonymous-session fallback so `setup('authenticate', ...)` resolved
    // successfully. Now every path either performs a real login or throws.
    const fixture = authSetupContents();
    const setupBodyStart = fixture.indexOf("setup('authenticate'");
    const setupBody = fixture.slice(setupBodyStart);
    expect(setupBody).not.toMatch(/access\(authFile\)/);
  });

  it('waits for the identifier field to settle before filling, guarding against a transient second form/tab', () => {
    const fixture = authSetupContents();
    expect(fixture).toContain('async function waitForStableCount(locator, timeoutMs)');
    const loginFormIdx = fixture.indexOf('async function loginForm');
    const waitIdx = fixture.indexOf('waitForStableCount(identifierField, 2000)', loginFormIdx);
    const fillIdx = fixture.indexOf('identifierField.first().fill(email)', loginFormIdx);
    expect(waitIdx).toBeGreaterThan(loginFormIdx);
    expect(waitIdx).toBeLessThan(fillIdx);
  });

  it('re-verifies the identifier field actually holds the filled value before checking the submit button, re-filling once if not', () => {
    const fixture = authSetupContents();
    const loginFormIdx = fixture.indexOf('async function loginForm');
    const firstFillIdx = fixture.indexOf('identifierField.first().fill(email)', loginFormIdx);
    const verifyIdx = fixture.indexOf('identifierField.first().inputValue()', firstFillIdx);
    const secondFillIdx = fixture.indexOf('identifierField.first().fill(email)', firstFillIdx + 1);
    expect(verifyIdx).toBeGreaterThan(firstFillIdx);
    expect(secondFillIdx).toBeGreaterThan(verifyIdx);
  });

  it('waits for the submit button to become enabled before clicking, so a stuck-disabled button fails fast instead of consuming the full 60s test timeout', () => {
    const fixture = authSetupContents();
    expect(fixture).toContain('async function waitForSubmitEnabled(button, timeoutMs)');
    const loginFormIdx = fixture.indexOf('async function loginForm');
    const waitIdx = fixture.indexOf('waitForSubmitEnabled(submitButton, 8000)', loginFormIdx);
    const clickIdx = fixture.indexOf('submitButton.click(', loginFormIdx);
    expect(waitIdx).toBeGreaterThan(loginFormIdx);
    expect(waitIdx).toBeLessThan(clickIdx);
    // Bound well under the config's 60s test timeout.
    expect(fixture).toContain('submitButton.click({ timeout: 15_000 })');
  });

  it('throws a clear, non-selector diagnostic (never the raw credential values) when the submit button never enables', () => {
    const fixture = authSetupContents();
    const loginFormIdx = fixture.indexOf('async function loginForm');
    const guardIdx = fixture.indexOf('if (!(await waitForSubmitEnabled(submitButton, 8000)))', loginFormIdx);
    const blockEnd = fixture.indexOf('await submitButton.click(', guardIdx);
    const block = fixture.slice(guardIdx, blockEnd);
    expect(guardIdx).toBeGreaterThan(loginFormIdx);
    expect(block).toContain('never became enabled');
    expect(block).toContain('not a selector gap');
    // Only booleans/lengths for field state — never the actual credential values,
    // since this text reaches the AI triage provider (see triage/prompt.ts).
    expect(block).not.toContain('${email}');
    expect(block).not.toContain('${password}');
    expect(block).toContain('identifierFilled');
    expect(block).toContain('passwordFilled');
  });
});
