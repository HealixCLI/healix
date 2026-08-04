/**
 * Unit tests for directed re-exploration (see directed-reexplore.ts's own doc comment): resolving
 * an escape-hatched spec's plan item to a route, targeted re-crawling of ONLY that route, and the
 * bounded regenerate/merge loop. Uses a fake BrowserSurface (same pattern as gap-fill.test.ts's
 * makeFakeBrowser) so the REAL crawl() logic runs against controlled fixtures, and a fake TestMode
 * so generate()/validate() are fully under test control.
 */
import { describe, it, expect, vi } from 'vitest';

import type { BrowserSurfaceOptions, CapturedNetworkEvent, DomSnapshot, Point } from '../browser/types.js';
import type { BrowserSurface } from '../browser/types.js';
import { normalizeUrl, type RoutePrefixInfo } from '../browser/crawler.js';
import type {
  ExplorationArtifact,
  GeneratedSpec,
  TestMode,
  TestModeContext,
  TestPlan,
  TestPlanItem,
} from '../modes/types.js';
import type { GroundTruth } from '../modes/playwright/generate.js';
import {
  dedupGapTargets,
  resolveGapTargets,
  runDirectedReexplore,
  DIRECTED_REEXPLORE_MAX_ITERATIONS,
  type EscapeHatchGap,
} from './directed-reexplore.js';

const NO_HASH: RoutePrefixInfo = { hashRouted: false };
const BASE_URL = 'https://a.test';

function specWithEscapeHatch(
  planItemId: string,
  path = 'tests/x.spec.ts',
  reason = 'no reason given',
): GeneratedSpec {
  return {
    path,
    title: `[REQ:${planItemId}] guessed`,
    reqTag: planItemId,
    tier: 'tierA-public',
    contents: `import { test, expect } from '@playwright/test';

test('[REQ:${planItemId}] guessed', async ({ page }) => {
  // TODO: unobserved element - ${reason}
  await page.locator('button').click();
});
`,
    planItemId,
  };
}

function cleanSpec(planItemId: string, path = 'tests/x.spec.ts'): GeneratedSpec {
  return {
    path,
    title: `[REQ:${planItemId}] resolved`,
    reqTag: planItemId,
    tier: 'tierA-public',
    // Deliberately a plain CSS selector, not a data-testid/getByRole/getByText call —
    // findUngroundedReferences only checks THOSE patterns, so this "clean" fixture stays clean
    // even against a fake/empty ground truth (an empty exploration would otherwise flag ANY
    // testid reference as unverifiable, which is correct new behavior, just not what this
    // fixture is meant to exercise).
    contents: `import { test, expect } from '@playwright/test';

test('[REQ:${planItemId}] resolved', async ({ page }) => {
  await page.locator('.submit-button').click();
});
`,
    planItemId,
  };
}

function planItem(
  id: string,
  unitKey?: string,
  tier: TestPlanItem['tier'] = 'tierA-public',
  overrides: { title?: string; scenarios?: TestPlanItem['scenarios'] } = {},
): TestPlanItem {
  return {
    id,
    title: overrides.title ?? `Feature ${id}`,
    reqTag: id,
    tier,
    intent: 'test intent',
    scenarios: overrides.scenarios ?? [{ kind: 'positive', description: 'does the thing' }],
    unitKey,
  };
}

describe('resolveGapTargets — resolves an escape-hatched spec to a target route, or drops it', () => {
  const items = [planItem('a', 'route:/forgot-password'), planItem('b')];
  const routing = NO_HASH;

  it('resolves a route:-prefixed unitKey to its absolute URL', () => {
    const gaps = resolveGapTargets([specWithEscapeHatch('a')], items, routing, BASE_URL);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.targetUrl).toBe('https://a.test/forgot-password');
    expect(gaps[0]?.planItemId).toBe('a');
    expect(gaps[0]?.reason).toBe('no reason given');
  });

  it('leaves targetUrl undefined when the item has no unitKey AND no crawled routes exist to fall back on', () => {
    const gaps = resolveGapTargets([specWithEscapeHatch('b')], items, routing, BASE_URL);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.targetUrl).toBeUndefined();
  });

  it('drops a spec with no planItemId (a carried-forward spec — never a re-crawl target)', () => {
    const carried: GeneratedSpec = { ...specWithEscapeHatch('a'), planItemId: undefined };
    expect(resolveGapTargets([carried], items, routing, BASE_URL)).toEqual([]);
  });

  it('returns nothing for a spec with no escape-hatch marker', () => {
    expect(resolveGapTargets([cleanSpec('a')], items, routing, BASE_URL)).toEqual([]);
  });

  it('returns one gap per escape-hatched test block in the same spec', () => {
    const spec = specWithEscapeHatch('a');
    spec.contents += `
test('[REQ:a] second guess', async ({ page }) => {
  // TODO: unobserved element - another reason.
  await page.locator('input').fill('x');
});
`;
    const gaps = resolveGapTargets([spec], items, routing, BASE_URL);
    expect(gaps).toHaveLength(2);
  });
});

describe('resolveGapTargets — tier-based fallback when unitKey is endpoint:-prefixed or absent', () => {
  function route(url: string, role: 'anonymous' | 'authenticated') {
    return {
      url,
      title: url,
      snapshot: { url, title: url, interactiveElements: [] },
      depth: 0,
      hasPasswordField: false,
      role,
      networkEvents: [],
    };
  }

  it('falls back to the anonymous landing route for a tierA-public item with an endpoint:-prefixed unitKey', () => {
    const items = [planItem('a', 'endpoint:POST /api/auth/register', 'tierA-public')];
    const crawledRoutes = [route('https://a.test/', 'anonymous')];
    const gaps = resolveGapTargets([specWithEscapeHatch('a')], items, NO_HASH, BASE_URL, crawledRoutes);
    expect(gaps[0]?.targetUrl).toBe('https://a.test/');
  });

  it('falls back to the anonymous landing route for a tierA-public item with NO unitKey at all', () => {
    const items = [planItem('a', undefined, 'tierA-public')];
    const crawledRoutes = [route('https://a.test/', 'anonymous')];
    const gaps = resolveGapTargets([specWithEscapeHatch('a')], items, NO_HASH, BASE_URL, crawledRoutes);
    expect(gaps[0]?.targetUrl).toBe('https://a.test/');
  });

  it('falls back to the AUTHENTICATED landing route (not just any route) for a tierB-auth item', () => {
    const items = [planItem('a', undefined, 'tierB-auth')];
    const crawledRoutes = [
      route('https://a.test/', 'anonymous'),
      route('https://a.test/dashboard', 'authenticated'),
    ];
    const gaps = resolveGapTargets([specWithEscapeHatch('a')], items, NO_HASH, BASE_URL, crawledRoutes);
    expect(gaps[0]?.targetUrl).toBe('https://a.test/dashboard');
  });

  it('falls back to whatever route exists when no route matches the preferred role', () => {
    const items = [planItem('a', undefined, 'tierB-auth')];
    const crawledRoutes = [route('https://a.test/', 'anonymous')]; // no authenticated route crawled
    const gaps = resolveGapTargets([specWithEscapeHatch('a')], items, NO_HASH, BASE_URL, crawledRoutes);
    expect(gaps[0]?.targetUrl).toBe('https://a.test/');
  });

  it('never falls back for a tierC-api item, even when routes are available', () => {
    const items = [planItem('a', 'endpoint:GET /api/todos', 'tierC-api')];
    const crawledRoutes = [route('https://a.test/', 'anonymous')];
    const gaps = resolveGapTargets([specWithEscapeHatch('a')], items, NO_HASH, BASE_URL, crawledRoutes);
    expect(gaps[0]?.targetUrl).toBeUndefined();
  });

  it('still prefers a resolvable route:-prefixed unitKey over the tier fallback', () => {
    const items = [planItem('a', 'route:/forgot-password', 'tierA-public')];
    const crawledRoutes = [route('https://a.test/', 'anonymous')];
    const gaps = resolveGapTargets([specWithEscapeHatch('a')], items, NO_HASH, BASE_URL, crawledRoutes);
    expect(gaps[0]?.targetUrl).toBe('https://a.test/forgot-password');
  });
});

describe('resolveGapTargets — matches an already-discovered UI state before falling back to the tier landing page', () => {
  function stateRoute(
    url: string,
    stateKey: string,
    interactiveElements: { role: string; name: string; selector: string }[],
  ) {
    return {
      url,
      stateKey,
      title: url,
      snapshot: { url, title: url, interactiveElements },
      depth: 0,
      hasPasswordField: false,
      role: 'anonymous' as const,
      networkEvents: [],
    };
  }
  function plainRoute(url: string) {
    return {
      url,
      title: url,
      snapshot: { url, title: url, interactiveElements: [] },
      depth: 0,
      hasPasswordField: false,
      role: 'anonymous' as const,
      networkEvents: [],
    };
  }

  it('targets a discovered state whose content plausibly matches the item, carrying its stateKey', () => {
    const items = [
      planItem('a', undefined, 'tierA-public', {
        title: 'Switching between Login and Register modes',
        scenarios: [{ kind: 'positive', description: 'clicking Register switches to the register form' }],
      }),
    ];
    const crawledRoutes = [
      plainRoute('https://a.test/'),
      stateRoute('https://a.test/', 'https://a.test/>>button.register', [
        { role: 'heading', name: 'Register', selector: 'h1' },
      ]),
    ];
    const gaps = resolveGapTargets([specWithEscapeHatch('a')], items, NO_HASH, BASE_URL, crawledRoutes);
    expect(gaps[0]?.targetUrl).toBe('https://a.test/');
    expect(gaps[0]?.stateKey).toBe('https://a.test/>>button.register');
  });

  it('falls back to the tier landing page (no stateKey) when no discovered state matches the item', () => {
    const items = [
      planItem('a', undefined, 'tierA-public', {
        title: 'Switching between Login and Register modes',
        scenarios: [{ kind: 'positive', description: 'clicking Register switches to the register form' }],
      }),
    ];
    const crawledRoutes = [
      plainRoute('https://a.test/'),
      // A `role: 'button'` would false-positive-match the "register" action-verb bonus
      // regardless of name (see ACTION_VERB_BONUSES) — using a non-actionable role here so this
      // genuinely tests "no plausible overlap," not an accidental one.
      stateRoute('https://a.test/', 'https://a.test/>>a.unrelated', [
        { role: 'link', name: 'Help center', selector: 'a.help' },
      ]),
    ];
    const gaps = resolveGapTargets([specWithEscapeHatch('a')], items, NO_HASH, BASE_URL, crawledRoutes);
    expect(gaps[0]?.targetUrl).toBe('https://a.test/');
    expect(gaps[0]?.stateKey).toBeUndefined();
  });

  it('still prefers a resolvable route:-prefixed unitKey over a matching state', () => {
    const items = [
      planItem('a', 'route:/forgot-password', 'tierA-public', {
        title: 'Register',
        scenarios: [{ kind: 'positive', description: 'register a new account' }],
      }),
    ];
    const crawledRoutes = [
      stateRoute('https://a.test/', 'https://a.test/>>button.register', [
        { role: 'heading', name: 'Register', selector: 'h1' },
      ]),
    ];
    const gaps = resolveGapTargets([specWithEscapeHatch('a')], items, NO_HASH, BASE_URL, crawledRoutes);
    expect(gaps[0]?.targetUrl).toBe('https://a.test/forgot-password');
    expect(gaps[0]?.stateKey).toBeUndefined();
  });
});

describe('resolveGapTargets — also catches WARN-level ungrounded references (a quiet guess, not the sanctioned escape hatch)', () => {
  function groundTruth(overrides: Partial<GroundTruth> = {}): GroundTruth {
    return {
      testids: new Set(),
      selectors: new Set(),
      names: [],
      roleByName: new Map(),
      endpoints: [],
      hasEndpointLevelMocks: false,
      inventoryTruncated: false,
      attributes: new Map(),
      ...overrides,
    };
  }

  function specReferencingTestId(planItemId: string, testid: string): GeneratedSpec {
    return {
      path: 'tests/x.spec.ts',
      title: `[REQ:${planItemId}] guessed`,
      reqTag: planItemId,
      tier: 'tierA-public',
      contents: `import { test, expect } from '@playwright/test';

test('[REQ:${planItemId}] guessed', async ({ page }) => {
  await page.getByTestId('${testid}').click();
});
`,
      planItemId,
    };
  }

  it('flags a spec with no escape-hatch marker but an ungrounded testid reference, when buildGroundTruth is supplied', () => {
    const items = [planItem('a', undefined, 'tierA-public')];
    const crawledRoutes = [
      {
        url: 'https://a.test/',
        title: 'https://a.test/',
        snapshot: { url: 'https://a.test/', title: 'https://a.test/', interactiveElements: [] },
        depth: 0,
        hasPasswordField: false,
        role: 'anonymous' as const,
        networkEvents: [],
      },
    ];
    const spec = specReferencingTestId('a', 'mystery-button');
    // findUngroundedReferences routes a testid miss to `hard` (not `warn`) whenever the ground
    // truth's inventory is non-empty ("inventoryKnown") — a HARD finding gets rejected/retried
    // during the ORIGINAL generation and never survives into a final spec, so the only shape
    // findUngroundedWarnReasons needs to (and does) check is `warn`, which requires an EMPTY
    // ground truth here (matching how this actually arises: nothing crawled for this item at all).
    const buildGroundTruth = () => groundTruth();
    const gaps = resolveGapTargets([spec], items, NO_HASH, BASE_URL, crawledRoutes, buildGroundTruth);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.reason).toContain('mystery-button');
    expect(gaps[0]?.targetUrl).toBe('https://a.test/'); // still resolves via the tier fallback
  });

  it('does NOT flag the same spec when buildGroundTruth is omitted (existing escape-hatch-only behavior, unchanged)', () => {
    const items = [planItem('a', undefined, 'tierA-public')];
    const spec = specReferencingTestId('a', 'mystery-button');
    expect(resolveGapTargets([spec], items, NO_HASH, BASE_URL)).toEqual([]);
  });

  it('does NOT flag a spec whose testid reference IS actually grounded (no false positive)', () => {
    const items = [planItem('a', undefined, 'tierA-public')];
    const spec = specReferencingTestId('a', 'mystery-button');
    const buildGroundTruth = () => groundTruth({ testids: new Set(['mystery-button']) });
    expect(resolveGapTargets([spec], items, NO_HASH, BASE_URL, [], buildGroundTruth)).toEqual([]);
  });

  it('prefers the sanctioned escape-hatch marker over warn-level detection when a spec has both', () => {
    const items = [planItem('a', undefined, 'tierA-public')];
    // Has a real escape hatch AND, in principle, could also trip the warn-level check — the
    // escape-hatch reasons must win, not get diluted/duplicated by also running the warn check.
    const spec = specWithEscapeHatch('a', 'tests/x.spec.ts', 'a real escape-hatch reason');
    const buildGroundTruth = () => groundTruth(); // would flag plenty if it were ever consulted
    const gaps = resolveGapTargets([spec], items, NO_HASH, BASE_URL, [], buildGroundTruth);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.reason).toBe('a real escape-hatch reason');
  });
});

describe('dedupGapTargets — collapses gaps resolving to the same target into one crawl target', () => {
  it('keeps only one entry per normalized URL, in first-seen order, for plain route targets', () => {
    const gaps: EscapeHatchGap[] = [
      { id: '1', planItemId: 'a', testTitle: 't1', reason: 'r', targetUrl: 'https://a.test/x' },
      { id: '2', planItemId: 'b', testTitle: 't2', reason: 'r', targetUrl: 'https://a.test/x/' },
      { id: '3', planItemId: 'c', testTitle: 't3', reason: 'r', targetUrl: 'https://a.test/y' },
      { id: '4', planItemId: 'd', testTitle: 't4', reason: 'r', targetUrl: undefined },
    ];
    expect(dedupGapTargets(gaps)).toEqual([
      { targetUrl: 'https://a.test/x', stateKey: undefined },
      { targetUrl: 'https://a.test/y', stateKey: undefined },
    ]);
  });

  it('keeps two states that share the same URL as SEPARATE targets, keyed by stateKey', () => {
    const gaps: EscapeHatchGap[] = [
      {
        id: '1',
        planItemId: 'a',
        testTitle: 't1',
        reason: 'r',
        targetUrl: 'https://a.test/',
        stateKey: 'https://a.test/>>button.register',
      },
      {
        id: '2',
        planItemId: 'b',
        testTitle: 't2',
        reason: 'r',
        targetUrl: 'https://a.test/',
        stateKey: 'https://a.test/>>button.forgot-password',
      },
    ];
    expect(dedupGapTargets(gaps)).toEqual([
      { targetUrl: 'https://a.test/', stateKey: 'https://a.test/>>button.register' },
      { targetUrl: 'https://a.test/', stateKey: 'https://a.test/>>button.forgot-password' },
    ]);
  });

  it('collapses two gaps resolving to the SAME state into one target', () => {
    const gaps: EscapeHatchGap[] = [
      {
        id: '1',
        planItemId: 'a',
        testTitle: 't1',
        reason: 'r1',
        targetUrl: 'https://a.test/',
        stateKey: 'https://a.test/>>button.register',
      },
      {
        id: '2',
        planItemId: 'a',
        testTitle: 't2',
        reason: 'r2',
        targetUrl: 'https://a.test/',
        stateKey: 'https://a.test/>>button.register',
      },
    ];
    expect(dedupGapTargets(gaps)).toHaveLength(1);
  });
});

// ---- Fake BrowserSurface: lets the REAL crawl() logic run against controlled fixtures ----

interface FakePage {
  interactiveElements?: DomSnapshot['interactiveElements'];
  hasPasswordField?: boolean;
  /** Simulates the app redirecting this URL elsewhere — snapshot() reports a DIFFERENT resolved url than the one goto() was called with. */
  redirectsTo?: string;
}

function makeFakeBrowser(pages: Record<string, FakePage>): {
  browser: BrowserSurface;
  gotoCalls: string[];
  clickCalls: string[];
  typeCalls: Array<{ selector: string; text: string }>;
  startCalls: BrowserSurfaceOptions[];
  // An array, not a number — so the count stays live via reference after this function returns,
  // instead of freezing at the (always-zero) snapshot taken at destructuring time.
  stopCalls: unknown[];
} {
  let currentUrl = '';
  const gotoCalls: string[] = [];
  const clickCalls: string[] = [];
  const typeCalls: Array<{ selector: string; text: string }> = [];
  const startCalls: BrowserSurfaceOptions[] = [];
  const stopCalls: unknown[] = [];
  const browser: BrowserSurface = {
    async start(opts?: BrowserSurfaceOptions): Promise<void> {
      startCalls.push(opts ?? {});
    },
    async goto(url: string): Promise<void> {
      gotoCalls.push(url);
      currentUrl = url;
    },
    async reload(): Promise<void> {},
    async screenshot(): Promise<Buffer> {
      return Buffer.alloc(0);
    },
    async snapshot(): Promise<DomSnapshot> {
      const page = pages[currentUrl];
      return {
        url: page?.redirectsTo ?? currentUrl,
        title: currentUrl,
        interactiveElements: page?.interactiveElements ?? [],
      };
    },
    async click(selector: string): Promise<void> {
      clickCalls.push(selector);
    },
    async clickAt(_point: Point): Promise<void> {},
    async type(selector: string, text: string): Promise<void> {
      typeCalls.push({ selector, text });
    },
    async pressKey(_key: string): Promise<void> {},
    onFrame(): () => void {
      return () => {};
    },
    drainNetworkEvents(): CapturedNetworkEvent[] {
      return [];
    },
    async exportStorageState(): Promise<unknown> {
      return {};
    },
    async stop(): Promise<void> {
      stopCalls.push(true);
    },
  };
  return { browser, gotoCalls, clickCalls, typeCalls, startCalls, stopCalls };
}

function makeExploration(
  routes: ExplorationArtifact['crawl']['routes'],
  overrides: Partial<ExplorationArtifact['crawl']> = {},
): ExplorationArtifact {
  return {
    crawl: {
      routes,
      visitedCount: routes.length,
      budgetExhausted: false,
      redirectLoopsDetected: [],
      shellCollapsed: false,
      degenerateRedirectsSkipped: [],
      authAttempted: false,
      authVerified: false,
      ...overrides,
    },
    routing: NO_HASH,
    loginCandidates: [],
    useful: true,
    observedEndpoints: [],
  };
}

function thinRoute(url: string) {
  return {
    url,
    title: url,
    snapshot: { url, title: url, interactiveElements: [] },
    depth: 0,
    hasPasswordField: false,
    role: 'anonymous' as const,
    networkEvents: [],
  };
}

function makeCtx(
  overrides: Partial<TestModeContext> & { exploration: ExplorationArtifact },
): TestModeContext {
  return {
    projectDir: '/tmp/unused',
    baseUrl: BASE_URL,
    provider: {} as TestModeContext['provider'],
    target: {} as TestModeContext['target'],
    browser: {} as TestModeContext['browser'],
    ...overrides,
  };
}

function noopEmit() {
  return vi.fn();
}

describe('runDirectedReexplore — bounded loop: resolve -> re-crawl -> regenerate -> merge', () => {
  it('never starts the browser when there is nothing to resolve', async () => {
    const { browser, startCalls } = makeFakeBrowser({});
    const ctx = makeCtx({ browser, exploration: makeExploration([thinRoute(BASE_URL)]) });
    const plan: TestPlan = { summary: 's', items: [planItem('a', 'route:/forgot-password')] };
    const mode = { generate: vi.fn() } as unknown as TestMode;

    const result = await runDirectedReexplore({
      ctx,
      mode,
      plan,
      specs: [cleanSpec('a')], // no escape hatch — nothing to chase
      routing: NO_HASH,
      baseUrl: BASE_URL,
      reregisterSpecRows: vi.fn(),
      emit: noopEmit(),
    });

    expect(startCalls).toHaveLength(0);
    expect(result.iterations).toBe(0);
    expect(result.specs).toEqual([cleanSpec('a')]);
  });

  it('re-crawls ONLY the resolved route — never the whole app', async () => {
    const target = `${BASE_URL}/forgot-password`;
    const { browser, gotoCalls } = makeFakeBrowser({
      [target]: {
        interactiveElements: [{ role: 'button', name: 'Reset', selector: '[data-testid="reset"]' }],
      },
      [BASE_URL]: { interactiveElements: [{ role: 'link', name: 'unrelated', selector: 'a.unrelated' }] },
    });
    const ctx = makeCtx({ browser, exploration: makeExploration([thinRoute(target)]) });
    const plan: TestPlan = { summary: 's', items: [planItem('a', 'route:/forgot-password')] };
    const mode = {
      generate: vi.fn().mockResolvedValue([cleanSpec('a')]),
    } as unknown as TestMode;

    await runDirectedReexplore({
      ctx,
      mode,
      plan,
      specs: [specWithEscapeHatch('a')],
      routing: NO_HASH,
      baseUrl: BASE_URL,
      reregisterSpecRows: vi.fn(),
      emit: noopEmit(),
      forgetCheckpointEntries: vi.fn().mockResolvedValue(undefined),
    });

    expect(gotoCalls).toEqual([target]);
  });

  it('merges the richer route into ctx.exploration.crawl.routes, preserving verifiedLogin/authAttempted untouched', async () => {
    const target = `${BASE_URL}/forgot-password`;
    const { browser } = makeFakeBrowser({
      [target]: {
        interactiveElements: [{ role: 'button', name: 'Reset', selector: '[data-testid="reset"]' }],
      },
    });
    const verifiedLogin = {
      pageUrl: `${BASE_URL}/login`,
      identifierSelector: '#user',
      passwordSelector: '#pass',
      submitSelector: '#submit',
    };
    const ctx = makeCtx({
      browser,
      exploration: makeExploration([thinRoute(target)], {
        authAttempted: true,
        authVerified: true,
        verifiedLogin,
      }),
    });
    const plan: TestPlan = { summary: 's', items: [planItem('a', 'route:/forgot-password')] };
    const mode = { generate: vi.fn().mockResolvedValue([cleanSpec('a')]) } as unknown as TestMode;

    await runDirectedReexplore({
      ctx,
      mode,
      plan,
      specs: [specWithEscapeHatch('a')],
      routing: NO_HASH,
      baseUrl: BASE_URL,
      reregisterSpecRows: vi.fn(),
      emit: noopEmit(),
      forgetCheckpointEntries: vi.fn().mockResolvedValue(undefined),
    });

    expect(ctx.exploration?.crawl.routes).toHaveLength(1);
    expect(ctx.exploration?.crawl.routes[0]?.snapshot.interactiveElements).toEqual([
      { role: 'button', name: 'Reset', selector: '[data-testid="reset"]' },
    ]);
    // Sibling fields execute.ts depends on must survive untouched.
    expect(ctx.exploration?.crawl.authAttempted).toBe(true);
    expect(ctx.exploration?.crawl.authVerified).toBe(true);
    expect(ctx.exploration?.crawl.verifiedLogin).toEqual(verifiedLogin);
  });

  it('a redirecting route does not accumulate a duplicate entry across a SECOND merge in a later iteration', async () => {
    // Regression test: after the first merge, the stored route's OWN .url field is the resolved
    // (post-redirect) URL, not the original pre-redirect target — so a naive merge that always
    // looks up "does an entry exist under the pre-redirect target" would find NOTHING on a second
    // pass (the entry it should replace is now stored under the redirected url) and push a
    // duplicate. Item 'a' resolves to a redirecting route that NEVER closes (forcing a second
    // re-crawl of the exact same target); item 'b' resolves to an unrelated route and closes on
    // the first pass, which is what keeps the loop going into a second iteration at all.
    const targetA = `${BASE_URL}/forgot-password`;
    const resolvedA = `${BASE_URL}/account/forgot-password`; // app-side redirect to a different path
    const targetB = `${BASE_URL}/other`;
    const { browser } = makeFakeBrowser({
      [targetA]: {
        redirectsTo: resolvedA,
        interactiveElements: [{ role: 'button', name: 'Reset', selector: '[data-testid="reset"]' }],
      },
      [targetB]: { interactiveElements: [] },
    });
    const ctx = makeCtx({ browser, exploration: makeExploration([thinRoute(targetA), thinRoute(targetB)]) });
    const plan: TestPlan = {
      summary: 's',
      items: [planItem('a', 'route:/forgot-password'), planItem('b', 'route:/other')],
    };
    // 'a' never resolves (keeps re-triggering the same redirecting re-crawl); 'b' resolves on its
    // very first regeneration (the "forward progress" that keeps the loop going past iteration 1).
    const generate = vi
      .fn()
      .mockImplementation(async (_ctx: TestModeContext, calledPlan: TestPlan) =>
        calledPlan.items.map((it) =>
          it.id === 'a' ? specWithEscapeHatch('a', 'tests/a.spec.ts', 'still missing') : cleanSpec('b'),
        ),
      );
    const mode = { generate } as unknown as TestMode;

    const result = await runDirectedReexplore({
      ctx,
      mode,
      plan,
      specs: [specWithEscapeHatch('a'), specWithEscapeHatch('b')],
      routing: NO_HASH,
      baseUrl: BASE_URL,
      reregisterSpecRows: vi.fn(),
      emit: noopEmit(),
      forgetCheckpointEntries: vi.fn().mockResolvedValue(undefined),
    });

    // Confirms two iterations actually ran (iteration 2 is what re-crawls targetA a second time).
    expect(result.iterations).toBe(2);
    // Exactly 2 routes total (a's slot + b's slot) — the redirect must not have left a duplicate
    // stale/rich pair for 'a' after its second merge.
    expect(ctx.exploration?.crawl.routes).toHaveLength(2);
    const aRoutes = ctx.exploration?.crawl.routes.filter(
      (r) => normalizeUrl(r.url) === normalizeUrl(targetA) || normalizeUrl(r.url) === normalizeUrl(resolvedA),
    );
    expect(aRoutes).toHaveLength(1);
    expect(aRoutes?.[0]?.snapshot.interactiveElements).toEqual([
      { role: 'button', name: 'Reset', selector: '[data-testid="reset"]' },
    ]);
  });

  it('regenerates only the affected item(s) via a subset TestPlan', async () => {
    const target = `${BASE_URL}/forgot-password`;
    const { browser } = makeFakeBrowser({ [target]: { interactiveElements: [] } });
    const ctx = makeCtx({ browser, exploration: makeExploration([thinRoute(target)]) });
    const plan: TestPlan = {
      summary: 's',
      items: [planItem('a', 'route:/forgot-password'), planItem('b')],
    };
    const generate = vi.fn().mockResolvedValue([cleanSpec('a')]);
    const mode = { generate } as unknown as TestMode;

    await runDirectedReexplore({
      ctx,
      mode,
      plan,
      specs: [specWithEscapeHatch('a'), cleanSpec('b')],
      routing: NO_HASH,
      baseUrl: BASE_URL,
      reregisterSpecRows: vi.fn(),
      emit: noopEmit(),
      forgetCheckpointEntries: vi.fn().mockResolvedValue(undefined),
    });

    expect(generate).toHaveBeenCalledTimes(1);
    const [, calledPlan] = generate.mock.calls[0] as [unknown, TestPlan];
    expect(calledPlan.items.map((it) => it.id)).toEqual(['a']);
  });

  it('replaces the stale spec in the returned specs array — never a duplicate for the same item', async () => {
    const target = `${BASE_URL}/forgot-password`;
    const { browser } = makeFakeBrowser({ [target]: { interactiveElements: [] } });
    const ctx = makeCtx({ browser, exploration: makeExploration([thinRoute(target)]) });
    const plan: TestPlan = { summary: 's', items: [planItem('a', 'route:/forgot-password')] };
    const regenerated = cleanSpec('a', 'tests/regenerated.spec.ts');
    const mode = { generate: vi.fn().mockResolvedValue([regenerated]) } as unknown as TestMode;

    const result = await runDirectedReexplore({
      ctx,
      mode,
      plan,
      specs: [specWithEscapeHatch('a', 'tests/original.spec.ts')],
      routing: NO_HASH,
      baseUrl: BASE_URL,
      reregisterSpecRows: vi.fn(),
      emit: noopEmit(),
      forgetCheckpointEntries: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.specs).toHaveLength(1);
    expect(result.specs[0]?.path).toBe('tests/regenerated.spec.ts');
  });

  it('stops after DIRECTED_REEXPLORE_MAX_ITERATIONS even when gaps still remain', async () => {
    // DIRECTED_REEXPLORE_MAX_ROUTES_PER_ITERATION caps each iteration to 5 distinct routes, so 16
    // distinct, independently-resolvable, always-successfully-regenerated items need 4 iterations
    // to fully close (5+5+5+1) — with the cap at 3, one item must still be gapped when the loop
    // stops, proving the cap (not convergence) is what ended it.
    const itemCount = 16;
    const items = Array.from({ length: itemCount }, (_, i) => planItem(`item-${i}`, `route:/item-${i}`));
    const specs = items.map((it) => specWithEscapeHatch(it.id, `tests/${it.id}.spec.ts`));
    const routes = items.map((_it, i) => thinRoute(`${BASE_URL}/item-${i}`));
    const { browser } = makeFakeBrowser({});
    const ctx = makeCtx({ browser, exploration: makeExploration(routes) });
    const plan: TestPlan = { summary: 's', items };
    // Fully resolves whatever subset of items it's called with, every time.
    const generate = vi
      .fn()
      .mockImplementation(async (_ctx: TestModeContext, calledPlan: TestPlan) =>
        calledPlan.items.map((it) => cleanSpec(it.id, `tests/${it.id}.spec.ts`)),
      );
    const mode = { generate } as unknown as TestMode;

    const result = await runDirectedReexplore({
      ctx,
      mode,
      plan,
      specs,
      routing: NO_HASH,
      baseUrl: BASE_URL,
      reregisterSpecRows: vi.fn(),
      emit: noopEmit(),
      forgetCheckpointEntries: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.iterations).toBe(DIRECTED_REEXPLORE_MAX_ITERATIONS);
    expect(result.gapsRemaining).toBe(1); // 16 - 3*5 = 1 left unresolved when the cap stopped it
  });

  it('stops early when an iteration closes zero gaps (no forward progress)', async () => {
    const target = `${BASE_URL}/forgot-password`;
    const { browser } = makeFakeBrowser({ [target]: { interactiveElements: [] } });
    const ctx = makeCtx({ browser, exploration: makeExploration([thinRoute(target)]) });
    const plan: TestPlan = { summary: 's', items: [planItem('a', 'route:/forgot-password')] };
    // Regenerating produces the SAME escape hatch every time — zero gaps closed.
    const generate = vi
      .fn()
      .mockResolvedValue([specWithEscapeHatch('a', 'tests/x.spec.ts', 'still missing')]);
    const mode = { generate } as unknown as TestMode;

    const result = await runDirectedReexplore({
      ctx,
      mode,
      plan,
      specs: [specWithEscapeHatch('a', 'tests/x.spec.ts', 'still missing')],
      routing: NO_HASH,
      baseUrl: BASE_URL,
      reregisterSpecRows: vi.fn(),
      emit: noopEmit(),
      forgetCheckpointEntries: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.iterations).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('never throws when the crawl fails mid-loop — degrades to a warn emit and leaves specs unchanged for that gap', async () => {
    // crawl() itself swallows a single dead-link goto() failure internally (dead link handling) —
    // to exercise OUR OWN try/catch around the crawl call, fail at a point crawl() does NOT
    // protect: browser.drainNetworkEvents(), called unconditionally before crawl()'s own
    // try/catch region even begins.
    const target = `${BASE_URL}/forgot-password`;
    const { browser } = makeFakeBrowser({ [target]: { interactiveElements: [] } });
    browser.drainNetworkEvents = vi.fn().mockImplementation(() => {
      throw new Error('browser session crashed');
    });
    const ctx = makeCtx({ browser, exploration: makeExploration([thinRoute(target)]) });
    const plan: TestPlan = { summary: 's', items: [planItem('a', 'route:/forgot-password')] };
    const generate = vi.fn();
    const mode = { generate } as unknown as TestMode;
    const emit = vi.fn();

    const original = specWithEscapeHatch('a');
    const result = await runDirectedReexplore({
      ctx,
      mode,
      plan,
      specs: [original],
      routing: NO_HASH,
      baseUrl: BASE_URL,
      reregisterSpecRows: vi.fn(),
      emit,
      forgetCheckpointEntries: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.specs).toEqual([original]);
    expect(generate).not.toHaveBeenCalled(); // crawl failed, so nothing was merged -> no forward progress -> stop before regenerating
    expect(emit).toHaveBeenCalledWith('generate', 'warn', expect.stringContaining('browser session crashed'));
  });

  it('starts and stops the browser exactly once for the whole loop, even across multiple iterations', async () => {
    const target = `${BASE_URL}/forgot-password`;
    const { browser, startCalls, stopCalls } = makeFakeBrowser({ [target]: { interactiveElements: [] } });
    const ctx = makeCtx({ browser, exploration: makeExploration([thinRoute(target)]) });
    const plan: TestPlan = { summary: 's', items: [planItem('a', 'route:/forgot-password')] };
    let call = 0;
    const generate = vi.fn().mockImplementation(async () => {
      call += 1;
      return [specWithEscapeHatch('a', 'tests/x.spec.ts', `reason ${call}`)];
    });
    const mode = { generate } as unknown as TestMode;

    await runDirectedReexplore({
      ctx,
      mode,
      plan,
      specs: [specWithEscapeHatch('a')],
      routing: NO_HASH,
      baseUrl: BASE_URL,
      reregisterSpecRows: vi.fn(),
      emit: noopEmit(),
      forgetCheckpointEntries: vi.fn().mockResolvedValue(undefined),
    });

    expect(startCalls).toHaveLength(1);
    expect(stopCalls).toHaveLength(1);
  });

  it("replays a matched state's exact click chain (not a generic probe) and merges it in by stateKey", async () => {
    const { browser, gotoCalls, clickCalls } = makeFakeBrowser({
      [BASE_URL]: { interactiveElements: [{ role: 'heading', name: 'Register', selector: 'h1' }] },
    });
    const stateKey = `${BASE_URL}>>button.register`;
    const ctx = makeCtx({
      browser,
      exploration: makeExploration([
        thinRoute(BASE_URL),
        {
          url: BASE_URL,
          stateKey,
          title: BASE_URL,
          // findMatchingState checks THIS (already-discovered) inventory, not what a fresh crawl
          // would return — must already carry something that overlaps the item's own requirement
          // tokens for the match to fire at all.
          snapshot: {
            url: BASE_URL,
            title: BASE_URL,
            interactiveElements: [{ role: 'heading', name: 'Register', selector: 'h1' }],
          },
          depth: 0,
          hasPasswordField: false,
          role: 'anonymous',
          networkEvents: [],
        },
      ]),
    });
    // No unitKey at all — resolveGapTargets must fall through to the state match, not the plain
    // tier-landing fallback (BASE_URL has no route: unitKey to resolve to either).
    const items = [
      planItem('a', undefined, 'tierA-public', {
        title: 'Switching between Login and Register modes',
        scenarios: [{ kind: 'positive', description: 'clicking Register switches to the register form' }],
      }),
    ];
    const plan: TestPlan = { summary: 's', items };
    const mode = { generate: vi.fn().mockResolvedValue([cleanSpec('a')]) } as unknown as TestMode;

    await runDirectedReexplore({
      ctx,
      mode,
      plan,
      specs: [specWithEscapeHatch('a')],
      routing: NO_HASH,
      baseUrl: BASE_URL,
      reregisterSpecRows: vi.fn(),
      emit: noopEmit(),
      forgetCheckpointEntries: vi.fn().mockResolvedValue(undefined),
    });

    // Replayed the exact recorded click — never a generic/random probe.
    expect(gotoCalls).toContain(BASE_URL);
    expect(clickCalls).toEqual(['button.register']);

    // Merged into the SAME stateKey'd entry (not a duplicate, and not overwriting the unrelated
    // plain thinRoute(BASE_URL) entry, which shares the same url but a different identity).
    const routes = ctx.exploration?.crawl.routes ?? [];
    expect(routes).toHaveLength(2);
    const stateEntry = routes.find((r) => r.stateKey === stateKey);
    expect(stateEntry?.snapshot.interactiveElements).toEqual([
      { role: 'heading', name: 'Register', selector: 'h1' },
    ]);
    const plainEntry = routes.find((r) => !r.stateKey);
    expect(plainEntry?.url).toBe(BASE_URL);
  });
});
