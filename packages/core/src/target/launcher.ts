import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { logger } from '../logger.js';
import type { LaunchHandle, LaunchOptions } from './types.js';
import { probeUrl } from './http-probe.js';

const POLL_INTERVAL_MS = 500;
const DEFAULT_READY_TIMEOUT_MS = 120_000;
// Installs are slow (native deps, cold cache, no local registry mirror) —
// give this far more room than the readiness poll.
const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60_000;
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

/**
 * Run a one-shot shell command to completion (unlike the long-lived dev
 * server, this is expected to exit on its own). Uses the same shell:true,
 * single-command-string form as the startCommand spawn below so compound
 * commands (`cd apps/web && npm install`) work identically on POSIX and
 * Windows. Never rejects — resolves with the exit code (null on spawn error)
 * and the combined stdout+stderr for error reporting.
 */
function runInstall(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, env: process.env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const push = (chunk: Buffer): void => {
      output += chunk.toString('utf-8');
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}${String(err)}` });
    });
  });
}

/**
 * Install dependencies before the dev server is spawned, but only when
 * they're actually missing — a cloned repo (or a repo the user just pointed
 * Healix at) has no node_modules yet, so its start command would otherwise
 * fail immediately (module not found) and launch() would report a confusing
 * "exited early" error instead of the real problem.
 *
 * Gated on installDir's node_modules rather than always running: re-running
 * an install on every launch of an already-set-up project would be pure
 * overhead (and surprising — it executes the repo's install scripts).
 */
async function ensureDependencies(opts: LaunchOptions): Promise<void> {
  if (!opts.installCommand) return;
  const repoPath = opts.repoPath ?? process.cwd();
  const installDir = opts.installDir ?? '.';
  const nodeModulesPath = path.join(repoPath, installDir, 'node_modules');
  if (existsSync(nodeModulesPath)) return;

  logger.info('target.launch: installing dependencies', { command: opts.installCommand, cwd: repoPath });
  const { code, output } = await runInstall(
    opts.installCommand,
    repoPath,
    opts.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
  );
  if (code !== 0) {
    throw new Error(
      `[healix] dependency install failed ('${opts.installCommand}', exit code ${code ?? 'null'}):\n${redactSecrets(output.trim().slice(-4000))}`,
    );
  }
  logger.info('target.launch: dependencies installed', { cwd: repoPath });
}

/**
 * Bind a TCP server to `port` (0 = OS-assigned ephemeral) and immediately
 * release it, resolving with the port that was actually bound, or null when
 * the bind failed (EADDRINUSE, EACCES, ...). Never rejects. Binds on the
 * default (all-interfaces) address so anything holding the port on either
 * stack makes the check fail — the strictest availability signal we can get.
 */
function tryBind(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    // The probe server must never keep the parent event loop alive.
    server.unref();
    server.once('error', () => resolve(null));
    server.listen(port, () => {
      const addr = server.address();
      const bound = typeof addr === 'object' && addr !== null ? addr.port : null;
      server.close(() => resolve(bound));
    });
  });
}

/**
 * Find a free TCP port for a per-run dev-server launch: try `preferred` first
 * and keep it when it binds; otherwise (busy, privileged, or no preference)
 * fall back to an OS-assigned ephemeral port.
 *
 * TOCTOU caveat: the port is released again before the caller spawns anything,
 * so another process CAN grab it in the window between this check and the dev
 * server binding it. That race is inherent to "find a free port" helpers (the
 * dev server must bind the port itself; we cannot hand it an open socket).
 * In practice the window is milliseconds and the failure mode is the same
 * launch-timeout error we already surface — this helper only removes the
 * *deterministic* collision where two concurrent runs of the same project both
 * launch on the framework default port and silently test each other's server.
 */
export async function findFreePort(preferred?: number): Promise<number> {
  if (preferred !== undefined) {
    const got = await tryBind(preferred);
    if (got !== null) return got;
  }
  const ephemeral = await tryBind(0);
  if (ephemeral !== null) return ephemeral;
  // Both binds failed (no sockets left / sandboxed environment). Fall back to
  // the preferred/default so the caller still has something to try; launch()
  // will surface the real error if it too cannot bind.
  return preferred ?? 3000;
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
  // A clean exit must cancel the escalation — the process-group id could
  // otherwise be reused by the OS and the stray SIGKILL would hit a stranger.
  child.once('exit', () => clearTimeout(killTimer));
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

  await ensureDependencies(opts);

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
  // The detached child must not keep the PARENT's event loop alive — the run
  // finishes (and the CLI exits) once stop() has torn the tree down, not when
  // the OS reaps the group. Documented limitation: if the parent is SIGKILLed
  // (no chance to run stop()/killTree), the detached process group is orphaned
  // and keeps running; that is the price of detaching for group-kill. A normal
  // parent exit still tears the tree down via the LaunchHandle cleanup paths.
  child.unref();

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
      throw new Error(
        `[healix] failed to launch '${startCommand}': ${(spawnError as Error).message}\n${tail()}`,
      );
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
