import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probeUrl } from './http-probe.js';

/** Servers started during a test, closed in afterEach. */
const servers: http.Server[] = [];

/**
 * Start a tiny loopback HTTP server on an ephemeral port and resolve with the
 * port it bound to. Deterministic + offline (127.0.0.1 only).
 */
function startServer(handler: http.RequestListener): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve(addr.port);
    });
  });
}

/** Bind to port 0 to learn a free port, then release it before probing. */
function findUnusedPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = http.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address() as AddressInfo;
      const port = addr.port;
      probe.close(() => resolve(port));
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
});

describe('probeUrl', () => {
  it('reports { reachable: true, status: 200 } for a live server', async () => {
    const port = await startServer((_req, res) => {
      res.statusCode = 200;
      res.end('ok');
    });

    const result = await probeUrl(`http://127.0.0.1:${port}/`);

    expect(result.reachable).toBe(true);
    expect(result.status).toBe(200);
  });

  it('counts a 4xx/5xx response as reachable (any HTTP response = up)', async () => {
    const port = await startServer((_req, res) => {
      res.statusCode = 404;
      res.end('nope');
    });

    const result = await probeUrl(`http://127.0.0.1:${port}/`);

    expect(result.reachable).toBe(true);
    expect(result.status).toBe(404);
  });

  it('reports { reachable: false } for an unused port without throwing', async () => {
    const port = await findUnusedPort();

    // Short timeout so a stray bind by another process still resolves quickly.
    const result = await probeUrl(`http://127.0.0.1:${port}/`, 1_000);

    expect(result.reachable).toBe(false);
    expect(result.status).toBeUndefined();
  });

  it('reports { reachable: false } for a malformed URL without throwing', async () => {
    const result = await probeUrl('not-a-valid-url');

    expect(result.reachable).toBe(false);
  });

  it('reports { reachable: false } for an unsupported protocol without throwing', async () => {
    const result = await probeUrl('ftp://127.0.0.1/');

    expect(result.reachable).toBe(false);
  });
});
