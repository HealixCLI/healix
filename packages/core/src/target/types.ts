export type ProjectKind = 'frontend' | 'backend' | 'fullstack' | 'unknown';

export interface DetectedProject {
  kind: ProjectKind;
  framework: string | null;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | null;
  startCommand: string | null;
  /**
   * Shell command that installs dependencies for the app startCommand will
   * launch (e.g. "npm install", or "cd apps/web && npm install" for a
   * workspace app resolved via the cd fallback). Null exactly when no package
   * manager could be determined. Run (if needed — see installDir) before
   * startCommand by launch().
   */
  installCommand: string | null;
  /**
   * Dir, relative to repoPath, whose node_modules indicates dependencies are
   * already installed ("." for the repo root). Null exactly when
   * installCommand is null.
   */
  installDir: string | null;
  port: number | null;
  baseUrl: string | null;
  /**
   * Human-readable detection notes for surfacing in UIs/logs — e.g. which
   * monorepo workspace the detection came from, or a "docker compose up"
   * project hint when no start command could be derived. Present only when
   * there is something worth saying; never load-bearing for launch().
   */
  notes?: string[];
}

export interface RepoIndex {
  root: string;
  files: string[];
  /** Short natural-language summary of the repo for AI context. */
  summary: string;
}

export interface LaunchHandle {
  baseUrl: string;
  pid: number | null;
  stop(): Promise<void>;
}

export interface LaunchOptions {
  repoPath?: string;
  startCommand?: string;
  /** Shell command that installs dependencies; run before startCommand when installDir's node_modules is missing. */
  installCommand?: string;
  /** Dir, relative to repoPath, whose node_modules gates whether installCommand runs. Defaults to "." (repoPath itself). */
  installDir?: string;
  baseUrl?: string;
  port?: number;
  readyTimeoutMs?: number;
  installTimeoutMs?: number;
  env?: Record<string, string>;
}

export interface UrlProbe {
  reachable: boolean;
  status?: number;
}

/** White-box (repo) and black-box (URL) access to the app under test. */
export interface TargetAdapter {
  detect(repoPath: string): Promise<DetectedProject>;
  indexRepo(repoPath: string, opts?: { maxFiles?: number }): Promise<RepoIndex>;
  launch(opts: LaunchOptions): Promise<LaunchHandle>;
  probeUrl(url: string, timeoutMs?: number): Promise<UrlProbe>;
}

/** Broad kind of external dependency, used to pick a plausible canned mock response. */
export type ExternalDependencyCategory = 'sms' | 'email' | 'payment' | 'auth' | 'otp' | 'backend' | 'other';

/** How a dependency was discovered. */
export type ExternalDependencySource = 'package' | 'url-literal' | 'env-var';

/**
 * How Healix can mock a given dependency:
 *  - 'route-intercept': browser-visible (frontend fetch/XHR or a client-side SDK) —
 *    handled entirely inside a Playwright fixture via page.route(), no server needed.
 *  - 'env-override': server-side call whose base URL the app reads from an env var
 *    Healix can safely rewrite before launch, redirecting it to the local mock server.
 *  - 'both': browser-visible AND env-override capable (e.g. the app's own backend
 *    API base URL, read by the frontend and overridable at launch time).
 *  - 'undeterminable': detected, but neither mechanism applies (e.g. SMTP-based
 *    email, or a server-side SDK with no discoverable base-URL override) — reported
 *    to the user, not silently mocked.
 */
export type MockStrategy = 'route-intercept' | 'env-override' | 'both' | 'undeterminable';

export interface ExternalDependency {
  /** Stable identity for de-duplication and mock-response lookups. */
  id: string;
  category: ExternalDependencyCategory;
  /** Human-readable label for reports/CLI output. */
  label: string;
  source: ExternalDependencySource;
  mockStrategy: MockStrategy;
  /** Matched npm package name, when detected via package.json/import. */
  packageName?: string;
  /** Hostnames this dependency is reachable at — used to build page.route() matchers. */
  hostnames?: string[];
  /** Env var Healix can override to redirect this dependency to the mock server. */
  envVar?: string;
  /** Source file the dependency was detected in, when applicable. */
  file?: string;
  /** For category 'backend': whether the resolved URL was reachable at detection time. */
  reachable?: boolean;
  /** Human-readable explanation, e.g. why a dependency is undeterminable. */
  note?: string;
  /**
   * Distinct (method, path) call sites statically found for this dependency's
   * client, e.g. a call like `apiClient.get('/customer_lookup')`. `pathPattern`
   * normalizes template-literal interpolations (`` `/reward/${id}` ``) to a
   * `:param` placeholder so a real request's path can still match it. Present
   * only when at least one literal call site could be extracted — a dependency
   * with none of these still gets the single dependency-level MockResponse as
   * a fallback (see mock-responses.ts / mock-server.ts).
   */
  endpoints?: EndpointMock[];
}

/** One statically-detected (method, path) call site for an ExternalDependency's client. */
export interface EndpointMock {
  method: string;
  pathPattern: string;
  response?: MockResponse;
}

/** A canned response Healix serves in place of a real call to an ExternalDependency. */
export interface MockResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

/** One intercepted request, recorded for the run report. */
export interface MockRequestRecord {
  method: string;
  url: string;
  dependencyId: string;
  at: string;
}

/** Handle for the local mock HTTP server started for 'env-override'/'both' dependencies. */
export interface MockServerHandle {
  baseUrl: string;
  stop(): Promise<void>;
  requestLog: MockRequestRecord[];
}
