import { describe, expect, it } from 'vitest';
import { deriveUrlTokenCredentialFromBaseUrl } from './index.js';

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
