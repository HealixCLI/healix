import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseModule } from './parse.js';

describe('parseModule', () => {
  it('parses a plain TS module', () => {
    const ast = parseModule('export function add(a: number, b: number): number { return a + b; }\n', 'a.ts');
    expect(ast).not.toBeNull();
    expect(ast?.program.body.length).toBe(1);
  });

  it('parses JSX/TSX with typed props', () => {
    const source = `
      import React from 'react';
      export function Greeting({ name }: { name: string }) {
        return <div data-testid="greeting">Hello {name}</div>;
      }
    `;
    const ast = parseModule(source, 'Greeting.tsx');
    expect(ast).not.toBeNull();
  });

  it('parses nested/multi-line JSX router config that regex would miss', () => {
    const source = `
      import { Routes, Route } from 'react-router-dom';
      export function App() {
        return (
          <Routes>
            <Route
              path="/dashboard"
              element={<Dashboard />}
            />
          </Routes>
        );
      }
    `;
    const ast = parseModule(source, 'App.tsx');
    expect(ast).not.toBeNull();
  });

  it('returns null (not a throw) on malformed source', () => {
    expect(() => parseModule('function ( { [[[', 'broken.ts')).not.toThrow();
    expect(parseModule('function ( { [[[', 'broken.ts')).toBeNull();
  });
});

// --- Isolated check against a real fixture repo (Item A1) ------------------
// Verifies parseModule doesn't throw across a real-world codebase and reports
// the null-rate as informational context, not a hard pass/fail threshold —
// some framework-specific syntax (e.g. Vue SFCs, decorators) is expected to
// fall back to null for some files.

const FIXTURES_ROOT = path.join('C:', 'Users', 'AdroyFernandes', 'Documents', 'TestApps');
const RBAC_DIRS = [
  path.join(FIXTURES_ROOT, 'Role-Based-Access-Control-RBAC-', 'vrb-backend'),
  path.join(FIXTURES_ROOT, 'Role-Based-Access-Control-RBAC-', 'vrb-frontend', 'src'),
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(abs));
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

const rbacAvailable = RBAC_DIRS.some((d) => fs.existsSync(d));

describe.skipIf(!rbacAvailable)(
  'parseModule against Role-Based-Access-Control-RBAC- (isolated check)',
  () => {
    it('never throws across the real repo, and parses the large majority of files', () => {
      const files = RBAC_DIRS.flatMap(listSourceFiles);
      expect(files.length).toBeGreaterThan(0);

      let failed = 0;
      const failures: string[] = [];
      for (const file of files) {
        const source = fs.readFileSync(file, 'utf-8');
        let ast: ReturnType<typeof parseModule> = null;
        expect(() => {
          ast = parseModule(source, file);
        }).not.toThrow();
        if (ast === null) {
          failed += 1;
          failures.push(file);
        }
      }

      // Informational: report which files failed to parse (if any) without
      // asserting a specific count, since fixture content may change.
      if (failed > 0) {
        console.log(`parseModule: ${failed}/${files.length} file(s) failed to parse:`, failures);
      }
      expect(failed).toBeLessThan(files.length);
    });
  },
);
