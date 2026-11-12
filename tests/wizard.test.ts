import assert from 'node:assert/strict';
import test from 'node:test';
import { canCommit, colorCheck, newDraft, nextFreeAddress, validateAddress, validatePin, virtualProbe } from '../packages/engine/src/wizard.js';
import { genericProfiles } from '../packages/engine/src/index.js';

const fixture = { id: 'a', name: 'Left PAR', profileId: 'generic-rgbw', modeId: 'rgbw-4', universe: 1, address: 1, groupIds: [], enabled: true };
test('wizard rejects weak pins and accepts a real setup pin', () => { assert.equal(validatePin('123456'), 'That PIN is too easy to guess.'); assert.equal(validatePin('111111'), 'Use more than one distinct digit.'); assert.equal(validatePin('314159'), null); });
test('wizard suggests the first gap that fits', () => { assert.equal(nextFreeAddress([fixture, { ...fixture, id: 'b', name: 'Right PAR', address: 9 }], genericProfiles, 4), 5); });
test('wizard address validation explains the problem', () => { const outOfRange = validateAddress('507', 7, [], genericProfiles); const invalid = validateAddress('1.5', 4, [], genericProfiles); const valid = validateAddress('015', 4, [], genericProfiles); assert.equal(outOfRange.ok, false); assert.equal(invalid.ok, false); assert.equal(valid.ok, true); if (!outOfRange.ok) assert.equal(outOfRange.code, 'ADDRESS_OUT_OF_RANGE'); if (!invalid.ok) assert.equal(invalid.code, 'VALIDATION'); if (valid.ok) assert.equal(valid.address, 15); });
test('virtual room distinguishes success, wrong mode, and unpowered', () => { const light = { id: 'a', actualAddress: 15, channelCount: 4, powered: true, cabled: true, colorOrder: 'rgb' as const }; assert.equal(virtualProbe(light, 15, 4).result, 'flashed'); assert.equal(virtualProbe(light, 15, 7).result, 'different'); assert.equal(virtualProbe({ ...light, powered: false }, 15, 4).result, 'nothing'); assert.deepEqual(colorCheck('grb'), ['red', 'blue', 'green']); });
test('draft does not commit until it has a light and room', () => { const draft = newDraft('s1'); assert.equal(canCommit(draft).ok, false); draft.fixtures.push(fixture); assert.equal(canCommit(draft).ok, true); });
