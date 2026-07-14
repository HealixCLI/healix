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
