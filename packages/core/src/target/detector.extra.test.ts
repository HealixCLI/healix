import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detect } from './detector.js';

/** Temp dirs created during the suite, removed in afterEach. */
const tempDirs: string[] = [];

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-detector-extra-'));
  tempDirs.push(dir);
  return dir;
}

function writeJson(dir: string, name: string, value: unknown): void {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2), 'utf-8');
}

function writeFile(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content, 'utf-8');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('detect (backend frameworks & non-JS markers)', () => {
  it('detects a Fastify API as backend with a sensible default port (3000)', async () => {
    const dir = makeRepo();
    writeJson(dir, 'package.json', {
      name: 'fastify-api',
      scripts: {
        // `start` is a recognized start script; its body has no explicit port,
        // so the framework default (3000) is used.
        start: 'node server.js',
        dev: 'fastify start -w app.js',
      },
      dependencies: { fastify: '^4.28.0' },
    });
    // No lockfile and no packageManager field -> falls back to npm because a
    // package.json exists.

    const result = await detect(dir);

    expect(result.framework).toBe('fastify');
    expect(result.kind).toBe('backend');
    expect(result.packageManager).toBe('npm');
    // START_SCRIPTS prefers `dev` over `start`.
    expect(result.startCommand).toBe('npm run dev');
    expect(result.port).toBe(3000);
    expect(result.baseUrl).toBe('http://localhost:3000');
  });

  it('detects an Express + React repo as fullstack (frontend dep + backend dep)', async () => {
    const dir = makeRepo();
    writeJson(dir, 'package.json', {
      name: 'express-react-app',
      scripts: { start: 'node server.js' },
      // express (backend) + react (frontend) with no bundler -> inferFramework
      // returns 'express' (backend branch), but frameworkToKind upgrades the
      // pairing of a frontend dep with a backend dep to 'fullstack'.
      dependencies: { express: '^4.19.2', react: '^18.3.1', 'react-dom': '^18.3.1' },
    });
    writeFile(dir, 'package-lock.json', '{}\n');

    const result = await detect(dir);

    expect(result.framework).toBe('express');
    expect(result.kind).toBe('fullstack');
    expect(result.packageManager).toBe('npm');
    expect(result.startCommand).toBe('npm run start');
    expect(result.port).toBe(3000);
    expect(result.baseUrl).toBe('http://localhost:3000');
  });

  it('detects a Go module (go.mod only, no package.json) as backend on port 8080', async () => {
    const dir = makeRepo();
    // The only signal is a go.mod marker file the detector supports.
    writeFile(dir, 'go.mod', 'module example.com/app\n\ngo 1.22\n');

    const result = await detect(dir);

    expect(result.framework).toBe('go');
    expect(result.kind).toBe('backend');
    // No package.json and no lockfile -> no package manager / start command.
    expect(result.packageManager).toBeNull();
    expect(result.startCommand).toBeNull();
    // A recognized framework still yields its default port/baseUrl.
    expect(result.port).toBe(8080);
    expect(result.baseUrl).toBe('http://localhost:8080');
  });

  it('gracefully yields kind "unknown" for an unsupported marker (requirements.txt only)', async () => {
    const dir = makeRepo();
    // requirements.txt alone is NOT a supported marker (only manage.py implies
    // django). With no package.json the detector recognizes nothing.
    writeFile(dir, 'requirements.txt', 'flask==3.0.0\n');

    const result = await detect(dir);

    expect(result.kind).toBe('unknown');
    expect(result.framework).toBeNull();
    expect(result.packageManager).toBeNull();
    expect(result.startCommand).toBeNull();
    expect(result.port).toBeNull();
    expect(result.baseUrl).toBeNull();
  });
});

describe('detect (monorepo workspace fallback)', () => {
  /** Root package.json that yields NO framework and NO start command. */
  function writeWorkspaceRoot(dir: string, extra: Record<string, unknown> = {}): void {
    writeJson(dir, 'package.json', {
      name: 'demo-monorepo',
      private: true,
      ...extra,
    });
  }

  function writeNextApp(dir: string, rel: string, name: string, devScript = 'next dev'): void {
    const appDir = path.join(dir, rel);
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, 'package.json'),
      JSON.stringify(
        {
          name,
          scripts: { dev: devScript, build: 'next build' },
          dependencies: { next: '^14.2.0', react: '^18.3.1', 'react-dom': '^18.3.1' },
        },
        null,
        2,
      ),
      'utf-8',
    );
  }

  it('pnpm workspaces: uses the first apps/* child and a pnpm --filter start command', async () => {
    const dir = makeRepo();
    writeWorkspaceRoot(dir);
    writeFile(dir, 'pnpm-workspace.yaml', 'packages:\n  - apps/*\n');
    writeFile(dir, 'pnpm-lock.yaml', 'lockfileVersion: "9.0"\n');
    writeNextApp(dir, 'apps/web', '@demo/web');

    const result = await detect(dir);

    expect(result.framework).toBe('next');
    expect(result.kind).toBe('fullstack');
    expect(result.packageManager).toBe('pnpm');
    expect(result.startCommand).toBe('pnpm --filter @demo/web dev');
    expect(result.port).toBe(3000);
    expect(result.baseUrl).toBe('http://localhost:3000');
    // The chosen subdir is surfaced in the detection notes.
    expect(result.notes?.some((n) => n.includes('apps/web'))).toBe(true);
  });

  it('npm workspaces: uses `npm run dev --workspace <name>`', async () => {
    const dir = makeRepo();
    writeWorkspaceRoot(dir, { workspaces: ['apps/*'] });
    writeFile(dir, 'package-lock.json', '{}\n');
    writeNextApp(dir, 'apps/web', '@demo/web');

    const result = await detect(dir);

    expect(result.framework).toBe('next');
    expect(result.packageManager).toBe('npm');
    expect(result.startCommand).toBe('npm run dev --workspace @demo/web');
  });

  it('yarn workspaces: uses `yarn workspace <name> dev`', async () => {
    const dir = makeRepo();
    writeWorkspaceRoot(dir, { workspaces: ['apps/*'] });
    writeFile(dir, 'yarn.lock', '# yarn lockfile v1\n');
    writeNextApp(dir, 'apps/web', '@demo/web');

    const result = await detect(dir);

    expect(result.startCommand).toBe('yarn workspace @demo/web dev');
  });

  it('no workspace declaration: falls back to `cd <dir> && <pm> run dev`', async () => {
    const dir = makeRepo();
    // Root package.json but NO workspaces field and NO pnpm-workspace.yaml —
    // the PM-native workspace invocation would not resolve the child, so the
    // detector must emit the location-independent cd form instead.
    writeWorkspaceRoot(dir);
    writeNextApp(dir, 'apps/web', '@demo/web');

    const result = await detect(dir);

    expect(result.framework).toBe('next');
    expect(result.startCommand).toBe('cd apps/web && npm run dev');
    expect(result.notes?.some((n) => n.includes('apps/web'))).toBe(true);
  });

  it('skips non-launchable siblings and picks the first child with framework + dev script', async () => {
    const dir = makeRepo();
    writeWorkspaceRoot(dir);
    writeFile(dir, 'pnpm-workspace.yaml', 'packages:\n  - apps/*\n');
    writeFile(dir, 'pnpm-lock.yaml', 'lockfileVersion: "9.0"\n');
    // apps/api sorts FIRST but has no start script -> must be skipped.
    const apiDir = path.join(dir, 'apps/api');
    fs.mkdirSync(apiDir, { recursive: true });
    fs.writeFileSync(
      path.join(apiDir, 'package.json'),
      JSON.stringify({
        name: '@demo/api',
        scripts: { test: 'vitest' },
        dependencies: { express: '^4.19.2' },
      }),
      'utf-8',
    );
    writeNextApp(dir, 'apps/web', '@demo/web');

    const result = await detect(dir);

    expect(result.framework).toBe('next');
    expect(result.startCommand).toBe('pnpm --filter @demo/web dev');
    expect(result.notes?.some((n) => n.includes('apps/web'))).toBe(true);
  });

  it('does NOT scan workspaces when the root itself is launchable', async () => {
    const dir = makeRepo();
    writeJson(dir, 'package.json', {
      name: 'root-app',
      scripts: { dev: 'vite' },
      devDependencies: { vite: '^5.4.0' },
    });
    writeFile(dir, 'pnpm-lock.yaml', 'lockfileVersion: "9.0"\n');
    writeNextApp(dir, 'apps/web', '@demo/web');

    const result = await detect(dir);

    // The root's own detection wins; the workspace app is never consulted.
    expect(result.framework).toBe('vite');
    expect(result.startCommand).toBe('pnpm dev');
    expect(result.port).toBe(5173);
  });
});

describe('detect (env files, next -p, docker hints)', () => {
  it('honors .env.local over .env for the PORT (first hit wins)', async () => {
    const dir = makeRepo();
    writeJson(dir, 'package.json', {
      name: 'express-api',
      scripts: { dev: 'node server.js' },
      dependencies: { express: '^4.19.2' },
    });
    writeFile(dir, 'package-lock.json', '{}\n');
    writeFile(dir, '.env', 'PORT=4222\n');
    writeFile(dir, '.env.local', 'PORT=4111\n');

    const result = await detect(dir);

    expect(result.port).toBe(4111);
    expect(result.baseUrl).toBe('http://localhost:4111');
  });

  it('reads .env.development when .env.local is absent', async () => {
    const dir = makeRepo();
    writeJson(dir, 'package.json', {
      name: 'express-api',
      scripts: { dev: 'node server.js' },
      dependencies: { express: '^4.19.2' },
    });
    writeFile(dir, 'package-lock.json', '{}\n');
    writeFile(dir, '.env', 'PORT=4222\n');
    writeFile(dir, '.env.development', 'PORT=4333\n');

    const result = await detect(dir);

    expect(result.port).toBe(4333);
  });

  it('honors the bare -p flag for next ("next dev -p 4000")', async () => {
    const dir = makeRepo();
    writeJson(dir, 'package.json', {
      name: 'next-app',
      scripts: { dev: 'next dev -p 4000' },
      dependencies: { next: '^14.2.0', react: '^18.3.1', 'react-dom': '^18.3.1' },
    });
    writeFile(dir, 'package-lock.json', '{}\n');

    const result = await detect(dir);

    expect(result.framework).toBe('next');
    expect(result.port).toBe(4000);
    expect(result.baseUrl).toBe('http://localhost:4000');
  });

  it('surfaces a docker-compose hint (and the missing start command) for a compose-only Go repo', async () => {
    const dir = makeRepo();
    writeFile(dir, 'go.mod', 'module example.com/app\n\ngo 1.22\n');
    writeFile(dir, 'docker-compose.yml', 'services:\n  app:\n    build: .\n');

    const result = await detect(dir);

    // Framework detected, but nothing launchable — startCommand stays null and
    // BOTH gaps are spelled out in the notes. No docker launch is attempted.
    expect(result.framework).toBe('go');
    expect(result.startCommand).toBeNull();
    expect(result.notes?.some((n) => /no start command could be derived/i.test(n))).toBe(true);
    expect(
      result.notes?.some((n) => n.includes('"docker compose up" project — auto-launch not supported yet.')),
    ).toBe(true);
  });

  it('surfaces a Dockerfile hint when only a Dockerfile is present', async () => {
    const dir = makeRepo();
    writeFile(dir, 'go.mod', 'module example.com/app\n\ngo 1.22\n');
    writeFile(dir, 'Dockerfile', 'FROM golang:1.22\n');

    const result = await detect(dir);

    expect(result.startCommand).toBeNull();
    expect(result.notes?.some((n) => /dockerfile present/i.test(n))).toBe(true);
  });
});
