import assert from 'node:assert/strict';
import test from 'node:test';
import { LightingEngine, genericProfiles, validatePatch } from '../packages/engine/src/index.js';

const clock = { value: 0, now() { return this.value; } };
test('validates patch range and overlap without channel arithmetic in the UI', () => {
  const base = { id: 'a', name: 'A', profileId: 'generic-rgbw', modeId: 'rgbw-4', universe: 1, address: 1, groupIds: [], enabled: true };
  assert.deepEqual(validatePatch([base], genericProfiles), { ok: true });
  assert.equal(validatePatch([{ ...base, address: 4 }, { ...base, id: 'b', name: 'B', address: 7 }], genericProfiles).ok, false);
  assert.equal(validatePatch([{ ...base, address: 510 }], genericProfiles).ok, false);
});
test('creates exact 512-byte frames and maps normalized attributes', () => {
  const engine = new LightingEngine({ clock });
  engine.dispatch({ type: 'scene.activate', id: 'scene-1', sceneId: 'house', fadeMs: 0, groupIds: [], takeover: false });
  const frame = engine.tick();
  assert.equal(frame.length, 512); assert.equal(frame[0], Math.round(.85 * .82 * 255)); assert.equal(frame[3], Math.round(.4 * .82 * 255));
});
test('fade uses elapsed time and blackout wins over later ticks', () => {
  const engine = new LightingEngine({ clock });
  engine.dispatch({ type: 'scene.activate', id: 'fade-1', sceneId: 'house', fadeMs: 1000, groupIds: [], takeover: false });
  clock.value = 500; const mid = engine.tick(); assert(mid[0] > 0 && mid[0] < 200);
  engine.dispatch({ type: 'blackout.set', id: 'blackout-1', on: true });
  const dark = engine.tick(); assert.equal(dark[0], 0); assert.equal(dark[1], 0);
});
test('duplicate command ids are idempotent', () => {
  const engine = new LightingEngine({ clock });
  const first = engine.dispatch({ type: 'master.set', id: 'same', value: .4 }); const second = engine.dispatch({ type: 'master.set', id: 'same', value: .9 });
  assert.deepEqual(first, second); assert.equal(engine.snapshot().master, .4);
});
