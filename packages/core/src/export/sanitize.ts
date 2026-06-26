import os from 'node:os';
import path from 'node:path';

/** File extensions that are treated as sanitizable text. */
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.yml', '.yaml']);

/** Placeholder substituted for the user's home directory. */
const HOME_PLACEHOLDER = '<HOME>';
/** Placeholder substituted for the exported suite's source directory. */
const SUITE_PLACEHOLDER = '.';

/**
 * Patterns matching common secret-bearing lines. Matches are replaced with a
 * redacted placeholder while preserving the key so the file stays well-formed.
 */
interface SecretPattern {
  readonly regex: RegExp;
  /** Replacer compatible with String.prototype.replace's function overload. */
  readonly replace: (match: string, ...rest: unknown[]) => string;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  // KEY=value style (dotenv / shell). Redacts the value, keeps the key and the
  // original separator/whitespace. The identifier must be UPPERCASE and CONTAIN a
  // secret token (KEY/TOKEN/SECRET/PASSWORD/...), so MY_API_KEY and DB_PASSWORD
  // match while lowercase words ('capital') and token-free words ('RAPID') do not.
  // A non-empty value is required.
  {
    regex: /^([ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*[ \t]*=[ \t]*)\S.*$/gm,
    replace: (_m, prefix) => `${String(prefix)}<REDACTED>`,
  },
  // "key": "value" style (JSON / JS objects). Redacts the value, keeps the key.
  {
    regex: /("(?:[a-z0-9_-]*(?:key|token|secret|password|passwd|apikey|api_key|auth|credential)[a-z0-9_-]*)"[ \t]*:[ \t]*)"(?:[^"\\]|\\.)*"/gi,
    replace: (_m, prefix) => `${String(prefix)}"<REDACTED>"`,
  },
  // Bearer tokens embedded anywhere.
  {
    regex: /\bBearer[ \t]+[A-Za-z0-9._\-+/=]{8,}/gi,
    replace: () => 'Bearer <REDACTED>',
  },
  // Well-known provider key shapes (OpenAI / Anthropic / Stripe-style keys).
  // Matches both hyphen- and underscore-delimited forms (sk-..., sk_live_...).
  {
    regex: /\b(?:sk|pk|rk)[_-](?:live|test)?[_-]?[A-Za-z0-9]{16,}/g,
    replace: () => '<REDACTED>',
  },
  {
    regex: /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
    replace: () => '<REDACTED>',
  },
];

/** True when a relative/absolute path looks like sanitizable text by extension. */
export function isTextFile(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Escape a string for safe literal use inside a RegExp.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace every (case-insensitive on Windows-like inputs we keep case-sensitive)
 * occurrence of `needle` with `replacement`. Also normalises backslash-separated
 * variants of the same absolute path so Windows-authored suites sanitize too.
 */
function replaceAllPaths(content: string, needle: string, replacement: string): string {
  if (!needle) return content;
  let out = content;
  const variants = new Set<string>([needle]);
  // POSIX and Windows separator variants of the same prefix.
  variants.add(needle.split(path.sep).join('/'));
  variants.add(needle.split('/').join('\\'));
  for (const variant of variants) {
    if (!variant) continue;
    out = out.replace(new RegExp(escapeRegExp(variant), 'g'), replacement);
  }
  return out;
}

/**
 * Sanitize the textual contents of a copied suite file:
 *  - rewrites the absolute suite directory prefix to a relative placeholder,
 *  - rewrites the user's home directory prefix to a stable placeholder,
 *  - redacts obvious secrets (API keys, tokens, passwords, bearer tokens).
 *
 * Order matters: the (longer, more specific) suite directory is replaced before
 * the home directory so nested paths collapse correctly.
 */
export function sanitizeContent(content: string, suiteDir: string): string {
  const home = os.homedir();
  const normalizedSuite = path.resolve(suiteDir);

  let out = content;

  // Most specific prefix first.
  out = replaceAllPaths(out, normalizedSuite, SUITE_PLACEHOLDER);
  if (home && home !== normalizedSuite) {
    out = replaceAllPaths(out, home, HOME_PLACEHOLDER);
  }

  for (const pattern of SECRET_PATTERNS) {
    // RegExp objects with the global flag carry lastIndex state across calls;
    // reset defensively before each use.
    pattern.regex.lastIndex = 0;
    out = out.replace(pattern.regex, pattern.replace);
  }

  return out;
}
