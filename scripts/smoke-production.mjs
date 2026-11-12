import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../dist/apps/server/server.js';
const directory = await mkdtemp(join(tmpdir(), 'flashify-production-'));
let controller;
try {
  controller = await createController({ directory, advertise: false });
  const address = await controller.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).setupRequired, true);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<!doctype html>/i);
  for (const path of ['/app.js', '/styles.css']) assert.equal((await fetch(`${base}${path}`)).status, 200);
  for (const path of ['/apps/server/server.js', '/data/auth.json']) assert.equal((await fetch(`${base}${path}`)).status, 404);
  console.log('Compiled production server, bundled web assets, and static denial passed.');
} finally {
  await controller?.close();
  await rm(directory, { recursive: true, force: true });
}
