import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TestModeContext } from '../types.js';
import type { ExternalDependency, MockResponse } from '../../target/types.js';
import { scaffold } from './scaffold.js';

describe('scaffold — mock fixture generation', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'healix-scaffold-test-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<TestModeContext> = {}): TestModeContext {
    return {
      projectDir,
      baseUrl: 'http://localhost:3000',
      provider: {} as TestModeContext['provider'],
      target: {} as TestModeContext['target'],
      browser: {} as TestModeContext['browser'],
      ...overrides,
    };
  }

  async function fixtureExists(): Promise<boolean> {
    try {
      await stat(join(projectDir, 'fixtures', 'mock.fixture.ts'));
      return true;
    } catch {
      return false;
    }
  }

  it('does not write a mock fixture when mocking is disabled', async () => {
    await scaffold(makeCtx());
    expect(await fixtureExists()).toBe(false);
  });

  it('writes an empty-routes mock fixture when mocking is enabled but nothing is route-interceptable', async () => {
    await scaffold(makeCtx({ mockExternalDependencies: true }));
    expect(await fixtureExists()).toBe(true);
    const contents = await readFile(join(projectDir, 'fixtures', 'mock.fixture.ts'), 'utf-8');
    expect(contents).toContain('const MOCKED_ROUTES = []');
  });

  it('embeds route-intercept/both dependencies with resolved responses', async () => {
    const deps: ExternalDependency[] = [
      {
        id: 'pkg:stripe',
        category: 'payment',
        label: 'Stripe (payments)',
        source: 'package',
        mockStrategy: 'route-intercept',
        hostnames: ['api.stripe.com'],
      },
      {
        id: 'pkg:nodemailer',
        category: 'email',
        label: 'Nodemailer (SMTP email)',
        source: 'package',
        mockStrategy: 'undeterminable',
      },
    ];
    const mockResponses: Record<string, MockResponse> = {
      'pkg:stripe': { status: 200, body: { status: 'succeeded' } },
    };

    await scaffold(makeCtx({ mockExternalDependencies: true, externalDependencies: deps, mockResponses }));
    const contents = await readFile(join(projectDir, 'fixtures', 'mock.fixture.ts'), 'utf-8');
    expect(contents).toContain('"id": "pkg:stripe"');
    expect(contents).toContain('"api.stripe.com"');
    // The undeterminable dependency (no route-intercept strategy) must not appear.
    expect(contents).not.toContain('pkg:nodemailer');
  });
});
