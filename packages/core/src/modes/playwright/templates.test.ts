import { describe, expect, it } from 'vitest';
import { playwrightConfigContents } from './templates.js';

describe('playwrightConfigContents — artifact capture policy', () => {
  it('records a screenshot AND video for every test, pass or fail', () => {
    const cfg = playwrightConfigContents();
    // 'on' (not 'only-on-failure' / 'retain-on-failure') is load-bearing: the
    // run detail's media gallery must have something to show for EVERY UI test.
    expect(cfg).toContain("screenshot: 'on'");
    expect(cfg).toContain("video: 'on'");
    expect(cfg).toContain("trace: 'retain-on-failure'");
  });

  it('declares the json/html/list reporters that produce results.json and playwright-report/', () => {
    const cfg = playwrightConfigContents();
    expect(cfg).toContain("['json', { outputFile: 'results.json' }]");
    expect(cfg).toContain("['html', { open: 'never' }]");
    expect(cfg).toContain("['list']");
  });

  it('honors HEALIX_BASE_URL over any baked-in base URL', () => {
    expect(playwrightConfigContents({ baseUrl: 'http://example.test' })).toContain(
      'process.env.HEALIX_BASE_URL || "http://example.test"',
    );
    expect(playwrightConfigContents()).toContain("process.env.HEALIX_BASE_URL || 'http://localhost:3000'");
  });

  it('enables retries locally so flaky detection can trigger (overridable via HEALIX_RETRIES)', () => {
    const cfg = playwrightConfigContents();
    // Local default must be non-zero (1) or a fail-then-pass can never register
    // as flaky; CI gets 2; HEALIX_RETRIES overrides both.
    expect(cfg).toContain('process.env.HEALIX_RETRIES');
    expect(cfg).toContain('process.env.CI ? 2 : 1');
  });
});
