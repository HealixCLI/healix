/**
 * Deterministic, path-based detection of login/session-handshake endpoints —
 * independent of hostname, env-var name, and the KNOWN_PROVIDERS table (dependencies.ts),
 * all of which miss a custom auth host like `eu.api.capillarytech.com/auth/token/generate`.
 * Shared between dependencies.ts (endpoint attribution) and mock-responses.ts (response
 * shape) so detection can't drift between the two.
 */
import type { ExternalDependencyCategory } from './types.js';

/** Path segments that on their own identify a login/session handshake endpoint. */
const AUTH_SEGMENTS = new Set([
  'auth',
  'authenticate',
  'authentication',
  'authorize',
  'oauth',
  'oauth2',
  'sso',
  'saml',
  'identity',
  'connect',
  'login',
  'logon',
  'signin',
  'session',
  'sessions',
  'token',
  'tokens',
  'jwt',
]);

/**
 * Verb-embedding segments, matched against a separator-flattened path so `sign-in`,
 * `sign_in`, `signIn` and `accounts:signInWithPassword` all read the same.
 */
const AUTH_FLAT_RE =
  /(signin|login|authenticat|accesstoken|idtoken|refreshtoken|passwordvalidate|validatepassword|tokengenerate|generatetoken)/;

/**
 * Auth-ADJACENT paths that must never be handed a session/token body: a logout that
 * returns a fresh token, or a push/CSRF token endpoint mistaken for an auth token, is
 * worse than the generic fallback. Checked FIRST, so it also neutralizes the
 * `token`/`auth` segment rules (`/device/token`, `/auth/logout`).
 */
const NON_AUTH_FLAT_RE =
  /(logout|signout|revoke|forgotpassword|resetpassword|changepassword|csrftoken|devicetoken|pushtoken|fcm|apns)/;

/** Strip separators/case so segment-shape variants collapse to one comparable string. */
function flatten(pathPattern: string): string {
  return pathPattern.toLowerCase().replace(/[-_./:]/g, '');
}

/**
 * True when a (normalized) endpoint path is a login/token/session handshake, judged
 * from the PATH ALONE. Tolerates `:param` placeholders (see dependencies.ts's
 * normalizeEndpointPath) and any `/api/v2/...` prefix. Uses exact-segment matching for
 * the short/ambiguous markers (`auth`, `token`, ...) so `/authors/:param` doesn't
 * false-positive against `/auth/token/generate` — a substring rule would match both.
 */
export function isAuthEndpointPath(pathPattern: string): boolean {
  const flat = flatten(pathPattern);
  if (NON_AUTH_FLAT_RE.test(flat)) return false;
  if (AUTH_FLAT_RE.test(flat)) return true;
  return pathPattern
    .toLowerCase()
    .split(/[/?#]/)
    .filter(Boolean)
    .some((segment) => AUTH_SEGMENTS.has(segment));
}

/**
 * A login handshake is almost always POST, but session probes and OAuth `authorize`
 * are GET, and the mocked body is identical either way — registering both beats
 * guessing wrong and silently not matching.
 */
export const AUTH_ENDPOINT_METHODS: readonly string[] = ['POST', 'GET'];

/** Auth-looking hostname, for narrowing which dependency an auth path is attributed to. */
const AUTH_HOST_RE = /(^|[.-])(auth|login|identity|sso|accounts?|cognito|oauth)([.-]|$)/i;

/** True when a hostname itself looks like a dedicated auth/identity host. */
export function isAuthHostname(host: string): boolean {
  return AUTH_HOST_RE.test(host);
}

/** The category an auth-classified endpoint/dependency should use for its mock body. */
export const AUTH_CATEGORY: ExternalDependencyCategory = 'auth';
