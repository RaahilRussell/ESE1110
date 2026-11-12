import assert from 'node:assert/strict';
import test from 'node:test';
import { AUDIO_STALE_MS, IDEMPOTENCY_LIMIT, LightingEngine, genericProfiles, validatePatch } from '../packages/engine/src/index.js';

const clock = { value: 0, now() { return this.value; } };
test('validates patch range and overlap without channel arithmetic in the UI', () => {
  const base = { id: 'a', name: 'A', profileId: 'generic-rgbw', modeId: 'rgbw-4', universe: 1 as const, address: 1, groupIds: [], enabled: true };
  assert.deepEqual(validatePatch([base], genericProfiles), { ok: true });
  assert.equal(validatePatch([{ ...base, address: 4 }, { ...base, id: 'b', name: 'B', address: 7 }], genericProfiles).ok, false);
  assert.equal(validatePatch([{ ...base, address: 510 }], genericProfiles).ok, false);
});
test('creates exact 512-byte frames and maps normalized attributes', () => {
  clock.value = 0;
  const engine = new LightingEngine({ clock });
  engine.dispatch({ type: 'scene.activate', id: 'scene-1', sceneId: 'house', fadeMs: 0, groupIds: [], takeover: false });
  const frame = engine.tick();
  assert.equal(frame.length, 512); assert.equal(frame[0], Math.round(.85 * .82 * 255)); assert.equal(frame[3], Math.round(.4 * .82 * 255));
});
test('fade uses elapsed time and blackout wins over later ticks', () => {
  clock.value = 0;
  const engine = new LightingEngine({ clock });
  engine.dispatch({ type: 'scene.activate', id: 'fade-1', sceneId: 'house', fadeMs: 1000, groupIds: [], takeover: false });
  clock.value = 500; const mid = engine.tick(); assert(mid[0] > 0 && mid[0] < 200);
  engine.dispatch({ type: 'blackout.set', id: 'blackout-1', on: true });
  const dark = engine.tick(); assert.equal(dark[0], 0); assert.equal(dark[1], 0);
});
test('duplicate command ids are idempotent', () => {
  clock.value = 0;
  const engine = new LightingEngine({ clock });
  const first = engine.dispatch({ type: 'master.set', id: 'same', value: .4 }); const second = engine.dispatch({ type: 'master.set', id: 'same', value: .9 });
  assert.deepEqual(first, second); assert.equal(engine.snapshot().master, .4);
});

import type { Attribute, FixtureProfile, PatchedFixture, Scene } from '../packages/protocol/src/index.js';
const fixture: PatchedFixture = { id: 'a', name: 'A', profileId: 'generic-rgbw', modeId: 'rgbw-4', universe: 1, address: 1, groupIds: ['all', 'a'], enabled: true };
function harness() {
  const clock = { value: 0, now() { return this.value; } };
  const engine = new LightingEngine({ clock });
  let id = 0;
  const send = (command: Record<string, unknown>) => engine.dispatch({ id: `cmd-${++id}`, ...command });
  return { clock, engine, send };
}
function scene(id: string, values: Scene['values'], clearOthers = false): Scene {
  return { id, name: id, values, clearOthers, builtin: false, revision: 1 };
}

test('patch validation rejects malformed offsets, duplicate IDs, disabled invalid references and extra universes', () => {
  for (const fixtures of [[{ ...fixture, universe: 2 }], [{ ...fixture, address: 0 }], [fixture, fixture], [{ ...fixture, enabled: false, modeId: 'missing' }]]) {
    assert.equal(validatePatch(fixtures as PatchedFixture[], genericProfiles).ok, false);
  }
  const profiles = structuredClone(genericProfiles);
  profiles[0].modes[0].channels[0].offset = 5;
  assert.equal(validatePatch([fixture], profiles).ok, false);
  assert.throws(() => new LightingEngine({ clock, fixtures: [{ ...fixture, address: 512 }] }));
});

test('commands validate at the engine boundary and retain exact failures and revisions', () => {
  const { engine, send } = harness();
  const missing = { type: 'scene.activate', id: 'missing', sceneId: 'absent', fadeMs: 0 };
  const failed = engine.dispatch(missing);
  assert.equal(failed.ok, false);
  send({ type: 'master.set', value: .5 });
  assert.deepEqual(engine.dispatch(missing), failed);
  const good = { type: 'master.set', id: 'good', value: .3 };
  const original = engine.dispatch(good);
  send({ type: 'master.set', value: .8 });
  assert.deepEqual(engine.dispatch(good), original);
  assert.equal(engine.snapshot().master, .8);
  const before = engine.snapshot().revision;
  for (const command of [{ type: 'master.set', value: NaN }, { type: 'not.real' }, { type: 'fixture.set', fixtureId: 'left', values: { red: 2 } }]) {
    assert.equal(send(command).ok, false);
    assert.equal(engine.snapshot().revision, before);
  }
  const invalid = { id: 'invalid', type: 'master.set', value: 10 };
  assert.deepEqual(engine.dispatch(invalid), engine.dispatch(invalid));
});

test('idempotency history evicts oldest entries at a bounded limit', () => {
  const { engine } = harness();
  engine.dispatch({ type: 'master.set', id: 'old', value: .1 });
  for (let i = 0; i < IDEMPOTENCY_LIMIT; i++) assert.equal(engine.dispatch({ type: 'master.set', id: `new-${i}`, value: .5 }).ok, true);
  assert.equal(engine.dispatch({ type: 'master.set', id: 'old', value: .8 }).ok, true);
  assert.equal(engine.snapshot().master, .8);
});

test('scene CRUD, clearOthers and group scope preserve unselected fixtures', () => {
  const { engine, send } = harness();
  send({ type: 'scene.activate', sceneId: 'house', fadeMs: 0 });
  assert.equal(send({ type: 'scene.upsert', scene: scene('red', { left: { red: 1 }, right: { red: 1 } }, true) }).ok, true);
  assert.equal(send({ type: 'scene.activate', sceneId: 'red', groupIds: ['left'], fadeMs: 0 }).ok, true);
  const state = engine.snapshot();
  assert.equal(state.fixtures.left.red, 1);
  assert.equal(state.fixtures.left.green, 0);
  assert.equal(state.fixtures.right.green, .55);
  assert.equal(send({ type: 'scene.save', sceneId: 'saved', name: 'Saved' }).ok, true);
  assert.deepEqual(engine.exportConfiguration().scenes.find(s => s.id === 'saved')!.values, state.fixtures);
  assert.equal(send({ type: 'scene.upsert', scene: scene('bad', { absent: { red: 1 } }) }).ok, false);
  assert.equal(send({ type: 'scene.activate', sceneId: 'red', groupIds: ['missing'], fadeMs: 0 }).ok, false);
  assert.equal(send({ type: 'scene.delete', sceneId: 'saved' }).ok, true);
  assert.equal(send({ type: 'scene.delete', sceneId: 'saved' }).ok, false);
});

test('cue GO and Back activate real scenes and STOP freezes an interrupted fade', () => {
  const { clock, engine, send } = harness();
  send({ type: 'scene.upsert', scene: scene('dark', { left: { red: 0 }, right: { red: 0 } }, true) });
  send({ type: 'cue.upsert', cue: { id: 'q1', name: 'One', sceneId: 'house', fadeMs: 1000 } });
  send({ type: 'cue.upsert', cue: { id: 'q2', name: 'Two', sceneId: 'dark', fadeMs: 0 } });
  assert.equal(engine.snapshot().show.currentCueIndex, -1);
  assert.equal(send({ type: 'show.go' }).ok, true);
  assert.equal(engine.snapshot().show.currentCueId, 'q1');
  clock.value = 500;
  send({ type: 'show.stop' });
  const stopped = engine.tick()[0];
  assert.equal(stopped, Math.round(.425 * .82 * 255));
  clock.value = 2000;
  assert.equal(engine.tick()[0], stopped);
  assert.equal(engine.snapshot().show.phase, 'paused');
  assert.equal(send({ type: 'show.go' }).ok, true);
  assert.equal(engine.tick()[0], 0);
  assert.equal(engine.snapshot().activeSceneId, 'dark');
  assert.equal(send({ type: 'show.go' }).ok, false);
  send({ type: 'show.back' });
  assert.equal(engine.snapshot().show.currentCueId, 'q1');
  clock.value = 2500;
  assert.equal(engine.tick()[0], stopped);
  clock.value = 3000;
  assert.equal(engine.snapshot().show.phase, 'complete');
  assert.equal(engine.tick()[0], Math.round(.85 * .82 * 255));
});

test('cue editing preserves current cue identity and rejects dangling scenes', () => {
  const { engine, send } = harness();
  assert.equal(send({ type: 'show.go' }).ok, false);
  assert.equal(send({ type: 'cue.upsert', cue: { id: 'bad', name: 'Bad', sceneId: 'missing', fadeMs: 0 } }).ok, false);
  for (const id of ['one', 'two']) send({ type: 'cue.upsert', cue: { id, name: id, sceneId: 'house', fadeMs: 0 } });
  send({ type: 'show.go' });
  send({ type: 'cue.upsert', cue: { id: 'zero', name: 'Zero', sceneId: 'house', fadeMs: 0 }, index: 0 });
  assert.equal(engine.snapshot().show.currentCueId, 'one');
  assert.equal(engine.snapshot().show.currentCueIndex, 1);
  assert.equal(send({ type: 'scene.delete', sceneId: 'house' }).ok, false);
  assert.equal(send({ type: 'cue.delete', cueId: 'one' }).ok, true);
  assert.equal(engine.snapshot().mode, 'manual');
  assert.equal(engine.snapshot().show.currentCueIndex, -1);
  assert.equal(send({ type: 'cue.delete', cueId: 'one' }).ok, false);
});

test('fixture and group edits support fades, virtual dimmer and explicit takeover', () => {
  const { clock, engine, send } = harness();
  send({ type: 'scene.activate', sceneId: 'house', fadeMs: 0 });
  send({ type: 'music.start' });
  assert.equal(send({ type: 'fixture.set', fixtureId: 'left', values: { red: 0 } }).ok, false);
  assert.equal(send({ type: 'group.set', groupId: 'all', values: { dimmer: .5 }, takeover: true }).ok, true);
  assert.equal(engine.snapshot().music.running, false);
  assert.equal(engine.tick()[0], Math.round(.85 * .5 * .82 * 255));
  send({ type: 'fixture.set', fixtureId: 'left', values: { red: 0 }, fadeMs: 1000 });
  clock.value = 500;
  assert.equal(engine.tick()[0], Math.round(.425 * .5 * .82 * 255));
  // Interruption starts at elapsed output even without a tick at the new time.
  clock.value = 750;
  send({ type: 'fixture.set', fixtureId: 'left', values: { red: 1 }, fadeMs: 1000 });
  assert.equal(engine.snapshot().fixtures.left.red, .21250000000000002);
  assert.equal(send({ type: 'group.set', groupId: 'all', values: { pan: .2 } }).ok, false);
  assert.equal(send({ type: 'fixture.set', fixtureId: 'missing', values: { red: .2 } }).ok, false);
});

test('identify expires, preserves base values and remains subordinate to blackout and master', () => {
  const { clock, engine, send } = harness();
  send({ type: 'scene.activate', sceneId: 'house', fadeMs: 0 });
  const baseline = engine.tick();
  send({ type: 'fixture.identify', fixtureId: 'left', durationMs: 100 });
  assert.equal(engine.tick()[0], Math.round(.82 * 255));
  assert.equal(engine.tick()[4], baseline[4]);
  send({ type: 'blackout.set', on: true });
  assert.equal(engine.tick()[0], 0);
  send({ type: 'blackout.set', on: false });
  send({ type: 'master.set', value: 0 });
  assert.equal(engine.tick()[0], 0);
  send({ type: 'master.set', value: .82 });
  clock.value = 100;
  assert.deepEqual(engine.tick(), baseline);
  assert.equal(engine.snapshot().identify, undefined);
});

test('music is output-only, repeatable and stale input cannot accumulate brightness', () => {
  const { clock, engine, send } = harness();
  send({ type: 'scene.activate', sceneId: 'house', fadeMs: 0 });
  const before = engine.snapshot().fixtures;
  send({ type: 'music.start' });
  assert.equal(engine.snapshot().music.source, 'none');
  assert.equal(engine.snapshot().music.stale, true);
  send({ type: 'audio.set', rms: .4, bass: .2, onset: false, source: 'simulated' });
  const frame = engine.tick();
  for (let i = 0; i < 100; i++) assert.deepEqual(engine.tick(), frame);
  assert.deepEqual(engine.snapshot().fixtures, before);
  assert.equal(engine.snapshot().music.source, 'simulated');
  clock.value = AUDIO_STALE_MS;
  assert.equal(engine.snapshot().music.stale, true);
  assert.equal(engine.tick()[0], Math.round(.85 * .82 * 255));
  assert.equal(engine.setAudio({ rms: .2, bass: 0, onset: false }).ok, true);
  assert.equal(engine.snapshot().music.source, 'external');
  assert.equal(engine.setAudio({ rms: Infinity, bass: 0, onset: false }).ok, false);
  send({ type: 'music.stop' });
  assert.deepEqual(engine.snapshot().fixtures, before);
});

function complexHarness(dimmer = false) {
  const attributes: Attribute[] = [...(dimmer ? ['dimmer' as const] : []), 'red', 'amber', 'uv', 'cct', 'pan', 'strobe', 'control'];
  const profile: FixtureProfile = { id: 'complex', manufacturer: 'Test', model: 'Test', source: 'custom', profileVersion: 1, modes: [{ id: 'mode', name: 'Mode', channelCount: attributes.length, channels: attributes.map((attribute, index) => ({ offset: index + 1, attribute, default: 0, ...(attribute === 'control' ? { ranges: [{ from: 100, to: 200, label: 'Reset', safe: false }] } : {}) })) }] };
  const engine = new LightingEngine({ clock: { now: () => 0 }, profiles: [profile], fixtures: [{ ...fixture, profileId: profile.id, modeId: 'mode' }], master: .5 });
  return { engine, attributes };
}

test('master scales all emitters, leaves CCT and motion alone, and blackout disables strobe', () => {
  const { engine } = complexHarness();
  assert.equal(engine.dispatch({ id: 'set', type: 'fixture.set', fixtureId: 'a', values: { red: 1, amber: 1, uv: 1, cct: .7, pan: .3, strobe: 1, control: 150 / 255 } }).ok, true);
  assert.deepEqual([...engine.tick().slice(0, 6)], [128, 128, 128, 179, 77, 255]);
  assert(engine.tick()[6] < 100 || engine.tick()[6] > 200);
  engine.dispatch({ id: 'master', type: 'master.set', value: 0 });
  assert.deepEqual([...engine.tick().slice(0, 3)], [0, 0, 0]);
  engine.dispatch({ id: 'blackout', type: 'blackout.set', on: true });
  assert.equal(engine.tick()[5], 0);
  assert.equal(engine.tick()[3], 179);
});

test('physical dimmer avoids applying master twice to its emitters', () => {
  const { engine } = complexHarness(true);
  engine.dispatch({ id: 'set', type: 'fixture.set', fixtureId: 'a', values: { dimmer: 1, red: 1, amber: 1, uv: 1 } });
  assert.deepEqual([...engine.tick().slice(0, 4)], [128, 255, 255, 255]);
  engine.dispatch({ id: 'blackout', type: 'blackout.set', on: true });
  assert.deepEqual([...engine.tick().slice(0, 4)], [0, 0, 0, 0]);
});

test('configuration exports are isolated; apply is validated and atomic and preserves blackout', () => {
  const { engine, send } = harness();
  const config = engine.exportConfiguration();
  config.roomName = 'Changed';
  assert.equal(engine.snapshot().controller.roomName, 'Detkin Lab');
  const before = engine.snapshot();
  assert.equal(engine.applyConfiguration({ ...config, fixtures: [{ ...config.fixtures[0], universe: 2 }] }).ok, false);
  assert.deepEqual(engine.snapshot(), before);
  send({ type: 'scene.activate', sceneId: 'house', fadeMs: 0 });
  send({ type: 'blackout.set', on: true });
  send({ type: 'music.start' });
  send({ type: 'fixture.identify', fixtureId: 'left' });
  assert.equal(engine.applyConfiguration(config).ok, true);
  assert.equal(engine.snapshot().blackout, true);
  assert.equal(engine.snapshot().mode, 'manual');
  assert.equal(engine.snapshot().identify, undefined);
  assert.equal(engine.snapshot().show.currentCueIndex, -1);
  assert.equal(engine.snapshot().music.source, 'none');
  assert.equal(engine.snapshot().controller.roomName, 'Changed');
  const fresh = new LightingEngine({ clock, configuration: engine.getConfiguration() });
  assert.deepEqual(fresh.exportConfiguration(), engine.exportConfiguration());
  const snapshot = engine.snapshot();
  snapshot.configuration.fixtures[0].address = 512;
  snapshot.fixtures.left.red = 1;
  assert.notEqual(engine.snapshot().configuration.fixtures[0].address, 512);
  assert.equal(engine.replaceConfiguration(engine.exportConfiguration()).ok, true);
});

test('rejected mode commands stay rejected on retry after takeover', () => {
  const { engine, send } = harness();
  send({ type: 'music.start' });
  const rejected = { type: 'scene.activate', id: 'mode-rejected', sceneId: 'house', fadeMs: 0 };
  const error = engine.dispatch(rejected);
  assert.deepEqual(error, { ok: false, code: 'MODE_ACTIVE', message: 'Take manual control to edit the current look.' });
  send({ type: 'music.stop' });
  const revision = engine.snapshot().revision;
  assert.deepEqual(engine.dispatch(rejected), error);
  assert.equal(engine.snapshot().revision, revision);
  assert.equal(engine.snapshot().activeSceneId, '');
});

test('virtual dimmer scenes survive save, export, apply and activation without losing colour', () => {
  const { engine, send } = harness();
  send({ type: 'scene.activate', sceneId: 'house', fadeMs: 0 });
  send({ type: 'group.set', groupId: 'all', values: { dimmer: .25 } });
  assert.equal(send({ type: 'scene.save', sceneId: 'quarter', name: 'Quarter' }).ok, true);
  const config = engine.exportConfiguration();
  assert.equal(config.scenes.find(s => s.id === 'quarter')!.values.left.dimmer, .25);
  assert.equal(engine.applyConfiguration(config).ok, true);
  assert.equal(send({ type: 'scene.activate', sceneId: 'quarter', fadeMs: 0 }).ok, true);
  assert.equal(engine.snapshot().fixtures.left.red, .85);
  assert.equal(engine.tick()[0], Math.round(.85 * .25 * .82 * 255));
  assert.equal(send({ type: 'fixture.identify', fixtureId: 'left' }).ok, true);
  assert.equal(engine.tick()[0], Math.round(.82 * 255));
});

test('safety ranges are enforced after fade and master with no upward intensity jump', () => {
  const clock = { value: 0, now() { return this.value; } };
  const profile: FixtureProfile = { id: 'safe', manufacturer: 'Test', model: 'Safe', source: 'custom', profileVersion: 1, modes: [{ id: 'safe', name: 'Safe', channelCount: 2, channels: [
    { offset: 1, attribute: 'red', default: 0, ranges: [{ from: 100, to: 200, label: 'Unsafe', safe: false }] },
    { offset: 2, attribute: 'control', default: 0, home: 255, blackoutValue: 0, ranges: [{ from: 100, to: 200, label: 'Reset', safe: false }] }
  ] }] };
  const engine = new LightingEngine({ clock, profiles: [profile], fixtures: [{ ...fixture, profileId: 'safe', modeId: 'safe' }], master: 1 });
  engine.dispatch({ id: 'fade', type: 'fixture.set', fixtureId: 'a', values: { red: 1, control: 1 }, fadeMs: 1000 });
  for (let time = 0; time <= 1000; time += 10) {
    clock.value = time;
    const frame = engine.tick();
    for (const byte of frame.slice(0, 2)) assert(byte < 100 || byte > 200);
    assert(frame[0] <= Math.round(time / 1000 * 255));
  }
  engine.dispatch({ id: 'half', type: 'master.set', value: .5 });
  assert(engine.tick()[0] < 100);
  engine.dispatch({ id: 'dark', type: 'blackout.set', on: true });
  assert.deepEqual([...engine.tick().slice(0, 2)], [0, 0]);
});
