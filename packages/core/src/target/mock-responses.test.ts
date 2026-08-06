import { describe, expect, it } from 'vitest';
import {
  applyCanonicalIdentity,
  extractCanonicalIdentity,
  generateMockResponses,
  mergeGroundedResponse,
  reconcileAuthTokens,
  staticMockResponse,
} from './mock-responses.js';
import type { CompleteOptions, ProviderAdapter } from '../providers/types.js';
import type { ExternalDependency, MockResponse } from './types.js';

function fakeProvider(
  text: string,
  ok = true,
  onComplete?: (opts: CompleteOptions | undefined, prompt?: string) => void,
): ProviderAdapter {
  return {
    id: 'claude',
    label: 'Claude',
    capabilities: ['codegen'],
    detect: async () => ({ installed: true, binPath: '/bin/claude', version: '1.0.0' }),
    health: async () => ({
      provider: 'claude',
      status: 'ready',
      installed: true,
      binPath: '/bin/claude',
      version: '1.0.0',
      authenticated: true,
      model: null,
      latencyMs: 1,
      detail: '',
    }),
    plan: async () => ({ provider: 'claude', ok: true, plan: '', raw: null, detail: '' }),
    complete: async (prompt, opts) => {
      onComplete?.(opts, prompt);
      return { provider: 'claude', ok, text, raw: null, detail: '' };
    },
  };
}

const smsDep: ExternalDependency = {
  id: 'pkg:twilio',
  category: 'sms',
  label: 'Twilio (SMS/OTP)',
  source: 'package',
  mockStrategy: 'env-override',
};

const undeterminableDep: ExternalDependency = {
  id: 'pkg:nodemailer',
  category: 'email',
  label: 'Nodemailer (SMTP email)',
  source: 'package',
  mockStrategy: 'undeterminable',
};

describe('staticMockResponse', () => {
  it('returns a plausible canned response per category', () => {
    expect(staticMockResponse('sms').status).toBe(200);
    expect(staticMockResponse('payment').body).toMatchObject({ status: 'succeeded' });
  });

  it('F-12: nests the auth category\'s "status" under an object with a "success" boolean, not a flat string', () => {
    // A capillary-style login handshake destructures the response as
    // `status?.success` — a flat `status: "success"` string reads as
    // `undefined` through that pattern and silently breaks every
    // login-dependent test with no error at all.
    const body = staticMockResponse('auth').body as { status?: unknown };
    expect(typeof body.status).toBe('object');
    expect(body.status).toMatchObject({ success: true });
    expect((body.status as { success?: unknown })?.success).toBe(true);
    // Guard against the destructuring pattern this category exists to satisfy.
    const destructured = (body as { status?: { success?: boolean } }).status?.success;
    expect(destructured).toBe(true);
  });
});

describe('mergeGroundedResponse', () => {
  const staticResponse: MockResponse = {
    status: 200,
    body: { token: 'healix-static-jwt', shared: 'static-value', user: { name: 'Healix Mock User' } },
  };

  it('falls back to the static/floor response unchanged when observedBody is absent or unusable', () => {
    expect(mergeGroundedResponse('backend', staticResponse, undefined)).toEqual(staticResponse);
    expect(mergeGroundedResponse('backend', staticResponse, '')).toEqual(staticResponse);
    expect(mergeGroundedResponse('backend', staticResponse, ['not', 'an', 'object'])).toEqual(staticResponse);
  });

  it('serves a non-empty STRING observedBody wholesale instead of falling back — real non-JSON traffic (XML/SOAP, GAP-069) is genuine captured data even though it is not mergeable field-by-field', () => {
    const merged = mergeGroundedResponse('backend', staticResponse, '<xml/>');
    expect(merged.body).toBe('<xml/>');
    expect(merged.status).toBe(staticResponse.status);
  });

  it('prefers observed values on a genuine field conflict, for a non-auth category', () => {
    const merged = mergeGroundedResponse('backend', staticResponse, { shared: 'observed-value' });
    expect((merged.body as Record<string, unknown>).shared).toBe('observed-value');
    // Fields the observed sample didn't include still survive from the static side.
    expect((merged.body as Record<string, unknown>).token).toBe('healix-static-jwt');
  });

  it('skips a redacted secret leaf, keeping the static value at that field instead', () => {
    const merged = mergeGroundedResponse('auth', staticResponse, {
      token: '<REDACTED>',
      user: { name: 'adroy tester' },
    });
    const body = merged.body as { token: string; user: { name: string } };
    expect(body.token).toBe('healix-static-jwt');
    expect(body.user.name).toBe('adroy tester');
  });

  it('skips a "Bearer <REDACTED>" leaf the same way', () => {
    const merged = mergeGroundedResponse('auth', staticResponse, { token: 'Bearer <REDACTED>' });
    expect((merged.body as { token: string }).token).toBe('healix-static-jwt');
  });

  it('runs the auth-category result through the auth floor, guaranteeing baseline fields', () => {
    const merged = mergeGroundedResponse('auth', staticResponse, { user: { name: 'adroy tester' } });
    const body = merged.body as Record<string, unknown>;
    expect(body.access_token).toBeTruthy();
    expect(body.success).toBe(true);
  });

  it('clamps an observed error status for auth (never brick every login-dependent test), but preserves it for other categories', () => {
    const authMerged = mergeGroundedResponse('auth', staticResponse, { user: { name: 'x' } }, 401);
    expect(authMerged.status).toBe(200);

    const backendMerged = mergeGroundedResponse(
      'backend',
      { status: 200, body: {} },
      { error: 'not found' },
      404,
    );
    expect(backendMerged.status).toBe(200); // observedStatus >= 400 never overrides
  });

  it('prefers a non-error observed status over the static one', () => {
    const merged = mergeGroundedResponse('backend', { status: 500, body: {} }, { ok: true }, 200);
    expect(merged.status).toBe(200);
  });

  it("threads observedHeaders through (e.g. a captured content-type, GAP-063 follow-up), preferring it over the static response's own headers", () => {
    const withStaticHeaders: MockResponse = {
      status: 200,
      body: {},
      headers: { 'content-type': 'text/plain' },
    };
    const merged = mergeGroundedResponse('backend', withStaticHeaders, { ok: true }, 200, {
      'content-type': 'application/json; charset=utf-8',
    });
    expect(merged.headers).toEqual({ 'content-type': 'application/json; charset=utf-8' });
  });

  it("keeps the static response's own headers when observedHeaders is not provided", () => {
    const withStaticHeaders: MockResponse = {
      status: 200,
      body: {},
      headers: { 'content-type': 'text/plain' },
    };
    const merged = mergeGroundedResponse('backend', withStaticHeaders, { ok: true }, 200);
    expect(merged.headers).toEqual({ 'content-type': 'text/plain' });
  });
});

describe('extractCanonicalIdentity', () => {
  it('returns null when no observed endpoint has an identity-shaped body', () => {
    expect(
      extractCanonicalIdentity([
        { pathPattern: '/coupons', sampleResponseBody: '{"couponId":"526233086","code":"1T6L6AU2"}' },
      ]),
    ).toBeNull();
  });

  it('ignores a lone id-shaped field (false-positive guard) — a coupon/transaction id is not a person', () => {
    // Only one identity-shaped key ("id") present — must not qualify on its own.
    expect(
      extractCanonicalIdentity([{ pathPattern: '/coupons', sampleResponseBody: '{"id":526233086}' }]),
    ).toBeNull();
  });

  it('extracts name/email/id from an object with >= 2 co-occurring identity-shaped keys', () => {
    const identity = extractCanonicalIdentity([
      {
        pathPattern: '/mobile/v2/api/customer/getbyemail',
        sampleResponseBody:
          '{"firstname":"adroy","lastname":"tester","email":"adroytester@gmail.com","id":81278446}',
      },
    ]);
    expect(identity).toEqual({ id: '81278446', email: 'adroytester@gmail.com', name: 'adroy tester' });
  });

  it('prefers a match from an auth/login-shaped endpoint over an earlier non-auth match', () => {
    const identity = extractCanonicalIdentity([
      {
        pathPattern: '/customer/profile',
        sampleResponseBody: '{"name":"Wrong Name","email":"wrong@example.test"}',
      },
      {
        pathPattern: '/auth/login',
        sampleResponseBody: '{"user":{"name":"Real Name","email":"real@example.test"}}',
      },
    ]);
    expect(identity).toEqual({ name: 'Real Name', email: 'real@example.test' });
  });

  it('fills the id from a separate (non-auth) endpoint when the auth/login response itself never provides one, instead of blocking on the incomplete auth match (regression: a token-generate response with only email/name used to permanently shadow a real id sitting in a sibling ledger/profile endpoint)', () => {
    const identity = extractCanonicalIdentity([
      {
        pathPattern: '/auth/v1/web/token/generate',
        sampleResponseBody: '{"user":{"email":"sid55boss@gmail.com","name":"Sid verekar"}}',
      },
      {
        pathPattern: '/loyalty/v2/customer/ledger',
        sampleResponseBody:
          '{"customerDetails":{"firstName":"Sid","lastName":"verekar","user_id":"81552639"}}',
      },
    ]);
    expect(identity).toEqual({ email: 'sid55boss@gmail.com', name: 'Sid verekar', id: '81552639' });
  });

  it('still lets an auth match win a field outright over a LATER non-auth match for that same field (auth stays sticky regardless of order)', () => {
    const identity = extractCanonicalIdentity([
      {
        pathPattern: '/auth/login',
        sampleResponseBody: '{"user":{"name":"Real Name","email":"real@example.test"}}',
      },
      {
        pathPattern: '/customer/profile',
        sampleResponseBody: '{"name":"Wrong Name","email":"wrong@example.test"}',
      },
    ]);
    expect(identity).toEqual({ name: 'Real Name', email: 'real@example.test' });
  });

  it('skips a malformed (non-JSON) observed body without throwing', () => {
    expect(
      extractCanonicalIdentity([
        { pathPattern: '/x', sampleResponseBody: 'not json' },
        { pathPattern: '/customer', sampleResponseBody: '{"name":"OK","email":"ok@example.test"}' },
      ]),
    ).toEqual({ name: 'OK', email: 'ok@example.test' });
  });

  it('extracts a snake_case id field (e.g. a real Capillary-style "user_id") alongside email/name, not just camelCase/bare "id"', () => {
    // Real shape observed from a live C&A/Capillary backend: the id key is snake_case, which
    // used to never match the ('id'|'userid'|'customerid'|'username') lookup set because only
    // .toLowerCase() was applied (never separator-stripped) — so this object's real numeric
    // customer id silently fell through and the mocked auth response kept its fake placeholder
    // id even after email/name were correctly grounded in real data.
    const identity = extractCanonicalIdentity([
      {
        pathPattern: '/customer/profile',
        sampleResponseBody:
          '{"firstname":"Sid","lastname":"verekar","user_id":"81552639","email":"sid55boss@gmail.com"}',
      },
    ]);
    expect(identity).toEqual({ id: '81552639', email: 'sid55boss@gmail.com', name: 'Sid verekar' });
  });
});

describe('applyCanonicalIdentity', () => {
  it('is a no-op when canonical is null', () => {
    const body = { user: { name: 'Healix Mock User', email: 'healix.mock@example.test' } };
    expect(applyCanonicalIdentity(body, null)).toBe(body);
  });

  it("rewrites an identity-qualifying object's matching fields to the canonical values", () => {
    const body = {
      user: { id: 'healix-mock-user', email: 'healix.mock@example.test', name: 'Healix Mock User' },
    };
    const result = applyCanonicalIdentity(body, {
      id: '81278446',
      email: 'adroytester@gmail.com',
      name: 'adroy tester',
    }) as {
      user: { id: string; email: string; name: string };
    };
    expect(result.user).toEqual({ id: '81278446', email: 'adroytester@gmail.com', name: 'adroy tester' });
  });

  it('never rewrites a lone id/name-shaped field on an object that does not itself qualify as identity', () => {
    const body = { coupon: { id: '526233086', name: 'Welcome_Online' } };
    const result = applyCanonicalIdentity(body, {
      id: 'x',
      email: 'x@example.test',
      name: 'Someone Else',
    }) as {
      coupon: { id: string; name: string };
    };
    expect(result.coupon).toEqual({ id: '526233086', name: 'Welcome_Online' });
  });

  it('rewrites a snake_case "user_id" key to the canonical id, not just camelCase/bare "id"', () => {
    const body = {
      user: { user_id: 'healix-mock-user', email: 'healix.mock@example.test', name: 'Healix Mock User' },
    };
    const result = applyCanonicalIdentity(body, {
      id: '81552639',
      email: 'sid55boss@gmail.com',
      name: 'Sid verekar',
    }) as {
      user: { user_id: string; email: string; name: string };
    };
    expect(result.user).toEqual({ user_id: '81552639', email: 'sid55boss@gmail.com', name: 'Sid verekar' });
  });
});

/** Decodes a base64url JWT's middle (payload) segment back to a plain object, for asserting on
 * its claims — mirrors the encoding scheme reconcileAuthTokens/buildMockJwt use internally. */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const [, payload] = jwt.split('.');
  const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
}

describe('reconcileAuthTokens', () => {
  it('is a no-op when canonical is null', () => {
    const body = { token: 'stays-as-is', user: { id: 'healix-mock-user' } };
    expect(reconcileAuthTokens(body, null)).toBe(body);
  });

  it('is a no-op when canonical has no id yet (email/name-only match)', () => {
    const body = { token: 'stays-as-is' };
    expect(reconcileAuthTokens(body, { email: 'x@example.test', name: 'X' })).toEqual(body);
  });

  it("regenerates token/access_token/accessToken so the JWT's own sub claim matches the real id — not just the plain user.id field", () => {
    const body = {
      token: 'fake.jwt.here',
      access_token: 'fake.jwt.here',
      accessToken: 'fake.jwt.here',
      token_type: 'Bearer',
      refresh_token: 'healix-mock-refresh-token',
      user: { id: 'healix-mock-user', email: 'sid55boss@gmail.com', name: 'Sid verekar' },
    };
    const result = reconcileAuthTokens(body, { id: '81552639', email: 'sid55boss@gmail.com' }) as {
      token: string;
      access_token: string;
      accessToken: string;
      token_type: string;
      refresh_token: string;
    };
    expect(decodeJwtPayload(result.token)).toMatchObject({ sub: '81552639' });
    expect(decodeJwtPayload(result.access_token)).toMatchObject({ sub: '81552639' });
    expect(decodeJwtPayload(result.accessToken)).toMatchObject({ sub: '81552639' });
    // Never touched: not a decodable identity token, and not a JWT-bearing key at all.
    expect(result.token_type).toBe('Bearer');
    expect(result.refresh_token).toBe('healix-mock-refresh-token');
  });
});

describe('generateMockResponses', () => {
  it('skips undeterminable dependencies and calls the provider only for mockable ones', async () => {
    let capturedOpts: CompleteOptions | undefined;
    const provider = fakeProvider('```json\n{"responses":[]}\n```', true, (opts) => {
      capturedOpts = opts;
    });
    const result = await generateMockResponses([smsDep, undeterminableDep], provider);
    expect(result.has('pkg:twilio')).toBe(true);
    expect(result.has('pkg:nodemailer')).toBe(false);
    // Lets the provider resolve a per-task-type model/effort (see model-config.ts).
    expect(capturedOpts?.taskType).toBe('mock-response');
  });

  it('returns only static fallbacks when there are no mockable dependencies (no provider call)', async () => {
    let called = false;
    const provider = fakeProvider('{}');
    provider.complete = async () => {
      called = true;
      return { provider: 'claude', ok: true, text: '{}', raw: null, detail: '' };
    };
    const result = await generateMockResponses([undeterminableDep], provider);
    expect(result.size).toBe(0);
    expect(called).toBe(false);
  });

  it('overrides the static fallback with a valid AI-generated response', async () => {
    const provider = fakeProvider(
      '```json\n{"responses":[{"id":"pkg:twilio","status":201,"body":{"sid":"SM123","status":"queued"}}]}\n```',
    );
    const result = await generateMockResponses([smsDep], provider);
    const response = result.get('pkg:twilio');
    expect(response?.status).toBe(201);
    expect(response?.body).toMatchObject({ sid: 'SM123' });
  });

  it('keeps the static fallback when the provider call fails', async () => {
    const provider = fakeProvider('', false);
    const result = await generateMockResponses([smsDep], provider);
    const response = result.get('pkg:twilio');
    expect(response).toEqual(staticMockResponse('sms'));
  });

  it('keeps the static fallback when the provider returns unparseable text', async () => {
    const provider = fakeProvider('not json at all');
    const result = await generateMockResponses([smsDep], provider);
    expect(result.get('pkg:twilio')).toEqual(staticMockResponse('sms'));
  });

  it('returns static fallbacks with no provider at all (no crash, no call attempted)', async () => {
    const result = await generateMockResponses([smsDep]);
    expect(result.get('pkg:twilio')).toEqual(staticMockResponse('sms'));
  });

  it('drops a response entry whose id is not in the requested set', async () => {
    const provider = fakeProvider(
      '```json\n{"responses":[{"id":"pkg:unknown","status":200,"body":{}}]}\n```',
    );
    const result = await generateMockResponses([smsDep], provider);
    expect(result.get('pkg:twilio')).toEqual(staticMockResponse('sms'));
    expect(result.has('pkg:unknown')).toBe(false);
  });

  it('gives a "backend"-category endpoint tagged auth by dependencies.ts the auth body, with no provider at all', async () => {
    const backendDep: ExternalDependency = {
      id: 'env:VITE_API_URL',
      category: 'backend',
      label: 'Backend API',
      source: 'env-var',
      mockStrategy: 'both',
      endpoints: [{ method: 'POST', pathPattern: '/auth/token/generate', category: 'auth' }],
    };
    const result = await generateMockResponses([backendDep]);
    expect(result.get('env:VITE_API_URL')).toEqual(staticMockResponse('backend'));
    const endpointResponse = backendDep.endpoints?.[0]?.response;
    expect(endpointResponse?.body).toMatchObject({
      token: expect.any(String),
      access_token: expect.any(String),
    });
    expect((endpointResponse?.body as { status?: { success?: boolean } })?.status?.success).toBe(true);
  });

  it('falls back to path-sniffing an untagged auth-looking endpoint on a non-auth dependency', async () => {
    const backendDep: ExternalDependency = {
      id: 'env:VITE_API_URL',
      category: 'backend',
      label: 'Backend API',
      source: 'env-var',
      mockStrategy: 'both',
      endpoints: [{ method: 'POST', pathPattern: '/auth/login' }],
    };
    await generateMockResponses([backendDep]);
    const endpointResponse = backendDep.endpoints?.[0]?.response;
    expect((endpointResponse?.body as { token?: unknown })?.token).toBeDefined();
  });

  it('leaves a non-auth endpoint on a non-auth dependency alone (no auth body leakage)', async () => {
    const backendDep: ExternalDependency = {
      id: 'env:VITE_API_URL',
      category: 'backend',
      label: 'Backend API',
      source: 'env-var',
      mockStrategy: 'both',
      endpoints: [{ method: 'GET', pathPattern: '/orders' }],
    };
    await generateMockResponses([backendDep]);
    expect(backendDep.endpoints?.[0]?.response).toEqual(staticMockResponse('backend'));
  });

  it('merges an AI-generated auth-endpoint body OVER the static auth floor, rather than replacing it', async () => {
    const backendDep: ExternalDependency = {
      id: 'env:VITE_API_URL',
      category: 'backend',
      label: 'Backend API',
      source: 'env-var',
      mockStrategy: 'both',
      endpoints: [{ method: 'POST', pathPattern: '/auth/token/generate', category: 'auth' }],
    };
    const provider = fakeProvider(
      '```json\n{"responses":[{"id":"env:VITE_API_URL::POST::/auth/token/generate","status":200,"body":{"customerId":"CUST-1"}}]}\n```',
    );
    await generateMockResponses([backendDep], provider);
    const body = backendDep.endpoints?.[0]?.response?.body as Record<string, unknown>;
    // The AI's own field survives...
    expect(body.customerId).toBe('CUST-1');
    // ...and so does the guaranteed floor the AI response omitted.
    expect((body.status as { success?: boolean })?.success).toBe(true);
    expect(body.access_token).toBeDefined();
  });

  it('clamps an AI-returned error status to 200 for an auth endpoint (a 401 there would fail every login-dependent test)', async () => {
    const backendDep: ExternalDependency = {
      id: 'env:VITE_API_URL',
      category: 'backend',
      label: 'Backend API',
      source: 'env-var',
      mockStrategy: 'both',
      endpoints: [{ method: 'POST', pathPattern: '/auth/token/generate', category: 'auth' }],
    };
    const provider = fakeProvider(
      '```json\n{"responses":[{"id":"env:VITE_API_URL::POST::/auth/token/generate","status":401,"body":{}}]}\n```',
    );
    await generateMockResponses([backendDep], provider);
    expect(backendDep.endpoints?.[0]?.response?.status).toBe(200);
  });

  it('does NOT apply the auth floor to a non-auth endpoint (AI body replaces wholesale)', async () => {
    const backendDep: ExternalDependency = {
      id: 'env:VITE_API_URL',
      category: 'backend',
      label: 'Backend API',
      source: 'env-var',
      mockStrategy: 'both',
      endpoints: [{ method: 'GET', pathPattern: '/orders' }],
    };
    const provider = fakeProvider(
      '```json\n{"responses":[{"id":"env:VITE_API_URL::GET::/orders","status":200,"body":{"orders":[]}}]}\n```',
    );
    await generateMockResponses([backendDep], provider);
    const body = backendDep.endpoints?.[0]?.response?.body;
    expect(body).toEqual({ orders: [] });
  });

  it('surfaces the auth-endpoint key and category marker in the prompt sent to the provider', async () => {
    const backendDep: ExternalDependency = {
      id: 'env:VITE_API_URL',
      category: 'backend',
      label: 'Backend API',
      source: 'env-var',
      mockStrategy: 'both',
      endpoints: [{ method: 'POST', pathPattern: '/auth/token/generate', category: 'auth' }],
    };
    let capturedPrompt = '';
    const provider = fakeProvider('```json\n{"responses":[]}\n```', true, (_opts, prompt) => {
      capturedPrompt = prompt ?? '';
    });
    await generateMockResponses([backendDep], provider);
    expect(capturedPrompt).toContain('env:VITE_API_URL::POST::/auth/token/generate');
    expect(capturedPrompt).toContain('category: auth (LOGIN HANDSHAKE)');
  });

  it("instructs the model to inspect the app's own response-consuming code instead of guessing from the path (Cluster A, Track 2)", async () => {
    const backendDep: ExternalDependency = {
      id: 'env:VITE_API_URL',
      category: 'auth',
      label: 'Auth API',
      source: 'env-var',
      mockStrategy: 'both',
      endpoints: [{ method: 'POST', pathPattern: '/login', category: 'auth' }],
    };
    let capturedPrompt = '';
    const provider = fakeProvider('```json\n{"responses":[]}\n```', true, (_opts, prompt) => {
      capturedPrompt = prompt ?? '';
    });
    await generateMockResponses([backendDep], provider);
    expect(capturedPrompt).toContain('use your read-only file access');
    expect(capturedPrompt).toContain('destructured or checked');
    expect(capturedPrompt).toContain('"gate" field');
  });
});
