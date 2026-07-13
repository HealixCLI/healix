import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { findFreePort } from './launcher.js';

// ---------------------------------------------------------------------------
// findFreePort() — hermetic: only ever binds loopback/wildcard listeners on
// OS-assigned ports, nothing is spawned and nothing leaves the machine.
// ---------------------------------------------------------------------------

/** Bind a listener (0 = ephemeral) and resolve with the live server. */
function listen(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function boundPort(server: net.Server): number {
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) return addr.port;
  throw new Error('server has no bound port');
}

describe('findFreePort', () => {
  it('returns the preferred port when it is free', async () => {
    // Grab an OS-assigned port, then release it: the kernel will not hand the
    // same ephemeral port out again immediately, so it is free for the check.
    const probe = await listen(0);
    const port = boundPort(probe);
    await close(probe);

    await expect(findFreePort(port)).resolves.toBe(port);
  });

  it('returns a DIFFERENT free port when the preferred one is occupied', async () => {
    // Hold a listener open for the duration so the preferred port stays busy.
    const holder = await listen(0);
    const held = boundPort(holder);
    try {
      const port = await findFreePort(held);
      expect(port).not.toBe(held);
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThanOrEqual(65535);
      // The returned port is genuinely bindable right now.
      const check = await listen(port);
      await close(check);
    } finally {
      await close(holder);
    }
  });

  it('returns a valid ephemeral port when no preference is given', async () => {
    const port = await findFreePort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });
});
