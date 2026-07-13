import type { ModeId, NewProject } from './types.js';

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
 *  - if a `baseUrl` is given it must be a valid http(s) URL.
 *
 * On success the returned `value` is trimmed/normalized and ready to persist.
 */
export function validateNewProject(input: NewProject): NewProjectValidation {
  const name = (input?.name ?? '').trim();
  if (!name) return { ok: false, error: 'Project name is required.' };

  const repoPath = (input.repoPath ?? '').trim() || null;
  const baseUrl = (input.baseUrl ?? '').trim() || null;

  if (!repoPath && !baseUrl) {
    return {
      ok: false,
      error: 'A project needs a repo path or a base URL — set at least one.',
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
    value: { name, mode: input.mode ?? 'playwright', repoPath, baseUrl },
  };
}
