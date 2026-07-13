import { spawn } from 'node:child_process';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when the caller's AbortSignal fired before the process settled. */
  aborted: boolean;
  durationMs: number;
}

export interface RunOptions {
  timeoutMs?: number;
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Cooperative cancellation. On abort the whole child process tree is killed
   * and the promise RESOLVES (never rejects) with code:null, aborted:true and
   * stderr suffixed with "[aborted]" — callers already handle resolve-only
   * results, so cancellation must not introduce a rejection path.
   */
  signal?: AbortSignal;
}

/**
 * Pull a semver-looking version out of raw `--version` output. CLIs decorate
 * the number differently ("2.1.6 (Claude Code)", "codex-cli 0.142.4", update
 * banners on extra lines), so taking a fixed whitespace token is brittle —
 * match the first x.y.z(-prerelease/build) pattern anywhere instead.
 */
export function extractSemver(output: string): string | null {
  return output.match(/\d+\.\d+\.\d+[-\w.]*/)?.[0] ?? null;
}

/** Spawn a process, capture stdout/stderr, enforce a timeout. Never rejects. */
export function runCli(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const start = Date.now();
  return new Promise<RunResult>((resolve) => {
    // Already-aborted signal: don't spawn at all. Spawning just to kill the
    // process races the child's startup and can leak it entirely.
    if (opts.signal?.aborted) {
      resolve({ code: null, stdout: '', stderr: '[aborted]', timedOut: false, aborted: true, durationMs: 0 });
      return;
    }

    const isWindows = process.platform === 'win32';
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      // Windows: npm-global CLIs (claude, codex) are .cmd/.bat shims that can
      // only be spawned through a shell (Node refuses to exec .cmd directly).
      // But real executables (node.exe, where, …) must NOT go through cmd.exe —
      // it mangles quoted/paren args, so e.g. `node -e 'foo("hi")'` becomes a
      // syntax error and the child exits 1. So only shell out on Windows when
      // the target isn't already a directly-spawnable .exe/.com.
      shell: isWindows && !/\.(exe|com)$/i.test(cmd),
      // POSIX: make the child its own process-group leader so timeout/abort can
      // kill the CLI *and* everything it spawned (helpers, node children) with
      // one group signal — killing only the direct child leaves grandchildren
      // running and holding our stdio pipes open (same treatment as
      // playwright/execute).
      detached: !isWindows,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;

    /**
     * Kill the whole process tree, not just the direct child. On POSIX signal
     * the process group (negative pid); on Windows there are no process groups,
     * so `taskkill /T` walks and terminates the tree. Either path falls back to
     * a plain child.kill if the tree kill fails (e.g. already exited).
     */
    const killTree = (): void => {
      try {
        if (process.platform === 'win32') {
          if (!child.pid) throw new Error('no pid');
          spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)]);
        } else {
          if (!child.pid) throw new Error('no pid');
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    // Abort takes the same kill path as a timeout; the eventual 'close' event
    // settles the promise so partial stdout/stderr is still delivered.
    const onAbort = (): void => {
      aborted = true;
      killTree();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    // Single settle point: clear the timer AND detach the abort listener so a
    // long-lived caller signal doesn't accumulate listeners across runs.
    const settle = (res: RunResult): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(res);
    };

    // setEncoding decodes multi-byte UTF-8 safely across chunk boundaries.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      stdout += d;
    });
    child.stderr.on('data', (d: string) => {
      stderr += d;
    });
    child.on('error', (err) => {
      settle({
        code: null,
        stdout,
        stderr: `${stderr}${String(err)}`,
        timedOut,
        aborted,
        durationMs: Date.now() - start,
      });
    });
    child.on('close', (code) => {
      settle({
        // An aborted run reports code:null regardless of how the platform kill
        // surfaced (SIGKILL yields null on POSIX, but taskkill on Windows can
        // produce a numeric exit code) — callers key off aborted, not code.
        code: aborted ? null : code,
        stdout,
        stderr: aborted ? `${stderr}[aborted]` : stderr,
        timedOut,
        aborted,
        durationMs: Date.now() - start,
      });
    });

    // Swallow stdin errors BEFORE writing: if the CLI exits without reading
    // stdin (e.g. `--version` fast paths), the write/end below raises EPIPE,
    // and an unhandled 'error' event on the stream would crash the process.
    child.stdin.on('error', () => {});

    // Always close stdin. Some CLIs (e.g. `codex exec`) block reading stdin to
    // EOF when none is provided; writing the optional input first preserves the
    // stdin-piping path for tools that consume it.
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** Resolve a binary on PATH; returns its absolute path or null. */
export async function which(bin: string): Promise<string | null> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = await runCli(finder, [bin], { timeoutMs: 5_000 });
  if (r.code === 0) {
    const first = r.stdout.split('\n')[0]?.trim();
    return first || null;
  }
  return null;
}
