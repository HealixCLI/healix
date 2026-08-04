/**
 * Unit tests for createBrowserSurface().start()'s missing-browser self-heal wiring:
 * on a `chromium.launch()` failure that looks like a missing Playwright browser
 * binary, it should install once (ensurePlaywrightBrowsersInstalled) and retry the
 * launch — exactly once, never looping, and never touching install for an
 * unrelated failure. Nothing here exercises a real browser; `playwright` and
 * `./ensure-browsers.js` are both mocked so this only proves the RETRY WIRING
 * itself, independent of real browser/install behavior (covered separately by
 * ensure-browsers.test.ts and a real, non-mocked repro run manually).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const launchMock = vi.fn();
vi.mock('playwright', () => ({
  chromium: { launch: (...args: unknown[]) => launchMock(...args) },
}));

const looksLikeMissingBrowserMock = vi.fn();
const ensurePlaywrightBrowsersInstalledMock = vi.fn();
vi.mock('./ensure-browsers.js', () => ({
  looksLikeMissingBrowser: (...args: unknown[]) => looksLikeMissingBrowserMock(...args),
  ensurePlaywrightBrowsersInstalled: (...args: unknown[]) => ensurePlaywrightBrowsersInstalledMock(...args),
}));

import { captureNetworkEvent, createBrowserSurface, truncateBody, truncateXmlBody } from './index.js';
import type { Response } from 'playwright';

function fakeBrowser() {
  const page = { on: vi.fn() };
  const context = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { browser, context, page };
}

describe('createBrowserSurface().start() — missing-browser self-heal wiring', () => {
  beforeEach(() => {
    launchMock.mockReset();
    looksLikeMissingBrowserMock.mockReset();
    ensurePlaywrightBrowsersInstalledMock.mockReset();
  });

  it('launches normally on the first try when nothing is missing (install never attempted)', async () => {
    const { browser } = fakeBrowser();
    launchMock.mockResolvedValueOnce(browser);

    const surface = createBrowserSurface();
    await surface.start({ headless: true });

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(ensurePlaywrightBrowsersInstalledMock).not.toHaveBeenCalled();
  });

  it('self-heals: on a missing-browser error, installs once and retries the launch, which then succeeds', async () => {
    const { browser } = fakeBrowser();
    const err = new Error("Executable doesn't exist");
    launchMock.mockRejectedValueOnce(err).mockResolvedValueOnce(browser);
    looksLikeMissingBrowserMock.mockReturnValue(true);
    ensurePlaywrightBrowsersInstalledMock.mockResolvedValue(true);

    const surface = createBrowserSurface();
    await surface.start({ headless: true });

    expect(launchMock).toHaveBeenCalledTimes(2);
    expect(ensurePlaywrightBrowsersInstalledMock).toHaveBeenCalledTimes(1);
  });

  it('does not attempt install/retry for an unrelated launch failure, and rethrows it as-is', async () => {
    const err = new Error('some other launch failure');
    launchMock.mockRejectedValueOnce(err);
    looksLikeMissingBrowserMock.mockReturnValue(false);

    const surface = createBrowserSurface();
    await expect(surface.start({ headless: true })).rejects.toThrow('some other launch failure');

    expect(ensurePlaywrightBrowsersInstalledMock).not.toHaveBeenCalled();
    expect(launchMock).toHaveBeenCalledTimes(1);
  });

  it('rethrows the ORIGINAL error (not a generic one), and does not retry the launch, when the install itself fails', async () => {
    const err = new Error("Executable doesn't exist");
    launchMock.mockRejectedValueOnce(err);
    looksLikeMissingBrowserMock.mockReturnValue(true);
    ensurePlaywrightBrowsersInstalledMock.mockResolvedValue(false);

    const surface = createBrowserSurface();
    await expect(surface.start({ headless: true })).rejects.toBe(err);

    expect(launchMock).toHaveBeenCalledTimes(1);
  });
});

describe('truncateBody() — JSON-aware structural truncation (GAP-063)', () => {
  it('returns short bodies (JSON or not) unchanged, with no reformatting', () => {
    expect(truncateBody('short')).toBe('short');
    expect(truncateBody('{"a":1}')).toBe('{"a":1}');
  });

  it('caps a top-level JSON array to its first 5 elements while staying valid JSON', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: i, note: 'x'.repeat(30) }));
    const body = JSON.stringify(items);
    expect(body.length).toBeGreaterThan(400);

    const result = truncateBody(body);

    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(5);
    expect(parsed[0]).toEqual(items[0]);
  });

  it('caps a nested array (e.g. { entity: [...] }) recursively, not just the root', () => {
    const entity = Array.from({ length: 30 }, (_, i) => ({ id: i, description: 'coupon '.repeat(10) }));
    const body = JSON.stringify({ entity, pageDetails: { total: 30 } });

    const result = truncateBody(body);
    const parsed = JSON.parse(result);

    expect(parsed.entity).toHaveLength(5);
    expect(parsed.pageDetails).toEqual({ total: 30 });
  });

  it('cuts a long string field at its first sentence boundary, leaving the rest of the object intact', () => {
    const longDescription =
      'This is the first sentence. This is a much longer second sentence that goes on and on. '.repeat(5);
    const body = JSON.stringify({ id: 1, description: longDescription, status: 'active' });
    expect(body.length).toBeGreaterThan(400);

    const result = truncateBody(body);
    const parsed = JSON.parse(result);

    expect(parsed.description).toBe('This is the first sentence.');
    expect(parsed.id).toBe(1);
    expect(parsed.status).toBe('active');
  });

  it('hard-cuts with an ellipsis, staying valid JSON, when a long string has no sentence boundary', () => {
    const noSentenceBoundary = 'a'.repeat(500);
    const body = JSON.stringify({ blob: noSentenceBoundary });

    const result = truncateBody(body);
    const parsed = JSON.parse(result);

    expect(parsed.blob.endsWith('…')).toBe(true);
    expect(parsed.blob.length).toBeLessThan(noSentenceBoundary.length);
  });

  it('falls back to a plain char-slice for a non-JSON body over the cap (HTML/plaintext/XML — unchanged behavior)', () => {
    const html = `<div>${'x'.repeat(500)}</div>`;

    const result = truncateBody(html);

    expect(result).toBe(`${html.slice(0, 400)}…`);
    expect(() => JSON.parse(result)).toThrow();
  });
});

/** Balanced-tag well-formedness check for test assertions — every non-self-closing
 * open tag has a matching close tag, in matching order. */
function isWellFormedXml(xml: string): boolean {
  const stack: string[] = [];
  const tokenRe = /<\/?([a-zA-Z_][\w:.-]*)[^>]*?(\/)?>/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(xml)) !== null) {
    const [full, tag, selfClosing] = match;
    if (selfClosing) continue;
    if (full.startsWith('</')) {
      if (stack.pop() !== tag) return false;
    } else {
      stack.push(tag);
    }
  }
  return stack.length === 0;
}

describe('truncateXmlBody() / truncateBody() with XML content-type — structural XML truncation (GAP-069)', () => {
  it('returns a well-formed XML body under the cap unchanged', () => {
    const xml = '<root><a>1</a><b>2</b></root>';
    expect(truncateBody(xml, 'application/xml')).toBe(xml);
    expect(truncateXmlBody(xml)).toBe(xml);
  });

  it('leaves a run of 5-or-fewer repeated sibling elements unchanged in structure', () => {
    const items = Array.from({ length: 5 }, (_, i) => `<item>value ${i} ${'pad'.repeat(30)}</item>`).join('');
    const xml = `<items>${items}</items>`;
    expect(xml.length).toBeGreaterThan(400);

    const result = truncateBody(xml, 'text/xml');

    expect(isWellFormedXml(result)).toBe(true);
    expect((result.match(/<item>/g) ?? []).length).toBe(5);
  });

  it('caps a run of many repeated sibling elements to the first 5, staying well-formed', () => {
    const items = Array.from({ length: 200 }, (_, i) => `<item><id>${i}</id></item>`).join('');
    const xml = `<items>${items}</items>`;

    const result = truncateBody(xml, 'application/soap+xml');

    expect(isWellFormedXml(result)).toBe(true);
    expect((result.match(/<item>/g) ?? []).length).toBe(5);
    expect(result).toContain('<id>0</id>');
    expect(result).not.toContain('<id>5</id>');
  });

  it('caps repeated siblings at every nesting level, not just the root', () => {
    const inner = (n: number) => Array.from({ length: n }, (_, i) => `<row><cell>${i}</cell></row>`).join('');
    const xml = `<table><section>${inner(20)}</section><section>${inner(20)}</section></table>`;

    const result = truncateXmlBody(xml);

    expect(isWellFormedXml(result)).toBe(true);
    expect((result.match(/<section>/g) ?? []).length).toBe(2);
    expect((result.match(/<row>/g) ?? []).length).toBe(10);
  });

  it('cuts a long text node at its first sentence boundary while staying well-formed', () => {
    const longText =
      'This is the first sentence. This is a much longer second sentence that goes on and on. '.repeat(5);
    const xml = `<note><description>${longText}</description><status>active</status></note>`;

    const result = truncateXmlBody(xml);

    expect(isWellFormedXml(result)).toBe(true);
    expect(result).toContain('<description>This is the first sentence.</description>');
    expect(result).toContain('<status>active</status>');
  });

  it('hard-cuts a long text node with an ellipsis, staying well-formed, when no sentence boundary exists', () => {
    const noSentenceBoundary = 'a'.repeat(500);
    const xml = `<blob>${noSentenceBoundary}</blob>`;

    const result = truncateXmlBody(xml);

    expect(isWellFormedXml(result)).toBe(true);
    expect(result).toMatch(/<blob>a+…<\/blob>/);
    expect(result.length).toBeLessThan(xml.length);
  });

  it('falls back to a flat char-slice for a malformed (mismatched-tag) body', () => {
    const malformed = `<a>${'x'.repeat(500)}</b>`;

    const result = truncateXmlBody(malformed);

    expect(result).toBe(`${malformed.slice(0, 400)}…`);
  });

  it('does not route a non-XML content-type through XML truncation (HTML unchanged behavior)', () => {
    const html = `<div>${'x'.repeat(500)}</div>`;

    const result = truncateBody(html, 'text/html');

    expect(result).toBe(`${html.slice(0, 400)}…`);
  });

  it('does not route a missing content-type through XML truncation', () => {
    const xml = `<items>${Array.from({ length: 200 }, (_, i) => `<item>${i}</item>`).join('')}</items>`;

    const result = truncateBody(xml);

    expect(result).toBe(`${xml.slice(0, 400)}…`);
  });
});

describe('captureNetworkEvent() — content-type capture (GAP-063 follow-up)', () => {
  function fakeResponse(opts: {
    text: string;
    contentType?: string;
    method?: string;
    url?: string;
    status?: number;
  }): Response {
    return {
      request: () => ({
        method: () => opts.method ?? 'GET',
        url: () => opts.url ?? 'https://a.test/api/thing',
        postData: () => undefined,
      }),
      status: () => opts.status ?? 200,
      text: async () => opts.text,
      headers: () => (opts.contentType ? { 'content-type': opts.contentType } : {}),
    } as unknown as Response;
  }

  it('captures the response content-type header onto the event', async () => {
    const response = fakeResponse({ text: '{"ok":true}', contentType: 'application/json; charset=utf-8' });

    const event = await captureNetworkEvent(response);

    expect(event.contentType).toBe('application/json; charset=utf-8');
  });

  it('omits contentType when the header is absent, without throwing', async () => {
    const response = fakeResponse({ text: '{"ok":true}' });

    const event = await captureNetworkEvent(response);

    expect(event.contentType).toBeUndefined();
  });

  it('uses the captured content-type to route an over-cap response body through XML truncation (GAP-069)', async () => {
    const items = Array.from({ length: 50 }, (_, i) => `<item>${i}</item>`).join('');
    const xml = `<items>${items}</items>`;
    const response = fakeResponse({ text: xml, contentType: 'application/soap+xml; charset=utf-8' });

    const event = await captureNetworkEvent(response);

    expect(event.responseBody).toBeDefined();
    expect(isWellFormedXml(event.responseBody as string)).toBe(true);
    expect((event.responseBody?.match(/<item>/g) ?? []).length).toBe(5);
  });
});
