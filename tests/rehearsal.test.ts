import test from 'node:test';
import assert from 'node:assert/strict';
import { LightingEngine } from '../packages/engine/src/index.js';

test('24 simulated hours preserve frame bounds, blackout and scene levels across command history eviction', () => {
  let now = 0;
  const engine = new LightingEngine({ clock: { now: () => now } });
  assert.equal(engine.dispatch({ type: 'scene.activate', id: 'start', sceneId: 'house', fadeMs: 0 }).ok, true);
  for (let second = 0; second < 86400; second++) {
    now = second * 1000;
    const master = (second % 101) / 100;
    assert.equal(engine.dispatch({ type: 'master.set', id: `master-${second}`, value: master }).ok, true);
    const dark = second % 17 === 0;
    assert.equal(engine.dispatch({ type: 'blackout.set', id: `blackout-${second}`, on: dark }).ok, true);
    const frame = engine.tick();
    assert.equal(frame.length, 512);
    if (dark) assert(frame.every(value => value === 0));
    else assert.equal(frame[0], Math.round(.85 * master * 255));
  }
  assert.equal(engine.snapshot().mode, 'manual');
});
