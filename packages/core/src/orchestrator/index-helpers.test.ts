import { describe, expect, it } from 'vitest';
import { deriveUrlTokenCredentialFromBaseUrl, mergeMockedRequestCounts } from './index.js';

// F-17 (Set 2 — fixtures/mock/auth execution): a project's baseUrl can itself
// already be a working url-token deep link even though no credential was ever
// configured — authSetupContents()'s loginUrlToken() fully supports this
// scheme, but an empty project.credentials never gave it a chance to run.
// See docs/set-2-fixtures-mock-execute.md's F-17 for the Herfy run evidence.
describe('deriveUrlTokenCredentialFromBaseUrl', () => {
  it('derives a url-token credential from a recognizable token=...&mobile=... query string', () => {
    const cred = deriveUrlTokenCredentialFromBaseUrl(
      'https://app.example.test/?token=abc123&mobile=966046567657',
    );
    expect(cred).not.toBeNull();
    expect(cred?.authType).toBe('url-token');
    expect(cred?.token).toBe('abc123');
    expect(cred?.urlTemplate).toBe('/?token={token}&mobile={mobile}');
    expect(cred?.extraParams).toEqual({ mobile: '966046567657' });
  });

  it('derives a credential from a hash-routed token deep link (SPA style)', () => {
    const cred = deriveUrlTokenCredentialFromBaseUrl(
      'https://app.example.test/#/token=abc123&mobile=966046567657&lang=ar-sa',
    );
    expect(cred).not.toBeNull();
    expect(cred?.authType).toBe('url-token');
    expect(cred?.token).toBe('abc123');
    expect(cred?.urlTemplate).toBe('/#/token={token}&mobile={mobile}&lang={lang}');
    expect(cred?.extraParams).toEqual({ mobile: '966046567657', lang: 'ar-sa' });
  });

  it('returns null for a plain baseUrl with no token-like param — the generic "no credentials configured" path stays correct', () => {
    expect(deriveUrlTokenCredentialFromBaseUrl('https://app.example.test/dashboard')).toBeNull();
  });

  it('returns null for a null/undefined/empty baseUrl', () => {
    expect(deriveUrlTokenCredentialFromBaseUrl(null)).toBeNull();
    expect(deriveUrlTokenCredentialFromBaseUrl(undefined)).toBeNull();
    expect(deriveUrlTokenCredentialFromBaseUrl('')).toBeNull();
  });

  it('returns null for an unparsable URL string instead of throwing', () => {
    expect(() => deriveUrlTokenCredentialFromBaseUrl('not a url at all')).not.toThrow();
    expect(deriveUrlTokenCredentialFromBaseUrl('not a url at all')).toBeNull();
  });

  it('the derived credential has no username/password — url-token auth never needs them', () => {
    const cred = deriveUrlTokenCredentialFromBaseUrl('https://app.example.test/?token=xyz');
    expect(cred?.username).toBe('');
    expect(cred?.password).toBe('');
    expect(cred?.extraParams).toBeNull();
  });
});

// F-15: mockedRequestCounts used to only ever reflect the launch-time mock
// HTTP server (MockServerHandle) — completely blind to fixture-level
// (page.route()/`request` override) mocking, which is what most white-box
// projects actually use. mergeMockedRequestCounts is the seam that combines
// both into the one total the report shows.
describe('mergeMockedRequestCounts', () => {
  it('sums counts for a dependency id hit by both mechanisms', () => {
    const merged = mergeMockedRequestCounts({ 'pkg:twilio': 2 }, { 'pkg:twilio': 3, 'env:API': 1 });
    expect(merged).toEqual({ 'pkg:twilio': 5, 'env:API': 1 });
  });

  it('returns the launch-time counts unchanged when there are no browser-level hits at all', () => {
    const launchTime = { 'pkg:twilio': 2 };
    expect(mergeMockedRequestCounts(launchTime, undefined)).toBe(launchTime);
    expect(mergeMockedRequestCounts(launchTime, {})).toBe(launchTime);
  });

  it('surfaces browser-level-only counts even when the launch-time server never ran (the Herfy case)', () => {
    const merged = mergeMockedRequestCounts({}, { 'env:VITE_CAP_API_BASE_URL': 4 });
    expect(merged).toEqual({ 'env:VITE_CAP_API_BASE_URL': 4 });
  });
});
