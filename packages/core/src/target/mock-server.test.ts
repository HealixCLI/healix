import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { mockDependencyUrl, startMockServer } from './mock-server.js';
import type { MockResponse, MockServerHandle } from './types.js';

const handles: MockServerHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.stop();
  }
});

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

describe('startMockServer', () => {
  it('serves the canned response for a matched dependency path', async () => {
    const responses = new Map<string, MockResponse>([
      ['pkg:twilio', { status: 201, body: { sid: 'SM123', status: 'sent' } }],
    ]);
    const handle = await startMockServer(responses);
    handles.push(handle);

    const url = mockDependencyUrl(handle.baseUrl, 'pkg:twilio');
    const res = await get(`${url}/Messages.json`);
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body)).toMatchObject({ sid: 'SM123' });
  });

  it('records intercepted requests in requestLog', async () => {
    const responses = new Map<string, MockResponse>([['pkg:twilio', { status: 200, body: {} }]]);
    const handle = await startMockServer(responses);
    handles.push(handle);

    await get(mockDependencyUrl(handle.baseUrl, 'pkg:twilio'));
    expect(handle.requestLog).toHaveLength(1);
    expect(handle.requestLog[0]?.dependencyId).toBe('pkg:twilio');
  });

  it('returns a generic 200 for an unmatched/unknown dependency id', async () => {
    const handle = await startMockServer(new Map());
    handles.push(handle);

    const res = await get(mockDependencyUrl(handle.baseUrl, 'pkg:unknown'));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({});
  });

  it('applies custom response headers on top of the default content-type', async () => {
    const responses = new Map<string, MockResponse>([
      ['pkg:stripe', { status: 200, body: { ok: true }, headers: { 'x-request-id': 'abc123' } }],
    ]);
    const handle = await startMockServer(responses);
    handles.push(handle);

    const url = mockDependencyUrl(handle.baseUrl, 'pkg:stripe');
    await new Promise<void>((resolve, reject) => {
      http
        .get(url, (res) => {
          expect(res.headers['x-request-id']).toBe('abc123');
          expect(res.headers['content-type']).toBe('application/json');
          res.resume();
          resolve();
        })
        .on('error', reject);
    });
  });
});
