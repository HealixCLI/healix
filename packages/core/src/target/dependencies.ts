import fs from 'node:fs';
import path from 'node:path';
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

/** Env files consulted for a var's value, in precedence order (mirrors detector.ts's ENV_FILES). */
const ENV_FILES = ['.env.local', '.env.development', '.env'];

function readEnvVar(repoPath: string, varName: string): string | null {
  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*${escaped}\\s*=\\s*['"]?([^'"\\r\\n]*)['"]?\\s*$`, 'm');
  for (const file of ENV_FILES) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(repoPath, file), 'utf-8');
    } catch {
      continue;
    }
    const m = content.match(re);
    if (m && m[1] && m[1].trim().length > 0) return m[1].trim();
  }
  return null;
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
function classifyEnvUrlVar(varName: string): ExternalDependencyCategory {
  return /AUTH|COGNITO|LOGIN|SSO|OAUTH|IDENTITY/i.test(varName) ? 'auth' : 'backend';
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
 */
const CALL_SITE_RE =
  /\b[\w$]+\.(get|post|put|patch|delete|head|options)\(\s*(?:`([^`]*)`|'([^']*)'|"([^"]*)")/gi;

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

/** Collapse a template-literal interpolation (`${id}`) to a `:param` placeholder so
 * `/reward/${id}` and `/reward/${x}` collapse to the same pattern. Exported so other
 * ground-truth sources (e.g. EXPLORE's captured network traffic, see
 * `browser/network-capture.ts`) normalize endpoint paths the same way this static
 * scan does, keeping both sides comparable. */
export function normalizeEndpointPath(raw: string): string {
  return raw.replace(/\$\{[^}]*\}/g, ':param');
}

/** Best-effort (method, path) call-site scan across every source file. Capped and deduped. */
function extractEndpointCallSites(files: WalkFile[]): { endpoints: EndpointMock[]; truncated: boolean } {
  const seen = new Set<string>();
  const endpoints: EndpointMock[] = [];
  let truncated = false;

  const tryAdd = (method: string | undefined, raw: string | undefined): boolean => {
    if (!method || raw === undefined || !raw.startsWith('/')) return false;
    const pathPattern = normalizeEndpointPath(raw);
    const key = `${method.toUpperCase()} ${pathPattern}`;
    if (seen.has(key)) return false;
    seen.add(key);
    endpoints.push({ method: method.toUpperCase(), pathPattern });
    return true;
  };

  outer: for (const f of files) {
    const source = readSafe(f.abs);
    if (!source) continue;

    for (const m of source.matchAll(CALL_SITE_RE)) {
      tryAdd(m[1], m[2] ?? m[3] ?? m[4]);
      if (endpoints.length >= MAX_ENDPOINTS_PER_DEP) {
        truncated = true;
        break outer;
      }
    }
    for (const m of source.matchAll(CONFIG_CALL_RE)) {
      const inner = m[1] ?? '';
      const method = CONFIG_METHOD_RE.exec(inner)?.[1];
      const urlMatch = CONFIG_URL_RE.exec(inner);
      tryAdd(method, urlMatch?.[1] ?? urlMatch?.[2] ?? urlMatch?.[3]);
      if (endpoints.length >= MAX_ENDPOINTS_PER_DEP) {
        truncated = true;
        break outer;
      }
    }
  }

  return { endpoints, truncated };
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
  const seenIds = new Set<string>();

  const addDep = (dep: ExternalDependency): void => {
    if (seenIds.has(dep.id)) return;
    seenIds.add(dep.id);
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
      if (!host || LOCAL_HOSTS.has(host)) continue;
      const known = findKnownProviderForHost(host);
      const id = known ? `pkg:${known.packageNames[0]}` : `url:${host}`;
      if (seenIds.has(id)) continue;

      const line = lineAround(source, m.index ?? 0);
      // A namespace attribute (xmlns="http://www.w3.org/2000/svg") is never a
      // network call — the single most common false positive in JSX/SVG code.
      if (/\bxmlns/i.test(line)) continue;

      if (known) {
        if (!known.mockable) continue; // already recorded (or will be) via the package-based pass
        addDep({
          id,
          category: known.category,
          label: known.label,
          source: 'url-literal',
          hostnames: known.hostnames,
          mockStrategy: 'route-intercept',
          file: f.rel,
        });
      } else {
        // An unrecognized host is only worth flagging when it's plausibly a
        // network call (fetch/axios/etc. on the same line) — otherwise it's
        // just a string constant (a support link, an asset URL) that isn't a
        // dependency the app talks to over the network at runtime.
        if (!NETWORK_CALL_MARKER_RE.test(line)) continue;
        addDep({
          id,
          category: 'other',
          label: `Third-party API at ${host}`,
          source: 'url-literal',
          hostnames: [host],
          mockStrategy: 'route-intercept',
          file: f.rel,
        });
      }
    }

    for (const m of source.matchAll(ENV_VAR_REF_RE)) {
      const varName = m[1] ?? m[2];
      if (!varName) continue;
      const id = `env:${varName}`;
      if (seenIds.has(id)) continue;
      // A redirect/callback URL is the app's OWN endpoint that a provider (an
      // OAuth/SSO identity provider, typically) redirects the browser BACK
      // to — the app never calls out to it, so it isn't an outbound
      // dependency and there is nothing to mock.
      if (/REDIRECT|CALLBACK/i.test(varName)) continue;

      const value = readEnvVar(root, varName);
      if (!value) continue;
      const parsed = parseHttpUrl(value);
      if (!parsed) continue;

      let reachable = false;
      try {
        reachable = (await probeUrl(value, 2_000)).reachable;
      } catch {
        reachable = false;
      }

      // A LOCAL host (localhost/127.0.0.1) is almost certainly the app's OWN
      // dev backend — only worth flagging when it's actually down right now
      // (the classic "backend isn't running" case); a live local server has
      // nothing to mock. A REAL external host (third-party or a remote/QA
      // backend) is flagged regardless of current reachability: mocking it is
      // about deterministic, offline test runs, not just "is it down".
      if (LOCAL_HOSTS.has(parsed.hostname) && reachable) continue;

      // Capture the host (with port, when present) so scaffold.ts's page.route()
      // fixture can also intercept this same URL at the browser network layer —
      // 'both' means route-intercept AND env-override both apply.
      const host = parsed.host;
      const category = classifyEnvUrlVar(varName);

      addDep({
        id,
        category,
        label: `${category === 'auth' ? 'Auth/identity endpoint' : 'Backend API'} (${varName})`,
        source: 'env-var',
        envVar: varName,
        mockStrategy: 'both',
        hostnames: [host],
        file: f.rel,
        reachable,
        note: reachable
          ? `Reads ${varName}=${value} (currently reachable).`
          : `Reads ${varName}=${value}; not reachable at detection time.`,
      });
    }
  }

  // Attach statically-detected (method, path) call sites to whichever single
  // mockable dependency exists — the common shape for a frontend SPA (one
  // backend, called from many service files). With MULTIPLE mockable
  // dependencies there is no reliable static signal for which endpoint
  // belongs to which host without deeper import-graph tracing, so endpoint-
  // level detail is skipped rather than risk misattributing it — those
  // dependencies still get the coarser dependency-level mock as before.
  const mockableDeps = deps.filter((d) => d.mockStrategy !== 'undeterminable');
  if (mockableDeps.length === 1) {
    const { endpoints, truncated } = extractEndpointCallSites(files);
    if (endpoints.length > 0) {
      const dep = mockableDeps[0];
      dep.endpoints = endpoints;
      if (truncated) {
        dep.note = `${dep.note ? `${dep.note} ` : ''}Endpoint list capped at ${MAX_ENDPOINTS_PER_DEP}; some call sites were not scanned.`;
      }
    }
  }

  return deps;
}
