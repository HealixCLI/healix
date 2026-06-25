import http from 'node:http';
import https from 'node:https';
import type { UrlProbe } from './types.js';

/**
 * GET a URL and report reachability + status. Never throws.
 *
 * "Reachable" means we got *any* HTTP response (even 4xx/5xx) — a dev server
 * that answers 401/404 is still up and explorable. Redirects are NOT followed
 * so a 302 to /login still counts as a reachable, ready server. Connection
 * refused / DNS failure / timeout all resolve to { reachable: false }.
 */
export function probeUrl(url: string, timeoutMs = 5_000): Promise<UrlProbe> {
  return new Promise<UrlProbe>((resolve) => {
    let settled = false;
    const finish = (result: UrlProbe): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      finish({ reachable: false });
      return;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      finish({ reachable: false });
      return;
    }

    const client = parsed.protocol === 'https:' ? https : http;

    let req: http.ClientRequest;
    try {
      req = client.request(
        parsed,
        {
          method: 'GET',
          // Bound how long we wait for headers; the socket timeout below
          // guards the connection phase.
          timeout: timeoutMs,
        },
        (res) => {
          const status = res.statusCode;
          // Drain so the socket can be freed; we don't need the body.
          res.resume();
          finish({ reachable: true, status });
        },
      );
    } catch {
      finish({ reachable: false });
      return;
    }

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish({ reachable: false });
    });

    req.on('error', () => {
      finish({ reachable: false });
    });

    req.end();
  });
}
