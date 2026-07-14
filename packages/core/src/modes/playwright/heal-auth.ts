import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TestModeContext } from '../types.js';
import { stripCodeFences } from './generate.js';
import { authSetupWithStepsContents } from './templates.js';

const HEAL_AUTH_TIMEOUT_MS = 180_000;

function emit(ctx: TestModeContext, message: string, data?: unknown): void {
  ctx.emit?.('heal', message, data);
}

/**
 * Validate model-proposed login STEPS before they are injected into the
 * trusted auth-setup wrapper. The steps run with the user's privileges, so the
 * gate is stricter than the spec gate: no module access of any kind, no
 * dynamic code, no process control — only driving `page` and reading the
 * wrapper-provided `email` / `password` / `loginUrl` constants.
 */
export function findForbiddenStepTokens(steps: string): string[] {
  const violations: string[] = [];
  if (/\bimport\b/.test(steps)) violations.push('import');
  if (/\brequire\s*\(/.test(steps)) violations.push('require(');
  if (/\beval\s*\(/.test(steps)) violations.push('eval(');
  if (/\bnew\s+Function\s*\(/.test(steps)) violations.push('new Function(');
  if (/\bchild_process\b/.test(steps)) violations.push('child_process');
  if (/\bprocess\s*\.\s*(?!env\b)/.test(steps)) violations.push('process.* (only process.env is allowed)');
  if (/\bfs\b\s*\./.test(steps)) violations.push('fs.*');
  if (/\bwriteFile|readFile|unlink|mkdir\b/.test(steps)) violations.push('filesystem API');
  if (!/\bpage\s*\.\s*\w+/.test(steps)) violations.push('no page.* action found');
  if (!/\bemail\b/.test(steps) || !/\bpassword\b/.test(steps)) {
    violations.push('steps must use the provided email/password constants');
  }
  return violations;
}

/**
 * Regenerate the login flow from a FRESH look at the live login page and
 * rewrite fixtures/auth.setup.ts. The model proposes only the login steps;
 * they are validated and injected into the trusted wrapper (which owns
 * imports, credential env reads, storageState and the sidecar meta). Returns
 * true when a repaired setup file was written.
 */
export async function repairAuthSetup(ctx: TestModeContext, error: string): Promise<boolean> {
  const loginUrl = ctx.extraEnv?.HEALIX_TIERB_LOGIN_URL ?? process.env.HEALIX_TIERB_LOGIN_URL ?? '';
  const baseUrl = (ctx.baseUrl ?? '').trim();
  const targetUrl = loginUrl || (baseUrl ? `${baseUrl.replace(/\/$/, '')}/login` : '');
  if (!targetUrl) {
    emit(ctx, 'Auth-setup heal skipped: no login URL to inspect.');
    return false;
  }

  // Fresh grounding: snapshot the LIVE login page right now (the run-start
  // snapshot may be of a different page, and the login UI may have changed —
  // that being the very reason the setup failed).
  let inventory = '';
  try {
    await ctx.browser.start({ headless: true, ...(baseUrl ? { baseUrl } : {}) });
    await ctx.browser.goto(targetUrl);
    const snap = await ctx.browser.snapshot();
    const lines = snap.interactiveElements
      .slice(0, 40)
      .map((el) => `- ${el.role} "${el.name.slice(0, 80)}" -> ${el.selector}`);
    inventory =
      lines.length > 0 ? `\nInteractive elements observed on ${snap.url}:\n${lines.join('\n')}` : '';
  } catch (err) {
    emit(ctx, `Auth-setup heal: login-page snapshot failed (continuing without): ${String(err)}`);
  } finally {
    await ctx.browser.stop().catch(() => undefined);
  }

  const boundedError = error.length > 3000 ? `${error.slice(0, 3000)}\n[...truncated]` : error;
  const prompt = `The automated LOGIN step of a Playwright test suite failed. Write the corrected login steps.

You are writing ONLY the body statements that go inside an async Playwright setup
function. Already in scope (do NOT redeclare): \`page\` (a Playwright Page), and the
constants \`email\`, \`password\`, \`loginUrl\` (strings; loginUrl is ${targetUrl || 'the login page'}).

Output ONLY the JavaScript statements. No markdown, no code fences, no imports, no
function wrapper, no comments about what you are doing.

Rules:
- Start by navigating: await page.goto(loginUrl);
- Fill the real email and password fields using the observed selectors below; use the
  \`email\` and \`password\` constants as values.
- Submit the form and wait for the post-login navigation/response to settle.
- Do NOT read or write files, import anything, use eval, or touch process (process.env excepted).
- Do NOT call page.context().storageState() — the wrapper does that after your steps.

Login failure being repaired:
"""
${boundedError}
"""${inventory}`;

  let text = '';
  try {
    const res = await ctx.provider.complete(prompt, {
      timeoutMs: HEAL_AUTH_TIMEOUT_MS,
      readOnly: true,
      signal: ctx.signal,
    });
    if (!res.ok) {
      emit(ctx, `Auth-setup heal provider error: ${res.detail}`);
      return false;
    }
    text = res.text;
  } catch (err) {
    emit(ctx, `Auth-setup heal threw: ${String(err)}`);
    return false;
  }

  const steps = stripCodeFences(text);
  if (!steps) {
    emit(ctx, 'Auth-setup heal produced no steps.');
    return false;
  }
  const violations = findForbiddenStepTokens(steps);
  if (violations.length > 0) {
    emit(ctx, `Auth-setup heal rejected (forbidden tokens): ${violations.join('; ')}`, { violations });
    return false;
  }

  await writeFile(
    join(ctx.projectDir, 'fixtures', 'auth.setup.ts'),
    authSetupWithStepsContents(steps),
    'utf-8',
  );
  emit(ctx, 'Auth-setup heal: rewrote fixtures/auth.setup.ts from the live login page.');
  return true;
}
