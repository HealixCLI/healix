import { spawn as nodeSpawn } from 'node:child_process';
import { statSync } from 'node:fs';
import spawn from 'cross-spawn';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /**
   * Which timer caused `timedOut`: 'idle' means no stdout/stderr activity
   * arrived within `idleTimeoutMs`; 'hard' means the absolute `timeoutMs`
   * ceiling was reached regardless of activity. Undefined when timedOut is
   * false.
   */
  timeoutKind?: 'idle' | 'hard';
  /** True when the caller's AbortSignal fired before the process settled. */
  aborted: boolean;
  durationMs: number;
}

export interface RunOptions {
  timeoutMs?: number;
  /**
   * Sliding-window (idle) timeout, in ms: the kill timer resets on every
   * stdout/stderr chunk received, so the process is only killed after this
   * many ms pass with NO output activity — not after this much total time.
   * `timeoutMs` still applies unconditionally as an absolute backstop
   * ceiling (see killTree below), so a call that streams forever without
   * ever going idle is still bounded. Omit to keep the pre-streaming
   * behaviour of a single fixed `timeoutMs` timer (every non-streaming
   * caller — `which`, `--version` probes, etc. — is unaffected by this).
   */
  idleTimeoutMs?: number;
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

    // A missing/invalid cwd (e.g. a project's repoPath was moved or deleted)
    // makes CreateProcess/posix_spawn fail on ANY child, including the shell
    // itself on Windows — libuv then reports a confusing "spawn <shell> ENOENT"
    // that has nothing to do with the real target binary. Check up front and
    // fail with a message that names the actual problem.
    if (opts.cwd !== undefined) {
      let cwdIsDir = false;
      try {
        cwdIsDir = statSync(opts.cwd).isDirectory();
      } catch {
        cwdIsDir = false;
      }
      if (!cwdIsDir) {
        resolve({
          code: null,
          stdout: '',
          stderr: `working directory does not exist: ${opts.cwd}`,
          timedOut: false,
          aborted: false,
          durationMs: Date.now() - start,
        });
        return;
      }
    }

    const isWindows = process.platform === 'win32';
    // cross-spawn resolves Windows .cmd/.bat shims (claude, codex, npx, …) and
    // quotes argv itself, without cmd.exe string-concatenation (the plain
    // shell:true + args combo Node's DEP0190 warns about, and which let a
    // hostile argv element — e.g. a pasted git URL — inject shell metachars).
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
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
    let timeoutKind: 'idle' | 'hard' | undefined;
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
          nodeSpawn('taskkill', ['/F', '/T', '/PID', String(child.pid)]);
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

    // Absolute backstop: fires regardless of activity. This is the ONLY timer
    // when idleTimeoutMs is omitted, preserving today's fixed-timeout
    // behaviour byte-for-byte for every non-streaming caller.
    const hardTimer = setTimeout(() => {
      timedOut = true;
      timeoutKind = 'hard';
      if (idleTimer) clearTimeout(idleTimer);
      killTree();
    }, timeoutMs);

    // Sliding-window idle timer: only armed when the caller opts in. Reset on
    // every stdout/stderr chunk (see the 'data' handlers below) rather than on
    // parsed JSONL lines — raw byte arrival is a strictly earlier and simpler
    // liveness signal than "a full line parsed", and it still proves the
    // process isn't hung even mid-line.
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdleTimer = (): void => {
      if (opts.idleTimeoutMs === undefined) return;
      // Once a timeout has already fired (e.g. the hard backstop), the killed
      // process may still emit a few buffered data chunks before it actually
      // dies. Without this guard, those late chunks would re-arm the idle
      // timer and its eventual fire would clobber timeoutKind from 'hard'
      // back to 'idle', even though the hard timer won the race first.
      if (timedOut) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        timeoutKind = 'idle';
        killTree();
      }, opts.idleTimeoutMs);
    };
    armIdleTimer();

    // Abort takes the same kill path as a timeout; the eventual 'close' event
    // settles the promise so partial stdout/stderr is still delivered.
    const onAbort = (): void => {
      aborted = true;
      killTree();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    // Single settle point: clear both timers AND detach the abort listener so
    // a long-lived caller signal doesn't accumulate listeners across runs.
    const settle = (res: RunResult): void => {
      clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(res);
    };

    // cross-spawn's type declarations return the nullable-stream ChildProcess
    // shape, but we never override `stdio`, so these are always piped in
    // practice — non-null assertions match runtime reality.
    // setEncoding decodes multi-byte UTF-8 safely across chunk boundaries.
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      stdout += d;
      armIdleTimer();
    });
    child.stderr!.on('data', (d: string) => {
      stderr += d;
      armIdleTimer();
    });
    child.on('error', (err) => {
      settle({
        code: null,
        stdout,
        stderr: `${stderr}${String(err)}`,
        timedOut,
        timeoutKind,
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
        timeoutKind,
        aborted,
        durationMs: Date.now() - start,
      });
    });

    // Swallow stdin errors BEFORE writing: if the CLI exits without reading
    // stdin (e.g. `--version` fast paths), the write/end below raises EPIPE,
    // and an unhandled 'error' event on the stream would crash the process.
    child.stdin!.on('error', () => {});

    // Always close stdin. Some CLIs (e.g. `codex exec`) block reading stdin to
    // EOF when none is provided; writing the optional input first preserves the
    // stdin-piping path for tools that consume it.
    if (opts.input !== undefined) child.stdin!.write(opts.input);
    child.stdin!.end();
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
