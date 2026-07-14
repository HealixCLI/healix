/**
 * Project config (.healix/config.json): secret-free credential wiring.
 * Env precedence (explicit HEALIX_TIERB_* beats config), role→env indirection,
 * and relative login-URL resolution against the launched base URL.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readProjectConfig, resolveTierBEnv, type HealixProjectConfig } from './config.js';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'healix-config-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('readProjectConfig', () => {
  it('reads .healix/config.json and returns {} when absent or invalid', async () => {
    expect(await readProjectConfig(repo)).toEqual({});

    await mkdir(join(repo, '.healix'), { recursive: true });
    await writeFile(
      join(repo, '.healix', 'config.json'),
      JSON.stringify({
        auth: {
          loginUrl: '/login',
          roles: { default: { emailEnv: 'APP_QA_EMAIL', passwordEnv: 'APP_QA_PASSWORD' } },
        },
      }),
      'utf-8',
    );
    const cfg = await readProjectConfig(repo);
    expect(cfg.auth?.loginUrl).toBe('/login');
    expect(cfg.auth?.roles?.default?.emailEnv).toBe('APP_QA_EMAIL');

    await writeFile(join(repo, '.healix', 'config.json'), 'not json', 'utf-8');
    expect(await readProjectConfig(repo)).toEqual({});
  });
});

describe('resolveTierBEnv', () => {
  const config: HealixProjectConfig = {
    auth: {
      loginUrl: '/login',
      roles: { default: { emailEnv: 'APP_QA_EMAIL', passwordEnv: 'APP_QA_PASSWORD' } },
    },
  };

  it('resolves credentials through the config role env names and relative loginUrl against baseUrl', () => {
    const env = { APP_QA_EMAIL: 'qa@app.test', APP_QA_PASSWORD: 's3cret' } as NodeJS.ProcessEnv;
    const out = resolveTierBEnv(config, 'http://localhost:4173/', env);
    expect(out).toEqual({
      HEALIX_TIERB_EMAIL: 'qa@app.test',
      HEALIX_TIERB_PASSWORD: 's3cret',
      HEALIX_TIERB_LOGIN_URL: 'http://localhost:4173/login',
    });
  });

  it('explicit HEALIX_TIERB_* env always beats the config indirection', () => {
    const env = {
      APP_QA_EMAIL: 'config@app.test',
      HEALIX_TIERB_EMAIL: 'override@app.test',
      HEALIX_TIERB_PASSWORD: 'override-pass',
      HEALIX_TIERB_LOGIN_URL: 'http://other:9999/signin',
    } as NodeJS.ProcessEnv;
    const out = resolveTierBEnv(config, 'http://localhost:4173', env);
    expect(out.HEALIX_TIERB_EMAIL).toBe('override@app.test');
    expect(out.HEALIX_TIERB_PASSWORD).toBe('override-pass');
    expect(out.HEALIX_TIERB_LOGIN_URL).toBe('http://other:9999/signin');
  });

  it('returns only what is resolvable (no creds in env → no cred keys)', () => {
    const out = resolveTierBEnv(config, 'http://localhost:4173', {} as NodeJS.ProcessEnv);
    expect(out).toEqual({ HEALIX_TIERB_LOGIN_URL: 'http://localhost:4173/login' });
  });

  it('absolute config loginUrl passes through untouched; no baseUrl leaves relative URL unresolved', () => {
    const absCfg: HealixProjectConfig = { auth: { loginUrl: 'https://sso.corp.test/login' } };
    expect(
      resolveTierBEnv(absCfg, 'http://localhost:1', {} as NodeJS.ProcessEnv).HEALIX_TIERB_LOGIN_URL,
    ).toBe('https://sso.corp.test/login');
    const rel = resolveTierBEnv(config, null, {} as NodeJS.ProcessEnv);
    expect(rel.HEALIX_TIERB_LOGIN_URL).toBe('/login');
  });
});
