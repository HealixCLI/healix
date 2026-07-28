import { describe, expect, it } from 'vitest';
import { deriveRegionCodesFromText, deriveRegionSeeds, regionCodeOf } from './seed-discovery.js';
import type { CrawlResult, CrawledRoute } from './crawler.js';

function route(url: string): CrawledRoute {
  return {
    url,
    title: url,
    snapshot: { url, title: url, interactiveElements: [] },
    depth: 0,
    hasPasswordField: false,
    role: 'anonymous',
    networkEvents: [],
  };
}

function crawlResult(urls: string[]): CrawlResult {
  return {
    routes: urls.map(route),
    visitedCount: urls.length,
    budgetExhausted: false,
    redirectLoopsDetected: [],
    shellCollapsed: false,
    degenerateRedirectsSkipped: [],
  };
}

describe('deriveRegionSeeds()', () => {
  it('substitutes the detected region prefix across every visited route to derive sibling-region URLs', () => {
    const result = crawlResult(['https://a.test/#/SK/home', 'https://a.test/#/SK/dashboard/vouchers']);

    const seeds = deriveRegionSeeds({ hashRouted: true, invariantPrefix: '#/SK' }, result, [
      'SK',
      'CZ',
      'HU',
    ]);

    expect(seeds.sort()).toEqual(
      [
        'https://a.test/#/CZ/home',
        'https://a.test/#/CZ/dashboard/vouchers',
        'https://a.test/#/HU/home',
        'https://a.test/#/HU/dashboard/vouchers',
      ].sort(),
    );
  });

  it('excludes the current region code from the derived siblings', () => {
    const result = crawlResult(['https://a.test/#/SK/home']);

    const seeds = deriveRegionSeeds({ hashRouted: true, invariantPrefix: '#/SK' }, result, ['SK']);

    expect(seeds).toEqual([]);
  });

  it('returns nothing for a non-hash-routed app (no invariant prefix to substitute)', () => {
    const result = crawlResult(['https://a.test/home']);

    const seeds = deriveRegionSeeds({ hashRouted: false }, result, ['SK', 'CZ']);

    expect(seeds).toEqual([]);
  });

  it('returns nothing when no region codes are known', () => {
    const result = crawlResult(['https://a.test/#/SK/home']);

    const seeds = deriveRegionSeeds({ hashRouted: true, invariantPrefix: '#/SK' }, result, []);

    expect(seeds).toEqual([]);
  });
});

describe('deriveRegionCodesFromText()', () => {
  it('extracts plausible region codes from plan-item-shaped text, dropping common false positives', () => {
    const codes = deriveRegionCodesFromText([
      'CZ/HU-specific home page copy must render correctly',
      'Verify the FAQ page loads via the API',
    ]);

    expect(codes.sort()).toEqual(['CZ', 'HU'].sort());
    expect(codes).not.toContain('FAQ');
    expect(codes).not.toContain('API');
  });
});

describe('regionCodeOf()', () => {
  it('extracts the first hash segment as the region code', () => {
    expect(regionCodeOf('https://a.test/#/CZ/dashboard/vouchers')).toBe('CZ');
  });

  it('returns undefined for a URL with no hash route', () => {
    expect(regionCodeOf('https://a.test/dashboard')).toBeUndefined();
  });
});
