import { describe, expect, it } from 'vitest';
import { detectStaticRegionCodes } from './region-index.js';

describe('detectStaticRegionCodes', () => {
  it('extracts codes from a REGIONS object registry', () => {
    const source = `
      export const REGIONS = {
        SK: { currency: 'EUR', locale: 'sk-SK' },
        CZ: { currency: 'CZK', locale: 'cs-CZ' },
        HU: { currency: 'HUF', locale: 'hu-HU' },
      };
    `;
    expect(detectStaticRegionCodes(source).sort()).toEqual(['CZ', 'HU', 'SK']);
  });

  it('extracts codes from an array-of-codes registry', () => {
    const source = `export const SUPPORTED_REGIONS = ['SK', 'CZ', 'RO'];`;
    expect(detectStaticRegionCodes(source).sort()).toEqual(['CZ', 'RO', 'SK']);
  });

  it('extracts codes from an enum-shaped RegionCode registry', () => {
    const source = `
      export enum RegionCode {
        SK = 'SK',
        CZ = 'CZ',
      }
    `;
    expect(detectStaticRegionCodes(source).sort()).toEqual(['CZ', 'SK']);
  });

  it('returns an empty array for a file with no region/locale registry', () => {
    const source = `export const API_BASE = 'https://api.example.com';\nexport function login() {}\n`;
    expect(detectStaticRegionCodes(source)).toEqual([]);
  });

  it('filters out shape-matching stopwords that are never real region codes', () => {
    const source = `export const REGIONS = { SK: {}, API: {}, URL: {} };`;
    expect(detectStaticRegionCodes(source)).toEqual(['SK']);
  });

  it('does not pick up unrelated uppercase tokens from code far outside the registry window', () => {
    const source = `export const REGIONS = { SK: {} };\n` + 'x'.repeat(5000) + `\nconst FOO = 'BAR';`;
    expect(detectStaticRegionCodes(source)).toEqual(['SK']);
  });

  it('does not fragment a SCREAMING_SNAKE_CASE identifier that trails the registry body within the scan window', () => {
    // Regression guard for a live-crawl-confirmed bug: BODY_SCAN_WINDOW_CHARS overscans past the
    // registry's own closing brace into whatever code follows (still at depth 0, since the
    // registry's own brackets already balanced). A boundary-less token regex read "REG"/"ION"/
    // "CON"/"FIG"/"DEF"/"AUL" out of a trailing `REGION_CONFIG_DEFAULT`-shaped identifier there —
    // confirmed live against a real i18n/regions.ts file with exactly this shape nearby.
    const source = `
      export const REGIONS = {
        SK: {},
        CZ: {},
      };
      const _INTERNAL_REGION_CONFIG_DEFAULT = true;
    `;
    expect(detectStaticRegionCodes(source).sort()).toEqual(['CZ', 'SK']);
  });
});
