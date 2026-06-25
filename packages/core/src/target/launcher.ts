import { spawn, type ChildProcess } from 'node:child_process';
import process from 'node:process';
import { logger } from '../logger.js';
import type { LaunchHandle, LaunchOptions } from './types.js';
import { probeUrl } from './http-probe.js';

const POLL_INTERVAL_MS = 500;
const DEFAULT_READY_TIMEOUT_MS = 120_000;
/** Bounded ring buffer of recent stderr lines for diagnostics on timeout. */
const MAX_STDERR_LINES = 50;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mask obvious secrets before interpolating captured stderr into thrown errors:
 *  - `key=value` / `key: value` where the key looks sensitive, and
 *  - long base64 / hex blobs that are likely keys or tokens regardless of key.
 */
function redactSecrets(text: string): string {
  return text
    .replace(
      /\b((?:secret|token|password|api[_-]?key|authorization)[\w-]*)(\s*[=:]\s*)(["']?)([^\s"']+)\3/gi,
      (_m, key: string, sep: string, quote: string) => `${key}${sep}${quote}***${quote}`,
    )
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g, '***')
    .replace(/\b[0-9a-fA-F]{32,}\b/g, '***');
}

function deriveBaseUrl(opts: LaunchOptions): string {
  if (opts.baseUrl) return opts.baseUrl.replace(/\/+$/, '');
  const port = opts.port ?? 3000;
  return `http://localhost:${port}`;
}

/**
 * Kill a spawned process tree. On POSIX the child is started in its own process
 * group (detached) so we can signal the whole group via `-pid`. On Windows we
 * fall back to taskkill /T. Always best-effort and never throws.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    return;
  }

  // POSIX: try the process group first, then the bare pid.
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }

  // Escalate to SIGKILL shortly after if it hasn't exited.
  const killTimer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }, 4_000);
  // Don't let the kill timer keep the event loop alive.
  if (typeof killTimer.unref === 'function') killTimer.unref();
}

/**
 * Spawn the start command in `repoPath` and poll `baseUrl` until it is
 * reachable or `readyTimeoutMs` elapses. Returns a LaunchHandle whose stop()
 * tears down the whole process tree.
 *
 * Defensive behaviors:
 *  - No startCommand -> rejects with a clear error (nothing to launch).
 *  - Process exits before becoming ready -> rejects with captured stderr tail.
 *  - Readiness timeout -> kills the tree and rejects with stderr tail.
 *  - The command runs through a shell so detected commands like `npm run dev`
 *    or `cd web && npm run dev` work verbatim.
 */
export async function launch(opts: LaunchOptions): Promise<LaunchHandle> {
  const startCommand = opts.startCommand;
  if (!startCommand || !startCommand.trim()) {
    throw new Error('[healix] TargetAdapter.launch: no startCommand provided.');
  }

  const cwd = opts.repoPath ?? process.cwd();
  const baseUrl = deriveBaseUrl(opts);
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(opts.env ?? {}),
  };
  // Surface the detected port to the child so frameworks that read $PORT bind it.
  if (opts.port !== undefined) env.PORT = String(opts.port);

  const detached = process.platform !== 'win32';
  const child = spawn(startCommand, {
    cwd,
    env,
    shell: true,
    detached,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderrTail: string[] = [];
  const pushLines = (chunk: Buffer): void => {
    const text = chunk.toString('utf-8');
    for (const line of text.split('\n')) {
      const trimmed = line.replace(/\r$/, '');
      if (!trimmed) continue;
      stderrTail.push(trimmed);
      if (stderrTail.length > MAX_STDERR_LINES) stderrTail.shift();
    }
  };
  child.stderr?.on('data', pushLines);
  // Drain stdout so a chatty dev server doesn't block on a full pipe buffer.
  child.stdout?.on('data', () => {
    /* discarded */
  });

  let exited = false;
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let spawnError: Error | null = null;

  // Promise that settles the moment the child fails to start or exits early, so
  // the readiness poll can react to an ENOENT / early-exit deterministically
  // instead of hoping to observe it within a single macrotask.
  const failure = new Promise<'error' | 'exit'>((resolve) => {
    child.on('error', (err) => {
      spawnError = err instanceof Error ? err : new Error(String(err));
      resolve('error');
    });
    child.on('exit', (code, signal) => {
      exited = true;
      exitInfo = { code, signal };
      resolve('exit');
    });
  });

  const tail = (): string =>
    stderrTail.length ? redactSecrets(stderrTail.join('\n')) : '(no stderr captured)';

  const handle: LaunchHandle = {
    baseUrl,
    pid: child.pid ?? null,
    async stop(): Promise<void> {
      child.stderr?.removeListener('data', pushLines);
      if (exited) return;
      killTree(child);
      // Wait briefly for the exit event so callers can await a clean teardown.
      const deadline = Date.now() + 6_000;
      while (!exited && Date.now() < deadline) {
        await delay(100);
      }
    },
  };

  // Throws if the child has signalled a spawn error or exited early. Called
  // whenever the `failure` promise wins a race against the readiness poll.
  const throwIfFailed = (): void => {
    if (spawnError) {
      throw new Error(`[healix] failed to launch '${startCommand}': ${(spawnError as Error).message}\n${tail()}`);
    }
    if (exited) {
      const info = exitInfo as { code: number | null; signal: NodeJS.Signals | null } | null;
      const detail = info
        ? `exited early (code=${info.code ?? 'null'}, signal=${info.signal ?? 'null'})`
        : 'exited early';
      throw new Error(`[healix] start command ${detail}: '${startCommand}'\n${tail()}`);
    }
  };

  // Surface an immediate ENOENT / early-exit before we begin polling. Rather
  // than betting on a single fixed macrotask, race the `failure` event against a
  // brief settle window: whichever resolves first wins, and a failure is then
  // detected deterministically.
  const FAILURE_SETTLE = Symbol('settle');
  const first = await Promise.race([failure, delay(POLL_INTERVAL_MS).then(() => FAILURE_SETTLE)]);
  if (first !== FAILURE_SETTLE) throwIfFailed();

  logger.debug('target.launch: spawned', { startCommand, cwd, pid: child.pid, baseUrl });

  const startedAt = Date.now();
  while (Date.now() - startedAt < readyTimeoutMs) {
    throwIfFailed();

    // Race the readiness probe against the child failing/exiting so an
    // ENOENT/early-exit interrupts the wait immediately instead of only being
    // noticed at the top of the next poll iteration.
    const outcome = await Promise.race([
      failure,
      probeUrl(baseUrl, 4_000).then((probe) => ({ probe }) as const),
    ]);

    if (typeof outcome === 'string') {
      // `failure` won the race ('error' | 'exit').
      throwIfFailed();
    } else if (outcome.probe.reachable) {
      logger.info('target.launch: ready', {
        baseUrl,
        status: outcome.probe.status,
        elapsedMs: Date.now() - startedAt,
      });
      return handle;
    }

    // Wait before the next poll, but cut the wait short if the child fails.
    await Promise.race([failure, delay(POLL_INTERVAL_MS)]);
    throwIfFailed();
  }

  // Timed out — never leak the process.
  await handle.stop();
  throw new Error(
    `[healix] target at ${baseUrl} did not become reachable within ${readyTimeoutMs}ms.\n${tail()}`,
  );
}
