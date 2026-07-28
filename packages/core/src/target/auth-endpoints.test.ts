import { describe, expect, it } from 'vitest';
import { isAuthEndpointPath, isAuthHostname } from './auth-endpoints.js';

describe('isAuthEndpointPath', () => {
  const positives = [
    '/auth/token/generate',
    '/v3/oauth/token/generate',
    '/api/v1/auth/login',
    '/login',
    '/users/login',
    '/signin',
    '/sign-in',
    '/sign_in',
    '/session',
    '/sessions/new',
    '/connect/token',
    '/identity/connect/token',
    '/v1/accounts:signInWithPassword',
    '/customer/passwordvalidate',
    '/refresh-token',
    '/authenticate',
    '/token',
    '/AUTH/Token/Generate',
    '/auth/:param/token',
  ];

  it.each(positives)('detects %s as an auth endpoint', (path) => {
    expect(isAuthEndpointPath(path)).toBe(true);
  });

  const negatives = [
    '/authors/:param',
    '/logout',
    '/auth/logout',
    '/signout',
    '/csrf-token',
    '/device/token',
    '/reset-password',
    '/forgot-password',
    '/customer/registerforpassword',
    '/settings',
    '/products',
  ];

  it.each(negatives)('does not detect %s as an auth endpoint', (path) => {
    expect(isAuthEndpointPath(path)).toBe(false);
  });
});

describe('isAuthHostname', () => {
  it('matches dedicated auth/identity hosts', () => {
    expect(isAuthHostname('auth.example.com')).toBe(true);
    expect(isAuthHostname('login.example.com')).toBe(true);
    expect(isAuthHostname('sso.example.com')).toBe(true);
    expect(isAuthHostname('accounts.google.com')).toBe(true);
  });

  it('does not match a generic API host', () => {
    expect(isAuthHostname('eu.api.capillarytech.com')).toBe(false);
    expect(isAuthHostname('api.example.com')).toBe(false);
  });
});
