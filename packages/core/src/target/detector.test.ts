import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detect } from './detector.js';

/** Temp dirs created during the suite, removed in afterEach. */
const tempDirs: string[] = [];

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-detector-'));
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

describe('detect', () => {
  it('detects a Vite React app (port 5173, frontend, pnpm)', async () => {
    const dir = makeRepo();
    writeJson(dir, 'package.json', {
      name: 'vite-react-app',
      scripts: {
        dev: 'vite',
        build: 'vite build',
        preview: 'vite preview',
      },
      dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
      devDependencies: { vite: '^5.4.0' },
    });
    writeFile(dir, 'pnpm-lock.yaml', 'lockfileVersion: "9.0"\n');

    const result = await detect(dir);

    expect(result.framework).toBe('vite-react');
    expect(result.kind).toBe('frontend');
    expect(result.packageManager).toBe('pnpm');
    expect(result.startCommand).toBe('pnpm dev');
    expect(result.port).toBe(5173);
    expect(result.baseUrl).toBe('http://localhost:5173');
  });

  it('detects a Next.js app (fullstack, port 3000, npm)', async () => {
    const dir = makeRepo();
    writeJson(dir, 'package.json', {
      name: 'next-app',
      scripts: {
        dev: 'next dev',
        build: 'next build',
        start: 'next start',
      },
      dependencies: { next: '^14.2.0', react: '^18.3.1', 'react-dom': '^18.3.1' },
    });
    writeFile(dir, 'package-lock.json', '{}\n');

    const result = await detect(dir);

    expect(result.framework).toBe('next');
    expect(result.kind).toBe('fullstack');
    expect(result.packageManager).toBe('npm');
    expect(result.startCommand).toBe('npm run dev');
    expect(result.port).toBe(3000);
    expect(result.baseUrl).toBe('http://localhost:3000');
  });

  it('detects a plain Node/Express API (backend, port 3000, yarn)', async () => {
    const dir = makeRepo();
    writeJson(dir, 'package.json', {
      name: 'express-api',
      scripts: {
        start: 'node server.js',
        dev: 'nodemon server.js',
      },
      dependencies: { express: '^4.19.2' },
    });
    writeFile(dir, 'yarn.lock', '# yarn lockfile v1\n');
    writeFile(dir, 'server.js', 'require("express")();\n');

    const result = await detect(dir);

    expect(result.framework).toBe('express');
    expect(result.kind).toBe('backend');
    expect(result.packageManager).toBe('yarn');
    expect(result.startCommand).toBe('yarn dev');
    expect(result.port).toBe(3000);
    expect(result.baseUrl).toBe('http://localhost:3000');
  });

  it('returns kind "unknown" with nulls for a repo with NO package.json', async () => {
    const dir = makeRepo();
    // intentionally empty: no package.json, no lockfile, no markers.

    const result = await detect(dir);

    expect(result.kind).toBe('unknown');
    expect(result.framework).toBeNull();
    expect(result.packageManager).toBeNull();
    expect(result.startCommand).toBeNull();
    expect(result.port).toBeNull();
    expect(result.baseUrl).toBeNull();
  });

  it('does NOT let a "preview --port 9999" script override the selected dev port (regression)', async () => {
    const dir = makeRepo();
    writeJson(dir, 'package.json', {
      name: 'vite-react-app',
      scripts: {
        // dev is the SELECTED start script and has no explicit port -> framework default 5173.
        dev: 'vite',
        // preview carries a --port that must NOT leak into the dev port.
        preview: 'vite preview --port 9999',
        build: 'vite build',
      },
      dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
      devDependencies: { vite: '^5.4.0' },
    });
    writeFile(dir, 'pnpm-lock.yaml', 'lockfileVersion: "9.0"\n');

    const result = await detect(dir);

    // dev is chosen over preview, and its body has no port, so the framework
    // default (5173) wins — NOT the 9999 from the preview script.
    expect(result.startCommand).toBe('pnpm dev');
    expect(result.port).toBe(5173);
    expect(result.port).not.toBe(9999);
    expect(result.baseUrl).toBe('http://localhost:5173');
  });

  it('reads an explicit --port from the selected dev script', async () => {
    const dir = makeRepo();
    writeJson(dir, 'package.json', {
      name: 'vite-react-app',
      scripts: { dev: 'vite --port 4321' },
      dependencies: { react: '^18.3.1' },
      devDependencies: { vite: '^5.4.0' },
    });
    writeFile(dir, 'pnpm-lock.yaml', 'lockfileVersion: "9.0"\n');

    const result = await detect(dir);

    expect(result.port).toBe(4321);
    expect(result.baseUrl).toBe('http://localhost:4321');
  });

  it('honors a PORT in .env over the framework default for an Express API', async () => {
    const dir = makeRepo();
    writeJson(dir, 'package.json', {
      name: 'express-api',
      scripts: { dev: 'node server.js' },
      dependencies: { express: '^4.19.2' },
    });
    writeFile(dir, 'package-lock.json', '{}\n');
    writeFile(dir, '.env', 'PORT=4545\n');

    const result = await detect(dir);

    expect(result.framework).toBe('express');
    expect(result.port).toBe(4545);
    expect(result.baseUrl).toBe('http://localhost:4545');
  });
});
