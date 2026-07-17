import http from 'node:http';
import { findFreePort } from './launcher.js';
import type { MockRequestRecord, MockResponse, MockServerHandle } from './types.js';

/**
 * Start a local HTTP server serving canned responses for env-override/both
 * dependencies, keyed by path prefix `/dep/<id>/...`. One server per run:
 * each dependency's env var is pointed at `${baseUrl}/dep/<id>`, so a
 * request's leading path segment identifies which canned response to serve.
 * An unmatched path (unknown/missing id) gets a generic 200 + `{}` rather
 * than erroring, so an app that appends unexpected sub-paths still gets a
 * response instead of hanging.
 *
 * Only 'env-override'/'both' dependencies are ever served here —
 * 'route-intercept'-only dependencies are handled entirely inside the
 * generated Playwright fixture via page.route(), with no network hop.
 */
export async function startMockServer(responses: Map<string, MockResponse>): Promise<MockServerHandle> {
  const requestLog: MockRequestRecord[] = [];

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    const match = /^\/dep\/([^/]+)(?:\/|$)/.exec(url);
    const depId = match?.[1] ? decodeURIComponent(match[1]) : null;

    requestLog.push({ method, url, dependencyId: depId ?? 'unknown', at: new Date().toISOString() });

    // Drain the request body so a POST/PUT payload doesn't hang the client.
    req.resume();

    const response: MockResponse = (depId && responses.get(depId)) || { status: 200, body: {} };
    const bodyText = JSON.stringify(response.body ?? {});
    res.writeHead(response.status, {
      'content-type': 'application/json',
      ...(response.headers ?? {}),
    });
    res.end(bodyText);
  });

  const port = await findFreePort();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    server.on('error', (err) => {
      if (settled) return; // post-listen errors have no promise left to settle — swallow rather than crash
      settled = true;
      reject(err);
    });
    server.listen(port, '127.0.0.1', () => {
      settled = true;
      resolve();
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    requestLog,
    stop(): Promise<void> {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Build the URL Healix should point a dependency's override env var at. */
export function mockDependencyUrl(baseUrl: string, dependencyId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/dep/${encodeURIComponent(dependencyId)}`;
}
