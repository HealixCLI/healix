import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Project-level Healix configuration, committed at `.healix/config.json` in
 * the repo under test. HOLDS NO SECRETS — credentials are referenced by the
 * NAME of the environment variable that carries them, so the file is safe to
 * share while each teammate/CI keeps the actual values in their environment
 * (or a vault that exports env vars).
 *
 * Multi-role is modeled as a named-role map; the runner currently wires the
 * 'default' role into the Tier-B auth setup. Additional roles (admin, tenant
 * variants, …) are accepted and validated today so teams can standardize the
 * config shape now; per-role storageState projects are the planned consumer.
 */
export interface HealixAuthRole {
  /** Name of the env var holding this role's login email/username. */
  emailEnv: string;
  /** Name of the env var holding this role's password. */
  passwordEnv: string;
}

export interface HealixProjectConfig {
  auth?: {
    /** Login page URL; relative paths resolve against the launched app's base URL. */
    loginUrl?: string;
    /** Named roles; 'default' drives the Tier-B setup. */
    roles?: Record<string, HealixAuthRole>;
  };
}

/** Read `.healix/config.json` from the repo; absent/invalid → empty config. */
export async function readProjectConfig(repoPath: string): Promise<HealixProjectConfig> {
  try {
    const raw = await readFile(join(repoPath, '.healix', 'config.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as HealixProjectConfig;
  } catch {
    /* absent or unreadable — behave as unconfigured */
  }
  return {};
}

/**
 * Resolve the Tier-B credential env block for a run.
 *
 * Precedence: explicitly exported HEALIX_TIERB_* vars always win (a run-time
 * override must beat the committed config); otherwise the config's 'default'
 * role names which env vars to read. The returned map only ever contains
 * HEALIX_-prefixed keys — the execute-phase env allowlist stays intact.
 */
export function resolveTierBEnv(
  config: HealixProjectConfig,
  baseUrl: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};

  const role = config.auth?.roles?.['default'];
  const email = env.HEALIX_TIERB_EMAIL ?? (role ? env[role.emailEnv] : undefined);
  const password = env.HEALIX_TIERB_PASSWORD ?? (role ? env[role.passwordEnv] : undefined);
  if (email) out.HEALIX_TIERB_EMAIL = email;
  if (password) out.HEALIX_TIERB_PASSWORD = password;

  let loginUrl = env.HEALIX_TIERB_LOGIN_URL ?? config.auth?.loginUrl;
  if (loginUrl && !/^https?:\/\//i.test(loginUrl) && baseUrl) {
    loginUrl = `${baseUrl.replace(/\/$/, '')}/${loginUrl.replace(/^\//, '')}`;
  }
  if (loginUrl) out.HEALIX_TIERB_LOGIN_URL = loginUrl;

  return out;
}
