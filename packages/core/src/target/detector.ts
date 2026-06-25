import fs from 'node:fs';
import path from 'node:path';
import type { DetectedProject, ProjectKind } from './types.js';

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const RUN_PREFIX: Record<PackageManager, string> = {
  npm: 'npm run',
  pnpm: 'pnpm',
  yarn: 'yarn',
  bun: 'bun run',
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
  const field = (pkg as { packageManager?: string } | null)?.packageManager;
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
  if (pkg && (deps.dotenv || pkg.scripts?.start || fileExists(repoPath, 'server.js') || fileExists(repoPath, 'index.js'))) {
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
  const hasFrontendDep = !!(deps.react || deps['react-dom'] || deps.vue || deps.svelte || deps['@angular/core'] || deps.vite);
  const hasBackendDep = !!(deps.express || deps.fastify || deps.koa || deps['@nestjs/core'] || deps['@nestjs/common']);
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
const DEV_PORT_BINARIES = /\b(?:vite|webpack-dev-server)\b/;

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

function readEnvPort(repoPath: string): number | null {
  const envPath = path.join(repoPath, '.env');
  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    return null;
  }
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*(?:PORT|APP_PORT)\s*=\s*['"]?(\d{2,5})['"]?\s*$/);
    if (m && m[1]) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
    }
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
  // 2. A framework-known config / .env PORT.
  const envPort = readEnvPort(repoPath);
  if (envPort !== null) return envPort;

  // 3. Framework default.
  return defaultPort(framework);
}

/**
 * Detect framework / package manager / start command / port for a repo.
 * Fully defensive: a missing package.json yields kind 'unknown' but we still
 * attempt marker-file framework inference (e.g. python/go/java backends).
 */
export async function detect(repoPath: string): Promise<DetectedProject> {
  const pkg = readPackageJson(repoPath);
  const pm = detectPackageManager(repoPath, pkg);
  const framework = inferFramework(repoPath, pkg);
  const deps = mergedDeps(pkg);
  const kind = frameworkToKind(framework, deps);

  const { command: startCommand, scriptName } = detectStartCommand(pkg, pm);

  // Only assign a port/baseUrl when we have something runnable or a recognized
  // framework; an entirely unknown repo with no package.json gets nulls.
  let port: number | null = null;
  let baseUrl: string | null = null;
  if (framework !== null || startCommand !== null || pkg !== null) {
    port = detectPort(repoPath, pkg, framework, scriptName);
    baseUrl = `http://localhost:${port}`;
  }

  return {
    kind,
    framework,
    packageManager: pm,
    startCommand,
    port,
    baseUrl,
  };
}
