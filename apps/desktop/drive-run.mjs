import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const electronBin = require('electron');
const SHOT = (n) => `/tmp/healix-shots/${n}.png`;
const log = (...a) => console.log('[drive]', ...a);

const app = await electron.launch({
  executablePath: electronBin,
  args: ['out/main/index.js'],
  cwd: process.cwd(),
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await sleep(2500);

// Go to Runs
await win.locator('aside button', { hasText: 'Runs' }).first().click();
await sleep(1000);

// Pick the white-box fixture project + codegen, then start
const projectSelect = win.locator('select').first();
await projectSelect.selectOption({ label: 'Demo From GUI' }).catch(async () => {
  // fall back to first real option
  const opts = await projectSelect.locator('option').allTextContents();
  log('project options:', opts.join(' | '));
  await projectSelect.selectOption({ index: 1 });
});
log('selected project:', await projectSelect.inputValue());

await win.locator('button', { hasText: 'Start run' }).first().click();
log('clicked Start run');

// Wait for the plan-approval gate (real Claude plan ~ up to 3 min)
const approve = win.locator('button', { hasText: 'Approve plan' });
let approved = false;
for (let i = 0; i < 180; i++) {
  if (await approve.count()) {
    await win.screenshot({ path: SHOT('20-plan-gate') });
    await approve.first().click();
    approved = true;
    log('plan approved at ~', i, 's');
    break;
  }
  await sleep(1000);
}
if (!approved) { log('NO PLAN GATE appeared'); }

// Stream to completion: poll the status badge until done/error (up to ~9 min)
let phase = '';
for (let i = 0; i < 540; i++) {
  await sleep(1000);
  const badge = (await win.locator('header span', { hasText: /running|awaiting|done|error|idle|starting/ }).first().innerText().catch(() => '')).trim();
  if (badge && badge !== phase) { phase = badge; log('phase:', phase, `(+${i}s)`); }
  if (i % 20 === 0) await win.screenshot({ path: SHOT('21-running') }).catch(() => {});
  if (phase === 'done' || phase === 'error') break;
}

await sleep(1500);
await win.screenshot({ path: SHOT('22-final') });

// Pull the visible result summary from the main panel
const mainText = await win.locator('main').innerText().catch(() => '');
const passed = (mainText.match(/(\d+)\s*passed/i) || [])[1];
const failed = (mainText.match(/(\d+)\s*failed/i) || [])[1];
log('FINAL_PHASE:', phase);
log('RESULT_PASSED:', passed, 'RESULT_FAILED:', failed);
log('CONSOLE_TAIL:', mainText.split('\n').filter(Boolean).slice(-12).join(' / '));

await app.close();
log('DONE');
