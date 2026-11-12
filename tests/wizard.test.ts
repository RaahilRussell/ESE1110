import assert from 'node:assert/strict';
import test from 'node:test';
import { canCommit, colorCheck, decodeVirtualFrame, newDraft, nextFreeAddress, validateAddress, validateFixtureName, validatePin, validateRoomName, VirtualRoom, virtualProbe, type VirtualLight } from '../packages/engine/src/wizard.js';
import { genericProfiles } from '../packages/engine/src/index.js';
import type { FixtureProfile, PatchedFixture } from '../packages/protocol/src/index.js';

const fixture: PatchedFixture = { id: 'a', name: 'Left PAR', profileId: 'generic-rgbw', modeId: 'rgbw-4', universe: 1, address: 1, groupIds: [], enabled: true };
const light: VirtualLight = { id: 'a', actualAddress: 15, channelCount: 4, powered: true, cabled: true, colorOrder: 'rgb' };
function random(seed: number) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; }; }

test('PIN validation rejects malformed and sequential PINs at every length', () => {
  for (const pin of ['', '12345', '1234567890123', ' 314159', '314159\n', '３１４１５９', '٣١٤١٥٩', '+314159', '31415a']) assert.notEqual(validatePin(pin), null, pin);
  for (let length = 6; length <= 12; length++) for (let start = 0; start < 10; start++) {
    assert.notEqual(validatePin(String(start).repeat(length)), null);
    for (const step of [1, -1]) assert.notEqual(validatePin(Array.from({ length }, (_, i) => String((start + step * i + 20) % 10)).join('')), null);
  }
  for (const pin of ['314159', '027183', '012394', '1234560', '314159265358']) assert.equal(validatePin(pin), null);
});
test('room and fixture names enforce trimmed protocol lengths', () => {
  for (const [validate, limit] of [[validateRoomName, 40], [validateFixtureName, 32]] as const) {
    for (const name of ['', ' ', '\t\n', 'x'.repeat(limit + 1)]) assert.notEqual(validate(name), null);
    for (const name of ['A', `  ${'x'.repeat(limit)}  `, 'Detkin – 灯光']) assert.equal(validate(name), null);
  }
});
test('address bounds include slot512 and reject malformed numbers or channel counts', () => {
  for (const text of ['', ' ', '1.5', '1e2', '0x10', '+1', '-1', '１２', '1\n2', 'Infinity']) assert.equal(validateAddress(text, 4, [], genericProfiles).ok, false, text);
  for (const text of ['0', '513', '99999999999999999999999']) assert.equal(validateAddress(text, 1, [], genericProfiles).ok, false);
  for (const count of [0, -1, .5, 513, NaN, Infinity]) {
    assert.equal(validateAddress('1', count, [], genericProfiles).ok, false);
    assert.equal(nextFreeAddress([], genericProfiles, count), -1);
  }
  assert.deepEqual(validateAddress(' 00509 ', 4, [], genericProfiles), { ok: true, address: 509 });
  assert.deepEqual(validateAddress('512', 1, [], genericProfiles), { ok: true, address: 512 });
  assert.deepEqual(validateAddress('1', 512, [], genericProfiles), { ok: true, address: 1 });
  assert.equal(validateAddress('510', 4, [], genericProfiles).ok, false);
});
test('free address search handles gaps, disabled fixtures, missing profiles, and a full universe', () => {
  assert.equal(nextFreeAddress([fixture, { ...fixture, id: 'b', address: 9 }], genericProfiles, 4), 5);
  assert.equal(nextFreeAddress([{ ...fixture, enabled: false }], genericProfiles, 4), 1);
  assert.equal(nextFreeAddress([{ ...fixture, profileId: 'missing' }], genericProfiles, 4), -1);
  assert.equal(validateAddress('20', 4, [{ ...fixture, profileId: 'missing' }], genericProfiles).ok, false);
  const full = Array.from({ length: 128 }, (_, i) => ({ ...fixture, id: `f${i}`, address: i * 4 + 1 }));
  const conflict = validateAddress('1', 4, full, genericProfiles);
  assert.equal(nextFreeAddress(full, genericProfiles, 4), -1);
  assert.equal(conflict.ok, false);
  if (!conflict.ok) { assert.equal(conflict.code, 'ADDRESS_OVERLAP'); assert.match(conflict.message, /Next free address: none/); }
});
test('randomized first-fit and overlap validation agree with a slot occupancy oracle', () => {
  const rand = random(0xc0ffee);
  for (let trial = 0; trial < 1500; trial++) {
    const fixtures = Array.from({ length: Math.floor(rand() * 90) }, (_, i) => ({ ...fixture, id: `f${i}`, address: 1 + Math.floor(rand() * 509), enabled: rand() > .2 }));
    const occupied = new Set(fixtures.filter(f => f.enabled).flatMap(f => Array.from({ length: 4 }, (_, i) => f.address + i)));
    const count = 1 + Math.floor(rand() * 512);
    const fits = (address: number) => Array.from({ length: count }, (_, i) => address + i).every(slot => !occupied.has(slot));
    const expected = Array.from({ length: 513 - count }, (_, i) => i + 1).find(fits) ?? -1;
    assert.equal(nextFreeAddress(fixtures, genericProfiles, count), expected, `seed c0ffee trial ${trial}`);
    const address = 1 + Math.floor(rand() * 512);
    const result = validateAddress(String(address), count, fixtures, genericProfiles);
    assert.equal(result.ok, address + count - 1 <= 512 && fits(address));
  }
});
test('physical decoder uses actual address and mode offsets, with no DMX start byte', () => {
  const frame = new Uint8Array(512); frame.set([11, 22, 33, 44], 14); frame.set([200, 201, 202, 203], 0);
  assert.deepEqual(decodeVirtualFrame(frame, [light])[0], { id: 'a', red: 11, green: 22, blue: 33, white: 44, dimmer: 255, lit: true });
  const actualMode: FixtureProfile['modes'][number] = { id: 'custom', name: 'Custom', channelCount: 8, channels: [
    { attribute: 'blue', offset: 1, default: 255 }, { attribute: 'red', offset: 8, default: 255 }, { attribute: 'green', offset: 5, default: 255 }, { attribute: 'dimmer', offset: 3, default: 255 }
  ] };
  const custom = { ...light, actualAddress: 505, actualMode };
  frame[504] = 90; frame[511] = 60; frame[508] = 30; frame[506] = 85;
  assert.deepEqual(decodeVirtualFrame(frame, [custom])[0], { id: 'a', red: 20, green: 10, blue: 30, white: 0, dimmer: 85, lit: true });
});
test('color checks report physical colors for red, green, blue channel tests', () => {
  assert.deepEqual(colorCheck('rgb'), ['red', 'green', 'blue']);
  assert.deepEqual(colorCheck('grb'), ['green', 'red', 'blue']);
  assert.deepEqual(colorCheck('brg'), ['blue', 'red', 'green']);
  for (const order of ['rgb', 'grb', 'brg'] as const) for (let channel = 0; channel < 3; channel++) {
    const frame = new Uint8Array(512); frame[14 + channel] = 255;
    const state = decodeVirtualFrame(frame, [{ ...light, colorOrder: order }])[0];
    for (const color of ['red', 'green', 'blue'] as const) assert.equal(state[color], color === colorCheck(order)[channel] ? 255 : 0);
  }
});
test('power, cable, unknown modes, invalid physical ranges and universe fail dark', () => {
  const frame = new Uint8Array(512).fill(255);
  for (const changes of [{ powered: false }, { cabled: false }, { actualAddress: 510 }, { actualAddress: 0 }, { actualAddress: 1.5 }, { channelCount: 2 }, { channelCount: NaN }, { universe: 2 }]) {
    const physical = { ...light, ...changes } as VirtualLight;
    assert.equal(decodeVirtualFrame(frame, [physical])[0].lit, false);
  }
  for (const length of [0, 511, 513]) assert.throws(() => decodeVirtualFrame(new Uint8Array(length), [light]), RangeError);
  const end = decodeVirtualFrame(frame, [{ ...light, actualAddress: 512, channelCount: 1 }])[0];
  assert.equal(end.white, 255);
});
test('adversarial random frames agree with independent physical fixture oracle', () => {
  const rand = random(0x1234abcd);
  const orders = ['rgb', 'grb', 'brg'] as const;
  for (let trial = 0; trial < 2000; trial++) {
    const frame = Uint8Array.from({ length: 512 }, () => Math.floor(rand() * 256));
    const count = [1, 3, 4, 7][Math.floor(rand() * 4)];
    const physical: VirtualLight = { id: `f${trial}`, actualAddress: 1 + Math.floor(rand() * (513 - count)), channelCount: count, colorOrder: orders[Math.floor(rand() * 3)], powered: rand() > .15, cabled: rand() > .15 };
    const on = physical.powered && physical.cabled;
    const bytes = Array.from(frame.slice(physical.actualAddress - 1, physical.actualAddress - 1 + count));
    const dimmer = on ? count === 1 || count === 7 ? bytes[0] : 255 : 0;
    const rgbStart = count === 7 ? 1 : 0;
    const expected = { id: physical.id, red: 0, green: 0, blue: 0, white: 0, dimmer, lit: false };
    if (on) {
      if (count === 1) expected.white = bytes[0];
      else {
        for (const color of ['red', 'green', 'blue'] as const) expected[color] = Math.round(bytes[rgbStart + physical.colorOrder.indexOf(color[0])] * dimmer / 255);
        expected.white = count === 3 ? 0 : Math.round(bytes[rgbStart + 3] * dimmer / 255);
      }
    }
    expected.lit = expected.red + expected.green + expected.blue + expected.white > 0;
    assert.deepEqual(decodeVirtualFrame(frame, [physical])[0], expected, `seed1234abcd trial ${trial}`);
  }
});
test('VirtualRoom probes distinguish duplicates, wrong modes, power and cable faults', () => {
  const room = new VirtualRoom([light, { ...light, id: 'b' }]);
  assert.equal(room.probe('a', 15, 4).result, 'multiple');
  assert.equal(room.probe('a', 15, 7).result, 'different');
  assert.equal(room.probe('a', 1, 4).result, 'nothing');
  assert.equal(room.probe('missing', 15, 4).result, 'nothing');
  assert.equal(virtualProbe({ ...light, powered: false }, 15, 4).result, 'nothing');
  assert.equal(virtualProbe({ ...light, cabled: false }, 15, 4).result, 'nothing');
  assert.equal(virtualProbe(light, 15, 4).result, 'flashed');
  assert.equal(virtualProbe(light, 15, NaN).result, 'nothing');
  const frame = new Uint8Array(512).fill(255);
  assert.deepEqual(room.decode(frame), room.render(frame));
});
test('commit validates names, IDs, universe1, profiles and overlaps', () => {
  const draft = newDraft('s1', '2026-11-11T00:00:00.000Z');
  assert.equal(canCommit(draft).ok, false);
  draft.fixtures.push(fixture);
  assert.equal(canCommit(draft, genericProfiles).ok, true);
  for (const roomName of ['', 'x'.repeat(41)]) assert.equal(canCommit({ ...draft, roomName }).ok, false);
  for (const change of [{ name: ' ' }, { name: 'x'.repeat(33) }, { universe: 2 }, { address: 0 }]) assert.equal(canCommit({ ...draft, fixtures: [{ ...fixture, ...change } as PatchedFixture] }).ok, false);
  assert.equal(canCommit({ ...draft, fixtures: [fixture, fixture] }).ok, false);
  assert.equal(canCommit({ ...draft, fixtures: [{ ...fixture, profileId: 'missing' }] }, genericProfiles).ok, false);
  assert.equal(canCommit({ ...draft, fixtures: [fixture, { ...fixture, id: 'b', address: 4 }] }, genericProfiles).ok, false);
});

test('random custom modes decode shuffled sparse offsets and ignore control-channel decoys', () => {
  const rand = random(0xbadc0de);
  for (let trial = 0; trial < 1000; trial++) {
    const count = 6 + Math.floor(rand() * 507);
    const offsets = Array.from({ length: count }, (_, i) => i + 1);
    for (let i = offsets.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [offsets[i], offsets[j]] = [offsets[j], offsets[i]]; }
    const attrs = ['red', 'green', 'blue', 'white', 'dimmer', 'control'] as const;
    const actualMode: FixtureProfile['modes'][number] = { id: 'random', name: 'Random', channelCount: count, channels: attrs.map((attribute, i) => ({ attribute, offset: offsets[i], default: 0 })) };
    const physical: VirtualLight = { ...light, actualAddress: 1 + Math.floor(rand() * (513 - count)), channelCount: 4, actualMode, colorOrder: ['rgb', 'grb', 'brg'][trial % 3] as VirtualLight['colorOrder'] };
    const frame = Uint8Array.from({ length: 512 }, () => Math.floor(rand() * 256));
    const read = (attribute: typeof attrs[number]) => frame[physical.actualAddress - 1 + offsets[attrs.indexOf(attribute)] - 1];
    const expected = { id: 'a', red: 0, green: 0, blue: 0, white: Math.round(read('white') * read('dimmer') / 255), dimmer: read('dimmer'), lit: false };
    for (const color of ['red', 'green', 'blue'] as const) {
      const inputColor = (['red', 'green', 'blue'] as const)[physical.colorOrder.indexOf(color[0])];
      expected[color] = Math.round(read(inputColor) * read('dimmer') / 255);
    }
    expected.lit = expected.red + expected.green + expected.blue + expected.white > 0;
    assert.deepEqual(decodeVirtualFrame(frame, [physical])[0], expected, `seedbadc0de trial ${trial}`);
    frame[physical.actualAddress + offsets[5] - 2] ^= 255;
    assert.deepEqual(decodeVirtualFrame(frame, [physical])[0], expected);
  }
});
test('malformed modes fail dark and no output leaks between frames or neighboring lights', () => {
  const invalidMode: FixtureProfile['modes'][number] = { id: 'bad', name: 'Bad', channelCount: 4, channels: [
    { attribute: 'red', offset: 1, default: 0 }, { attribute: 'green', offset: 1, default: 0 }
  ] };
  assert.equal(decodeVirtualFrame(new Uint8Array(512).fill(255), [{ ...light, actualMode: invalidMode }])[0].lit, false);
  const lights = [{ ...light }, { ...light, id: 'next', actualAddress: 19 }];
  const room = new VirtualRoom(lights);
  lights[0].actualAddress = 1;
  const frame = new Uint8Array(512); frame[14] = 255;
  assert.deepEqual(room.decode(frame).map(state => state.lit), [true, false]);
  assert.deepEqual(room.decode(new Uint8Array(512)).map(state => state.lit), [false, false]);
  const seven = { ...light, channelCount: 7 };
  frame.fill(0); frame.set([0, 255, 255, 255, 255, 255, 255], 14);
  assert.equal(decodeVirtualFrame(frame, [seven])[0].lit, false);
  frame[14] = 128;
  assert.equal(decodeVirtualFrame(frame, [seven])[0].red, 128);
});
