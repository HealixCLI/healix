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

  it("copies a candidate's selectorTier and repeatedRowText onto the resulting gap", () => {
    const dashboard = route('https://a.test/#/SK/dashboard', {
      unattemptedClickCandidates: [
        {
          selector: 'div > div > div:nth-of-type(1) > div > div:nth-of-type(3) > p',
          name: 'zmeniť',
          selectorTier: 4,
          repeatedRowText: 'Meno Priezvisko Dátum narodenia zmeniť',
        },
      ],
    });
    const gaps = identifyExplorationGaps({
      crawlResult: crawlResult([dashboard]),
      routing: HASH_ROUTING,
      baseUrl: 'https://a.test/',
      planItems: [],
      observedEndpoints: [],
    });

    expect(gaps[0]).toMatchObject({
      targetSelectorTier: 4,
      targetRepeatedRowText: 'Meno Priezvisko Dátum narodenia zmeniť',
    });
  });

  it('sorts plan-linked gaps first and caps only the UNLINKED tail at MAX_GAPS_PER_RUN', () => {
    // None of these 15 generic buttons correlate to the "Unsubscribe page" plan item (no shared
    // significant word — "button" is a correlation stopword), so they're all unlinked and compete
    // for the fixed backstop; the one genuinely plan-linked route gap is never subject to it.
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

    // 1 plan-linked route gap (uncapped) + 10 of the 15 unlinked affordance gaps (capped).
    expect(gaps.length).toBe(11);
    expect(gaps[0].relatedPlanItemId).toBe('p1');
    expect(gaps.filter((g) => !g.relatedPlanItemId).length).toBe(10);
  });

  it('never truncates plan-linked gaps even when there are more than MAX_GAPS_PER_RUN of them', () => {
    const dashboard = route('https://a.test/#/SK/dashboard');
    const planItems = Array.from({ length: 15 }, (_, i) => ({
      id: `p${i}`,
      title: `Item ${i}`,
      unitKey: `route:/route-${i}`,
    }));
    const gaps = identifyExplorationGaps({
      crawlResult: crawlResult([dashboard]),
      routing: HASH_ROUTING,
      baseUrl: 'https://a.test/',
      planItems,
      observedEndpoints: [],
    });

    expect(gaps.length).toBe(15);
    expect(gaps.every((g) => g.relatedPlanItemId)).toBe(true);
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

  it('correlates an affordance against the plan item with the MOST shared significant words, not the first item sharing any word', () => {
    // Regression guard for the "google wallet" mis-attribution: a naive first-match scan would
    // pick whichever of these two plan items happened to iterate first, since both titles share
    // the word "google" with the candidate name. Best-overlap must pick the wallet item, since it
    // additionally shares "wallet".
    const dashboard = route('https://a.test/#/SK/dashboard', {
      role: 'authenticated',
      unattemptedClickCandidates: [{ selector: '[data-testid=google-wallet]', name: 'google wallet' }],
    });
    const gaps = identifyExplorationGaps({
      crawlResult: crawlResult([dashboard]),
      routing: HASH_ROUTING,
      baseUrl: 'https://a.test/',
      planItems: [
        { id: 'social-login', title: 'Social login entry points (Google, Facebook via Cognito)' },
        { id: 'wallet', title: 'Digital wallet integration (Apple Wallet, Google Wallet)' },
      ],
      observedEndpoints: [],
    });

    const walletGap = gaps.find((g) => g.targetName === 'google wallet');
    expect(walletGap?.relatedPlanItemId).toBe('wallet');
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

  it('emits an unmet-content-need gap when a plan item describes content absent from every visited route, with the item scenario text as the goal', () => {
    const dashboard = route('https://a.test/#/SK/dashboard', {
      role: 'authenticated',
      unattemptedClickCandidates: [],
      snapshot: {
        url: 'https://a.test/#/SK/dashboard',
        title: 'Dashboard',
        interactiveElements: [{ role: 'generic', name: 'zmeniť', selector: 'p' }],
      },
    });
    const gaps = identifyExplorationGaps({
      crawlResult: crawlResult([dashboard]),
      routing: HASH_ROUTING,
      baseUrl: 'https://a.test/',
      planItems: [
        {
          id: 'p1',
          title: 'Change password from dashboard',
          unitKey: 'route:/dashboard',
          intent: 'verify the password-change flow',
          tier: 'tierB-auth',
          scenarios: [{ kind: 'positive', description: 'enter current password, new password, and submit' }],
        },
      ],
      observedEndpoints: [],
    });

    const contentGap = gaps.find((g) => g.kind === 'unmet-content-need');
    expect(contentGap).toBeDefined();
    expect(contentGap?.relatedPlanItemId).toBe('p1');
    expect(contentGap?.description).toContain('current password, new password, and submit');
    expect(contentGap?.candidateRouteUrls).toEqual(['https://a.test/#/SK/dashboard']);
  });

  it('does NOT emit an unmet-content-need gap when the requirement is already covered by an existing element', () => {
    const dashboard = route('https://a.test/#/SK/dashboard', {
      role: 'authenticated',
      snapshot: {
        url: 'https://a.test/#/SK/dashboard',
        title: 'Dashboard',
        interactiveElements: [{ role: 'textbox', name: 'New password', selector: '#np' }],
      },
    });
    const gaps = identifyExplorationGaps({
      crawlResult: crawlResult([dashboard]),
      routing: HASH_ROUTING,
      baseUrl: 'https://a.test/',
      planItems: [
        {
          id: 'p1',
          title: 'Change password from dashboard',
          unitKey: 'route:/dashboard',
          intent: 'verify the password-change flow',
          tier: 'tierB-auth',
          scenarios: [{ kind: 'positive', description: 'enter a new password' }],
        },
      ],
      observedEndpoints: [],
    });

    expect(gaps.some((g) => g.kind === 'unmet-content-need')).toBe(false);
  });

  it('never emits an unmet-content-need gap for a tierC-api item', () => {
    const dashboard = route('https://a.test/#/SK/dashboard', { role: 'authenticated' });
    const gaps = identifyExplorationGaps({
      crawlResult: crawlResult([dashboard]),
      routing: HASH_ROUTING,
      baseUrl: 'https://a.test/',
      planItems: [
        {
          id: 'p1',
          title: 'Backend rejects invalid tokens',
          unitKey: 'route:/dashboard',
          intent: 'verify API auth rejection',
          tier: 'tierC-api',
          scenarios: [{ kind: 'negative', description: 'expired token returns 401' }],
        },
      ],
      observedEndpoints: [],
    });

    expect(gaps.some((g) => g.kind === 'unmet-content-need')).toBe(false);
  });

  it('sorts an unmet-content-need gap ahead of a plan-correlated unclicked-affordance gap', () => {
    const dashboard = route('https://a.test/#/SK/dashboard', {
      role: 'authenticated',
      unattemptedClickCandidates: [{ selector: '[data-testid=voucher-btn]', name: 'Voucher barcode' }],
      snapshot: {
        url: 'https://a.test/#/SK/dashboard',
        title: 'Dashboard',
        interactiveElements: [],
      },
    });
    const gaps = identifyExplorationGaps({
      crawlResult: crawlResult([dashboard]),
      routing: HASH_ROUTING,
      baseUrl: 'https://a.test/',
      planItems: [
        { id: 'p1', title: 'Voucher listing with barcode' },
        {
          id: 'p2',
          title: 'Change password from dashboard',
          unitKey: 'route:/dashboard',
          intent: 'verify the password-change flow',
          tier: 'tierB-auth',
          scenarios: [{ kind: 'positive', description: 'enter current password and new password' }],
        },
      ],
      observedEndpoints: [],
    });

    expect(gaps[0].kind).toBe('unmet-content-need');
    expect(gaps[0].relatedPlanItemId).toBe('p2');
  });

  it('prefers authenticated routes for a tierB-auth item with no unitKey to resolve against (a common real-world case — many projects never populate unitKey at all)', () => {
    // Anonymous route listed FIRST in crawl order — if candidates weren't re-ordered by the
    // item's own tier, parentRouteRole/candidateRouteUrls[0] would arbitrarily inherit this
    // anonymous route's role even though the item is clearly about authenticated content.
    const home = route('https://a.test/#/SK/home', { role: 'anonymous' });
    const dashboard = route('https://a.test/#/SK/dashboard', {
      role: 'authenticated',
      snapshot: { url: 'https://a.test/#/SK/dashboard', title: 'Dashboard', interactiveElements: [] },
    });
    const gaps = identifyExplorationGaps({
      crawlResult: crawlResult([home, dashboard]),
      routing: HASH_ROUTING,
      baseUrl: 'https://a.test/',
      planItems: [
        {
          id: 'p1',
          title: 'Change password from dashboard',
          // No unitKey — candidates fall back to every visited route.
          intent: 'verify the password-change flow',
          tier: 'tierB-auth',
          scenarios: [{ kind: 'positive', description: 'enter current password and new password' }],
        },
      ],
      observedEndpoints: [],
    });

    const contentGap = gaps.find((g) => g.kind === 'unmet-content-need');
    expect(contentGap?.parentRouteRole).toBe('authenticated');
    expect(contentGap?.candidateRouteUrls?.[0]).toBe('https://a.test/#/SK/dashboard');
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
    async reload(): Promise<void> {
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

  it('retries with a text-anchored locator when a tier-4 positional selector reveals nothing on a fresh reload, and closes the gap', async () => {
    const staleSelector = 'div > div > div:nth-of-type(1) > div > div:nth-of-type(3) > p';
    const textSelector = ':text-is("zmeniť")';
    const revealed = [button('A'), button('B'), button('C'), button('D'), button('E'), button('F')];
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/#/SK/dashboard': [button('zmeniť', staleSelector)] },
      // The stale positional selector resolves to a different (or non-revealing) node on reload —
      // only the text-anchored retry selector actually reveals the form.
      onClickSelectorReveal: { [textSelector]: revealed },
    });
    const gaps = [
      {
        id: `click:https://a.test/#/SK/dashboard>>${staleSelector}`,
        kind: 'unclicked-affordance' as const,
        description: 'test',
        parentRouteUrl: 'https://a.test/#/SK/dashboard',
        targetSelectorGuess: staleSelector,
        targetName: 'zmeniť',
        targetSelectorTier: 4 as const,
      },
    ];

    const result = await runGapFillingPass({ browser, baseUrl: 'https://a.test/', gaps, emit: () => {} });

    expect(result.attempts[0].outcome).toBe('closed');
    expect(result.newRoutes).toHaveLength(1);
    expect(result.newRoutes[0].stateKey).toBe(`https://a.test/#/SK/dashboard>>${textSelector}`);
  });

  it('does not attempt a text-anchored retry for a stable (tier 1-3) selector that reveals nothing — the selector was never the suspected problem', async () => {
    const stableSelector = '[data-testid=wallet-btn]';
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/#/SK/dashboard': [button('Wallet', stableSelector)] },
      onClickSelectorReveal: {
        ':text-is("Wallet")': [button('A'), button('B'), button('C'), button('D'), button('E'), button('F')],
      },
    });
    const gaps = [
      {
        id: `click:https://a.test/#/SK/dashboard>>${stableSelector}`,
        kind: 'unclicked-affordance' as const,
        description: 'test',
        parentRouteUrl: 'https://a.test/#/SK/dashboard',
        targetSelectorGuess: stableSelector,
        targetName: 'Wallet',
        targetSelectorTier: 1 as const,
      },
    ];

    // No provider configured — if the deterministic step wrongly closed the gap via the
    // never-should-have-been-tried text retry, this would show 'closed' instead of 'partial'.
    const result = await runGapFillingPass({ browser, baseUrl: 'https://a.test/', gaps, emit: () => {} });

    expect(result.attempts[0].outcome).toBe('partial');
    expect(result.newRoutes).toHaveLength(0);
  });

  it('disambiguates between two identically-named triggers by scoping the retry to the row identified by targetRepeatedRowText', async () => {
    // Regression test for the live-discovered bug: `gap.targetName` ("zmeniť") is shared by BOTH
    // triggers, so a name-only retry's `.first()` would always resolve to whichever happens to be
    // first in DOM order — arbitrarily closing the WRONG one. Only the row-scoped selector
    // (targetRepeatedRowText + targetName combined) reveals the correct (password) section.
    const staleSelector = 'div > div:nth-of-type(2) > p';
    const rowScopedSelector = ':has-text("Heslo ******** zmeniť") >> :text-is("zmeniť")';
    const revealed = [button('A'), button('B'), button('C'), button('D'), button('E'), button('F')];
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/#/SK/dashboard': [button('zmeniť', staleSelector)] },
      onClickSelectorReveal: {
        [rowScopedSelector]: revealed,
        // Deliberately NOT configured to reveal anything for the ambiguous bare-name selector —
        // if the fix regressed back to name-only, this test would see 'partial', not 'closed'.
      },
    });
    const gaps = [
      {
        id: `click:https://a.test/#/SK/dashboard>>${staleSelector}`,
        kind: 'unclicked-affordance' as const,
        description: 'test',
        parentRouteUrl: 'https://a.test/#/SK/dashboard',
        targetSelectorGuess: staleSelector,
        targetName: 'zmeniť',
        targetSelectorTier: 4 as const,
        targetRepeatedRowText: 'Heslo ******** zmeniť',
      },
    ];

    const result = await runGapFillingPass({ browser, baseUrl: 'https://a.test/', gaps, emit: () => {} });

    expect(result.attempts[0].outcome).toBe('closed');
    expect(result.newRoutes[0].stateKey).toBe(`https://a.test/#/SK/dashboard>>${rowScopedSelector}`);
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

  it("scopes each micro-agent complete() call's timeoutMs to the gap's own remaining budget, never Claude's generic 25-minute backstop (regression: a slow-but-live call used to ride out the full hard timeout instead of the intended per-gap deadline)", async () => {
    const selector = '[data-testid=slow-btn]';
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/#/SK/dashboard': [button('Slow', selector)] },
    });

    const seenTimeouts: (number | undefined)[] = [];
    const provider: ProviderAdapter = {
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
      complete: async (_prompt, opts): Promise<CompletionResult> => {
        seenTimeouts.push(opts?.timeoutMs);
        return { provider: 'claude', ok: true, text: 'done()', raw: null, detail: '' };
      },
    };

    const gaps = [
      {
        id: 'click:dashboard>>slow',
        kind: 'unclicked-affordance' as const,
        description: 'slow gap',
        parentRouteUrl: 'https://a.test/#/SK/dashboard',
        targetSelectorGuess: selector,
        targetName: 'Slow',
      },
    ];

    await runGapFillingPass({
      browser,
      baseUrl: 'https://a.test/',
      gaps,
      emit: () => {},
      gapFillProvider: { provider },
      totalBudgetMs: 5_000,
      perGapBudgetMs: 2_000,
    });

    expect(seenTimeouts.length).toBeGreaterThan(0);
    // Scoped to (well under) this gap's own budget — never left undefined (which would fall back
    // to complete()'s internal ABSOLUTE_BACKSTOP_MS, 25 minutes) and never anywhere near it.
    for (const t of seenTimeouts) {
      expect(t).toBeDefined();
      expect(t as number).toBeLessThanOrEqual(2_000);
      expect(t as number).toBeGreaterThan(0);
    }
  });

  it('unmet-content-need: tries each candidate route in turn, stopping at the first that reveals content, without visiting the rest', async () => {
    const revealed = [button('A'), button('B'), button('C'), button('D'), button('E'), button('F')];
    const browser = makeFakeBrowser({
      pages: {
        'https://a.test/#/SK/route1': [button('Nothing useful', '[data-testid=r1-btn]')],
        'https://a.test/#/SK/route2': [button('Password field', '[data-testid=r2-btn]')],
        'https://a.test/#/SK/route3': [button('Also nothing', '[data-testid=r3-btn]')],
      },
      onClickSelectorReveal: { '[data-testid=r2-btn]': revealed },
    });

    let visitedRoute3 = false;
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
      complete: async (prompt: string): Promise<CompletionResult> => {
        if (prompt.includes('r1-btn'))
          return { provider: 'claude', ok: true, text: 'done()', raw: null, detail: '' };
        if (prompt.includes('r2-btn')) {
          return { provider: 'claude', ok: true, text: 'click([data-testid=r2-btn])', raw: null, detail: '' };
        }
        if (prompt.includes('r3-btn')) visitedRoute3 = true;
        return { provider: 'claude', ok: true, text: 'done()', raw: null, detail: '' };
      },
    };

    const gaps = [
      {
        id: 'content:p1',
        kind: 'unmet-content-need' as const,
        description: 'needs a password field',
        relatedPlanItemId: 'p1',
        candidateRouteUrls: [
          'https://a.test/#/SK/route1',
          'https://a.test/#/SK/route2',
          'https://a.test/#/SK/route3',
        ],
      },
    ];

    const result = await runGapFillingPass({
      browser,
      baseUrl: 'https://a.test/',
      gaps,
      emit: () => {},
      gapFillProvider: { provider: fakeProvider },
    });

    expect(result.attempts[0].outcome).toBe('closed');
    expect(result.attempts[0].usedMicroAgent).toBe(true);
    expect(result.newRoutes).toHaveLength(1);
    expect(visitedRoute3).toBe(false);
  });

  it('unmet-content-need: reports partial (not failed) when no candidate route reveals anything', async () => {
    const browser = makeFakeBrowser({
      pages: { 'https://a.test/#/SK/route1': [button('Nothing useful', '[data-testid=r1-btn]')] },
    });
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
        text: 'done()',
        raw: null,
        detail: '',
      }),
    };
    const gaps = [
      {
        id: 'content:p1',
        kind: 'unmet-content-need' as const,
        description: 'needs a password field',
        relatedPlanItemId: 'p1',
        candidateRouteUrls: ['https://a.test/#/SK/route1'],
      },
    ];

    const result = await runGapFillingPass({
      browser,
      baseUrl: 'https://a.test/',
      gaps,
      emit: () => {},
      gapFillProvider: { provider: fakeProvider },
    });

    expect(result.attempts[0].outcome).toBe('partial');
    expect(result.newRoutes).toHaveLength(0);
  });

  it('unmet-content-need: reports partial with a detail when no gap-fill provider is configured', async () => {
    const browser = makeFakeBrowser({ pages: {} });
    const gaps = [
      {
        id: 'content:p1',
        kind: 'unmet-content-need' as const,
        description: 'needs a password field',
        relatedPlanItemId: 'p1',
      },
    ];

    const result = await runGapFillingPass({ browser, baseUrl: 'https://a.test/', gaps, emit: () => {} });

    expect(result.attempts[0].outcome).toBe('partial');
    expect(result.attempts[0].detail).toBe('no gap-fill provider configured');
  });
});
