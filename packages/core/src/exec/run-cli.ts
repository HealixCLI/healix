import { spawn } from 'node:child_process';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface RunOptions {
  timeoutMs?: number;
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Spawn a process, capture stdout/stderr, enforce a timeout. Never rejects. */
export function runCli(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const start = Date.now();
  return new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${String(err)}`, timedOut, durationMs: Date.now() - start });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - start });
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
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
