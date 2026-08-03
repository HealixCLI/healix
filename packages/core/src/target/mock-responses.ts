import { isAuthEndpointPath } from './auth-endpoints.js';
import type { ProviderAdapter } from '../providers/types.js';
import type { EndpointMock, ExternalDependency, ExternalDependencyCategory, MockResponse } from './types.js';

const MOCK_RESPONSE_TIMEOUT_MS = 60_000;

function base64url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Deterministic, structurally valid, far-future-expiry JWT. An opaque placeholder like
 * 'healix-mock-token' throws in any app that runs jwtDecode()/parses the payload on login,
 * which fails the login just as silently as a missing token. Computed once from a literal
 * payload (no Date.now()) so the generated fixture is byte-stable run to run.
 */
const MOCK_JWT = [
  base64url('{"alg":"HS256","typ":"JWT"}'),
  base64url('{"sub":"healix-mock-user","exp":4102444800}'), // 2100-01-01, never expired
  base64url('healix-mock-signature'),
].join('.');

/**
 * A deliberate SUPERSET of the shapes real login APIs return, not one canonical shape: the
 * mock can't know which field the app reads to decide "I am logged in", and a MISSING field
 * breaks login silently (this is the exact bug this body exists to fix) while an extra
 * field is inert. Covers the capillary-style `status.success` envelope (an app checking
 * `!res.status?.success`), OAuth2/OIDC snake_case, and the camelCase twins SPA clients
 * commonly read. No nested `data` wrapper: with axios `res.data` IS the body, so
 * `res.data.token` already resolves.
 */
/**
 * The one synthetic identity every purely-invented (no real capture) mocked endpoint should
 * use for "the logged-in user," so a name/email/id shown by one endpoint's mock always
 * matches another endpoint's — see `extractCanonicalIdentity`/`applyCanonicalIdentity` for
 * the complementary real-capture-aware reconciliation.
 */
export const MOCK_IDENTITY_ID = 'healix-mock-user';
export const MOCK_IDENTITY_EMAIL = 'healix.mock@example.test';
export const MOCK_IDENTITY_NAME = 'Healix Mock User';

const AUTH_MOCK_BODY = {
  status: { success: true, code: 200, message: 'Success' },
  success: true,
  token: MOCK_JWT,
  access_token: MOCK_JWT,
  accessToken: MOCK_JWT,
  token_type: 'Bearer',
  tokenType: 'Bearer',
  expires_in: 3600,
  expiresIn: 3600,
  refresh_token: 'healix-mock-refresh-token',
  refreshToken: 'healix-mock-refresh-token',
  user: { id: MOCK_IDENTITY_ID, email: MOCK_IDENTITY_EMAIL, name: MOCK_IDENTITY_NAME },
};

/** Plausible canned success response per category — used until/unless the AI pass overrides it. */
const STATIC_TEMPLATES: Record<ExternalDependencyCategory, MockResponse> = {
  sms: { status: 200, body: { status: 'sent', sid: 'HEALIX-MOCK-SMS-000000' } },
  otp: { status: 200, body: { status: 'pending', message: 'OTP sent (mocked by Healix)' } },
  email: { status: 202, body: { status: 'queued', id: 'healix-mock-email-000000' } },
  payment: { status: 200, body: { status: 'succeeded', id: 'healix_mock_pi_000000' } },
  auth: { status: 200, body: AUTH_MOCK_BODY },
  backend: { status: 200, body: {} },
  // Never actually served — a 'local-backend' dependency's mockStrategy is always
  // 'undeterminable' (F-04: it's routed to directly, not mocked), so this entry only
  // exists to keep this Record exhaustive over ExternalDependencyCategory.
  'local-backend': { status: 200, body: {} },
  other: { status: 200, body: {} },
};

/** The static, deterministic fallback response for a dependency's category. Never fails, never calls out. */
export function staticMockResponse(category: ExternalDependencyCategory): MockResponse {
  return STATIC_TEMPLATES[category] ?? STATIC_TEMPLATES.other;
}

/**
 * The category to mock an individual endpoint with: the endpoint's own tag wins (set by
 * dependencies.ts when a path is statically recognized as auth-shaped), else a path sniff
 * as a second line of defense for endpoints reaching here by any other route, else the
 * parent dependency's own category.
 */
export function endpointCategory(
  dep: ExternalDependency,
  endpoint: EndpointMock,
): ExternalDependencyCategory {
  if (endpoint.category) return endpoint.category;
  if (isAuthEndpointPath(endpoint.pathPattern)) return 'auth';
  return dep.category;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A redaction/sanitize.ts placeholder left in place of a real secret value (see
 * `export/sanitize.ts`'s `redactSecrets()`) — real captured traffic that had its
 * token/secret fields scrubbed before ever reaching this module. */
const REDACTED_LEAF_RE = /^(?:Bearer )?<REDACTED>$/;

function isRedactedLeaf(value: unknown): boolean {
  return typeof value === 'string' && REDACTED_LEAF_RE.test(value);
}

/**
 * Deep-merges `observed` over `staticValue`, field by field, so real captured traffic can
 * ground a statically-detected/AI-guessed body without regressing it wholesale. A redacted
 * leaf (see `isRedactedLeaf`) is always skipped — falling back to whatever `staticValue` had
 * at that path (possibly nothing) — since serving the literal string "<REDACTED>" as a token
 * is exactly as broken as the flat-shape mismatch this module exists to fix. Arrays are
 * replaced wholesale by the observed value (no element-wise merge); plain objects merge
 * recursively so a static `user.id`/`user.email` field survives even when only `user.name`
 * was actually observed on the wire, or vice versa.
 */
function mergeObservedOverStatic(staticValue: unknown, observedValue: unknown): unknown {
  if (isRedactedLeaf(observedValue)) return staticValue;
  if (isPlainObject(observedValue)) {
    const staticObj = isPlainObject(staticValue) ? staticValue : {};
    const merged: Record<string, unknown> = { ...staticObj };
    for (const [key, value] of Object.entries(observedValue)) {
      merged[key] = mergeObservedOverStatic(staticObj[key], value);
    }
    return merged;
  }
  return observedValue;
}

/**
 * Grounds `staticResponse` in a real captured response for the SAME (method, path) call,
 * field by field, instead of the two all-or-nothing options this module used to have
 * (either the static/AI-guessed body wins outright, or the observed body replaces it
 * wholesale — losing any static field the observed sample happened not to include, e.g. an
 * auth token whose value was redacted before capture). A non-empty STRING `observedBody`
 * (real non-JSON traffic — XML/SOAP, see GAP-069 — passed through as-is by
 * scaffold.ts's `parseObservedBody`) is genuine captured data even though it isn't
 * mergeable field-by-field, so it's served wholesale rather than discarded in favor of the
 * static default. Falls back to `withAuthFloor(category, staticResponse)` unchanged when
 * `observedBody` is neither a usable plain object nor a non-empty string (parse failure
 * degraded to `{}` per GAP-063, or no capture at all). `observedHeaders` (e.g. a captured
 * `content-type`, GAP-063 follow-up) takes precedence over the static response's own headers
 * when present. The final auth-floor pass still runs even when a merge happened, so the
 * guaranteed-baseline contract (token/access_token/... always present) holds regardless of
 * which fields observed traffic actually supplied.
 */
export function mergeGroundedResponse(
  category: ExternalDependencyCategory,
  staticResponse: MockResponse,
  observedBody: unknown,
  observedStatus?: number,
  observedHeaders?: Record<string, string>,
): MockResponse {
  const status =
    typeof observedStatus === 'number' && observedStatus < 400 ? observedStatus : staticResponse.status;
  const headers = observedHeaders ?? staticResponse.headers;

  if (typeof observedBody === 'string' && observedBody.length > 0) {
    return withAuthFloor(category, { ...staticResponse, status, body: observedBody, headers });
  }
  if (!isPlainObject(observedBody)) {
    return withAuthFloor(category, staticResponse);
  }
  const body = mergeObservedOverStatic(staticResponse.body, observedBody);
  return withAuthFloor(category, { ...staticResponse, status, body, headers });
}

/** A person-identity value pulled from real captured traffic, to reconcile across sibling
 * synthetic (no-real-capture) mocked endpoints — see `extractCanonicalIdentity`. */
export interface CanonicalIdentity {
  id?: string;
  email?: string;
  name?: string;
}

// Matched case-insensitively against an object's OWN keys. Deliberately EXACT key names
// (not a substring check) — a substring match on "id" would false-positive on `couponId`/
// `seriesId`/`transactionId`, which are not person-identity fields.
const IDENTITY_ID_KEYS = new Set(['id', 'userid', 'customerid', 'username']);
const IDENTITY_EMAIL_KEYS = new Set(['email']);
const IDENTITY_NAME_KEYS = new Set(['name', 'fullname', 'displayname']);
const IDENTITY_FIRST_NAME_KEYS = new Set(['firstname']);
const IDENTITY_LAST_NAME_KEYS = new Set(['lastname']);

function stringLeaf(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Scans a plain object's own keys for identity-shaped fields (name/email/id-like). Qualifies
 * as a person-identity record ONLY when `email` co-occurs with at least one other
 * identity-shaped field, OR both `firstname`/`lastname` are present — deliberately NOT on a
 * generic `name`+`id` pair alone, since that combination is common on all sorts of non-person
 * entities (a coupon, a region, a product all typically have `id`+`name`). `email` and a
 * first+last name pair are comparatively rare, reliable "this is a person" signals; a bare
 * `id` (e.g. `{ couponId: '...' }`, `{ id: 526233086 }` on a coupon record) is never mistaken
 * for one just because one field happens to be named `id`.
 */
function identityFromObject(obj: Record<string, unknown>): CanonicalIdentity | null {
  let id: string | undefined;
  let email: string | undefined;
  let name: string | undefined;
  let firstName: string | undefined;
  let lastName: string | undefined;
  for (const [rawKey, value] of Object.entries(obj)) {
    const key = rawKey.toLowerCase();
    if (!id && IDENTITY_ID_KEYS.has(key)) {
      id = stringLeaf(value) ?? id;
    } else if (!email && IDENTITY_EMAIL_KEYS.has(key)) {
      email = stringLeaf(value) ?? email;
    } else if (!name && IDENTITY_NAME_KEYS.has(key)) {
      name = stringLeaf(value) ?? name;
    } else if (!firstName && IDENTITY_FIRST_NAME_KEYS.has(key)) {
      firstName = stringLeaf(value) ?? firstName;
    } else if (!lastName && IDENTITY_LAST_NAME_KEYS.has(key)) {
      lastName = stringLeaf(value) ?? lastName;
    }
  }
  const hasFullName = !!firstName && !!lastName;
  const qualifies = (!!email && !!(id || name || firstName || lastName)) || hasFullName;
  if (!qualifies) return null;
  const resolvedName = name ?? (hasFullName ? `${firstName} ${lastName}`.trim() : undefined);
  const identity: CanonicalIdentity = {};
  if (id) identity.id = id;
  if (email) identity.email = email;
  if (resolvedName) identity.name = resolvedName;
  return Object.keys(identity).length > 0 ? identity : null;
}

const MAX_IDENTITY_SEARCH_DEPTH = 6;

/** Depth-first search for the first identity-shaped object in a parsed response body,
 * preferring one nested directly under a `user` key (the common wrapper an auth/profile
 * response uses) before falling through to an arbitrary sibling field. */
function findIdentityIn(value: unknown, depth = 0): CanonicalIdentity | null {
  if (depth > MAX_IDENTITY_SEARCH_DEPTH || !isPlainObject(value)) return null;
  const direct = identityFromObject(value);
  if (direct) return direct;
  if (isPlainObject(value.user)) {
    const nested = identityFromObject(value.user);
    if (nested) return nested;
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findIdentityIn(item, depth + 1);
        if (found) return found;
      }
    } else {
      const found = findIdentityIn(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Scans real observed traffic for a canonical "who is the logged-in user" identity, so it can
 * be reused (via `applyCanonicalIdentity`) across sibling SYNTHETIC mocked endpoints that would
 * otherwise each invent their own inconsistent name/email/id (Cluster B: one endpoint showing
 * real captured "adroy tester" while another shows generic "Healix Mock User"). Prefers a match
 * found in an auth/login-shaped endpoint's body (most authoritative — it's literally "who just
 * logged in"), else the first match across any observed endpoint, in order. Returns `null` when
 * no real capture exists yet (the common PLAN-time-only case), or nothing observed looked like a
 * person record — the prompt-level identity-consistency rule in `buildPrompt` is what keeps
 * purely-synthetic endpoints consistent with each other in that case.
 */
export function extractCanonicalIdentity(
  observedEndpoints: Array<{ pathPattern: string; sampleResponseBody?: string }>,
): CanonicalIdentity | null {
  let firstMatch: CanonicalIdentity | null = null;
  for (const observed of observedEndpoints) {
    if (!observed.sampleResponseBody) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(observed.sampleResponseBody);
    } catch {
      continue;
    }
    const found = findIdentityIn(parsed);
    if (!found) continue;
    if (isAuthEndpointPath(observed.pathPattern)) return found;
    firstMatch ??= found;
  }
  return firstMatch;
}

/**
 * Overwrites identity-shaped fields in a purely SYNTHETIC (static/AI-guessed) body with
 * `canonical`'s values, so it agrees with whatever real identity `extractCanonicalIdentity`
 * found elsewhere in the same run. Only rewrites keys already recognized by
 * `identityFromObject`'s co-occurrence rule (never touches a lone `id`-shaped field in
 * isolation), and only ever narrows toward the canonical value the caller already resolved —
 * never invents an identity object where none existed. No-op when `canonical` is null (nothing
 * observed yet) or the body isn't a plain object.
 */
export function applyCanonicalIdentity(body: unknown, canonical: CanonicalIdentity | null): unknown {
  if (!canonical || !isPlainObject(body)) return body;
  // Same co-occurrence gate as identityFromObject/extractCanonicalIdentity: only an object
  // that itself qualifies as an identity record gets its id/email/name-shaped keys rewritten
  // — a lone "name" field on an unrelated nested object (e.g. a voucher's display name) is
  // never touched just because the key happens to match.
  const qualifies = identityFromObject(body) !== null;
  const result: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(body)) {
    const key = rawKey.toLowerCase();
    if (qualifies && canonical.id !== undefined && IDENTITY_ID_KEYS.has(key)) {
      result[rawKey] = canonical.id;
    } else if (qualifies && canonical.email !== undefined && IDENTITY_EMAIL_KEYS.has(key)) {
      result[rawKey] = canonical.email;
    } else if (qualifies && canonical.name !== undefined && IDENTITY_NAME_KEYS.has(key)) {
      result[rawKey] = canonical.name;
    } else if (isPlainObject(value)) {
      result[rawKey] = applyCanonicalIdentity(value, canonical);
    } else {
      result[rawKey] = value;
    }
  }
  return result;
}

/**
 * For an auth-classified endpoint, layers a response ON TOP of the static auth floor
 * rather than replacing it: a model reliably invents A plausible token response, but not
 * necessarily the exact field this particular app reads — and a plausible-but-wrong auth
 * body is the failure mode this whole module exists to prevent. Also clamps an error status
 * on the login endpoint, since an AI-returned 401 there would fail every login-dependent test.
 */
function withAuthFloor(category: ExternalDependencyCategory, response: MockResponse): MockResponse {
  if (category !== 'auth') return response;
  const body = response.body;
  const merged =
    body && typeof body === 'object' && !Array.isArray(body)
      ? { ...AUTH_MOCK_BODY, ...(body as Record<string, unknown>) }
      : AUTH_MOCK_BODY;
  return { ...response, status: response.status >= 400 ? 200 : response.status, body: merged };
}

/** Shape the model is asked to emit inside a fenced JSON block. */
interface RawMockResponse {
  id?: unknown;
  status?: unknown;
  body?: unknown;
  headers?: unknown;
}
interface RawMockResponses {
  responses?: unknown;
}

/** Composite key for an endpoint-level response entry: distinct from a plain dependency id, never collides with one. */
function endpointKey(depId: string, method: string, pathPattern: string): string {
  return `${depId}::${method}::${pathPattern}`;
}

function buildPrompt(deps: ExternalDependency[]): string {
  const lines: string[] = [];
  lines.push('You are configuring a local mock server for an offline test run. For each external dependency');
  lines.push(
    'listed below, produce a plausible SUCCESSFUL canned JSON response its real API would return, so',
  );
  lines.push('tests exercising this integration behave realistically without a real network call.');
  lines.push('');
  lines.push('Dependencies:');
  for (const d of deps) {
    const seenIn = d.file ? ` | seen in: ${d.file}` : '';
    lines.push(`- id: "${d.id}" | category: ${d.category} | label: ${d.label}${seenIn}`);
    if (d.endpoints && d.endpoints.length > 0) {
      lines.push(
        '  Known endpoints for this dependency (produce a distinct, endpoint-appropriate response for EACH):',
      );
      for (const e of d.endpoints) {
        const cat = endpointCategory(d, e);
        const tag = cat === 'auth' ? ' | category: auth (LOGIN HANDSHAKE)' : '';
        lines.push(
          `    - key: "${endpointKey(d.id, e.method, e.pathPattern)}" | ${e.method} ${e.pathPattern}${tag}`,
        );
      }
    }
  }
  lines.push('');
  lines.push('Respond with exactly one fenced ```json code block of the shape:');
  lines.push('```json');
  lines.push('{');
  lines.push('  "responses": [');
  lines.push(
    '    { "id": "<a dependency id, OR an endpoint key exactly as printed above>", "status": 200, "body": { "...": "realistic JSON" } }',
  );
  lines.push('  ]');
  lines.push('}');
  lines.push('```');
  lines.push(
    'Before answering, use your read-only file access at the given repo path to actually investigate how each ' +
      "endpoint's response is consumed by the app, instead of guessing a shape purely from the path name: search " +
      'for the client call (the dependency\'s "seen in" file above is a starting point, but the code that reads ' +
      'fields off the response is often a DIFFERENT file/component that calls or awaits it) and look for how the ' +
      'result is destructured or checked — e.g. `response.data.user.someFlag`, `if (!result.auth?.token)`, ' +
      "`res.status?.success`. Use the EXACT field names and nesting the app's own code reads when you can find " +
      "them; only fall back to guessing from the path/dependency label when the source genuinely isn't " +
      'inspectable or reachable.',
  );
  lines.push(
    'Produce exactly one entry per dependency id (or, when endpoints are listed, one entry per endpoint key — ' +
      'endpoint keys take priority over a single dependency-level entry). Use realistic field names and values ' +
      'appropriate to what that specific endpoint path suggests it does — e.g. a path containing "login"/"auth" ' +
      'returns a token; "list"/plural nouns return an array; "balance"/"points"/"ledger" return numeric fields; ' +
      'a POST "redeem"/"create" returns a confirmation id.',
  );
  lines.push(
    "Any field across ANY endpoint's response that represents a person's identity (a name, email, or " +
      'id/username field for "the logged-in user") MUST use the exact same value everywhere you emit it — ' +
      `name="${MOCK_IDENTITY_NAME}", email="${MOCK_IDENTITY_EMAIL}", id="${MOCK_IDENTITY_ID}" — never invent a ` +
      "different name/email/id for one endpoint's user object than another's; a UI showing one endpoint's " +
      "identity while a test asserts on a different endpoint's identity is exactly the kind of bug this " +
      'consistency rule exists to prevent.',
  );
  lines.push(
    'An endpoint marked "category: auth (LOGIN HANDSHAKE)" is the app\'s LOGIN/TOKEN handshake — return a ' +
      'successful session response (a token plus whatever envelope the path suggests), never an error or a ' +
      'health-check-style {status,service,version} body. Pay special attention to any app-specific "gate" field ' +
      'the login code checks before treating the session as valid (e.g. a boolean like ' +
      "`userRegisteredForPassword`, `isVerified`, `accountActive`) — a login mock that's missing exactly that " +
      'field looks like a success response but still fails login, since the app treats the missing/falsy gate ' +
      'field as a rejection. Healix merges your body over a guaranteed baseline, so ADD fields rather than ' +
      'replacing the shape.',
  );
  return lines.join('\n');
}

/** Extract a JSON object string from arbitrary model output (fenced ```json, fenced ```, or bare). */
function extractJsonObject(text: string): string | null {
  if (!text) return null;
  const fencedJson = /```json\s*([\s\S]*?)```/i.exec(text);
  if (fencedJson && fencedJson[1]) {
    const inner = sliceBalanced(fencedJson[1]);
    if (inner) return inner;
  }
  const fenced = /```\s*([\s\S]*?)```/.exec(text);
  if (fenced && fenced[1]) {
    const inner = sliceBalanced(fenced[1]);
    if (inner) return inner;
  }
  return sliceBalanced(text);
}

/** Return the first balanced {...} object substring, respecting strings/escapes. */
function sliceBalanced(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function normalizeStatus(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  return Number.isInteger(n) && n >= 100 && n < 600 ? n : 200;
}

/** Parse the model's completion into a map of dependency id -> MockResponse. Malformed entries are dropped. */
function parseMockResponses(text: string, validIds: Set<string>): Map<string, MockResponse> {
  const out = new Map<string, MockResponse>();
  const candidate = extractJsonObject(text);
  if (!candidate) return out;

  let raw: RawMockResponses;
  try {
    raw = JSON.parse(candidate) as RawMockResponses;
  } catch {
    return out;
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.responses)) return out;

  for (const entry of raw.responses as RawMockResponse[]) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id || !validIds.has(id) || out.has(id)) continue;
    const body = entry.body !== undefined ? entry.body : {};
    const headers =
      entry.headers && typeof entry.headers === 'object' && !Array.isArray(entry.headers)
        ? (entry.headers as Record<string, string>)
        : undefined;
    out.set(id, { status: normalizeStatus(entry.status), body, ...(headers ? { headers } : {}) });
  }
  return out;
}

/**
 * Resolve a canned response for every mockable dependency (mockStrategy !==
 * 'undeterminable'): starts every dependency at its static category default,
 * then makes ONE batched provider call asking for realistic content and
 * overrides whichever entries the model returns usably. A missing/invalid
 * model response for a given dependency simply keeps its static default —
 * this never blocks or fails the run on an AI hiccup. `provider` is optional
 * so callers with no ready AI provider (e.g. a quick manual `mock-launch`)
 * still get usable static responses instead of having to special-case it.
 */
export async function generateMockResponses(
  deps: ExternalDependency[],
  provider?: ProviderAdapter,
  opts?: { repoPath?: string; signal?: AbortSignal },
): Promise<Map<string, MockResponse>> {
  const mockable = deps.filter((d) => d.mockStrategy !== 'undeterminable');
  const result = new Map<string, MockResponse>();
  for (const d of mockable) {
    result.set(d.id, staticMockResponse(d.category));
    // Every detected endpoint gets a static fallback up front too, same as the
    // dependency-level entry — an AI override below replaces it when usable, but a run
    // with no ready provider still gets a (generic) response per endpoint instead of
    // falling back to the coarser dependency-wide one. Uses the ENDPOINT's own category
    // (endpointCategory), which wins over the dependency's when the path is auth-shaped.
    for (const e of d.endpoints ?? []) e.response = staticMockResponse(endpointCategory(d, e));
  }
  if (mockable.length === 0 || !provider) return result;

  try {
    const completion = await provider.complete(buildPrompt(mockable), {
      cwd: opts?.repoPath,
      timeoutMs: MOCK_RESPONSE_TIMEOUT_MS,
      readOnly: true,
      signal: opts?.signal,
      taskType: 'mock-response',
    });
    if (completion.ok && completion.text) {
      const validKeys = new Set<string>();
      for (const d of mockable) {
        validKeys.add(d.id);
        for (const e of d.endpoints ?? []) validKeys.add(endpointKey(d.id, e.method, e.pathPattern));
      }
      const parsed = parseMockResponses(completion.text, validKeys);
      for (const d of mockable) {
        const depLevel = parsed.get(d.id);
        if (depLevel) result.set(d.id, withAuthFloor(d.category, depLevel));
        for (const e of d.endpoints ?? []) {
          const perEndpoint = parsed.get(endpointKey(d.id, e.method, e.pathPattern));
          if (perEndpoint) e.response = withAuthFloor(endpointCategory(d, e), perEndpoint);
        }
      }
    }
  } catch {
    // AI content generation is best-effort; every dependency/endpoint already
    // has its static fallback set above, so a thrown/failed call changes nothing.
  }

  return result;
}
