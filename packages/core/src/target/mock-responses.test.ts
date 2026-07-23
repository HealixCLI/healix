import { describe, expect, it } from 'vitest';
import { generateMockResponses, staticMockResponse } from './mock-responses.js';
import type { CompleteOptions, ProviderAdapter } from '../providers/types.js';
import type { ExternalDependency } from './types.js';

function fakeProvider(
  text: string,
  ok = true,
  onComplete?: (opts: CompleteOptions | undefined) => void,
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
    complete: async (_prompt, opts) => {
      onComplete?.(opts);
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
});
