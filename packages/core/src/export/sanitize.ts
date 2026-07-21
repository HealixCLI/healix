import os from 'node:os';
import path from 'node:path';

/** File extensions that are treated as sanitizable text. */
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.txt',
  '.yml',
  '.yaml',
]);

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
  // original separator/whitespace. The identifier must contain a secret token
  // (KEY/TOKEN/SECRET/PASSWORD/...) as a full underscore-delimited segment
  // (APIKEY allowed as a common unseparated compound). Case-insensitive, so both
  // MY_API_KEY and api_key match; the ^ anchor plus the required delimiter keep
  // MONKEY/TURKEY and token-free words ('RAPID', 'normal') from matching. A
  // non-empty value is required.
  {
    regex:
      /^([ \t]*(?:export[ \t]+)?(?:[A-Za-z0-9_]*_)?(?:APIKEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(?:_[A-Za-z0-9_]*)?[ \t]*=[ \t]*)\S.*$/gim,
    replace: (_m, prefix) => `${String(prefix)}<REDACTED>`,
  },
  // "key": "value" style (JSON / JS objects). Redacts the value, keeps the key.
  // `auth(?!ors?\b)` keeps authorization/authToken/oauth but spares the
  // package.json "author"/"authors" fields.
  {
    regex:
      /("(?:[a-z0-9_-]*(?:key|token|secret|password|passwd|apikey|api_key|auth(?!ors?\b)|credential)[a-z0-9_-]*)"[ \t]*:[ \t]*)"(?:[^"\\]|\\.)*"/gi,
    replace: (_m, prefix) => `${String(prefix)}"<REDACTED>"`,
  },
  // "key": 12345 style — an UNQUOTED (numeric) secret value. The quoted variant
  // above handles string values; this catches numeric secrets (PINs, numeric
  // keys) that would otherwise ship in the clear. Rewritten to a quoted
  // placeholder so the surrounding JSON stays valid.
  {
    regex:
      /("(?:[a-z0-9_-]*(?:key|token|secret|password|passwd|apikey|api_key|auth(?!ors?\b)|credential)[a-z0-9_-]*)"[ \t]*:[ \t]*)(-?\d[\w.+-]*)/gi,
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
 * Redact obvious secrets (API keys, tokens, passwords, bearer tokens) from
 * arbitrary text, independent of file-export context (no suite dir/home dir
 * rewriting, no literal-credential redaction — see {@link sanitizeContent} for
 * that fuller pipeline). Used for redacting captured network traffic bodies
 * before they're stored on an exploration artifact or fed into a prompt.
 */
export function redactSecrets(content: string): string {
  let out = content;
  for (const pattern of SECRET_PATTERNS) {
    // RegExp objects with the global flag carry lastIndex state across calls;
    // reset defensively before each use.
    pattern.regex.lastIndex = 0;
    out = out.replace(pattern.regex, pattern.replace);
  }
  return out;
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

/** One of the target app's own login credentials — only known to the caller (project record). */
export interface ExportCredential {
  username?: string | null;
  password?: string | null;
}

/**
 * Redact literal occurrences of every one of the project's stored test
 * credentials (there may be several — see storage's ProjectCredential). The
 * KEY=value / "key": "value" patterns above only catch secrets that are
 * labeled as such; a generated spec that hardcodes the literal password
 * (e.g. `await page.fill('#pw', 'Real+Passw0rd')`) has no such label and
 * would otherwise ship in the clear. Guarded by a minimum length so a short
 * value (e.g. a 2-3 char username) doesn't blow away unrelated text.
 */
function redactLiteralCredentials(content: string, credentials: ExportCredential[] | undefined): string {
  if (!credentials || credentials.length === 0) return content;
  let out = content;
  for (const cred of credentials) {
    for (const value of [cred.username, cred.password]) {
      if (value && value.length >= 4) {
        out = out.replace(new RegExp(escapeRegExp(value), 'g'), '<REDACTED>');
      }
    }
  }
  return out;
}

/**
 * Sanitize the textual contents of a copied suite file:
 *  - rewrites the absolute suite directory prefix to a relative placeholder,
 *  - rewrites the user's home directory prefix to a stable placeholder,
 *  - redacts obvious secrets (API keys, tokens, passwords, bearer tokens),
 *  - redacts literal occurrences of the project's own test credentials.
 *
 * Order matters: the (longer, more specific) suite directory is replaced before
 * the home directory so nested paths collapse correctly.
 */
export function sanitizeContent(content: string, suiteDir: string, credentials?: ExportCredential[]): string {
  const home = os.homedir();
  const normalizedSuite = path.resolve(suiteDir);

  let out = content;

  // Most specific prefix first.
  out = replaceAllPaths(out, normalizedSuite, SUITE_PLACEHOLDER);
  if (home && home !== normalizedSuite) {
    out = replaceAllPaths(out, home, HOME_PLACEHOLDER);
  }

  out = redactSecrets(out);
  out = redactLiteralCredentials(out, credentials);

  return out;
}
