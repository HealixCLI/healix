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
