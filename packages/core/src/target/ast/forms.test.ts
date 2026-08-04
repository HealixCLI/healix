import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractFormsAst } from './forms.js';

describe('extractFormsAst', () => {
  it('extracts native <input>/<select>/<textarea> fields with name/type/required', () => {
    const source = `
      function SignupForm() {
        return (
          <form>
            <input name="email" type="email" required />
            <input name="age" type="number" />
            <select name="country"><option value="us">US</option></select>
            <textarea name="bio" />
            <button type="submit">Create account</button>
          </form>
        );
      }
    `;
    const forms = extractFormsAst('SignupForm.tsx', source);
    expect(forms).toHaveLength(1);
    const fields = forms![0].fields;
    expect(fields).toContainEqual({ name: 'email', type: 'email', required: true });
    expect(fields).toContainEqual({ name: 'age', type: 'number', required: false });
    expect(fields).toContainEqual({ name: 'country', type: 'select', required: false });
    expect(fields).toContainEqual({ name: 'bio', type: 'textarea', required: false });
    expect(forms![0].submitLabel).toBe('Create account');
  });

  it('recognizes a custom input-like component via its `type` attribute (no native <input> tag)', () => {
    const source = `
      function LoginForm() {
        return (
          <form onSubmit={onSubmit}>
            <MatInput label="Email" type="email" data-testid="login-email" {...emailReg} />
            <MatInput label="Password" type="password" data-testid="login-password" {...passwordReg} />
            <MatButton type="submit">Sign in</MatButton>
          </form>
        );
      }
    `;
    const forms = extractFormsAst('LoginForm.tsx', source);
    const fields = forms![0].fields;
    expect(fields).toEqual([
      { name: 'Email', type: 'email', required: false, testId: 'login-email' },
      { name: 'Password', type: 'password', required: false, testId: 'login-password' },
    ]);
    expect(forms![0].submitLabel).toBe('Sign in');
  });

  it('tags a Controller-wrapped custom picker/calendar widget field as widgetLike (GAP-066)', () => {
    // Mirrors RegisterPage.tsx:504-533's real shape: a react-hook-form Controller rendering a
    // MatDatepicker (react-datepicker customInput) — .fill() on this field's underlying input
    // never triggers the widget's own onChange.
    const source = `
      function RegisterForm() {
        return (
          <form>
            <input name="email" type="email" required />
            <Controller
              name="dob"
              control={control}
              render={({ field }) => (
                <MatDatepicker {...field} data-testid="register-dob" />
              )}
            />
            <button type="submit">Register</button>
          </form>
        );
      }
    `;
    const forms = extractFormsAst('RegisterForm.tsx', source);
    const fields = forms![0].fields;
    const dob = fields.find((f) => f.testId === 'register-dob');
    expect(dob).toBeDefined();
    expect(dob?.widgetLike).toBe(true);
    // A plain native input in the same form must not be tagged.
    const email = fields.find((f) => f.name === 'email');
    expect(email?.widgetLike).toBeUndefined();
  });

  it('recognizes required from an inline `{...register("x", { required: true })}` spread (GAP-068)', () => {
    // Mirrors RegisterPage.tsx:444/452/460's real shape: register() spread directly onto the
    // element with no intermediate variable.
    const source = `
      function RegisterForm() {
        return (
          <form>
            <input type="radio" value="MRS" data-testid="salutation-mrs" {...register("salutation", { required: true })} />
            <input type="checkbox" data-testid="newsletter" {...register("newsletter", { required: false })} />
          </form>
        );
      }
    `;
    const forms = extractFormsAst('RegisterForm.tsx', source);
    const fields = forms![0].fields;
    expect(fields.find((f) => f.testId === 'salutation-mrs')?.required).toBe(true);
    // required: false must not be treated as truthy just because the key is present.
    expect(fields.find((f) => f.testId === 'newsletter')?.required).toBe(false);
  });

  it('recognizes required from a const-then-spread `{...xReg}` via validate.required (GAP-068)', () => {
    // Mirrors RegisterPage.tsx's emailReg (validate.required present) vs. passwordReg (only a
    // bare custom `validate.all` fn, no `required`-named key) real-world shapes.
    const source = `
      function RegisterForm() {
        const emailReg = register('email', { validate: { required: requiredFn, pattern: patternFn } });
        const passwordReg = register('password', { validate: { all(v) { return true; } } });
        return (
          <form>
            <MatInput type="email" data-testid="reg-email" {...emailReg} />
            <MatInput type="password" data-testid="reg-password" {...passwordReg} />
          </form>
        );
      }
    `;
    const forms = extractFormsAst('RegisterForm.tsx', source);
    const fields = forms![0].fields;
    expect(fields.find((f) => f.testId === 'reg-email')?.required).toBe(true);
    // A single custom validate fn with no `required`-named key is a documented, accepted
    // static-analysis limitation (can't tell "this validator implies required" without
    // evaluating its body) — not a regression, mirrors the ternary-`type` limitation below.
    expect(fields.find((f) => f.testId === 'reg-password')?.required).toBe(false);
  });

  it("propagates a Controller's rules.validate.required to its rendered widget field (GAP-068)", () => {
    const source = `
      function RegisterForm() {
        return (
          <form>
            <input name="email" type="email" required />
            <Controller
              name="dob"
              control={control}
              rules={{ validate: { required: requiredFn } }}
              render={({ field }) => (
                <MatDatepicker {...field} data-testid="register-dob" />
              )}
            />
          </form>
        );
      }
    `;
    const forms = extractFormsAst('RegisterForm.tsx', source);
    const fields = forms![0].fields;
    const dob = fields.find((f) => f.testId === 'register-dob');
    expect(dob?.required).toBe(true);
    expect(dob?.widgetLike).toBe(true);
    // A sibling native field's required-ness is unaffected by the Controller stack.
    expect(fields.find((f) => f.name === 'email')?.required).toBe(true);
  });

  it("propagates a Controller's literal rules.required, without leaking across sibling Controllers (GAP-068)", () => {
    const source = `
      function RegisterForm() {
        return (
          <form>
            <Controller
              name="dob"
              control={control}
              rules={{ required: true }}
              render={({ field }) => <MatDatepicker {...field} data-testid="register-dob" />}
            />
            <Controller
              name="notes"
              control={control}
              render={({ field }) => <MatDatepicker {...field} data-testid="register-notes" />}
            />
          </form>
        );
      }
    `;
    const forms = extractFormsAst('RegisterForm.tsx', source);
    const fields = forms![0].fields;
    expect(fields.find((f) => f.testId === 'register-dob')?.required).toBe(true);
    // A Controller with no `rules` prop at all must default to false, and must not inherit the
    // preceding sibling Controller's required-ness.
    expect(fields.find((f) => f.testId === 'register-notes')?.required).toBe(false);
  });

  it('does NOT tag a plain native <input> as widgetLike', () => {
    const source = `<form><input name="name" type="text" /></form>;`;
    const forms = extractFormsAst('Plain.tsx', source);
    expect(forms![0].fields[0].widgetLike).toBeUndefined();
  });

  it('falls back to a positional name when no name/label/testid/id is present', () => {
    const source = `<form><input type="text" /></form>;`;
    const forms = extractFormsAst('Anon.tsx', source);
    expect(forms![0].fields[0].name).toBe('field-1');
  });

  it('ignores JSX outside any <form> element', () => {
    const source = `function App() { return <div><input name="search" type="text" /></div>; }`;
    const forms = extractFormsAst('App.tsx', source);
    expect(forms).toEqual([]);
  });

  it('returns null (not a throw) on malformed source', () => {
    expect(() => extractFormsAst('broken.tsx', 'function ( { [[[')).not.toThrow();
    expect(extractFormsAst('broken.tsx', 'function ( { [[[')).toBeNull();
  });
});

// --- Isolated check against a real fixture repo (Item B3) ------------------

const FIXTURES_ROOT = path.join('C:', 'Users', 'AdroyFernandes', 'Documents', 'TestApps');
const PSV_LOGIN_PAGE = path.join(
  FIXTURES_ROOT,
  'psv-ui-c-and-a-react-latest-development',
  'src',
  'pages',
  'login',
  'LoginPage.tsx',
);

const PSV_REGISTER_PAGE = path.join(
  FIXTURES_ROOT,
  'psv-ui-c-and-a-react-latest-development',
  'src',
  'pages',
  'register',
  'RegisterPage.tsx',
);
const PSV_RESET_PASSWORD_PAGE = path.join(
  FIXTURES_ROOT,
  'psv-ui-c-and-a-react-latest-development',
  'src',
  'pages',
  'resetpassword',
  'ResetPasswordPage.tsx',
);

describe.skipIf(!fs.existsSync(PSV_REGISTER_PAGE))(
  'extractFormsAst against psv-ui-c-and-a RegisterPage.tsx (isolated check, GAP-068)',
  () => {
    it('recognizes required fields driven by register()/Controller.rules validate.required', () => {
      const source = fs.readFileSync(PSV_REGISTER_PAGE, 'utf-8');
      const forms = extractFormsAst('src/pages/register/RegisterPage.tsx', source);
      expect(forms).toHaveLength(1);
      const fields = forms![0].fields;

      // register('x', { validate: { required: ... } }) const-then-spread fields.
      expect(fields.find((f) => f.testId === 'register-email')?.required).toBe(true);
      expect(fields.find((f) => f.testId === 'register-firstname')?.required).toBe(true);
      expect(fields.find((f) => f.testId === 'register-surname')?.required).toBe(true);

      // Controller + rules.validate.required wrapping a MatDatepicker widget — both GAP-066's
      // widgetLike tagging and GAP-068's required propagation must hold simultaneously.
      const dob = fields.find((f) => f.testId === 'register-dob');
      expect(dob?.required).toBe(true);
      expect(dob?.widgetLike).toBe(true);

      // The real fixture's passwordReg uses only a bare custom `validate.all` fn with no
      // `required`-named key — a documented, accepted static-analysis limitation, not a
      // regression (mirrors the login-page type-ternary limitation asserted below).
      expect(fields.find((f) => f.testId === 'register-password')?.required).toBe(false);

      // Note: the salutation radios are intentionally not asserted here — the real fixture gives
      // them no `name`/`data-testid` (only `value`+`type`), so they resolve to positional
      // `field-N` names; that inline-spread `required: true` shape is already covered by the
      // synthetic test above.
    });
  },
);

describe.skipIf(!fs.existsSync(PSV_RESET_PASSWORD_PAGE))(
  'extractFormsAst against psv-ui-c-and-a ResetPasswordPage.tsx (isolated check, GAP-068)',
  () => {
    it('recognizes required fields driven by register() validate.required', () => {
      const source = fs.readFileSync(PSV_RESET_PASSWORD_PAGE, 'utf-8');
      const forms = extractFormsAst('src/pages/resetpassword/ResetPasswordPage.tsx', source);
      expect(forms).toHaveLength(1);
      const fields = forms![0].fields;

      expect(fields.find((f) => f.testId === 'reset-email')?.required).toBe(true);
      expect(fields.find((f) => f.testId === 'reset-confirm-password')?.required).toBe(true);
      // Same accepted limitation as RegisterPage's passwordReg: a bare custom `validate.all` fn,
      // no `required`-named key.
      expect(fields.find((f) => f.testId === 'reset-password')?.required).toBe(false);
    });
  },
);

describe.skipIf(!fs.existsSync(PSV_LOGIN_PAGE))(
  'extractFormsAst against psv-ui-c-and-a LoginPage.tsx (isolated check)',
  () => {
    it("extracts the real login form's custom MatInput fields by data-testid, and the submit control", () => {
      const source = fs.readFileSync(PSV_LOGIN_PAGE, 'utf-8');
      const forms = extractFormsAst('src/pages/login/LoginPage.tsx', source);
      expect(forms).toHaveLength(1);

      const fields = forms![0].fields;
      const testIds = fields.map((f) => f.testId);
      // Real fixture: two MatInput fields (email/password) identified by data-testid since their
      // actual field name comes from a spread react-hook-form register(), not a static `name` attr.
      expect(testIds).toContain('login-email');
      expect(testIds).toContain('login-password');

      const emailField = fields.find((f) => f.testId === 'login-email');
      expect(emailField?.type).toBe('email');
      // The real fixture declares this field's type as a dynamic ternary
      // (`type={hide ? "password" : "text"}`), not a static string — an inherent limit of
      // static analysis. 'text' is the documented, honest fallback, not a bug.
      const passwordField = fields.find((f) => f.testId === 'login-password');
      expect(passwordField?.type).toBe('text');
    });
  },
);
