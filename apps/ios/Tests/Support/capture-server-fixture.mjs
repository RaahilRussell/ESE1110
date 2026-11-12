// Run from the repository root: node --import tsx apps/ios/Tests/Support/capture-server-fixture.mjs
// Starts an isolated real controller, captures its actual HTTP snapshot, and exercises the Swift client.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createController } from '../../../server/server.ts';
const support = fileURLToPath(new URL('.', import.meta.url));
const ios = resolve(support, '../..');
const directory = await mkdtemp(join(tmpdir(), 'flashify-ios-contract-'));
let controller;
async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)));
  });
}
try {
  controller = await createController({ directory, advertise: false, bootstrapToken: 'isolated-ios-test-bootstrap' });
  const { port } = await controller.listen();
  const base = `http://127.0.0.1:${port}`;
  let token;
  async function request(path, method = 'GET', body) {
    const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200, `${method} ${path}`);
    return response.json();
  }
  assert.equal((await request('/api/health')).setupRequired, true);
  token = (await request('/api/auth/setup', 'POST', { pin: '192837', bootstrapToken: 'isolated-ios-test-bootstrap' })).token;
  await request('/api/lease/acquire', 'POST', {});
  await request('/api/config', 'PUT', { revision: (await request('/api/state')).revision, configuration: {
    schemaVersion: 1, roomName: 'iOS Contract Room', master: 0.7,
    profiles: [{ id: 'contract-profile', manufacturer: 'Contract', model: 'Dimmer', source: 'custom', profileVersion: 1, modes: [{ id: 'contract-mode', name: 'One channel', channelCount: 1, channels: [{ offset: 1, attribute: 'dimmer', default: 0 }] }] }],
    fixtures: [{ id: 'contract-fixture', name: 'Contract light', profileId: 'contract-profile', modeId: 'contract-mode', universe: 1, address: 1, groupIds: ['contract-group'], enabled: true }],
    scenes: [{ id: 'contract-scene', name: 'Server captured scene', builtin: false, values: { 'contract-fixture': { dimmer: 0.35 } }, clearOthers: true, revision: 1 }],
    cues: [{ id: 'contract-cue', name: 'Server captured cue', sceneId: 'contract-scene', fadeMs: 0 }]
  } });
  await request('/api/command', 'POST', { type: 'scene.activate', id: 'contract-activate', sceneId: 'contract-scene', fadeMs: 0, groupIds: [], takeover: false });
  const response = await fetch(base + '/api/state', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const raw = await response.text();
  const state = JSON.parse(raw);
  assert.ok(state.configuration); assert.equal(state.config, undefined);
  assert.equal(state.fixtures['contract-fixture'].dimmer, 0.35);
  await writeFile(join(ios, 'Tests/Fixtures/server-state.json'), raw + '\n');
  await request('/api/lease/release', 'POST', {});
  const executable = join(directory, 'live-swift-transport');
  await run('swiftc', ['-parse-as-library', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`, ...['Models.swift', 'Transport.swift', 'ConnectionStore.swift'].map(file => join(ios, 'Sources', file)), join(support, 'LiveTransportSmoke.swift'), '-o', executable]);
  await run(executable, [base]);
  console.log('Captured unmodified /api/state response with canonical configuration, fixture, scene, and cue.');
} finally {
  await controller?.close();
  await rm(directory, { recursive: true, force: true });
}
