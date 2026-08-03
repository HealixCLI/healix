import fs from 'node:fs';
import path from 'node:path';
import { AUTH_ENDPOINT_METHODS, isAuthEndpointPath, isAuthHostname } from './auth-endpoints.js';
import { probeUrl } from './http-probe.js';
import type { EndpointMock, ExternalDependency, ExternalDependencyCategory, MockStrategy } from './types.js';

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface KnownProvider {
  packageNames: string[];
  category: ExternalDependencyCategory;
  label: string;
  /** Hostnames this provider's API is reachable at (exact or suffix match). */
  hostnames: string[];
  /** False for non-HTTP protocols (e.g. SMTP) — detected but never mocked. */
  mockable: boolean;
}

/**
 * Curated, deliberately small (extensible) list of popular third-party
 * SMS/OTP/email/payment/auth providers. Static, not exhaustive — matches the
 * same "regex/package-name over AST" tradeoff functionality-index.ts already
 * makes for route detection.
 */
const KNOWN_PROVIDERS: KnownProvider[] = [
  {
    packageNames: ['twilio'],
    category: 'sms',
    label: 'Twilio (SMS/OTP)',
    hostnames: ['api.twilio.com'],
    mockable: true,
  },
  {
    packageNames: ['@sendgrid/mail'],
    category: 'email',
    label: 'SendGrid (email)',
    hostnames: ['api.sendgrid.com'],
    mockable: true,
  },
  {
    packageNames: ['nodemailer'],
    category: 'email',
    label: 'Nodemailer (SMTP email)',
    hostnames: [],
    mockable: false,
  },
  {
    packageNames: ['stripe'],
    category: 'payment',
    label: 'Stripe (payments)',
    hostnames: ['api.stripe.com', 'js.stripe.com', 'checkout.stripe.com'],
    mockable: true,
  },
  {
    packageNames: ['firebase-admin', 'firebase'],
    category: 'auth',
    label: 'Firebase Auth/OTP',
    hostnames: ['identitytoolkit.googleapis.com', 'securetoken.googleapis.com'],
    mockable: true,
  },
  {
    packageNames: ['auth0', '@auth0/auth0-react', '@auth0/auth0-spa-js'],
    category: 'auth',
    label: 'Auth0',
    hostnames: ['auth0.com'],
    mockable: true,
  },
  {
    packageNames: ['razorpay'],
    category: 'payment',
    label: 'Razorpay (payments)',
    hostnames: ['api.razorpay.com'],
    mockable: true,
  },
  {
    packageNames: ['plaid'],
    category: 'payment',
    label: 'Plaid (banking)',
    hostnames: ['production.plaid.com', 'sandbox.plaid.com'],
    mockable: true,
  },
  {
    packageNames: ['msg91'],
    category: 'sms',
    label: 'MSG91 (SMS/OTP)',
    hostnames: ['api.msg91.com'],
    mockable: true,
  },
  {
    packageNames: ['2factor'],
    category: 'otp',
    label: '2Factor (OTP)',
    hostnames: ['2factor.in'],
    mockable: true,
  },
  {
    packageNames: ['@aws-sdk/client-ses'],
    category: 'email',
    label: 'AWS SES (email)',
    hostnames: ['email.amazonaws.com'],
    mockable: true,
  },
  {
    packageNames: ['@aws-sdk/client-sns'],
    category: 'sms',
    label: 'AWS SNS (SMS)',
    hostnames: ['sns.amazonaws.com'],
    mockable: true,
  },
  {
    packageNames: ['react-google-recaptcha', 'react-google-recaptcha-v3'],
    category: 'auth',
    label: 'Google reCAPTCHA',
    hostnames: ['www.google.com', 'recaptcha.net'],
    mockable: true,
  },
];

const SKIP_DIRS = new Set<string>([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  '.cache',
  '.parcel-cache',
  '.vercel',
  '.output',
  'out',
  'venv',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.idea',
  '.vscode',
  'target',
  'vendor',
]);

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

interface WalkFile {
  abs: string;
  rel: string;
}

/** Iterative BFS walk collecting source files — same traversal shape as functionality-index.ts's walker. */
function walkSourceFiles(root: string, hardCap: number): WalkFile[] {
  const files: WalkFile[] = [];
  const queue: string[] = [root];

  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined) break;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const subDirs: string[] = [];
    for (const entry of entries) {
      const name = entry.name;
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (name.startsWith('.') && name !== '.github') continue;
        subDirs.push(path.join(dir, name));
        continue;
      }

      if (!entry.isFile()) continue;
      if (files.length >= hardCap) break;

      const ext = path.extname(name).toLowerCase();
      if (!SOURCE_EXT.has(ext)) continue;

      const abs = path.join(dir, name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      files.push({ abs, rel });
    }

    if (files.length >= hardCap) break;
    for (const sub of subDirs) queue.push(sub);
  }

  return files;
}

function readSafe(abs: string): string {
  try {
    return fs.readFileSync(abs, 'utf-8');
  } catch {
    return '';
  }
}

function readPackageJson(repoPath: string): PackageJson | null {
  try {
    const raw = fs.readFileSync(path.join(repoPath, 'package.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as PackageJson) : null;
  } catch {
    return null;
  }
}

/**
 * Env files consulted for a var's value, in precedence order (mirrors detector.ts's
 * ENV_FILES — see the drift note there; kept independent on purpose since the two
 * constants serve different consumers). Widened beyond the original three (Cluster F) so a
 * dependency's recorded hostnames (see readEnvVarAllValues below) cover a dev/prod split
 * defined across more than one file, not just whichever one precedence would pick alone.
 */
const ENV_FILES = ['.env.local', '.env.development', '.env', '.env.production', '.env.test', '.env.staging'];

/**
 * Every DISTINCT value `varName` resolves to across all of ENV_FILES (deduped,
 * precedence-first order preserved) — not just the single highest-precedence value. A
 * dependency's detected hostname is normally taken from just the first of these;
 * recording every candidate lets the mock fixture also recognize a
 * request whose ACTUAL runtime value came from a different `.env*` file than the one this
 * detection pass happened to read first (e.g. a `.env.production` value used by the real
 * running app while `.env`/`.env.local` define a different one for local dev) — see
 * Cluster F: an unrecognized hostname silently falls through to the real network with no
 * mock at all.
 */
function readEnvVarAllValues(repoPath: string, varName: string): string[] {
  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*${escaped}\\s*=\\s*['"]?([^'"\\r\\n]*)['"]?\\s*$`, 'm');
  const seen = new Set<string>();
  const values: string[] = [];
  for (const file of ENV_FILES) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(repoPath, file), 'utf-8');
    } catch {
      continue;
    }
    const m = content.match(re);
    const v = m?.[1]?.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      values.push(v);
    }
  }
  return values;
}

/** Any hardcoded `https?://<host>` literal in source, excluding local dev hosts. */
const URL_LITERAL_RE = /https?:\/\/([a-zA-Z0-9.-]+)(?::\d+)?[^\s'"`)]*/g;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0']);

/**
 * Tokens that indicate a URL literal is actually being used to make a network
 * call, as opposed to a plain string constant (a support/marketing link, an
 * asset URL passed to <img>, etc.) — gates the 'other' catch-all bucket for
 * UNKNOWN hosts so it doesn't flag every external link a page happens to
 * render as a "dependency". A KNOWN provider hostname match skips this gate
 * entirely: matching a curated real API host is already high-confidence.
 */
const NETWORK_CALL_MARKER_RE =
  /\bfetch\s*\(|\baxios\b|XMLHttpRequest|\bajax\s*\(|createClient\s*\(|baseURL|\.request\s*\(|\.(?:get|post|put|patch|delete)\s*\(|https?\.request\s*\(/i;

/** Env var reads: process.env.X (Node/Next/CRA) or import.meta.env.VITE_X (Vite) — any name, not a fixed list. */
const ENV_VAR_REF_RE = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)\b|import\.meta\.env\.(VITE_[A-Za-z0-9_]*)\b/g;

/** Env var name patterns that plausibly let Healix redirect a server-side SDK's base URL. */
const OVERRIDE_ENV_VAR_RE = /process\.env\.([A-Z][A-Z0-9_]*(?:_URL|_ENDPOINT|_BASE_URL|_HOST))\b/;

/** Directories whose presence suggests browser-bundled (frontend) code, vs. server code. */
const FRONTEND_DIR_RE = /(^|\/)(src\/(components|pages|app|views)|pages|app|client|frontend|public)\//i;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The source line containing `index`, for context checks (xmlns exclusion, network-call gating). */
function lineAround(source: string, index: number): string {
  const start = source.lastIndexOf('\n', index) + 1;
  const nextBreak = source.indexOf('\n', index);
  const end = nextBreak === -1 ? source.length : nextBreak;
  return source.slice(start, end);
}

/** Parse `value` as an absolute http(s) URL, or null if it isn't one. */
function parseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort category guess for an env-configured external endpoint, from
 * its variable name alone — auth/identity providers (Cognito, Auth0-style
 * SSO, OAuth) get 'auth'; everything else defaults to 'backend' (the app's
 * own or a partner API it depends on).
 */
function classifyEnvUrlVar(varName: string, url?: URL | null): ExternalDependencyCategory {
  if (/AUTH|COGNITO|LOGIN|SSO|OAUTH|IDENTITY/i.test(varName)) return 'auth';
  // A base URL whose PATH is an auth path means every call through this dependency is an
  // auth call (e.g. API_BASE=https://host/auth/v1) — the var's NAME alone never sees this.
  if (url && isAuthEndpointPath(url.pathname)) return 'auth';
  return 'backend';
}

/** Find where a package is imported and infer how it could be mocked. */
function findUsageContext(
  files: WalkFile[],
  packageName: string,
): { strategy: MockStrategy; envVar?: string; file?: string; note?: string } {
  const importRe = new RegExp(
    `from\\s+['"]${escapeRegex(packageName)}['"]|require\\(\\s*['"]${escapeRegex(packageName)}['"]\\s*\\)`,
  );

  for (const f of files) {
    const source = readSafe(f.abs);
    if (!source || !importRe.test(source)) continue;

    if (FRONTEND_DIR_RE.test(f.rel)) {
      return { strategy: 'route-intercept', file: f.rel };
    }
    const envMatch = source.match(OVERRIDE_ENV_VAR_RE);
    if (envMatch && envMatch[1]) {
      return { strategy: 'env-override', envVar: envMatch[1], file: f.rel };
    }
    return {
      strategy: 'undeterminable',
      file: f.rel,
      note: 'Used server-side with no configurable base-URL env var found nearby — cannot redirect to a mock without app changes.',
    };
  }
  return {
    strategy: 'undeterminable',
    note: 'Package is a dependency but no import site was found in the scanned source.',
  };
}

/** True when `host` matches `known` exactly or as a dot-suffix (api.foo.com matches foo.com). */
function hostMatches(host: string, known: string): boolean {
  return host === known || host.endsWith(`.${known}`);
}

function findKnownProviderForHost(host: string): KnownProvider | null {
  for (const provider of KNOWN_PROVIDERS) {
    if (provider.hostnames.some((h) => hostMatches(host, h))) return provider;
  }
  return null;
}

/**
 * Auth-category or auth-hostname-looking dependencies among the given list, for narrowing
 * which dependency an auth path (found in a multi-dependency repo) is attributed to. Falls
 * back to the full list when none look auth-specific, since a path-based attribution is
 * inert if wrong — the generated fixture matches by exact (method, path).
 */
function authTargets(mockableDeps: ExternalDependency[]): ExternalDependency[] {
  const narrowed = mockableDeps.filter(
    (d) => d.category === 'auth' || (d.hostnames ?? []).some((h) => isAuthHostname(h)),
  );
  return narrowed.length > 0 ? narrowed : mockableDeps;
}

/**
 * `client.get('/path')` / `client.post(\`/path/${id}\`)` style call sites —
 * generic across any HTTP client (axios instance, fetch wrapper, custom
 * service class), not tied to any particular app. Only string/template-
 * literal first arguments are extractable; a computed/variable path is
 * skipped (nothing static to read). Interpolations in a template literal are
 * normalized to a `:param` placeholder so `/reward/${id}` and `/reward/${x}`
 * collapse to the same pattern and can later match a real request's path.
 *
 * `.get(`/`.post(` etc. are also common non-HTTP method names (Map/Storage
 * getters, generic setters) — gated by requiring the literal argument to
 * look like a path (starts with '/') to keep false positives low, matching
 * this module's existing "best-effort, not exhaustive" static-analysis
 * philosophy elsewhere.
 *
 * The optional `(?:<[^()]{0,80}>)?` between the method name and `(` matches an explicit
 * TypeScript generic type argument (e.g. axios's `client.post<ResponseType>('/path', body)`,
 * the standard typed-axios idiom) — without it, this real, common call shape was invisible to
 * the regex entirely, silently discarding the call site rather than just its path (found via
 * real-app verification against a live axios-based login call site, GAP-064 follow-up).
 */
const CALL_SITE_RE =
  /\b[\w$]+\.(get|post|put|patch|delete|head|options)(?:<[^()]{0,80}>)?\(\s*(?:`([^`]*)`|'([^']*)'|"([^"]*)")/gi;

/**
 * Object-config call style: `axios({ method: 'get', url: '/path' })` (or
 * `.request({...})`) — method/url can appear in either order, so this
 * matches the pair independently within a bounded window rather than
 * requiring one fixed key order.
 */
const CONFIG_CALL_RE = /\b[\w$]+\.?(?:request)?\(\s*\{([^{}]{0,300})\}\s*\)/gi;
const CONFIG_METHOD_RE = /\bmethod\s*:\s*['"](\w+)['"]/i;
const CONFIG_URL_RE = /\burl\s*:\s*(?:`([^`]*)`|'([^']*)'|"([^"]*)")/i;

const MAX_ENDPOINTS_PER_DEP = 40;
const MAX_AUTH_ENDPOINTS_PER_DEP = 8;

/**
 * HTTP verbs for which a relative-path literal (no leading '/') is safe to accept from
 * CALL_SITE_RE without the leading-slash false-positive guard: `.post(`/`.put(`/`.patch(` are
 * essentially never a non-HTTP Map/Storage/collection method in real code, unlike `.get(`/
 * `.delete(`, which collide with common getter/collection-deletion methods. This matters because
 * a very common, standard axios pattern is an instance with its own `baseURL` and a *relative*
 * call site (e.g. `authApi.post('v1/web/token/generate', body)`) — without this, that endpoint
 * (frequently the login handshake) is invisible to mock-endpoint detection entirely (GAP-064).
 */
const RELATIVE_PATH_OK_METHODS = new Set(['post', 'put', 'patch']);

/**
 * Any string/template literal that LOOKS like a path — needed because CALL_SITE_RE and
 * CONFIG_CALL_RE miss the common `fetch(`${base}/auth/token/generate`)` shape (no
 * `.post(`, no `{ url: ... }`). Deliberately feeds ONLY the auth-endpoint list further
 * down: a broad path-literal scan would flood normal endpoint detection with unrelated
 * string constants, but a spurious auth-looking match there is inert (mocks match by
 * exact path, so an extra unused entry changes nothing).
 */
const PATH_LITERAL_RE = /[`'"](?:\$\{[^}]{0,80}\})?(\/[\w\-./:]{2,120})[`'"]/g;

/** Collapse a template-literal interpolation (`${id}`) to a `:param` placeholder so
 * `/reward/${id}` and `/reward/${x}` collapse to the same pattern. Exported so other
 * ground-truth sources (e.g. EXPLORE's captured network traffic, see
 * `browser/network-capture.ts`) normalize endpoint paths the same way this static
 * scan does, keeping both sides comparable. */
export function normalizeEndpointPath(raw: string): string {
  return raw.replace(/\$\{[^}]*\}/g, ':param');
}

/** Auth-tagged (method, pathPattern) entries for one path — one per AUTH_ENDPOINT_METHODS,
 * since a login handshake's verb often isn't statically knowable. */
function authEndpointEntries(pathPattern: string): EndpointMock[] {
  return AUTH_ENDPOINT_METHODS.map((method) => ({ method, pathPattern, category: 'auth' as const }));
}

/** Append endpoints to a dependency, deduped on (method, pathPattern). */
function addEndpoints(dep: ExternalDependency, entries: EndpointMock[]): void {
  const existing = new Set((dep.endpoints ?? []).map((e) => `${e.method} ${e.pathPattern}`));
  const toAdd = entries.filter((e) => !existing.has(`${e.method} ${e.pathPattern}`));
  if (toAdd.length === 0) return;
  dep.endpoints = [...(dep.endpoints ?? []), ...toAdd];
}

/**
 * Best-effort (method, path) call-site scan across every source file. Ordinary endpoints
 * are capped/deduped at MAX_ENDPOINTS_PER_DEP as before; auth-shaped paths are additionally
 * collected into a separate, smaller-capped `authEndpoints` list that is NEVER cut short by
 * the ordinary cap being hit — a chatty repo with 40+ unrelated call sites must not be able
 * to make the one login endpoint invisible.
 */
function extractEndpointCallSites(files: WalkFile[]): {
  endpoints: EndpointMock[];
  authEndpoints: EndpointMock[];
  truncated: boolean;
} {
  const seen = new Set<string>();
  const authSeen = new Set<string>();
  const endpoints: EndpointMock[] = [];
  const authEndpoints: EndpointMock[] = [];
  let truncated = false;

  const addAuthEndpoint = (pathPattern: string): void => {
    for (const entry of authEndpointEntries(pathPattern)) {
      const key = `${entry.method} ${entry.pathPattern}`;
      if (authSeen.has(key) || authEndpoints.length >= MAX_AUTH_ENDPOINTS_PER_DEP) continue;
      authSeen.add(key);
      authEndpoints.push(entry);
    }
  };

  const tryAdd = (method: string | undefined, raw: string | undefined): void => {
    if (!method || raw === undefined) return;
    if (!raw.startsWith('/') && !RELATIVE_PATH_OK_METHODS.has(method.toLowerCase())) return;
    const pathPattern = normalizeEndpointPath(raw);
    const isAuth = isAuthEndpointPath(pathPattern);
    const key = `${method.toUpperCase()} ${pathPattern}`;
    if (!seen.has(key)) {
      seen.add(key);
      if (endpoints.length < MAX_ENDPOINTS_PER_DEP) {
        endpoints.push({
          method: method.toUpperCase(),
          pathPattern,
          ...(isAuth ? { category: 'auth' as const } : {}),
        });
      } else {
        truncated = true;
      }
    }
    if (isAuth) addAuthEndpoint(pathPattern);
  };

  const capsReached = (): boolean =>
    endpoints.length >= MAX_ENDPOINTS_PER_DEP && authEndpoints.length >= MAX_AUTH_ENDPOINTS_PER_DEP;

  outer: for (const f of files) {
    const source = readSafe(f.abs);
    if (!source) continue;

    for (const m of source.matchAll(CALL_SITE_RE)) {
      tryAdd(m[1], m[2] ?? m[3] ?? m[4]);
      if (capsReached()) break outer;
    }
    for (const m of source.matchAll(CONFIG_CALL_RE)) {
      const inner = m[1] ?? '';
      const method = CONFIG_METHOD_RE.exec(inner)?.[1];
      const urlMatch = CONFIG_URL_RE.exec(inner);
      tryAdd(method, urlMatch?.[1] ?? urlMatch?.[2] ?? urlMatch?.[3]);
      if (capsReached()) break outer;
    }
    if (authEndpoints.length < MAX_AUTH_ENDPOINTS_PER_DEP) {
      for (const m of source.matchAll(PATH_LITERAL_RE)) {
        const raw = m[1];
        const pathPattern = raw ? normalizeEndpointPath(raw) : null;
        if (pathPattern && isAuthEndpointPath(pathPattern)) addAuthEndpoint(pathPattern);
        if (capsReached()) break outer;
      }
    }
  }

  return { endpoints, authEndpoints, truncated };
}

/**
 * Detect a white-box repo's external dependencies: known third-party SMS/
 * email/payment/auth SDKs (via package.json + import-site scan), hardcoded
 * third-party API URLs referenced in a network call, and any env var (any
 * naming convention — process.env.X / import.meta.env.VITE_X) whose resolved
 * value is an absolute non-local URL, since that's how most SPAs configure
 * their own backend and any partner/auth endpoints. Reachability is recorded
 * as information, not a filter: a live third-party service is exactly as
 * important to mock for deterministic, offline test runs as a down one.
 *
 * Purely static (package.json + regex source scan), consistent with
 * functionality-index.ts's existing approach — no AST, no AI call. Best-
 * effort and additive: returns an empty array rather than throwing when the
 * repo can't be read.
 */
export async function detectExternalDependencies(repoPath: string): Promise<ExternalDependency[]> {
  const root = path.resolve(repoPath);
  const deps: ExternalDependency[] = [];
  // A Map (not a Set) so a REPEAT literal for an already-recorded host can still look up
  // the existing dependency object and contribute an auth-path endpoint to it — see the
  // URL-literal loop below, where this used to be an unconditional `continue`.
  const depsById = new Map<string, ExternalDependency>();
  // Env-var dependency id -> its base URL's path prefix (e.g. "/v2"), so a relative
  // call-site auth path can also be registered in its real, prefixed form.
  const basePathById = new Map<string, string>();

  const addDep = (dep: ExternalDependency): void => {
    if (depsById.has(dep.id)) return;
    depsById.set(dep.id, dep);
    deps.push(dep);
  };

  const files = walkSourceFiles(root, 3000);

  // 1. Package-based detection.
  const pkg = readPackageJson(root);
  const allDeps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  for (const provider of KNOWN_PROVIDERS) {
    const matchedPkg = provider.packageNames.find((n) => Object.prototype.hasOwnProperty.call(allDeps, n));
    if (!matchedPkg) continue;
    const id = `pkg:${matchedPkg}`;

    if (!provider.mockable) {
      addDep({
        id,
        category: provider.category,
        label: provider.label,
        source: 'package',
        packageName: matchedPkg,
        mockStrategy: 'undeterminable',
        note: `${provider.label} uses a non-HTTP protocol — not mockable via network interception.`,
      });
      continue;
    }

    const usage = findUsageContext(files, matchedPkg);
    addDep({
      id,
      category: provider.category,
      label: provider.label,
      source: 'package',
      packageName: matchedPkg,
      hostnames: provider.hostnames,
      mockStrategy: usage.strategy,
      ...(usage.envVar ? { envVar: usage.envVar } : {}),
      ...(usage.file ? { file: usage.file } : {}),
      ...(usage.note ? { note: usage.note } : {}),
    });
  }

  // 2. Source scan: hardcoded URL literals actually used in a network call,
  // plus any env var whose resolved value is an external URL.
  for (const f of files) {
    const source = readSafe(f.abs);
    if (!source) continue;

    for (const m of source.matchAll(URL_LITERAL_RE)) {
      const host = m[1];
      if (!host) continue;
      const isLocal = LOCAL_HOSTS.has(host);
      const known = isLocal ? null : findKnownProviderForHost(host);
      const id = known ? `pkg:${known.packageNames[0]}` : `url:${host}`;

      const line = lineAround(source, m.index ?? 0);
      // A namespace attribute (xmlns="http://www.w3.org/2000/svg") is never a
      // network call — the single most common false positive in JSX/SVG code.
      if (/\bxmlns/i.test(line)) continue;

      const isCall = !isLocal && (known !== null || NETWORK_CALL_MARKER_RE.test(line));
      // The literal's own PATH — discarded until now, and the one place a custom auth
      // host (with no matching env-var name or KNOWN_PROVIDERS entry) announces itself
      // unambiguously.
      const literalPath = isCall ? (parseHttpUrl(m[0])?.pathname ?? null) : null;
      const authPath =
        literalPath && isAuthEndpointPath(literalPath) ? normalizeEndpointPath(literalPath) : null;

      const existingDep = depsById.get(id);
      if (existingDep) {
        // Was an unconditional `continue`: a repeat literal for an already-recorded host
        // contributed nothing, so `fetch(BASE)` seen first and
        // `fetch('https://host/auth/token/generate')` seen second meant the auth path
        // was never recorded at all.
        if (authPath && existingDep.mockStrategy !== 'undeterminable') {
          addEndpoints(existingDep, authEndpointEntries(authPath));
        }
        continue;
      }

      if (isLocal) {
        // A hardcoded local-host literal, same as the env-var pass, is the
        // app's own dev backend — record it distinctly as 'local-backend'
        // (with a reachability probe, unlike today which dropped it
        // unconditionally) rather than suppressing it, so Generate (F-08) can
        // route tierC-api requests to its real origin. Still gated on the
        // network-call marker so a plain string constant isn't flagged.
        if (!NETWORK_CALL_MARKER_RE.test(line)) continue;
        const origin = parseHttpUrl(m[0])?.origin ?? `http://${host}`;
        let reachable = false;
        try {
          reachable = (await probeUrl(origin, 2_000)).reachable;
        } catch {
          reachable = false;
        }
        addDep({
          id,
          category: 'local-backend',
          label: 'Local backend API',
          source: 'url-literal',
          hostnames: [new URL(origin).host],
          mockStrategy: 'undeterminable',
          file: f.rel,
          reachable,
          note: reachable
            ? `Hardcoded reference to ${origin} (currently reachable local dev backend).`
            : `Hardcoded reference to ${origin}; not reachable at detection time.`,
        });
        continue;
      }

      if (known) {
        if (!known.mockable) continue; // already recorded (or will be) via the package-based pass
        const dep: ExternalDependency = {
          id,
          category: known.category,
          label: known.label,
          source: 'url-literal',
          hostnames: known.hostnames,
          mockStrategy: 'route-intercept',
          file: f.rel,
        };
        addDep(dep);
        if (authPath) addEndpoints(dep, authEndpointEntries(authPath));
      } else {
        // An unrecognized host is only worth flagging when it's plausibly a
        // network call (fetch/axios/etc. on the same line) — otherwise it's
        // just a string constant (a support link, an asset URL) that isn't a
        // dependency the app talks to over the network at runtime.
        if (!NETWORK_CALL_MARKER_RE.test(line)) continue;
        const dep: ExternalDependency = {
          id,
          category: authPath ? 'auth' : 'other',
          label: authPath ? `Auth/identity endpoint at ${host}` : `Third-party API at ${host}`,
          source: 'url-literal',
          hostnames: [host],
          mockStrategy: 'route-intercept',
          file: f.rel,
        };
        addDep(dep);
        if (authPath) addEndpoints(dep, authEndpointEntries(authPath));
      }
    }

    for (const m of source.matchAll(ENV_VAR_REF_RE)) {
      const varName = m[1] ?? m[2];
      if (!varName) continue;
      const id = `env:${varName}`;
      if (depsById.has(id)) continue;
      // A redirect/callback URL is the app's OWN endpoint that a provider (an
      // OAuth/SSO identity provider, typically) redirects the browser BACK
      // to — the app never calls out to it, so it isn't an outbound
      // dependency and there is nothing to mock.
      if (/REDIRECT|CALLBACK/i.test(varName)) continue;

      const allValues = readEnvVarAllValues(root, varName);
      const value = allValues[0];
      if (!value) continue;
      const parsed = parseHttpUrl(value);
      if (!parsed) continue;

      let reachable = false;
      try {
        reachable = (await probeUrl(value, 2_000)).reachable;
      } catch {
        reachable = false;
      }

      // Capture the host (with port, when present) so scaffold.ts's page.route()
      // fixture can also intercept this same URL at the browser network layer —
      // 'both' means route-intercept AND env-override both apply.
      const host = parsed.host;

      // A LOCAL host (localhost/127.0.0.1) that's reachable right now is
      // almost certainly the app's OWN live dev backend — nothing to mock
      // (Mock/Set 2 doesn't need it), but Generate (F-08) still needs its
      // real origin to route tierC-api requests correctly instead of
      // assuming same-origin with the frontend, so it's recorded distinctly
      // rather than suppressed. An unreachable local host (the classic
      // "backend isn't running" case) falls through to the same handling as
      // a real external host below, unchanged from today.
      if (LOCAL_HOSTS.has(parsed.hostname) && reachable) {
        addDep({
          id,
          category: 'local-backend',
          label: `Local backend API (${varName})`,
          source: 'env-var',
          envVar: varName,
          mockStrategy: 'undeterminable',
          hostnames: [host],
          file: f.rel,
          reachable,
          note: `Reads ${varName}=${value} (currently reachable local dev backend — route tierC-api requests here directly, no mock needed).`,
        });
        continue;
      }

      const category = classifyEnvUrlVar(varName, parsed);

      // Cluster F: also recognize a hostname from any OTHER .env* file's value for this
      // same var, in case the app's real running instance resolves it differently than
      // whichever file this detection pass read first (see readEnvVarAllValues) —
      // otherwise a request to that other hostname matches nothing and silently falls
      // through to the real network with no mock at all.
      const extraHosts = allValues
        .slice(1)
        .map((v) => parseHttpUrl(v)?.host)
        .filter((h): h is string => !!h && h !== host);

      addDep({
        id,
        category,
        label: `${category === 'auth' ? 'Auth/identity endpoint' : 'Backend API'} (${varName})`,
        source: 'env-var',
        envVar: varName,
        mockStrategy: 'both',
        hostnames: [host, ...extraHosts],
        file: f.rel,
        reachable,
        note: reachable
          ? `Reads ${varName}=${value} (currently reachable).${
              extraHosts.length
                ? ` Also recorded ${extraHosts.length} additional hostname(s) from other .env files for this var, to reduce runtime hostname mismatches.`
                : ''
            }`
          : `Reads ${varName}=${value}; not reachable at detection time.${
              extraHosts.length
                ? ` Also recorded ${extraHosts.length} additional hostname(s) from other .env files for this var, to reduce runtime hostname mismatches.`
                : ''
            }`,
      });
      // A non-empty, non-root path prefix (e.g. "/v2") means a relative call-site path
      // like "/auth/token/generate" won't equal the REAL request path
      // ("/v2/auth/token/generate") — recorded so the endpoint-attribution step below can
      // register both forms for this dependency.
      if (parsed.pathname && parsed.pathname !== '/') {
        basePathById.set(id, parsed.pathname.replace(/\/+$/, ''));
      }
    }
  }

  // Attach statically-detected (method, path) call sites. Ordinary endpoint-level detail
  // is only attached when exactly one mockable dependency exists — the common shape for a
  // frontend SPA (one backend, called from many service files). With MULTIPLE mockable
  // dependencies there is no reliable static signal for which endpoint belongs to which
  // host without deeper import-graph tracing, so ordinary endpoint-level detail is skipped
  // rather than risk misattributing it — those dependencies still get the coarser
  // dependency-level mock as before.
  //
  // Auth/login-shaped endpoints are the deliberate exception: they're few, highly
  // distinctive, and a mis-attributed one is inert (the generated fixture matches by exact
  // (method, path), so a token body registered on a host that never receives
  // "/auth/token/generate" is simply never served) — so they get per-endpoint attribution
  // regardless of how many mockable dependencies exist.
  const mockableDeps = deps.filter((d) => d.mockStrategy !== 'undeterminable');
  if (mockableDeps.length > 0) {
    const { endpoints, authEndpoints, truncated } = extractEndpointCallSites(files);

    const withPrefix = (dep: ExternalDependency, entries: EndpointMock[]): void => {
      addEndpoints(dep, entries);
      const prefix = basePathById.get(dep.id);
      if (prefix)
        addEndpoints(
          dep,
          entries.map((e) => ({ ...e, pathPattern: `${prefix}${e.pathPattern}` })),
        );
    };

    if (mockableDeps.length === 1) {
      const dep = mockableDeps[0];
      if (endpoints.length > 0) addEndpoints(dep, endpoints);
      withPrefix(dep, authEndpoints);
      if (truncated) {
        dep.note = `${dep.note ? `${dep.note} ` : ''}Endpoint list capped at ${MAX_ENDPOINTS_PER_DEP}; some call sites were not scanned.`;
      }
    } else if (authEndpoints.length > 0) {
      for (const dep of authTargets(mockableDeps)) {
        withPrefix(dep, authEndpoints);
        dep.note = `${dep.note ? `${dep.note} ` : ''}Login/token endpoint(s) attributed by path (${authEndpoints
          .map((e) => e.pathPattern)
          .join(', ')}); a mocked auth response is registered so login-dependent tests can succeed.`;
      }
    }
  }

  return deps;
}
