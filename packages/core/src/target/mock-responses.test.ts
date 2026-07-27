import { describe, expect, it } from 'vitest';
import { generateMockResponses, staticMockResponse } from './mock-responses.js';
import type { CompleteOptions, ProviderAdapter } from '../providers/types.js';
import type { ExternalDependency } from './types.js';

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
});
