import { describe, expect, it } from 'vitest';
import {
  buildRequirementTokens,
  hasRequirementCoverage,
  rankRouteElements,
  tokenize,
} from './requirement-tokens.js';
import type { CrawledRoute } from '../browser/crawler.js';
import type { InteractiveElement } from '../browser/types.js';

function el(overrides: Partial<InteractiveElement> = {}): InteractiveElement {
  return { role: 'generic', name: '', selector: 'div', inForm: false, disabled: false, ...overrides };
}

function route(elements: InteractiveElement[], role: CrawledRoute['role'] = 'anonymous'): CrawledRoute {
  return {
    url: 'https://a.test/page',
    title: 'page',
    snapshot: { url: 'https://a.test/page', title: 'page', interactiveElements: elements },
    depth: 0,
    hasPasswordField: false,
    role,
    networkEvents: [],
  };
}

describe('tokenize()', () => {
  it('lowercases, splits on non-alphanumeric, and drops stopwords/single chars', () => {
    expect(tokenize('Submit the Password Form!')).toEqual(['submit', 'password', 'form']);
  });
});

describe('buildRequirementTokens()', () => {
  it('collects tokens from title, intent, unitKey, and every scenario description', () => {
    const tokens = buildRequirementTokens({
      title: 'Change password',
      intent: 'verify password update flow',
      unitKey: 'route:/dashboard',
      scenarios: [{ description: 'enter current and new password, submit' }],
    });
    expect(tokens.has('password')).toBe(true);
    expect(tokens.has('submit')).toBe(true);
    expect(tokens.has('dashboard')).toBe(true);
  });

  it('returns an empty set when no item is passed', () => {
    expect(buildRequirementTokens(undefined).size).toBe(0);
  });
});

describe('rankRouteElements()', () => {
  it('ranks a keyword-matching element ahead of a non-matching one sharing DOM order', () => {
    const target = el({ name: 'Current password', selector: '#pw' });
    const other = el({ name: 'Unrelated', selector: '#other' });
    const r = route([other, target]);
    const reqTokens = buildRequirementTokens({ title: 'Change password', scenarios: [] });
    const ranked = rankRouteElements(r, reqTokens, 'authenticated');
    expect(ranked[0].selector).toBe('#pw');
  });
});

describe('hasRequirementCoverage()', () => {
  it('returns true when an element name overlaps a requirement token', () => {
    const r = route([el({ name: 'New password', selector: '#np' })]);
    const reqTokens = buildRequirementTokens({ title: 'Change password', scenarios: [] });
    expect(hasRequirementCoverage(r, reqTokens)).toBe(true);
  });

  it('returns true on an action-verb-only match (no literal keyword overlap)', () => {
    const r = route([el({ name: 'Confirm', role: 'button', selector: '#go' })]);
    const reqTokens = buildRequirementTokens({ title: 'Submit the form', scenarios: [] });
    expect(hasRequirementCoverage(r, reqTokens)).toBe(true);
  });

  it('returns false when nothing on the route relates to the requirement tokens', () => {
    const r = route([el({ name: 'Logo', selector: '#logo' })]);
    const reqTokens = buildRequirementTokens({ title: 'Change password', scenarios: [] });
    expect(hasRequirementCoverage(r, reqTokens)).toBe(false);
  });

  it('treats an empty requirement-token set as trivially covered', () => {
    const r = route([]);
    expect(hasRequirementCoverage(r, new Set())).toBe(true);
  });
});
