import { PatchedFixture as FixtureSchema, ProfileMode, type FixtureProfile, type PatchedFixture } from '../../protocol/src/index.js';

export type WizardStep = 'welcome' | 'pin' | 'room' | 'output' | 'type' | 'mode' | 'address' | 'set-on-light' | 'test' | 'color-check' | 'name-place' | 'groups' | 'presets' | 'music' | 'review' | 'done';
export type WizardDraft = { id: string; ownerSessionId: string; step: WizardStep; roomName: string; output: { kind: 'simulator' | 'sacn' | 'artnet' | 'usb-dmx'; target?: string }; fixtures: PatchedFixture[]; completedTests: string[]; checkedItems: string[]; warnings: string[]; revision: number; startedAt: string };
type Mode = FixtureProfile['modes'][number];
export type VirtualLight = { id: string; actualAddress: number; channelCount: number; powered: boolean; cabled: boolean; colorOrder: 'rgb' | 'grb' | 'brg'; actualMode?: Mode; universe?: 1 };
export type VirtualLightState = { id: string; red: number; green: number; blue: number; white: number; dimmer: number; lit: boolean };

export function newDraft(sessionId: string, now = new Date().toISOString()): WizardDraft {
  return { id: `draft-${Math.random().toString(36).slice(2, 10)}`, ownerSessionId: sessionId, step: 'welcome', roomName: 'Detkin Lab', output: { kind: 'simulator' }, fixtures: [], completedTests: [], checkedItems: [], warnings: [], revision: 1, startedAt: now };
}
export function validatePin(pin: string): string | null {
  if (typeof pin !== 'string' || !/^[0-9]{6,12}$/.test(pin)) return 'Use 6–12 digits.';
  if (/^(\d)\1+$/.test(pin)) return 'Use more than one distinct digit.';
  const digits = [...pin].map(Number);
  if ([1, 9].some(delta => digits.slice(1).every((digit, i) => (digit - digits[i] + 10) % 10 === delta))) return 'That PIN is too easy to guess.';
  return null;
}
export function validateRoomName(name: string): string | null {
  return typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 40 ? 'Room name must be 1–40 characters.' : null;
}
export function validateFixtureName(name: string): string | null {
  return typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 32 ? 'Light name must be 1–32 characters.' : null;
}
function validCount(count: number): boolean { return Number.isInteger(count) && count >= 1 && count <= 512; }
function validRange(address: number, count: number): boolean { return Number.isInteger(address) && address >= 1 && validCount(count) && address + count - 1 <= 512; }
function rangesFor(fixtures: PatchedFixture[], profiles: FixtureProfile[]) {
  const ranges: { start: number; end: number; name: string }[] = [];
  for (const fixture of fixtures) {
    const mode = profiles.find(p => p.id === fixture.profileId)?.modes.find(m => m.id === fixture.modeId);
    if (fixture.universe !== 1 || !mode || !validRange(fixture.address, mode.channelCount)) return null;
    if (!fixture.enabled) continue;
    ranges.push({ start: fixture.address, end: fixture.address + mode.channelCount - 1, name: fixture.name });
  }
  return ranges;
}
export function nextFreeAddress(fixtures: PatchedFixture[], profiles: FixtureProfile[], channelCount: number): number {
  if (!validCount(channelCount)) return -1;
  const ranges = rangesFor(fixtures, profiles);
  if (!ranges) return -1;
  for (let address = 1; address <= 513 - channelCount; address++) {
    if (!ranges.some(r => address <= r.end && r.start < address + channelCount)) return address;
  }
  return -1;
}
export function validateAddress(addressText: string, channelCount: number, fixtures: PatchedFixture[], profiles: FixtureProfile[]): { ok: true; address: number } | { ok: false; code: string; message: string } {
  if (!validCount(channelCount)) return { ok: false, code: 'VALIDATION', message: 'Choose a mode with 1–512 whole channels.' };
  if (typeof addressText !== 'string' || !/^[0-9]+$/.test(addressText.trim())) return { ok: false, code: 'VALIDATION', message: 'Enter a whole number.' };
  const address = Number(addressText);
  if (!validRange(address, channelCount)) return { ok: false, code: 'ADDRESS_OUT_OF_RANGE', message: `This light needs ${channelCount} channels, so its address must be from 1 to ${513 - channelCount}.` };
  const ranges = rangesFor(fixtures, profiles);
  if (!ranges) return { ok: false, code: 'PROFILE_INVALID', message: 'Fix the existing lights’ profiles, modes, addresses, and universe first.' };
  const conflict = ranges.find(r => address <= r.end && r.start < address + channelCount);
  const next = conflict && nextFreeAddress(fixtures, profiles, channelCount);
  return conflict ? { ok: false, code: 'ADDRESS_OVERLAP', message: `This overlaps ${conflict.name}. Next free address: ${next === -1 ? 'none' : next}.` } : { ok: true, address };
}
export function virtualProbe(light: VirtualLight, typedAddress: number, typedChannelCount: number): { result: 'flashed' | 'nothing' | 'different' | 'multiple'; reason: string } {
  if (!light.powered || !light.cabled) return { result: 'nothing', reason: !light.powered ? 'The light is not powered.' : 'A cable break is before this light.' };
  if ((light.universe ?? 1) !== 1 || !validRange(typedAddress, typedChannelCount) || !validRange(light.actualAddress, light.actualMode?.channelCount ?? light.channelCount)) return { result: 'nothing', reason: 'The light or probe has an invalid address, mode, or universe.' };
  if (typedAddress === light.actualAddress) return typedChannelCount === (light.actualMode?.channelCount ?? light.channelCount)
    ? { result: 'flashed', reason: 'The addressed light received the safe white probe.' }
    : { result: 'different', reason: 'The light responded, but its mode channel count differs.' };
  return { result: 'nothing', reason: 'No light at the entered address responded.' };
}
export function colorCheck(order: VirtualLight['colorOrder']): string[] {
  return [...order].map(channel => ({ r: 'red', g: 'green', b: 'blue' })[channel]!);
}

/** Decode the physical fixture, independent of the controller's logical patch. Frames have no start-code byte. */
export function decodeVirtualFrame(frame: Uint8Array, lights: readonly VirtualLight[]): VirtualLightState[] {
  if (frame.length !== 512) throw new RangeError('A DMX universe frame must contain exactly 512 bytes.');
  return lights.map(light => {
    const dark: VirtualLightState = { id: light.id, red: 0, green: 0, blue: 0, white: 0, dimmer: 0, lit: false };
    const count = light.actualMode?.channelCount ?? light.channelCount;
    if (light.actualMode && !ProfileMode.safeParse(light.actualMode).success) return dark;
    if (!light.powered || !light.cabled || (light.universe ?? 1) !== 1 || !validRange(light.actualAddress, count)) return dark;
    const fallback: Record<number, string[]> = { 1: ['dimmer'], 3: ['red', 'green', 'blue'], 4: ['red', 'green', 'blue', 'white'], 7: ['dimmer', 'red', 'green', 'blue', 'white', 'strobe', 'control'] };
    const channels = light.actualMode?.channels ?? fallback[count]?.map((attribute, i) => ({ attribute, offset: i + 1 }));
    if (!channels || channels.some(c => !Number.isInteger(c.offset) || c.offset < 1 || c.offset > count)) return dark;
    const values: Record<string, number> = {};
    for (const channel of channels) values[channel.attribute] = frame[light.actualAddress + channel.offset - 2];
    const dimmer = values.dimmer ?? 255;
    const rgb = [values.red ?? 0, values.green ?? 0, values.blue ?? 0];
    const colors = colorCheck(light.colorOrder);
    const state = { ...dark, dimmer };
    colors.forEach((color, i) => { state[color as 'red' | 'green' | 'blue'] = Math.round(rgb[i] * dimmer / 255); });
    state.white = Math.round((values.white ?? (count === 1 ? 255 : 0)) * dimmer / 255);
    state.lit = state.red > 0 || state.green > 0 || state.blue > 0 || state.white > 0;
    return state;
  });
}
export class VirtualRoom {
  readonly lights: VirtualLight[];
  constructor(lights: VirtualLight[] = []) { this.lights = structuredClone(lights); }
  decode(frame: Uint8Array): VirtualLightState[] { return decodeVirtualFrame(frame, this.lights); }
  render(frame: Uint8Array): VirtualLightState[] { return this.decode(frame); }
  probe(id: string, address: number, channelCount: number) {
    const light = this.lights.find(light => light.id === id);
    if (!light) return { result: 'nothing' as const, reason: 'Light not found.' };
    const result = virtualProbe(light, address, channelCount);
    const responders = this.lights.filter(candidate => virtualProbe(candidate, address, channelCount).result === 'flashed');
    return result.result === 'flashed' && responders.length > 1 ? { result: 'multiple' as const, reason: 'Multiple lights share this address and mode.' } : result;
  }
}
export function canCommit(draft: WizardDraft, profiles?: FixtureProfile[]): { ok: true } | { ok: false; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const roomError = validateRoomName(draft.roomName);
  if (roomError) errors.push(roomError);
  if (!draft.fixtures.length) errors.push('Add at least one light.');
  if (draft.fixtures.some(f => !FixtureSchema.safeParse(f).success)) errors.push('Fix invalid light names, addresses, or universe.');
  if (new Set(draft.fixtures.map(f => f.id)).size !== draft.fixtures.length) errors.push('Light IDs must be unique.');
  if (profiles) {
    const ranges = rangesFor(draft.fixtures, profiles);
    if (!ranges) errors.push('Fix invalid profiles, modes, or channel ranges.');
    else if (ranges.some((r, i) => ranges.slice(0, i).some(other => r.start <= other.end && other.start <= r.end))) errors.push('Light addresses overlap.');
  }
  const warnings = draft.fixtures.filter(f => f.enabled && !draft.completedTests.includes(f.id)).map(f => `${f.name} has not passed its light test.`);
  return errors.length ? { ok: false, errors, warnings } : { ok: true };
}
