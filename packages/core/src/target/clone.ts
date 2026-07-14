import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { runCli } from '../exec/run-cli.js';

/**
 * Matches a remote git URL (https/http/scp-like/ssh/git-protocol) as opposed to
 * a local filesystem path. Shared by the "repo path" validator (which rejects
 * these outright) and the clone flow (which is the one place allowed to act on
 * them before a local path ever reaches validation).
 */
const GIT_URL_PATTERN = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i;

export function isGitRemoteUrl(raw: string): boolean {
  return GIT_URL_PATTERN.test(raw.trim());
}

/** Derive a filesystem-safe folder name from a repo URL, e.g. ".../acme/web-app.git" -> "web-app". */
function repoSlug(url: string): string {
  const cleaned = url
    .trim()
    .replace(/\.git$/i, '')
    .replace(/[/\\]+$/, '');
  const last = cleaned.split(/[/:]/).filter(Boolean).pop() ?? 'repo';
  const safe = last.replace(/[^A-Za-z0-9_-]/g, '-');
  return safe || 'repo';
}

export interface CloneRepoResult {
  path: string;
}

/**
 * Shallow-clone a remote git URL into a fresh directory under destRoot.
 *
 * This is what lets a project's "Repo path" field accept a GitHub/GitLab/etc.
 * URL directly: the caller clones here first, then treats the resulting local
 * checkout exactly like any other white-box repoPath — validateNewProject
 * never sees the original URL.
 *
 * `--` before the URL stops git from treating it as option args; combined with
 * the GIT_URL_PATTERN prefix gate in isGitRemoteUrl, a hostile "repo path"
 * can't be parsed as a git-clone flag.
 */
export async function cloneRepo(url: string, destRoot: string): Promise<CloneRepoResult> {
  await mkdir(destRoot, { recursive: true });
  const dir = join(destRoot, `${repoSlug(url)}-${nanoid(8)}`);
  const result = await runCli('git', ['clone', '--depth', '1', '--', url, dir], {
    timeoutMs: 5 * 60_000,
  });
  if (result.code !== 0) {
    const reason = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(`git clone failed for ${url}: ${reason}`);
  }
  return { path: dir };
}
