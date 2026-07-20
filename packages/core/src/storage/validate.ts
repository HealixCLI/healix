import { isGitRemoteUrl } from '../target/clone.js';
import type { ModeId, NewProject, NewProjectCredential } from './types.js';

/** Upper bound on an accepted base URL; guards against pathological input. */
const BASE_URL_MAX_LEN = 2048;

/**
 * A base URL is valid when it parses as an absolute http(s) URL with a host.
 *
 * We deliberately reject other schemes (file:, ftp:, javascript:, data:, …) and
 * relative / hostless strings: the app under test is always reached over
 * http/https, and accepting anything else would let a run point the browser or
 * the API `request` fixture somewhere unintended.
 */
export function isValidBaseUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value || value.length > BASE_URL_MAX_LEN) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return url.hostname.length > 0;
}

export interface NormalizedNewProject {
  name: string;
  mode: ModeId;
  repoPath: string | null;
  baseUrl: string | null;
  credentials: NewProjectCredential[];
}

export type NewProjectValidation = { ok: true; value: NormalizedNewProject } | { ok: false; error: string };

/**
 * Validate + normalize a NewProject before it is persisted.
 *
 * This is the SINGLE SOURCE OF TRUTH for the "a project is not empty" invariant.
 * It is enforced by {@link HealixStore.createProject}, so every persistence path
 * — the desktop IPC handler and the `healix project add` CLI command — is
 * guarded regardless of what the caller passes. The desktop form mirrors these
 * same rules for inline feedback, but this function is the hard guarantee.
 *
 * Rules:
 *  - `name` is required (non-blank after trim);
 *  - a project must be reachable somehow — at least one of `repoPath` / `baseUrl`
 *    must be provided (this is what stops "empty" projects from being created);
 *  - if a `baseUrl` is given it must be a valid http(s) URL;
 *  - each credential needs a non-blank username AND password (role is optional —
 *    a credential with a blank username or password is dropped rather than
 *    rejecting the whole save, since a half-filled "add credential" row the
 *    user never finished is not the same as a deliberately invalid project).
 *
 * On success the returned `value` is trimmed/normalized and ready to persist.
 */
export function validateNewProject(input: NewProject): NewProjectValidation {
  const name = (input?.name ?? '').trim();
  if (!name) return { ok: false, error: 'Project name is required.' };

  const repoPath = (input.repoPath ?? '').trim() || null;
  const baseUrl = (input.baseUrl ?? '').trim() || null;
  const credentials: NewProjectCredential[] = (input.credentials ?? [])
    .map((c) => ({
      username: (c?.username ?? '').trim(),
      password: (c?.password ?? '').trim(),
      role: (c?.role ?? '').trim() || null,
    }))
    .filter((c) => c.username.length > 0 && c.password.length > 0);

  if (!repoPath && !baseUrl) {
    return {
      ok: false,
      error: 'A project needs a repo path or a base URL — set at least one.',
    };
  }
  // Repo path is a LOCAL filesystem path to an already-cloned checkout — it is
  // later used as a child process's cwd. Callers that want to accept a remote
  // git URL (desktop IPC, `healix project add`) clone it via cloneRepo() and
  // pass the resulting local path in here; validateNewProject never fetches
  // anything itself. This guard is the safety net for any caller that skips
  // that step and hands a raw URL straight through — it fails fast, with a
  // pointer to the field that DOES want a URL, instead of a confusing failure
  // deep in plan/codegen once the project is already saved.
  if (repoPath && isGitRemoteUrl(repoPath)) {
    return {
      ok: false,
      error: `Repo path must be a local folder path, not a URL (received "${repoPath}"). Clone the repo locally and point Repo path at that folder, or use Base URL for the running app instead.`,
    };
  }
  if (baseUrl && !isValidBaseUrl(baseUrl)) {
    return {
      ok: false,
      error: `Base URL must be a valid http(s) URL (received "${baseUrl}").`,
    };
  }

  return {
    ok: true,
    value: { name, mode: input.mode ?? 'playwright', repoPath, baseUrl, credentials },
  };
}
