import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractSelectorHintsAst } from './selectors.js';

describe('extractSelectorHintsAst', () => {
  it('extracts a static string data-testid attribute', () => {
    const source = `<button data-testid="submit-btn">Go</button>;`;
    const hints = extractSelectorHintsAst('Btn.tsx', source);
    expect(hints).toEqual([{ file: 'Btn.tsx', attribute: 'data-testid', value: 'submit-btn' }]);
  });

  it('extracts data-test and aria-label attributes too', () => {
    const source = `
      <div>
        <span data-test="legacy-hint">x</span>
        <div aria-label="lab API tabs example" />
      </div>;
    `;
    const hints = extractSelectorHintsAst('Panel.tsx', source);
    expect(hints).toContainEqual({ file: 'Panel.tsx', attribute: 'data-test', value: 'legacy-hint' });
    expect(hints).toContainEqual({
      file: 'Panel.tsx',
      attribute: 'aria-label',
      value: 'lab API tabs example',
    });
  });

  it('extracts a JSXExpressionContainer string literal form (data-testid={"x"})', () => {
    const source = `<div data-testid={"card"} />;`;
    const hints = extractSelectorHintsAst('Card.tsx', source);
    expect(hints).toEqual([{ file: 'Card.tsx', attribute: 'data-testid', value: 'card' }]);
  });

  it('ignores unrelated attributes and non-static values', () => {
    const source = `<div className="foo" data-testid={dynamicId}>x</div>;`;
    const hints = extractSelectorHintsAst('Dynamic.tsx', source);
    expect(hints).toEqual([]);
  });

  it('returns null (not a throw) on malformed source', () => {
    expect(() => extractSelectorHintsAst('broken.tsx', 'function ( { [[[')).not.toThrow();
    expect(extractSelectorHintsAst('broken.tsx', 'function ( { [[[')).toBeNull();
  });
});

// --- Isolated check against real fixture repos (Item B5) -------------------

const FIXTURES_ROOT = path.join('C:', 'Users', 'AdroyFernandes', 'Documents', 'TestApps');
const PSV_LOGIN_PAGE = path.join(
  FIXTURES_ROOT,
  'psv-ui-c-and-a-react-latest-development',
  'src',
  'pages',
  'login',
  'LoginPage.tsx',
);
const RBAC_ADMIN_DASHBOARD = path.join(
  FIXTURES_ROOT,
  'Role-Based-Access-Control-RBAC-',
  'vrb-frontend',
  'src',
  'components',
  'adminDashboard.js',
);

describe.skipIf(!fs.existsSync(PSV_LOGIN_PAGE))(
  'extractSelectorHintsAst against psv-ui-c-and-a LoginPage.tsx (isolated check)',
  () => {
    it('extracts every real data-testid on the login page', () => {
      const source = fs.readFileSync(PSV_LOGIN_PAGE, 'utf-8');
      const hints = extractSelectorHintsAst('src/pages/login/LoginPage.tsx', source);
      const values = hints?.filter((h) => h.attribute === 'data-testid').map((h) => h.value) ?? [];
      expect(values).toEqual(
        expect.arrayContaining([
          'login-email',
          'login-password',
          'login-password-toggle',
          'login-submit',
          'login-forgot',
          'login-register',
        ]),
      );
    });
  },
);

describe.skipIf(!fs.existsSync(RBAC_ADMIN_DASHBOARD))(
  'extractSelectorHintsAst against RBAC adminDashboard.js (isolated check)',
  () => {
    it('extracts the real aria-label on the tab list (an app with sparse/no data-testid coverage)', () => {
      const source = fs.readFileSync(RBAC_ADMIN_DASHBOARD, 'utf-8');
      const hints = extractSelectorHintsAst('src/components/adminDashboard.js', source);
      expect(hints).toContainEqual({
        file: 'src/components/adminDashboard.js',
        attribute: 'aria-label',
        value: 'lab API tabs example',
      });
    });
  },
);
