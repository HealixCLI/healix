import http from 'node:http';
import { findFreePort } from './launcher.js';
import type { ExternalDependency, MockRequestRecord, MockResponse, MockServerHandle } from './types.js';

/**
 * True when a request's (method, path) matches an EndpointMock's pattern —
 * `:param` segments match anything, and both method and path segments
 * compare case-insensitively (a detected `/API/Foo` and a real request to
 * `/api/foo` are the same endpoint to any real HTTP router).
 */
function endpointMatches(patternMethod: string, pattern: string, requestMethod: string, requestPath: string): boolean {
  if (patternMethod.toUpperCase() !== requestMethod.toUpperCase()) return false;
  const patternSegs = pattern.split('/').filter(Boolean);
  const pathSegs = requestPath.split('/').filter(Boolean);
  if (patternSegs.length !== pathSegs.length) return false;
  return patternSegs.every(
    (seg, i) => seg === ':param' || seg.toLowerCase() === pathSegs[i].toLowerCase(),
  );
}

/** Serialize a MockResponse body per its declared content-type — JSON.stringify only when the type is (or defaults to) JSON. */
function serializeBody(response: MockResponse): { contentType: string; text: string } {
  const contentType = response.headers?.['content-type'] ?? 'application/json';
  if (!/json/i.test(contentType) && typeof response.body === 'string') {
    return { contentType, text: response.body };
  }
  return { contentType, text: JSON.stringify(response.body ?? {}) };
}

/**
 * Start a local HTTP server serving canned responses for env-override/both
 * dependencies, keyed by path prefix `/dep/<id>/...`. One server per run:
 * each dependency's env var is pointed at `${baseUrl}/dep/<id>`, so a
 * request's leading path segment identifies which canned response to serve.
 * Everything AFTER that prefix is matched against the dependency's
 * statically-detected `endpoints` (method + normalized path), when present,
 * so different real endpoints under the same host get their own response
 * instead of one blob for the whole dependency. An unmatched sub-path, or a
 * dependency with no detected endpoints, falls back to the dependency-level
 * response; a fully unknown/missing id gets a generic 200 + `{}` rather than
 * erroring, so an app that appends unexpected sub-paths still gets a
 * response instead of hanging.
 *
 * Only 'env-override'/'both' dependencies are ever served here —
 * 'route-intercept'-only dependencies are handled entirely inside the
 * generated Playwright fixture via page.route(), with no network hop.
 */
export async function startMockServer(
  deps: ExternalDependency[],
  responses: Map<string, MockResponse>,
): Promise<MockServerHandle> {
  const requestLog: MockRequestRecord[] = [];
  const depsById = new Map(deps.map((d) => [d.id, d]));

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    const match = /^\/dep\/([^/]+)(\/.*)?$/.exec(url);
    const depId = match?.[1] ? decodeURIComponent(match[1]) : null;
    const subPath = (match?.[2] ?? '/').split('?')[0] || '/';

    requestLog.push({ method, url, dependencyId: depId ?? 'unknown', at: new Date().toISOString() });

    // Drain the request body so a POST/PUT payload doesn't hang the client.
    req.resume();

    const dep = depId ? depsById.get(depId) : undefined;
    const endpoint = dep?.endpoints?.find((e) => endpointMatches(e.method, e.pathPattern, method, subPath));
    const response: MockResponse =
      endpoint?.response ?? (depId ? responses.get(depId) : undefined) ?? { status: 200, body: {} };
    const { contentType, text } = serializeBody(response);
    res.writeHead(response.status, {
      'content-type': contentType,
      ...(response.headers ?? {}),
    });
    res.end(text);
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
