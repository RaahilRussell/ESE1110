import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let process: ChildProcess;
let base: string;
let token: string;
let directory: string;
let serverOutput = '';
const pin = '31415926';
async function signIn(page: Page) {
  await page.goto(base);
  await expect(page.locator('#login-button')).toBeEnabled();
  if (await page.locator('#bootstrap-label').isVisible()) await page.locator('#bootstrap-token').fill(token);
  await page.locator('#pin').fill(pin);
  await page.locator('#login-button').click();
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#connection-status')).toHaveText('Connected to controller');
}
async function takeControl(page: Page) {
  await page.locator('#take-control').click();
  await expect(page.locator('#lease-status')).toHaveText('Operator control');
}
async function next(page: Page, step: string) {
  await page.locator('#wizard-next').click();
  await expect(page.locator('#wizard-content h2')).toHaveText(step.replaceAll('-', ' '));
}
test.beforeEach(async () => {
  serverOutput = '';
  directory = await mkdtemp(join(tmpdir(), 'flashify-browser-'));
  process = spawn(globalThis.process.execPath, ['--import','tsx','apps/server/server.ts'], {
    cwd: globalThis.process.cwd(), env: {...globalThis.process.env, PORT:'0', HOST:'127.0.0.1', FLASHIFY_DATA_DIR:directory, DATA_DIR:directory}, stdio: ['ignore','pipe','pipe'],
  });
  const collect = (data: Buffer) => { serverOutput += data.toString(); };
  process.stdout!.on('data', collect); process.stderr!.on('data', collect);
  await expect.poll(() => serverOutput, {timeout:20000}).toMatch(/http:\/\/(?:localhost|127\.0\.0\.1):\d+/);
  base = serverOutput.match(/http:\/\/(?:localhost|127\.0\.0\.1):\d+/)![0];
  token = serverOutput.match(/(?:setup token|bootstrap token)\s*[:=]\s*([a-f0-9]{64})/i)?.[1] ?? '';
  expect(token, 'Server must print its local setup token').toHaveLength(64);
});
test.afterEach(async () => { process?.kill('SIGTERM'); if (process && process.exitCode === null) await new Promise(resolve => process.once('exit', resolve)); if (directory) await rm(directory,{recursive:true,force:true}); });
test('first setup requires local token; viewer controls are disabled until lease acquisition', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await expect(page.locator('#bootstrap-label')).toBeVisible();
  await page.locator('#bootstrap-token').fill('incorrect-token'); await page.locator('#pin').fill(pin); await page.locator('#login-button').click();
  await expect(page.locator('#notice')).toContainText(/token/i); await expect(page.locator('#workspace')).toBeHidden();
  await page.locator('#bootstrap-token').fill(token); await page.locator('#pin').fill(pin); await page.locator('#login-button').click();
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#wizard-content h2')).toHaveText('welcome');
  await expect(page.locator('[data-view="wizard"]')).toHaveClass(/is-active/); await expect(page.locator('[data-view="wizard"]')).toHaveAttribute('aria-current','page'); await expect(page.locator('#blackout-button')).toBeInViewport({ratio:1});
  await expect(page.locator('#wizard-next')).toBeDisabled();
  await takeControl(page); await expect(page.locator('#wizard-next')).toBeEnabled();
  await page.locator('#release-control').click(); await expect(page.locator('#wizard-next')).toBeDisabled();
  await page.locator('[data-view="looks"]').click(); await expect(page.locator('#blackout-button')).toBeEnabled(); await page.locator('#blackout-button').click(); await expect(page.locator('#blackout-button')).toHaveText('Release blackout'); await page.locator('#blackout-button').click(); await expect(page.locator('#blackout-button')).toHaveText('Activate blackout');
  expect(errors).toEqual([]);
});
test('resumable wizard saves actual patch, validates overlap and commits; live actions persist across reload', async ({page}, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await signIn(page); await takeControl(page);
  await next(page,'pin'); await next(page,'room');
  await page.locator('#wizard-room').fill('Browser E2E Room'); await next(page,'output');
  await next(page,'type'); await page.locator('#wizard-add').click(); await expect(page.locator('[data-remove-fixture]')).toHaveCount(1);
  await next(page,'mode'); await next(page,'address');
  await page.locator('[data-fixture-field="address"]').fill('17'); await page.locator('#wizard-save').click();
  await expect(page.locator('#toast')).toHaveText('Draft saved by controller.');
  await page.reload(); await expect(page.locator('#wizard-content h2')).toHaveText('address'); await expect(page.locator('[data-fixture-field="address"]')).toHaveValue('17');
  await expect(page.locator('#lease-status')).toHaveText('Operator control');
  await next(page,'set-on-light'); await page.locator('[data-check]').check(); await next(page,'test');
  await page.locator('[data-test-fixture]').click(); await expect(page.locator('#toast')).toContainText(/probe/i);
  await page.locator('[data-observe-fixture]').click(); await expect(page.locator('#wizard-content')).toContainText('Passed test recorded');
  await next(page,'color-check'); await page.locator('#wizard-next').click(); await expect(page.locator('#notice')).toContainText(/confirm the color order/i); await page.locator('[data-color="red"]').click(); await expect(page.locator('#toast')).toContainText('red probe acknowledged'); await page.locator('[data-check]').check(); await next(page,'name-place');
  await page.locator('[data-fixture-field="name"]').fill('Browser PAR'); await next(page,'groups');
  await page.locator('[data-fixture-field="groupIds"]').fill('stage'); await next(page,'presets'); await page.locator('[data-check]').check(); await next(page,'music'); await page.locator('[data-check]').check(); await next(page,'review');
  await page.locator('[data-check="commit-reviewed"]').check(); await page.locator('#wizard-commit').click();
  await expect(page.locator('#wizard-content h2')).toHaveText('done'); await expect(page.locator('#room-name')).toHaveText('Browser E2E Room');
  await page.locator('#wizard-open-looks').click(); await page.locator('#blackout-button').click(); await expect(page.locator('#blackout-button')).toHaveText('Release blackout');
  await page.locator('#new-scene').click(); await page.locator('[name="name"]').fill('Browser scene'); await page.locator('#edit-submit').click();
  await expect(page.locator('[data-scene]')).toContainText('Browser scene');
  await page.locator('[data-view="show"]').click(); await page.locator('#add-cue').click(); await page.locator('[name="name"]').fill('Browser cue'); await page.locator('#edit-submit').click();
  await expect(page.locator('#cue-list')).toContainText('Browser cue');
  await page.reload(); await expect(page.locator('#room-name')).toHaveText('Browser E2E Room');
  await page.locator('[data-view="show"]').click(); await expect(page.locator('#cue-list')).toContainText('Browser cue'); await expect(page.locator('[data-view="show"]')).toHaveClass(/is-active/); await expect(page.locator('#blackout-button')).toBeInViewport({ratio:1});
  await page.screenshot({path:testInfo.outputPath('controller-show.png'),fullPage:false});
  await page.locator('[data-view="wizard"]').click(); await expect(page.locator('[data-view="wizard"]')).toHaveClass(/is-active/); await expect(page.locator('[data-view="show"]')).not.toHaveClass(/is-active/); await expect(page.locator('#page-title')).toHaveText('Setup'); await expect(page.locator('#blackout-button')).toBeInViewport({ratio:1}); await page.screenshot({path:testInfo.outputPath('controller-setup.png'),fullPage:false});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#release-control').click(); expect(errors).toEqual([]);
});
test('exclusive operator lease prevents another browser from changing state; logout removes access', async ({browser}) => {
  const first = await browser.newContext(), second = await browser.newContext(); const a = await first.newPage(), b = await second.newPage();
  await signIn(a); await takeControl(a); await signIn(b); await b.locator('#take-control').click();
  await expect(b.locator('#notice')).toContainText(/another operator/i); await expect(b.locator('#wizard-save')).toBeDisabled();
  await a.locator('#release-control').click(); await takeControl(b); await b.locator('#logout').click(); await expect(b.locator('#auth-panel')).toBeVisible(); await expect(b.locator('#workspace')).toBeHidden();
  await first.close(); await second.close();
});
test('scene deletion requires confirmation and cancellation preserves authoritative state', async ({page}) => {
  await signIn(page); await takeControl(page); await page.locator('[data-view="looks"]').click();
  await page.locator('#new-scene').click(); await page.locator('[name="name"]').fill('Delete confirmation'); await page.locator('#edit-submit').click();
  const scene = page.locator('[data-scene]').filter({hasText:'Delete confirmation'}); await expect(scene).toBeVisible();
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button',{name:'Delete Delete confirmation',exact:true}).click(); await expect(scene).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button',{name:'Delete Delete confirmation',exact:true}).click(); await expect(scene).toHaveCount(0);
  await page.locator('#release-control').click();
});
test('missing server acknowledgement never claims success and stale controls disable within two seconds', async ({page}) => {
  await signIn(page); await takeControl(page); await page.locator('[data-view="looks"]').click();
  await expect(page.locator('#blackout-button')).toBeEnabled();
  process.kill('SIGSTOP');
  try {
    const started = Date.now();
    await page.locator('#blackout-button').click();
    await expect(page.locator('#stale-banner')).toBeVisible({timeout:2000});
    expect(Date.now()-started).toBeLessThan(2200);
    await expect(page.locator('#blackout-button')).toBeDisabled();
    await expect(page.locator('#toast')).not.toHaveClass(/is-visible/);
  } finally { process.kill('SIGCONT'); }
  await expect(page.locator('#connection-status')).toHaveText('Connected to controller');
  await expect(page.locator('#release-control')).toBeVisible(); await page.locator('#release-control').click();
});
test('responsive setup remains usable at 360px and 390px with autosaved fields and checklist gates', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await signIn(page); await takeControl(page); await next(page,'pin'); await next(page,'room');
  await page.locator('#wizard-room').fill('Autosaved browser room');
  await expect(page.locator('#draft-status')).toContainText('Saved draft');
  // Check server-confirmed autosave, then reload without pressing Save or Continue.
  await expect(page.locator('#draft-status')).not.toContainText('unsaved');
  await page.reload(); await expect(page.locator('#wizard-room')).toHaveValue('Autosaved browser room');
  await expect(page.locator('#lease-status')).toHaveText('Operator control');
  await next(page,'output'); await expect(page.locator('#wizard-output option')).toHaveCount(2); await next(page,'type');
  await page.locator('#wizard-next').click(); await expect(page.locator('#notice')).toContainText(/at least one enabled light/i); await expect(page.locator('#wizard-content h2')).toHaveText('type');
  await page.locator('#wizard-add').click(); await expect(page.locator('[data-remove-fixture]')).toHaveCount(1);
  await next(page,'mode'); await next(page,'address'); await next(page,'set-on-light');
  await page.locator('#wizard-next').click(); await expect(page.locator('#notice')).toContainText(/confirm the physical/i); await expect(page.locator('#wizard-content h2')).toHaveText('set on light');
  for (const width of [360,390]) {
    await page.setViewportSize({width,height:844});
    await page.locator('#wizard-next').scrollIntoViewIfNeeded();
    await expect(page.locator('#wizard-next')).toBeInViewport();
    await expect(page.locator('#wizard-content')).toBeVisible();
    await expect(page.locator('#blackout-button')).toBeInViewport({ratio:1});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('[data-check]').check(); await next(page,'test');
    await page.locator('[data-observe-fixture]').click(); await expect(page.locator('#notice')).toContainText(/run a light test|probe/i);
    await page.locator('#wizard-back').click(); await expect(page.locator('#wizard-content h2')).toHaveText('set on light');
  }
  expect(errors).toEqual([]);
});
