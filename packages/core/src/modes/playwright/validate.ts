import { writeFile, mkdir, rename } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import type { GeneratedSpec, QuarantinedSpec, TestModeContext, ValidationResult } from '../types.js';
import { hasExpect, looksLikePlaywrightSpec, MOCK_FIXTURE_IMPORT_PATH } from './generate.js';
import { ensureSuiteDeps, runCommand } from './execute.js';

const LIST_TIMEOUT_MS = 60_000;

/**
 * Same intent as orchestrator's looksLikeMissingDeps (not imported directly —
 * that module imports this mode, so importing back would be circular):
 * launch/parse output that indicates the suite's own node_modules aren't
 * installed, rather than a genuine syntax defect in the generated spec.
 */
function looksLikeMissingDeps(text: string): boolean {
  return /Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|node_modules/i.test(
    text,
  );
}

/**
 * Bracket/paren/brace + unterminated-string/template-literal repair.
 *
 * WHY: generate.ts's gates (looksLikePlaywrightSpec, hasExpect, the
 * forbidden-API deny-list) are all regex/string heuristics over TEXT that
 * happens to be syntactically valid — they never parse the TypeScript, so a
 * spec with a genuine syntax defect (an unclosed string, a dropped closing
 * brace) sails through generation and only fails at Playwright's own
 * parse-time, mid-suite, as a raw error rather than a clean skip (the RCA's
 * Branch 4c: `maybeRegionLink.first is not a function`-style codegen defects).
 *
 * This is a bounded tokenizer, not a real parser: it tracks string/template
 * literal and comment state char-by-char and a stack of open
 * brackets/parens/braces, then appends whatever's still open at EOF. It never
 * tries to fix a MISMATCHED bracket (e.g. `(...]`) — only genuinely missing
 * closers — so it can't paper over a structurally different defect.
 * Returns null when nothing needed fixing.
 */
export function attemptBracketRepair(source: string): string | null {
  const CLOSER: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  let inLineComment = false;
  let inBlockComment = false;
  let stringChar: string | null = null;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (stringChar) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === stringChar) {
        stringChar = null;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      stringChar = ch;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') {
      stack.push(ch);
      continue;
    }
    if (ch === ')' || ch === '}' || ch === ']') {
      const top = stack[stack.length - 1];
      if (top && CLOSER[top] === ch) stack.pop();
      continue;
    }
  }

  let repaired = source;
  let changed = false;
  if (stringChar) {
    repaired += stringChar;
    changed = true;
  }
  if (inBlockComment) {
    repaired += '*/';
    changed = true;
  }
  while (stack.length > 0) {
    const opener = stack.pop() as string;
    repaired += CLOSER[opener];
    changed = true;
  }

  return changed ? repaired : null;
}

/** Playwright's positional file filters are regex-matched against the test file path — POSIX-normalize so a Windows backslash is never misread as a regex escape (e.g. `\t` -> tab). */
function toPosixRelative(projectDir: string, absPath: string): string {
  return relative(projectDir, absPath).split(sep).join('/');
}

async function parseCheck(
  ctx: TestModeContext,
  relPosixPath: string,
): Promise<{ ok: boolean; tail: string }> {
  const res = await runCommand(ctx, 'npx', ['playwright', 'test', '--list', relPosixPath], LIST_TIMEOUT_MS);
  const tail = `${res.stdout}\n${res.stderr}`.split(/\r?\n/).filter(Boolean).slice(-6).join(' | ');
  return { ok: res.code === 0, tail };
}

async function quarantine(ctx: TestModeContext, spec: GeneratedSpec): Promise<void> {
  const quarantineDir = join(ctx.projectDir, 'tests', '_quarantine');
  await mkdir(quarantineDir, { recursive: true });
  try {
    await rename(spec.path, join(quarantineDir, basename(spec.path)));
  } catch {
    // Best-effort: if the move fails the file stays in its tier dir, but the
    // caller never adds it to `ok`/`repaired`, so it's still excluded from execute().
  }
}

/**
 * Pre-execution gate: parse-check every generated spec (via `playwright test
 * --list`, which imports/collects but never runs a test) BEFORE any of them
 * reach `execute()`. A spec that fails gets one mechanical repair attempt
 * (attemptBracketRepair); if the repair re-passes both the parse-check and
 * generate.ts's own content gates, it's accepted as `repaired`. A spec still
 * broken after that is moved out of its tier directory into
 * tests/_quarantine (so Playwright's testDir glob never sees it) rather than
 * silently shipped into a run whose first sign of trouble would otherwise be
 * a raw exception mid-suite.
 *
 * Never blocks the run on cancellation: an already-aborted signal returns
 * every spec as `ok` unvalidated (matches execute()'s own "ship as before"
 * fail-open behavior — see runCommand's own cooperative-cancellation
 * handling for anything that aborts mid-loop).
 */
export async function validateSuite(ctx: TestModeContext, specs: GeneratedSpec[]): Promise<ValidationResult> {
  if (specs.length === 0 || ctx.signal?.aborted) {
    return { ok: [...specs], repaired: [], quarantined: [] };
  }

  // The parse-check below runs `npx playwright test --list`, which requires
  // the scaffolded suite's own node_modules — install them here rather than
  // waiting for execute() (too late: by then every spec would already be
  // quarantined for the same reason, one at a time). No-ops if already present.
  await ensureSuiteDeps(ctx);

  const ok: GeneratedSpec[] = [];
  const repaired: GeneratedSpec[] = [];
  const quarantined: QuarantinedSpec[] = [];

  for (let i = 0; i < specs.length; i += 1) {
    if (ctx.signal?.aborted) {
      // Cancelled mid-validation: don't mass-quarantine the remainder —
      // degrade to the pre-gate behavior (ship unvalidated) for what's left.
      ok.push(...specs.slice(i));
      break;
    }

    const spec = specs[i];
    const relPath = toPosixRelative(ctx.projectDir, spec.path);
    const first = await parseCheck(ctx, relPath);
    if (first.ok) {
      ok.push(spec);
      continue;
    }

    if (looksLikeMissingDeps(first.tail)) {
      // Not a per-spec syntax defect — the suite still can't resolve its own
      // deps (e.g. ensureSuiteDeps' install failed). Quarantining every
      // remaining spec one-by-one would just repeat the same misleading
      // "fails to parse" message N times. Ship the rest unvalidated instead
      // and surface it once, same fail-open shape as the cancellation path above.
      ctx.emit?.(
        'generate',
        `[validate] Skipping parse-check for ${specs.length - i} spec(s): suite dependencies appear to be missing`,
        { reason: first.tail },
      );
      ok.push(...specs.slice(i));
      break;
    }

    // Mocking-enabled specs import test/expect from the Healix-authored mock
    // fixture instead of '@playwright/test' directly (see generate.ts) — the
    // repaired-spec sanity check needs to accept that import too, or a
    // genuinely-fixed mocked spec would be wrongly quarantined here.
    const extraAllowedImport = ctx.mockExternalDependencies ? MOCK_FIXTURE_IMPORT_PATH : undefined;
    const fixed = attemptBracketRepair(spec.contents);
    if (fixed && looksLikePlaywrightSpec(fixed, extraAllowedImport) && hasExpect(fixed)) {
      await writeFile(spec.path, fixed, 'utf-8');
      const second = await parseCheck(ctx, relPath);
      if (second.ok) {
        const repairedSpec = { ...spec, contents: fixed };
        repaired.push(repairedSpec);
        ctx.emit?.('generate', `[validate] Repaired a syntax defect in "${spec.title}"`, { path: spec.path });
        continue;
      }
      // The repair didn't actually fix it — restore the original content on
      // disk so what ends up quarantined is what the model actually produced.
      await writeFile(spec.path, spec.contents, 'utf-8');
    }

    await quarantine(ctx, spec);
    const reason = first.tail || 'failed `playwright test --list` parse check';
    quarantined.push({ spec, reason });
    ctx.emit?.('generate', `[validate] Quarantined "${spec.title}": fails to parse`, {
      path: spec.path,
      reason,
    });
  }

  return { ok, repaired, quarantined };
}
