import fs from 'node:fs';
import path from 'node:path';
import type { DetectedProject, ProjectKind } from './types.js';

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  /** npm/yarn/bun workspace globs — presence alone marks a monorepo root. */
  workspaces?: unknown;
  packageManager?: string;
}

const RUN_PREFIX: Record<PackageManager, string> = {
  npm: 'npm run',
  pnpm: 'pnpm',
  yarn: 'yarn',
  bun: 'bun run',
};

/** The install invocation for each package manager. */
const PM_INSTALL: Record<PackageManager, string> = {
  npm: 'npm install',
  pnpm: 'pnpm install',
  yarn: 'yarn install',
  bun: 'bun install',
};

/** Lockfile -> package manager, checked in priority order. */
const LOCKFILES: Array<{ file: string; pm: PackageManager }> = [
  { file: 'pnpm-lock.yaml', pm: 'pnpm' },
  { file: 'bun.lockb', pm: 'bun' },
  { file: 'bun.lock', pm: 'bun' },
  { file: 'yarn.lock', pm: 'yarn' },
  { file: 'package-lock.json', pm: 'npm' },
  { file: 'npm-shrinkwrap.json', pm: 'npm' },
];

/** Scripts we treat as a dev/start entry point, in preference order. */
const START_SCRIPTS = ['dev', 'start', 'serve', 'start:dev', 'develop', 'preview'];

function readPackageJson(repoPath: string): PackageJson | null {
  const pkgPath = path.join(repoPath, 'package.json');
  try {
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as PackageJson;
    }
  } catch {
    /* missing or unparseable — treated as no package.json */
  }
  return null;
}

function detectPackageManager(repoPath: string, pkg: PackageJson | null): PackageManager | null {
  for (const { file, pm } of LOCKFILES) {
    try {
      if (fs.existsSync(path.join(repoPath, file))) return pm;
    } catch {
      /* ignore fs errors and keep checking */
    }
  }
  // No lockfile: infer from packageManager field if present, else default to
  // npm when a package.json exists at all.
  const field = pkg?.packageManager;
  if (typeof field === 'string') {
    if (field.startsWith('pnpm')) return 'pnpm';
    if (field.startsWith('yarn')) return 'yarn';
    if (field.startsWith('bun')) return 'bun';
    if (field.startsWith('npm')) return 'npm';
  }
  return pkg ? 'npm' : null;
}

function mergedDeps(pkg: PackageJson | null): Record<string, string> {
  return {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  };
}

function fileExists(repoPath: string, rel: string): boolean {
  try {
    return fs.existsSync(path.join(repoPath, rel));
  } catch {
    return false;
  }
}

/**
 * Infer a framework label from dependencies + on-disk markers. Returns a stable
 * lowercase identifier or null when nothing recognizable is present.
 */
export function inferFramework(repoPath: string, pkg: PackageJson | null): string | null {
  const deps = mergedDeps(pkg);

  // Frontend / fullstack frameworks first (most specific wins).
  if (deps.next) return 'next';
  if (deps['@angular/core']) return 'angular';
  if (deps['@remix-run/react'] || deps['@remix-run/node']) return 'remix';
  if (deps['@sveltejs/kit']) return 'sveltekit';
  if (deps.svelte) return 'svelte';
  if (deps.nuxt) return 'nuxt';
  if (deps.vite && deps.vue) return 'vite-vue';
  if (deps.vite && (deps.react || deps['react-dom'])) return 'vite-react';
  if (deps.vite) return 'vite';
  if (deps['react-scripts']) return 'cra';
  if (deps.vue) return 'vue';

  // Backend frameworks.
  if (deps['@nestjs/core'] || deps['@nestjs/common']) return 'nest';
  if (deps.fastify) return 'fastify';
  if (deps.express) return 'express';
  if (deps.koa) return 'koa';
  if (deps['@hapi/hapi'] || deps.hapi) return 'hapi';

  // React present without a bundler -> assume CRA-style if react-scripts, else
  // a generic react app.
  if (deps.react || deps['react-dom']) return 'react';

  // Non-JS backends (best-effort by marker file).
  if (fileExists(repoPath, 'manage.py')) return 'django';
  if (fileExists(repoPath, 'pom.xml') || fileExists(repoPath, 'build.gradle')) return 'spring';
  if (fileExists(repoPath, 'go.mod')) return 'go';
  if (fileExists(repoPath, 'Cargo.toml')) return 'rust';
  if (fileExists(repoPath, 'Gemfile')) return 'rails';

  // Generic Node entry point.
  if (
    pkg &&
    (deps.dotenv ||
      pkg.scripts?.start ||
      fileExists(repoPath, 'server.js') ||
      fileExists(repoPath, 'index.js'))
  ) {
    return 'node';
  }

  return null;
}

function frameworkToKind(framework: string | null, deps: Record<string, string>): ProjectKind {
  if (!framework) return 'unknown';

  const fullstack = new Set(['next', 'nuxt', 'remix', 'sveltekit', 'django', 'rails']);
  const frontend = new Set(['angular', 'svelte', 'vite-vue', 'vite-react', 'vite', 'cra', 'vue', 'react']);
  const backend = new Set(['nest', 'fastify', 'express', 'koa', 'hapi', 'spring', 'go', 'rust', 'node']);

  if (fullstack.has(framework)) return 'fullstack';

  // A repo that pairs a frontend dep with a server dep is fullstack.
  const hasFrontendDep = !!(
    deps.react ||
    deps['react-dom'] ||
    deps.vue ||
    deps.svelte ||
    deps['@angular/core'] ||
    deps.vite
  );
  const hasBackendDep = !!(
    deps.express ||
    deps.fastify ||
    deps.koa ||
    deps['@nestjs/core'] ||
    deps['@nestjs/common']
  );
  if (hasFrontendDep && hasBackendDep) return 'fullstack';

  if (frontend.has(framework)) return 'frontend';
  if (backend.has(framework)) return 'backend';
  return 'unknown';
}

/** Default dev-server port for a recognized framework. */
function defaultPort(framework: string | null): number {
  switch (framework) {
    case 'next':
    case 'cra':
    case 'react':
    case 'remix':
    case 'rails':
      return 3000;
    case 'vite':
    case 'vite-react':
    case 'vite-vue':
    case 'svelte':
    case 'sveltekit':
      return 5173;
    case 'vue':
      return 8080;
    case 'nuxt':
      return 3000;
    case 'angular':
      return 4200;
    case 'express':
    case 'fastify':
    case 'koa':
    case 'hapi':
    case 'nest':
    case 'node':
      return 3000;
    case 'spring':
    case 'go':
      return 8080;
    case 'rust':
      return 8080;
    case 'django':
      return 8000;
    default:
      return 3000;
  }
}

/** Dev binaries whose bare `-p` flag unambiguously means "port". */
const DEV_PORT_BINARIES = /\b(?:vite|webpack-dev-server|next)\b/;

function toPort(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
  return null;
}

/**
 * Parse a port out of a script body. Prefers the unambiguous `--port 3001`,
 * `--port=3001`, and `PORT=3001` forms. The bare `-p 3001` form is only honored
 * for known dev binaries (vite / webpack-dev-server), where `-p` reliably means
 * port — for other tools `-p` is ambiguous (e.g. a path/project flag) and is
 * ignored. Returns the first valid port found.
 */
function parsePortFromScript(script: string): number | null {
  // Unambiguous forms first.
  const explicit = [/--port[=\s]+(\d{2,5})/, /(?:^|[\s=])PORT[=\s]+(\d{2,5})/];
  for (const re of explicit) {
    const port = toPort(script.match(re)?.[1]);
    if (port !== null) return port;
  }
  // Bare `-p` only for known dev binaries.
  if (DEV_PORT_BINARIES.test(script)) {
    const port = toPort(script.match(/(?:^|[\s=])-p[=\s]+(\d{2,5})/)?.[1]);
    if (port !== null) return port;
  }
  return null;
}

/**
 * Env files consulted for PORT/APP_PORT, in precedence order (first hit wins).
 * Mirrors the dotenv/Next.js convention where local overrides win over the
 * shared file: `.env.local` > `.env.development` > `.env`. A dev server that
 * loads these files will bind the same port we detect here.
 */
const ENV_FILES = ['.env.local', '.env.development', '.env'];

function readEnvPort(repoPath: string): number | null {
  for (const file of ENV_FILES) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(repoPath, file), 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*(?:PORT|APP_PORT)\s*=\s*['"]?(\d{2,5})['"]?\s*$/);
      if (m && m[1]) {
        const n = Number.parseInt(m[1], 10);
        if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
      }
    }
  }
  return null;
}

/** vite.config.* files, checked in the order Vite itself resolves them. */
const VITE_CONFIG_FILES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.mts',
  'vite.config.cjs',
];
const VITE_FRAMEWORKS = new Set(['vite', 'vite-react', 'vite-vue']);

/** Extract the balanced `{...}` block following `key:` in `source`, or null if not found. */
function extractBraceBlock(source: string, key: string): string | null {
  const keyRe = new RegExp(`\\b${key}\\s*:\\s*\\{`);
  const m = keyRe.exec(source);
  if (!m) return null;
  const start = m.index + m[0].length - 1; // position of the opening '{'
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Read an explicit `server.port` from the project's vite.config.*, when
 * present. Vite frequently hardcodes its dev-server port there (rather than
 * relying on Vite's 5173 default or reading `process.env.PORT`, which Vite
 * does not honor unless the config explicitly wires it) — without this,
 * relying on the generic framework-default guess makes launch() poll the
 * WRONG port and report a false "did not become reachable" failure even
 * though the app is actually running and healthy on its configured port.
 */
function detectVitePort(repoPath: string): number | null {
  for (const file of VITE_CONFIG_FILES) {
    let source: string;
    try {
      source = fs.readFileSync(path.join(repoPath, file), 'utf-8');
    } catch {
      continue;
    }
    const serverBlock = extractBraceBlock(source, 'server');
    if (!serverBlock) continue;
    const m = serverBlock.match(/\bport\s*:\s*(\d{2,5})\b/);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
  }
  return null;
}

/**
 * Pick the start command + the script we derived it from. Prefers dev-like
 * scripts. Returns null command when no package manager / scripts available.
 */
function detectStartCommand(
  pkg: PackageJson | null,
  pm: PackageManager | null,
): { command: string | null; scriptName: string | null } {
  if (!pkg?.scripts || !pm) return { command: null, scriptName: null };
  for (const name of START_SCRIPTS) {
    if (typeof pkg.scripts[name] === 'string' && pkg.scripts[name]) {
      return { command: `${RUN_PREFIX[pm]} ${name}`, scriptName: name };
    }
  }
  return { command: null, scriptName: null };
}

function detectPort(
  repoPath: string,
  pkg: PackageJson | null,
  framework: string | null,
  scriptName: string | null,
): number {
  // 1. Port declared in the body of the SELECTED start/dev script only. We must
  //    NOT scan every script: a `preview`/`test:e2e`/`build` script with its own
  //    `--port` would otherwise override the actual dev port and make launch()
  //    poll the wrong URL.
  if (scriptName && pkg?.scripts?.[scriptName]) {
    const fromScript = parsePortFromScript(pkg.scripts[scriptName]);
    if (fromScript !== null) return fromScript;
  }
  // 2. vite.config.*'s explicit server.port, for Vite-family frameworks —
  // takes priority over the generic .env/PORT convention below since Vite
  // does not read process.env.PORT unless the project's config explicitly
  // does so itself.
  if (framework && VITE_FRAMEWORKS.has(framework)) {
    const vitePort = detectVitePort(repoPath);
    if (vitePort !== null) return vitePort;
  }
  // 3. A framework-known config / .env PORT.
  const envPort = readEnvPort(repoPath);
  if (envPort !== null) return envPort;

  // 4. Framework default.
  return defaultPort(framework);
}

/**
 * First-level container dirs scanned for monorepo workspace apps, in priority
 * order — `apps/*` typically holds the runnable applications, `packages/*` the
 * libraries, so apps are scanned first.
 */
const WORKSPACE_CONTAINERS = ['apps', 'packages'];
/**
 * Upper bound on how many first-level workspace dirs we inspect in total. The
 * scan is a best-effort convenience, not an exhaustive search: a pathological
 * repo with hundreds of packages must not turn detect() into a crawl.
 */
const MAX_WORKSPACE_DIRS = 24;

/** A launchable app found under apps/* or packages/*. */
interface WorkspaceDetection {
  /** Relative dir from the repo root, POSIX-style (e.g. "apps/web"). */
  relDir: string;
  pkg: PackageJson;
  framework: string;
  scriptName: string;
  port: number;
}

/** True when the root declares a JS workspace layout (npm/yarn/bun field or pnpm-workspace.yaml). */
function hasWorkspaces(repoPath: string, rootPkg: PackageJson | null): boolean {
  if (rootPkg?.workspaces) return true;
  return fileExists(repoPath, 'pnpm-workspace.yaml');
}

/**
 * Scan first-level `apps/*` / `packages/*` dirs (bounded, sorted for
 * determinism) for the FIRST child package.json that has both a detectable
 * framework and a dev/start script. Returns null when nothing launchable is
 * found — the caller then falls back to the root-level detection as before.
 */
function scanWorkspaces(repoPath: string): WorkspaceDetection | null {
  let inspected = 0;
  for (const container of WORKSPACE_CONTAINERS) {
    const containerAbs = path.join(repoPath, container);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(containerAbs, { withFileTypes: true });
    } catch {
      continue; // container missing/unreadable — try the next one
    }
    // Stable order so two runs over the same repo always pick the same app.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (inspected >= MAX_WORKSPACE_DIRS) return null;
      inspected += 1;

      const childDir = path.join(containerAbs, entry.name);
      const childPkg = readPackageJson(childDir);
      if (!childPkg) continue;
      const framework = inferFramework(childDir, childPkg);
      if (!framework) continue;
      const scriptName =
        START_SCRIPTS.find((n) => typeof childPkg.scripts?.[n] === 'string' && childPkg.scripts[n]) ?? null;
      if (!scriptName) continue;

      // Port detection runs against the CHILD dir so its own script body /
      // .env files win, exactly as they would for a standalone checkout.
      const port = detectPort(childDir, childPkg, framework, scriptName);
      return { relDir: `${container}/${entry.name}`, pkg: childPkg, framework, scriptName, port };
    }
  }
  return null;
}

/** Start + install commands derived for a workspace app, and the dir installDir gates on. */
interface WorkspaceCommands {
  startCommand: string;
  installCommand: string;
  installDir: string;
}

/**
 * Build the start + install commands for a workspace app. When the root
 * declares a workspace layout AND has a known package manager AND the child
 * package is addressable by name, prefer the PM's native workspace invocation
 * (it runs from the repo root, which is where launch() spawns, and a root
 * install covers every workspace package). Anything less falls back to a
 * plain `cd <dir> && <pm> <script>` / `cd <dir> && <pm> install` pair that
 * works regardless of workspace wiring — this is also what a repo with NO
 * root package.json at all (each app manages its own deps independently)
 * needs. bun deliberately uses the cd fallback too — its workspace filtering
 * flags vary across versions.
 */
function workspaceCommands(
  repoPath: string,
  rootPkg: PackageJson | null,
  rootPm: PackageManager | null,
  ws: WorkspaceDetection,
): WorkspaceCommands {
  const name = typeof ws.pkg.name === 'string' && ws.pkg.name.trim().length > 0 ? ws.pkg.name.trim() : null;
  if (name && rootPm && hasWorkspaces(repoPath, rootPkg)) {
    const installCommand = PM_INSTALL[rootPm];
    switch (rootPm) {
      case 'pnpm':
        return { startCommand: `pnpm --filter ${name} ${ws.scriptName}`, installCommand, installDir: '.' };
      case 'yarn':
        return { startCommand: `yarn workspace ${name} ${ws.scriptName}`, installCommand, installDir: '.' };
      case 'npm':
        return {
          startCommand: `npm run ${ws.scriptName} --workspace ${name}`,
          installCommand,
          installDir: '.',
        };
      case 'bun':
        break; // fall through to the cd form
    }
  }
  const childPm = detectPackageManager(path.join(repoPath, ws.relDir), ws.pkg) ?? rootPm ?? 'npm';
  return {
    startCommand: `cd ${ws.relDir} && ${RUN_PREFIX[childPm]} ${ws.scriptName}`,
    installCommand: `cd ${ws.relDir} && ${PM_INSTALL[childPm]}`,
    installDir: ws.relDir,
  };
}

/** Compose files that mark a docker-first project (any one is enough). */
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/**
 * Detect framework / package manager / start command / port for a repo.
 * Fully defensive: a missing package.json yields kind 'unknown' but we still
 * attempt marker-file framework inference (e.g. python/go/java backends).
 *
 * Monorepo fallback: when the ROOT package.json yields neither a framework nor
 * a start command, the first launchable app under `apps/*` / `packages/*` is
 * used instead (its framework/port, with a workspace-aware start command), and
 * the chosen subdir is recorded in `notes`.
 */
export async function detect(repoPath: string): Promise<DetectedProject> {
  const pkg = readPackageJson(repoPath);
  const pm = detectPackageManager(repoPath, pkg);
  let framework = inferFramework(repoPath, pkg);
  let kind = frameworkToKind(framework, mergedDeps(pkg));
  const notes: string[] = [];

  let { command: startCommand, scriptName } = detectStartCommand(pkg, pm);

  // Only assign a port/baseUrl when we have something runnable or a recognized
  // framework; an entirely unknown repo with no package.json gets nulls.
  let port: number | null = null;
  let baseUrl: string | null = null;
  let installCommand: string | null = pm ? PM_INSTALL[pm] : null;
  let installDir: string | null = pm ? '.' : null;

  // Try the monorepo workspace scan whenever the ROOT gave us nothing
  // launchable — regardless of whether a marker-file framework guess (e.g.
  // "rust" from a root Cargo.toml alongside a Tauri/desktop app) was made.
  // A root-level marker file with no start command is strictly less useful
  // than an actual runnable app under apps/*/packages/*, so it must not
  // block the scan from ever running.
  if (startCommand === null) {
    const ws = scanWorkspaces(repoPath);
    if (ws) {
      framework = ws.framework;
      kind = frameworkToKind(ws.framework, mergedDeps(ws.pkg));
      scriptName = ws.scriptName;
      const commands = workspaceCommands(repoPath, pkg, pm, ws);
      startCommand = commands.startCommand;
      installCommand = commands.installCommand;
      installDir = commands.installDir;
      port = ws.port;
      baseUrl = `http://localhost:${port}`;
      notes.push(
        `Monorepo: using workspace app "${ws.relDir}"${typeof ws.pkg.name === 'string' && ws.pkg.name ? ` (${ws.pkg.name})` : ''}.`,
      );
    }
  }

  if (port === null && (framework !== null || startCommand !== null || pkg !== null)) {
    port = detectPort(repoPath, pkg, framework, scriptName);
    baseUrl = `http://localhost:${port}`;
  }

  // A recognized framework with NO derivable start command (Go/Django/Rails/
  // Spring/Rust, docker-only setups, ...): keep startCommand null, but say so
  // explicitly instead of leaving callers to infer the gap from a bare null.
  if (framework !== null && startCommand === null) {
    notes.push(
      `Framework "${framework}" detected but no start command could be derived — auto-launch is unavailable; start the app manually and set a base URL.`,
    );
  }

  // Docker presence hint. We NEVER attempt a docker launch; the note explains
  // why auto-launch is missing (or likely wrong) for container-first repos.
  if (COMPOSE_FILES.some((f) => fileExists(repoPath, f))) {
    notes.push('"docker compose up" project — auto-launch not supported yet.');
  } else if (fileExists(repoPath, 'Dockerfile')) {
    notes.push('Dockerfile present — containerized auto-launch not supported yet.');
  }

  return {
    kind,
    framework,
    packageManager: pm,
    startCommand,
    installCommand,
    installDir,
    port,
    baseUrl,
    ...(notes.length > 0 ? { notes } : {}),
  };
}
