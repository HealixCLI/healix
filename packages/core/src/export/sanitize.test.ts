import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizeContent } from './sanitize.js';

/** A redacted line keeps its key but drops the secret value. */
const REDACTED = '<REDACTED>';

describe('sanitizeContent — secret redaction', () => {
  // An arbitrary suite directory used as the sanitization anchor. It must not
  // appear in the benign fixtures below so it cannot perturb those assertions.
  const suiteDir = path.join(os.tmpdir(), 'healix-sanitize-anchor');

  it('leaves token-free / lowercase assignments unchanged', () => {
    // 'RAPID' contains no secret token; 'capital'/'normal' are lowercase words.
    for (const line of ['RAPID=12', '  capital = 5', 'normal=hello']) {
      expect(sanitizeContent(line, suiteDir)).toBe(line);
    }
  });

  it('redacts an UPPERCASE KEY assignment', () => {
    const out = sanitizeContent('MY_API_KEY=secret123', suiteDir);
    expect(out).not.toContain('secret123');
    expect(out).toContain(REDACTED);
    // Key + separator are preserved; only the value is redacted.
    expect(out).toBe('MY_API_KEY=<REDACTED>');
  });

  it('redacts an UPPERCASE PASSWORD assignment', () => {
    const out = sanitizeContent('DB_PASSWORD=hunter2', suiteDir);
    expect(out).not.toContain('hunter2');
    expect(out).toBe('DB_PASSWORD=<REDACTED>');
  });

  it('redacts an exported TOKEN assignment', () => {
    const out = sanitizeContent('export AUTH_TOKEN=abc', suiteDir);
    expect(out).not.toContain('abc');
    expect(out).toBe('export AUTH_TOKEN=<REDACTED>');
  });

  it('redacts a sk_live_ provider key (16+ chars)', () => {
    const key = 'sk_live_51HxQ2zABCDEFGHIJKLMNOPqrstuvwxyz0123456789';
    const out = sanitizeContent(`const stripe = "${key}";`, suiteDir);
    expect(out).not.toContain(key);
    expect(out).toContain(REDACTED);
  });

  it('redacts an Authorization Bearer token', () => {
    const out = sanitizeContent('Authorization: Bearer abc123DEF456ghi789', suiteDir);
    expect(out).not.toContain('abc123DEF456ghi789');
    expect(out).toContain('Bearer <REDACTED>');
  });

  it('redacts secrets without touching benign lines in the same blob', () => {
    const blob = [
      'RAPID=12',
      '  capital = 5',
      'normal=hello',
      'MY_API_KEY=secret123',
      'DB_PASSWORD=hunter2',
      'export AUTH_TOKEN=abc',
    ].join('\n');

    const out = sanitizeContent(blob, suiteDir);
    const lines = out.split('\n');

    expect(lines[0]).toBe('RAPID=12');
    expect(lines[1]).toBe('  capital = 5');
    expect(lines[2]).toBe('normal=hello');
    expect(lines[3]).toBe('MY_API_KEY=<REDACTED>');
    expect(lines[4]).toBe('DB_PASSWORD=<REDACTED>');
    expect(lines[5]).toBe('export AUTH_TOKEN=<REDACTED>');

    expect(out).not.toContain('secret123');
    expect(out).not.toContain('hunter2');
  });
});

describe('sanitizeContent — path rewriting', () => {
  it('rewrites the absolute suite directory prefix to a placeholder', () => {
    const suiteDir = path.join(os.tmpdir(), 'healix-suite-abc123');
    const filePath = path.join(suiteDir, 'tests', 'login.spec.ts');
    const out = sanitizeContent(`import "${filePath}";`, suiteDir);

    expect(out).not.toContain(suiteDir);
    // The suite dir collapses to the relative placeholder '.', leaving the
    // sub-path intact, e.g. "./tests/login.spec.ts" (OS separators).
    expect(out).toContain(`.${path.sep}tests`);
  });

  it('rewrites the home directory prefix to <HOME>', () => {
    const home = os.homedir();
    // Use a suite dir outside $HOME so the two replacements do not overlap.
    const suiteDir = path.join(os.tmpdir(), 'healix-suite-outside-home');
    const docPath = path.join(home, 'Documents', 'notes.md');
    const out = sanitizeContent(`see ${docPath}`, suiteDir);

    expect(out).not.toContain(home);
    expect(out).toContain('<HOME>');
  });
});
