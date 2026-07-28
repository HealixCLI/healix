import { describe, expect, it } from 'vitest';
import { identifyExplorationGaps, runGapFillingPass } from './gap-fill.js';
import type { CrawledRoute, CrawlWithAuthResult, RoutePrefixInfo } from '../browser/crawler.js';
import type {
  BrowserSurface,
  BrowserSurfaceOptions,
  CapturedNetworkEvent,
  DomSnapshot,
  InteractiveElement,
  Point,
} from '../browser/types.js';
import type { CompleteOptions, CompletionResult, ProviderAdapter } from '../providers/types.js';

function route(url: string, opts: Partial<CrawledRoute> = {}): CrawledRoute {
  return {
    url,
    title: opts.title ?? url,
    snapshot: opts.snapshot ?? { url, title: url, interactiveElements: [] },
    depth: 0,
    hasPasswordField: false,
    role: 'anonymous',
    networkEvents: [],
    ...opts,
  };
}

function crawlResult(routes: CrawledRoute[]): CrawlWithAuthResult {
  return {
    routes,
    visitedCount: routes.length,
    budgetExhausted: false,
    redirectLoopsDetected: [],
    shellCollapsed: false,
    degenerateRedirectsSkipped: [],
    authAttempted: false,
    authVerified: false,
  };
}

const HASH_ROUTING: RoutePrefixInfo = { hashRouted: true, invariantPrefix: '#/SK' };

describe('identifyExplorationGaps()', () => {
  it('flags a plan item whose route was never visited', () => {
    const gaps = identifyExplorationGaps({
      crawlResult: crawlResult([route('https://a.test/#/SK/home')]),
      routing: HASH_ROUTING,
      baseUrl: 'https://a.test/',
      planItems: [{ id: 'p1', title: 'Unsubscribe page', unitKey: 'route:/unsubscribeinfopage' }],
      observedEndpoints: [],
    });

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      kind: 'unvisited-plan-route',
      relatedPlanItemId: 'p1',
      targetUrlGuess: 'https://a.test/#/SK/unsubscribeinfopage',
    });
  });

  it('does not flag a plan item whose route was already visited', () => {
    const gaps = identifyExplorationGaps({
      crawlResult: crawlResult([route('https://a.test/#/SK/home')]),
      routing: HASH_ROUTING,
      baseUrl: 'https://a.test/',
      planItems: [{ id: 'p1', title: 'Home', unitKey: 'route:/home' }],
      observedEndpoints: [],
    });

    expect(gaps).toHaveLength(0);
  });

  it('flags an observed endpoint with no matching visited route traffic', () => {
    const visited = route('https://a.test/#/SK/home', {
      networkEvents: [{ method: 'GET', url: 'https://a.test/api/home', status: 200 }],
    });
    const gaps = identifyExplorationGaps({
      crawlResult: crawlResult([visited]),
      routing: HASH_ROUTING,
      baseUrl: 'https://a.test/',
      planItems: [],
      observedEndpoints: [{ method: 'GET', pathPattern: '/api/wallet', status: 200 }],
    });

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: 'unvisited-observed-endpoint', id: 'endpoint:GET /api/wallet' });
  });

  it('flags an unclicked affordance surfaced by the crawler', () => {
    const dashboard = route('https://a.test/#/SK/dashboard', {
      unattemptedClickCandidates: [{ selector: '[data-testid=wallet-btn]', name: 'Wallet' }],
    });
    const gaps = identifyExplorationGaps({
      crawlResult: crawlResult([dashboard]),
      routing: HASH_ROUTING,
      baseUrl: 'https://a.test/',
      planItems: [],
      observedEndpoints: [],
    });

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      kind: 'unclicked-affordance',
      parentRouteUrl: 'https://a.test/#/SK/dashboard',
      targetSelectorGuess: '[data-testid=wallet-btn]',
    });
  });

  it('sorts plan-linked gaps first and caps the total at MAX_GAPS_PER_RUN', () => {
    const unattempted = Array.from({ length: 15 }, (_, i) => ({
      selector: `[data-testid=btn-${i}]`,
      name: `Button ${i}`,
    }));
    const dashboard = route('https://a.test/#/SK/dashboard', { unattemptedClickCandidates: unattempted });
    const gaps = identifyExplorationGaps({
      crawlResult: crawlResult([dashboard]),
      routing: HASH_ROUTING,
      baseUrl: 'https://a.test/',
      planItems: [{ id: 'p1', title: 'Unsubscribe page', unitKey: 'route:/unsubscribeinfopage' }],
      observedEndpoints: [],
    });

    expect(gaps.length).toBeLessThanOrEqual(10);
    expect(gaps[0].relatedPlanItemId).toBe('p1');
  });

  it('sorts an authenticated-route affordance gap ahead of an anonymous-route one when neither correlates to a plan item', () => {
    // Anonymous route listed FIRST in the crawl result — if tiering didn't override crawl order,
    // its gap would sort first too.
    const anonymousRoute = route('https://a.test/#/SK/register', {
      role: 'anonymous',
      unattemptedClickCandidates: [{ selector: '[data-testid=some-toggle]', name: 'Some toggle' }],
    });
    const authenticatedRoute = route('https://a.test/#/SK/dashboard', {
      role: 'authenticated',
      unattemptedClickCandidates: [{ selector: '[data-testid=change-btn]', name: 'Change' }],
    });
    const gaps = identifyExplorationGaps({
      crawlResult: crawlResult([anonymousRoute, authenticatedRoute]),
      routing: HASH_ROUTING,
      baseUrl: 'https://a.test/',
      planItems: [],
      observedEndpoints: [],
    });

    expect(gaps.map((g) => g.parentRouteUrl)).toEqual([
      'https://a.test/#/SK/dashboard',
      'https://a.test/#/SK/register',
    ]);
  });

  it('correlates an affordance gap against a plan item title and sorts it into the top tier', () => {
    const dashboard = route('https://a.test/#/SK/dashboard', {
      role: 'authenticated',
      unattemptedClickCandidates: [
        { selector: '[data-testid=unrelated-btn]', name: 'Unrelated' },
        { selector: '[data-testid=voucher-btn]', name: 'Voucher barcode' },
      ],
    });
    const gaps = identifyExplorationGaps({
      crawlResult: crawlResult([dashboard]),
      routing: HASH_ROUTING,
      baseUrl: 'https://a.test/',
      planItems: [{ id: 'p1', title: 'Voucher listing with barcode' }],
      observedEndpoints: [],
    });

    expect(gaps[0]).toMatchObject({ targetName: 'Voucher barcode', relatedPlanItemId: 'p1' });
  });

  it('does not misclassify a brand-named affordance on an AUTHENTICATED route as low-value, even though the same brand name is a social/OAuth signal on an anonymous route', () => {
    // Regression guard: a naive brand-name regex would catch "Apple Wallet"/"Google Wallet" the
    // same way it (correctly) catches an anonymous-page Facebook/Google OAuth button.
    const dashboard = route('https://a.test/#/SK/dashboard', {
      role: 'authenticated',
      unattemptedClickCandidates: [
        { selector: '[data-testid=apple-wallet]', name: 'apple wallet' },
        { selector: '[data-testid=other-btn]', name: 'Some other feature' },
      ],
    });
    const register = route('https://a.test/#/SK/register', {
      role: 'anonymous',
      unattemptedClickCandidates: [{ selector: '[data-testid=facebook-btn]', name: 'Facebook' }],
    });
    const gaps = identifyExplorationGaps({
      crawlResult: crawlResult([register, dashboard]),
      routing: HASH_ROUTING,
      baseUrl: 'https://a.test/',
      planItems: [],
      observedEndpoints: [],
    });

    const appleWalletGap = gaps.find((g) => g.targetName === 'apple wallet');
    const facebookGap = gaps.find((g) => g.targetName === 'Facebook');
    expect(appleWalletGap?.lowValueAffordance).not.toBe(true);
    expect(facebookGap?.lowValueAffordance).toBe(true);
    expect(gaps.indexOf(appleWalletGap!)).toBeLessThan(gaps.indexOf(facebookGap!));
  });
});

function makeFakeBrowser(config: {
  pages: Record<string, InteractiveElement[]>;
  onClickSelectorReveal?: Record<string, InteractiveElement[]>;
  throwOnClick?: Set<string>;
}): BrowserSurface {
  let currentUrl = '';
  let revealed: InteractiveElement[] | undefined;
  return {
    async start(_opts?: BrowserSurfaceOptions): Promise<void> {},
    async goto(url: string): Promise<void> {
      currentUrl = url;
      revealed = undefined;
    },
    async screenshot(): Promise<Buffer> {
      return Buffer.alloc(0);
    },
    async snapshot(): Promise<DomSnapshot> {
      return {
        url: currentUrl,
        title: currentUrl,
        interactiveElements: revealed ?? config.pages[currentUrl] ?? [],
      };
    },
    async click(selector: string): Promise<void> {
      if (config.throwOnClick?.has(selector)) {
        throw new Error(`locator.click: Timeout 30000ms exceeded for ${selector}`);
      }
      const reveal = config.onClickSelectorReveal?.[selector];
      if (reveal) revealed = reveal;
    },
    async clickAt(_point: Point): Promise<void> {},
    async type(): Promise<void> {},
    async pressKey(key: string): Promise<void> {
      if (key === 'Escape') revealed = undefined;
    },
    onFrame(): () => void {
      return () => {};
    },
    drainNetworkEvents(): CapturedNetworkEvent[] {
      return [];
    },
    async exportStorageState() {
      return {};
    },
    async stop(): Promise<void> {},
  };
}

function button(name: string, selector = `button:has-text("${name}")`): InteractiveElement {
  return { role: 'button', name, selector };
}

describe('runGapFillingPass()', () => {
  it('deterministically closes an unvisited-plan-route gap via goto', async () => {
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/#/SK/unsubscribeinfopage': [button('Unsubscribe')] },
    });
    const gaps = [
      {
        id: 'route:/unsubscribeinfopage',
        kind: 'unvisited-plan-route' as const,
        description: 'test',
        targetUrlGuess: 'https://a.test/#/SK/unsubscribeinfopage',
      },
    ];

    const result = await runGapFillingPass({ browser, baseUrl: 'https://a.test/', gaps, emit: () => {} });

    expect(result.attempts).toEqual([{ gap: gaps[0], outcome: 'closed', newRoutesCaptured: 1 }]);
    expect(result.newRoutes).toHaveLength(1);
    expect(result.newRoutes[0].url).toBe('https://a.test/#/SK/unsubscribeinfopage');
  });

  it('deterministically closes an unclicked-affordance gap via click-and-diff', async () => {
    const walletBtn = button('Wallet', '[data-testid=wallet-btn]');
    const revealed = [walletBtn, button('A'), button('B'), button('C'), button('D'), button('E')];
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/#/SK/dashboard': [walletBtn] },
      onClickSelectorReveal: { '[data-testid=wallet-btn]': revealed },
    });
    const gaps = [
      {
        id: 'click:https://a.test/#/SK/dashboard>>[data-testid=wallet-btn]',
        kind: 'unclicked-affordance' as const,
        description: 'test',
        parentRouteUrl: 'https://a.test/#/SK/dashboard',
        targetSelectorGuess: '[data-testid=wallet-btn]',
        targetName: 'Wallet',
      },
    ];

    const result = await runGapFillingPass({ browser, baseUrl: 'https://a.test/', gaps, emit: () => {} });

    expect(result.attempts[0].outcome).toBe('closed');
    expect(result.newRoutes).toHaveLength(1);
    expect(result.newRoutes[0].stateKey).toBe('https://a.test/#/SK/dashboard>>[data-testid=wallet-btn]');
  });

  it('marks a gap skipped-budget once the total deadline has passed, without attempting it', async () => {
    const browser = makeFakeBrowser({ pages: {} });
    const gaps = [
      {
        id: 'route:/never',
        kind: 'unvisited-plan-route' as const,
        description: 'test',
        targetUrlGuess: 'https://a.test/#/SK/never',
      },
    ];

    const result = await runGapFillingPass({
      browser,
      baseUrl: 'https://a.test/',
      gaps,
      emit: () => {},
      totalBudgetMs: 0,
    });

    expect(result.attempts).toEqual([{ gap: gaps[0], outcome: 'skipped-budget', newRoutesCaptured: 0 }]);
  });

  it('escalates to the micro-agent when the deterministic click reveals nothing, and refuses an unsafe action', async () => {
    const noopBtn = button('Do nothing', '[data-testid=noop-btn]');
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/#/SK/dashboard': [noopBtn] },
      // No onClickSelectorReveal for this selector -> deterministic click-and-diff finds nothing.
    });
    const gaps = [
      {
        id: 'click:https://a.test/#/SK/dashboard>>[data-testid=noop-btn]',
        kind: 'unclicked-affordance' as const,
        description: 'test',
        parentRouteUrl: 'https://a.test/#/SK/dashboard',
        targetSelectorGuess: '[data-testid=noop-btn]',
        targetName: 'Do nothing',
      },
    ];

    const fakeProvider: ProviderAdapter = {
      id: 'claude',
      label: 'fake',
      capabilities: ['plan'],
      detect: async () => ({ installed: true, binPath: null, version: null }),
      health: async () => {
        throw new Error('unused');
      },
      plan: async () => {
        throw new Error('unused');
      },
      complete: async (_prompt: string, _opts?: CompleteOptions): Promise<CompletionResult> => ({
        provider: 'claude',
        ok: true,
        // Proposes clicking the "Delete account" — unsafe by name — which must be refused
        // without ever calling browser.click() for it.
        text: 'click([data-testid=delete-account])',
        raw: null,
        detail: '',
      }),
    };

    const result = await runGapFillingPass({
      browser,
      baseUrl: 'https://a.test/',
      gaps,
      emit: () => {},
      gapFillProvider: { provider: fakeProvider },
    });

    expect(result.attempts[0].usedMicroAgent).toBe(true);
    expect(result.attempts[0].outcome).toBe('partial');
    expect(result.newRoutes).toHaveLength(0);
  });

  it('escalates to the micro-agent when the deterministic click itself fails (stale/dead selector), rather than hard-failing the gap', async () => {
    const staleSelector = '[data-testid=stale-btn]';
    const validSelector = '[data-testid=valid-btn]';
    // Base page has 2 elements (Stale, Valid); a reveal needs >= 2+5=7 to register as real.
    const revealed = [
      button('A'),
      button('B'),
      button('C'),
      button('D'),
      button('E'),
      button('F'),
      button('G'),
    ];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/#/SK/dashboard': [button('Stale', staleSelector), button('Valid', validSelector)],
      },
      throwOnClick: new Set([staleSelector]),
      onClickSelectorReveal: { [validSelector]: revealed },
    });
    const gaps = [
      {
        id: `click:https://a.test/#/SK/dashboard>>${staleSelector}`,
        kind: 'unclicked-affordance' as const,
        description: 'test',
        parentRouteUrl: 'https://a.test/#/SK/dashboard',
        targetSelectorGuess: staleSelector,
        targetName: 'Stale',
      },
    ];

    const fakeProvider: ProviderAdapter = {
      id: 'claude',
      label: 'fake',
      capabilities: ['plan'],
      detect: async () => ({ installed: true, binPath: null, version: null }),
      health: async () => {
        throw new Error('unused');
      },
      plan: async () => {
        throw new Error('unused');
      },
      // The model looks at the live snapshot (which no longer has a "stale" element) and picks
      // the still-valid one instead.
      complete: async (): Promise<CompletionResult> => ({
        provider: 'claude',
        ok: true,
        text: `click(${validSelector})`,
        raw: null,
        detail: '',
      }),
    };

    const result = await runGapFillingPass({
      browser,
      baseUrl: 'https://a.test/',
      gaps,
      emit: () => {},
      gapFillProvider: { provider: fakeProvider },
    });

    expect(result.attempts[0].usedMicroAgent).toBe(true);
    expect(result.attempts[0].outcome).toBe('closed');
    expect(result.newRoutes).toHaveLength(1);
  });

  it('still parses the action when the model prepends boilerplate commentary before it (real CLI behavior observed live)', async () => {
    // targetSelectorGuess (the decoy) reveals nothing deterministically — the micro-agent has to
    // pick the OTHER, actually-useful selector itself, from its own reply.
    const decoySelector = '[data-testid=decoy-btn]';
    const realSelector = '[data-testid=real-btn]';
    // Base page has 2 elements (Decoy, Real); a reveal needs >= 2+5=7 to register as real.
    const revealed = [
      button('A'),
      button('B'),
      button('C'),
      button('D'),
      button('E'),
      button('F'),
      button('G'),
    ];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/#/SK/dashboard': [button('Decoy', decoySelector), button('Real', realSelector)],
      },
      onClickSelectorReveal: { [realSelector]: revealed },
    });
    const gaps = [
      {
        id: `click:https://a.test/#/SK/dashboard>>${decoySelector}`,
        kind: 'unclicked-affordance' as const,
        description: 'test',
        parentRouteUrl: 'https://a.test/#/SK/dashboard',
        targetSelectorGuess: decoySelector,
        targetName: 'Decoy',
      },
    ];

    const fakeProvider: ProviderAdapter = {
      id: 'claude',
      label: 'fake',
      capabilities: ['plan'],
      detect: async () => ({ installed: true, binPath: null, version: null }),
      health: async () => {
        throw new Error('unused');
      },
      plan: async () => {
        throw new Error('unused');
      },
      complete: async (): Promise<CompletionResult> => ({
        provider: 'claude',
        ok: true,
        text: `This is a single bounded browser action, not a plan-mode task.\n\nclick(${realSelector})`,
        raw: null,
        detail: '',
      }),
    };

    const result = await runGapFillingPass({
      browser,
      baseUrl: 'https://a.test/',
      gaps,
      emit: () => {},
      gapFillProvider: { provider: fakeProvider },
    });

    expect(result.attempts[0].usedMicroAgent).toBe(true);
    expect(result.attempts[0].outcome).toBe('closed');
    expect(result.newRoutes).toHaveLength(1);
  });

  it('parses a click() action whose selector argument itself contains parentheses (a real tier-4 positional selector, observed live)', async () => {
    // A live run against the real app hit exactly this: the model correctly chose
    // `click(div:nth-of-type(2) > ... > img)`, but a naive "capture up to the FIRST )" regex
    // mistook nth-of-type(2)'s own closing paren for the call's, silently failing to parse a
    // perfectly valid action and stopping the whole gap-fill attempt with no error at all.
    const decoySelector = '[data-testid=decoy-btn]';
    const realSelector = 'div:nth-of-type(2) > div > div:nth-of-type(3) > img';
    const revealed = [
      button('A'),
      button('B'),
      button('C'),
      button('D'),
      button('E'),
      button('F'),
      button('G'),
    ];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/#/SK/dashboard': [button('Decoy', decoySelector), button('Real', realSelector)],
      },
      onClickSelectorReveal: { [realSelector]: revealed },
    });
    const gaps = [
      {
        id: `click:https://a.test/#/SK/dashboard>>${decoySelector}`,
        kind: 'unclicked-affordance' as const,
        description: 'test',
        parentRouteUrl: 'https://a.test/#/SK/dashboard',
        targetSelectorGuess: decoySelector,
        targetName: 'Decoy',
      },
    ];

    const fakeProvider: ProviderAdapter = {
      id: 'claude',
      label: 'fake',
      capabilities: ['plan'],
      detect: async () => ({ installed: true, binPath: null, version: null }),
      health: async () => {
        throw new Error('unused');
      },
      plan: async () => {
        throw new Error('unused');
      },
      complete: async (): Promise<CompletionResult> => ({
        provider: 'claude',
        ok: true,
        text: `click(${realSelector})`,
        raw: null,
        detail: '',
      }),
    };

    const result = await runGapFillingPass({
      browser,
      baseUrl: 'https://a.test/',
      gaps,
      emit: () => {},
      gapFillProvider: { provider: fakeProvider },
    });

    expect(result.attempts[0].usedMicroAgent).toBe(true);
    expect(result.attempts[0].outcome).toBe('closed');
    expect(result.newRoutes).toHaveLength(1);
  });

  it('skips LLM escalation entirely for a gap already classified low-value, once its deterministic click reveals nothing', async () => {
    const facebookBtn = button('Facebook', '[data-testid=facebook-btn]');
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/#/SK/register': [facebookBtn] },
      // No onClickSelectorReveal -> deterministic click-and-diff reveals nothing.
    });
    let providerCalls = 0;
    const countingProvider: ProviderAdapter = {
      id: 'claude',
      label: 'fake',
      capabilities: ['plan'],
      detect: async () => ({ installed: true, binPath: null, version: null }),
      health: async () => {
        throw new Error('unused');
      },
      plan: async () => {
        throw new Error('unused');
      },
      complete: async (): Promise<CompletionResult> => {
        providerCalls += 1;
        return { provider: 'claude', ok: true, text: 'done()', raw: null, detail: '' };
      },
    };
    const gaps = [
      {
        id: 'click:https://a.test/#/SK/register>>[data-testid=facebook-btn]',
        kind: 'unclicked-affordance' as const,
        description: 'test',
        parentRouteUrl: 'https://a.test/#/SK/register',
        targetSelectorGuess: '[data-testid=facebook-btn]',
        targetName: 'Facebook',
        parentRouteRole: 'anonymous' as const,
        lowValueAffordance: true,
      },
    ];

    const result = await runGapFillingPass({
      browser,
      baseUrl: 'https://a.test/',
      gaps,
      emit: () => {},
      gapFillProvider: { provider: countingProvider },
    });

    expect(providerCalls).toBe(0);
    expect(result.attempts[0].outcome).toBe('partial');
    expect(result.attempts[0].usedMicroAgent).toBeUndefined();
    expect(result.attempts[0].detail).toMatch(/skipped LLM escalation/);
  });

  it("bounds a single gap's micro-agent turns to its own per-gap budget, so an overrunning gap does not starve the shared budget for the gap behind it", async () => {
    const slowSelector = '[data-testid=slow-btn]';
    const voucherSelector = '[data-testid=voucher-btn]';
    const revealed = [
      button('A'),
      button('B'),
      button('C'),
      button('D'),
      button('E'),
      button('F'),
      button('G'),
    ];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/#/SK/dashboard': [button('Slow', slowSelector)],
        'https://a.test/#/SK/vouchers': [button('Voucher', voucherSelector)],
      },
      onClickSelectorReveal: { [voucherSelector]: revealed },
    });

    let slowGapCompletions = 0;
    const slowProvider: ProviderAdapter = {
      id: 'claude',
      label: 'fake',
      capabilities: ['plan'],
      detect: async () => ({ installed: true, binPath: null, version: null }),
      health: async () => {
        throw new Error('unused');
      },
      plan: async () => {
        throw new Error('unused');
      },
      // Never reveals anything (targets the same dead-end selector every turn) and takes real
      // wall-clock time per turn, simulating a slow/looping micro-agent call.
      complete: async (): Promise<CompletionResult> => {
        slowGapCompletions += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { provider: 'claude', ok: true, text: `click(${slowSelector})`, raw: null, detail: '' };
      },
    };

    const gaps = [
      {
        id: 'click:dashboard>>slow',
        kind: 'unclicked-affordance' as const,
        description: 'slow gap',
        parentRouteUrl: 'https://a.test/#/SK/dashboard',
        targetSelectorGuess: slowSelector,
        targetName: 'Slow',
      },
      {
        id: 'click:vouchers>>voucher',
        kind: 'unclicked-affordance' as const,
        description: 'voucher gap',
        parentRouteUrl: 'https://a.test/#/SK/vouchers',
        targetSelectorGuess: voucherSelector,
        targetName: 'Voucher',
      },
    ];

    const result = await runGapFillingPass({
      browser,
      baseUrl: 'https://a.test/',
      gaps,
      emit: () => {},
      gapFillProvider: { provider: slowProvider },
      totalBudgetMs: 5_000,
      perGapBudgetMs: 20,
    });

    // Cut short by its own per-gap budget well before MICRO_AGENT_MAX_ACTIONS (4) turns.
    expect(slowGapCompletions).toBeLessThan(4);
    expect(result.attempts[0].outcome).toBe('partial');
    // The gap behind it must still be genuinely attempted, not starved into skipped-budget.
    expect(result.attempts[1].outcome).toBe('closed');
    expect(result.newRoutes).toHaveLength(1);
  });
});
