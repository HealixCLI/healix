import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isTextFile, sanitizeContent } from './sanitize.js';

/** Placeholder the sanitizer substitutes for a redacted secret value. */
const REDACTED = '<REDACTED>';

describe('sanitizeContent — JSON / JS-object secret redaction', () => {
  // An arbitrary suite anchor that must not appear in the fixtures so it cannot
  // perturb these assertions. The path is irrelevant to secret redaction.
  const suiteDir = path.join(os.tmpdir(), 'healix-sanitize-json-anchor');

  it('redacts a quoted "apiKey" value while keeping the key', () => {
    const out = sanitizeContent('"apiKey": "abc123"', suiteDir);
    expect(out).not.toContain('abc123');
    expect(out).toBe('"apiKey": "<REDACTED>"');
  });

  it('redacts a quoted "authToken" value with no whitespace around the colon', () => {
    const out = sanitizeContent('"authToken":"xyz"', suiteDir);
    expect(out).not.toContain('xyz');
    expect(out).toBe('"authToken":"<REDACTED>"');
  });

  it('leaves a non-secret "name" pair untouched', () => {
    const line = '"name": "value"';
    expect(sanitizeContent(line, suiteDir)).toBe(line);
  });

  it('redacts secret pairs but preserves a benign pair in the same object', () => {
    const blob = [
      '{',
      '  "name": "value",',
      '  "apiKey": "abc123",',
      '  "authToken":"xyz"',
      '}',
    ].join('\n');

    const out = sanitizeContent(blob, suiteDir);
    const lines = out.split('\n');

    expect(lines[1]).toBe('  "name": "value",');
    expect(lines[2]).toBe(`  "apiKey": "${REDACTED}",`);
    expect(lines[3]).toBe(`  "authToken":"${REDACTED}"`);

    expect(out).not.toContain('abc123');
    expect(out).not.toContain('xyz');
    // The benign value survives intact.
    expect(out).toContain('"value"');
  });
});

describe('sanitizeContent — Anthropic key shape', () => {
  const suiteDir = path.join(os.tmpdir(), 'healix-sanitize-ant-anchor');

  it('redacts an sk-ant- prefixed key embedded in code', () => {
    const key = 'sk-ant-XXXXXXXX';
    const out = sanitizeContent(`const client = "${key}";`, suiteDir);
    expect(out).not.toContain(key);
    expect(out).toContain(REDACTED);
    // Surrounding code is preserved; only the key is replaced.
    expect(out).toBe(`const client = "${REDACTED}";`);
  });

  it('redacts a longer realistic sk-ant- key', () => {
    const key = 'sk-ant-api03_AbCdEf012345-_GhIjKl6789MnOpQr';
    const out = sanitizeContent(`ANTHROPIC=${key}`, suiteDir);
    expect(out).not.toContain(key);
    expect(out).toContain(REDACTED);
  });
});

describe('isTextFile', () => {
  it('returns true for known text extensions', () => {
    for (const file of ['a.ts', 'config.json', 'README.md', 'script.js']) {
      expect(isTextFile(file)).toBe(true);
    }
  });

  it('returns false for binary extensions', () => {
    for (const file of ['logo.png', 'archive.zip', 'blob.bin']) {
      expect(isTextFile(file)).toBe(false);
    }
  });

  it('is case-insensitive on the extension', () => {
    expect(isTextFile('NOTES.MD')).toBe(true);
    expect(isTextFile('IMAGE.PNG')).toBe(false);
  });
});
