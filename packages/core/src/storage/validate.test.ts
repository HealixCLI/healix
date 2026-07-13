import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getStore, isValidBaseUrl, resetStoreForTests, validateNewProject } from '@healix/core';
import type { HealixStore } from '@healix/core';

/**
 * The "a project is not empty" invariant. validateNewProject is the single
 * source of truth; HealixStore.createProject enforces it so the desktop IPC path
 * and the CLI `project add` command are both guarded. These tests cover the pure
 * validator, the URL-format helper, and the store-level guard end-to-end.
 */

describe('isValidBaseUrl', () => {
  it('accepts absolute http(s) URLs with a host', () => {
    expect(isValidBaseUrl('https://app.acme.test')).toBe(true);
    expect(isValidBaseUrl('http://localhost:3000')).toBe(true);
    expect(isValidBaseUrl('https://app.acme.test/some/path?q=1')).toBe(true);
    expect(isValidBaseUrl('  https://app.acme.test  ')).toBe(true); // trims
  });

  it('rejects non-http(s) schemes, hostless, and non-URL strings', () => {
    expect(isValidBaseUrl('')).toBe(false);
    expect(isValidBaseUrl('app.acme.test')).toBe(false); // no scheme
    expect(isValidBaseUrl('ftp://files.acme.test')).toBe(false);
    expect(isValidBaseUrl('file:///etc/passwd')).toBe(false);
    expect(isValidBaseUrl('javascript:alert(1)')).toBe(false);
    expect(isValidBaseUrl('http://')).toBe(false); // no host
    expect(isValidBaseUrl('not a url')).toBe(false);
  });
});

describe('validateNewProject', () => {
  it('requires a non-blank name', () => {
    const r = validateNewProject({ name: '   ', baseUrl: 'https://acme.test' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/name is required/i);
  });

  it('rejects a project with neither a repo path nor a base URL (the empty-project bug)', () => {
    const r = validateNewProject({ name: 'Acme' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/repo path or a base URL/i);
  });

  it('treats whitespace-only repo/URL as absent', () => {
    const r = validateNewProject({ name: 'Acme', repoPath: '   ', baseUrl: '  ' });
    expect(r.ok).toBe(false);
  });

  it('accepts a repo-only project (no URL needed)', () => {
    const r = validateNewProject({ name: 'Acme', repoPath: '/Users/me/code/acme' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toMatchObject({
      name: 'Acme',
      repoPath: '/Users/me/code/acme',
      baseUrl: null,
      mode: 'playwright',
    });
  });

  it('accepts a URL-only project and normalizes (trims) all fields', () => {
    const r = validateNewProject({ name: '  Acme  ', baseUrl: '  https://app.acme.test  ' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toMatchObject({
      name: 'Acme',
      repoPath: null,
      baseUrl: 'https://app.acme.test',
    });
  });

  it('rejects a malformed base URL even when a repo is also given', () => {
    const r = validateNewProject({ name: 'Acme', repoPath: '/code/acme', baseUrl: 'not-a-url' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/valid http\(s\) URL/i);
  });

  it('preserves an explicit mode', () => {
    const r = validateNewProject({ name: 'Acme', baseUrl: 'https://acme.test', mode: 'selenium' });
    expect(r.ok && r.value.mode).toBe('selenium');
  });
});

// ---- store-level guard (end-to-end through createProject) -------------------

describe('HealixStore.createProject enforces the invariant', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'healix-validate-test-'));
    process.env.HEALIX_DATA_DIR = dataDir;
    resetStoreForTests();
  });

  afterEach(() => {
    resetStoreForTests();
    delete process.env.HEALIX_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function store(): Promise<HealixStore> {
    const s = await getStore();
    expect(s, 'getStore() returned null — node:sqlite unavailable').not.toBeNull();
    return s as HealixStore;
  }

  it('throws (and persists nothing) for an empty project', async () => {
    const s = await store();
    expect(() => s.createProject({ name: 'Empty' })).toThrow(/repo path or a base URL/i);
    expect(s.listProjects()).toHaveLength(0);
  });

  it('throws for a malformed base URL', async () => {
    const s = await store();
    expect(() => s.createProject({ name: 'Bad URL', baseUrl: 'nope' })).toThrow(/valid http\(s\) URL/i);
    expect(s.listProjects()).toHaveLength(0);
  });

  it('persists a valid project with a normalized base URL', async () => {
    const s = await store();
    const p = s.createProject({ name: '  Acme  ', baseUrl: '  https://app.acme.test  ' });
    expect(p.name).toBe('Acme');
    expect(p.baseUrl).toBe('https://app.acme.test');
    expect(s.listProjects()).toHaveLength(1);
  });
});
