import { describe, expect, it } from 'vitest';
import { collectObservedEndpoints } from './network-capture.js';
import type { CrawledRoute, CrawlWithAuthResult } from './crawler.js';
import type { CapturedNetworkEvent } from './types.js';

function route(events: CapturedNetworkEvent[], url = 'https://a.test/'): CrawledRoute {
  return {
    url,
    title: url,
    snapshot: { url, title: url, interactiveElements: [] },
    depth: 0,
    hasPasswordField: false,
    role: 'anonymous',
    networkEvents: events,
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

describe('collectObservedEndpoints()', () => {
  it('collapses numeric/UUID/opaque dynamic path segments to :param', () => {
    const events: CapturedNetworkEvent[] = [
      { method: 'GET', url: 'https://a.test/api/customer/12345/profile', status: 200 },
      { method: 'GET', url: 'https://a.test/api/customer/98765/profile', status: 200 },
      {
        method: 'GET',
        url: 'https://a.test/api/orders/9d3b6e2a-9c1b-4a3e-8b7e-1f2a3b4c5d6e',
        status: 200,
      },
    ];

    const result = collectObservedEndpoints(crawlResult([route(events)]));

    // The two numeric-id calls collapse to a single deduped endpoint.
    expect(result).toEqual([
      { method: 'GET', pathPattern: '/api/customer/:param/profile', status: 200, host: 'a.test' },
      { method: 'GET', pathPattern: '/api/orders/:param', status: 200, host: 'a.test' },
    ]);
  });

  it('dedupes by (method, pathPattern) across multiple routes, keeping the first-seen sample', () => {
    const events1: CapturedNetworkEvent[] = [
      { method: 'get', url: 'https://a.test/api/status', status: 200, responseBody: '{"ok":true}' },
    ];
    const events2: CapturedNetworkEvent[] = [
      { method: 'GET', url: 'https://a.test/api/status', status: 500, responseBody: '{"ok":false}' },
    ];

    const result = collectObservedEndpoints(
      crawlResult([route(events1, 'https://a.test/a'), route(events2, 'https://a.test/b')]),
    );

    expect(result).toEqual([
      {
        method: 'GET',
        pathPattern: '/api/status',
        status: 200,
        sampleResponseBody: '{"ok":true}',
        host: 'a.test',
      },
    ]);
  });

  it('redacts secrets in captured response bodies before they land on the artifact', () => {
    const events: CapturedNetworkEvent[] = [
      {
        method: 'POST',
        url: 'https://a.test/api/session',
        status: 200,
        responseBody: '{"token":"sk-live-abcdefghijklmnop1234567890","name":"Ada"}',
      },
    ];

    const result = collectObservedEndpoints(crawlResult([route(events)]));

    expect(result[0]?.sampleResponseBody).not.toContain('sk-live-abcdefghijklmnop1234567890');
    expect(result[0]?.sampleResponseBody).toContain('Ada');
  });

  it('skips an event whose URL cannot be parsed rather than throwing', () => {
    const events: CapturedNetworkEvent[] = [{ method: 'GET', url: 'not-a-url', status: 200 }];

    expect(() => collectObservedEndpoints(crawlResult([route(events)]))).not.toThrow();
    expect(collectObservedEndpoints(crawlResult([route(events)]))).toEqual([]);
  });

  it('caps output at 40 distinct endpoints', () => {
    const events: CapturedNetworkEvent[] = Array.from({ length: 60 }, (_, i) => ({
      method: 'GET',
      url: `https://a.test/api/thing-${i}`,
      status: 200,
    }));

    const result = collectObservedEndpoints(crawlResult([route(events)]));

    expect(result).toHaveLength(40);
  });

  it('returns an empty list for a crawl with no network activity', () => {
    expect(collectObservedEndpoints(crawlResult([route([])]))).toEqual([]);
  });

  it("records each observed endpoint's real hostname, distinguishing calls to different dependencies", () => {
    const events: CapturedNetworkEvent[] = [
      { method: 'GET', url: 'https://api.one.test/customer/coupons', status: 200 },
      { method: 'GET', url: 'https://api.two.test/customer/profile', status: 200 },
    ];

    const result = collectObservedEndpoints(crawlResult([route(events)]));

    expect(result.find((e) => e.pathPattern === '/customer/coupons')?.host).toBe('api.one.test');
    expect(result.find((e) => e.pathPattern === '/customer/profile')?.host).toBe('api.two.test');
  });
});
