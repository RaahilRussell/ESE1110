import type { Attribute, Command, FixtureProfile, PatchedFixture, Scene, Snapshot } from '../../protocol/src/index.js';

export type Clock = { now(): number };
export const SYSTEM_ATTRIBUTES = new Set<Attribute>(['dimmer', 'red', 'green', 'blue', 'white', 'amber', 'uv', 'cct']);

export const genericProfiles: FixtureProfile[] = [{ id: 'generic-rgbw', manufacturer: 'Flashify', model: 'Generic RGBW', source: 'builtin', profileVersion: 1, modes: [{ id: 'rgbw-4', name: 'RGBW 4-channel', channelCount: 4, channels: [
  { offset: 1, attribute: 'red', default: 0, blackoutValue: 0 }, { offset: 2, attribute: 'green', default: 0, blackoutValue: 0 }, { offset: 3, attribute: 'blue', default: 0, blackoutValue: 0 }, { offset: 4, attribute: 'white', default: 0, blackoutValue: 0 }
] }] }, { id: 'generic-dimmer', manufacturer: 'Flashify', model: 'Generic Dimmer', source: 'builtin', profileVersion: 1, modes: [{ id: 'dimmer-1', name: 'Dimmer 1-channel', channelCount: 1, channels: [{ offset: 1, attribute: 'dimmer', default: 0, blackoutValue: 0 }] }] }];

export function validatePatch(fixtures: PatchedFixture[], profiles: FixtureProfile[]): { ok: true } | { ok: false; code: string; message: string; details?: unknown } {
  const ranges: Array<{ start: number; end: number; fixture: string }> = [];
  for (const fixture of fixtures) {
    if (!fixture.enabled) continue;
    const profile = profiles.find(p => p.id === fixture.profileId); const mode = profile?.modes.find(m => m.id === fixture.modeId);
    if (!mode) return { ok: false, code: 'PROFILE_INVALID', message: `Profile or mode is missing for ${fixture.name}.` };
    if (fixture.address + mode.channelCount - 1 > 512) return { ok: false, code: 'ADDRESS_OUT_OF_RANGE', message: `${fixture.name} needs ${mode.channelCount} channels, so its address can be at most ${513 - mode.channelCount}.` };
    const range = { start: fixture.address, end: fixture.address + mode.channelCount - 1, fixture: fixture.name };
    const collision = ranges.find(r => r.start <= range.end && range.start <= r.end);
    if (collision) return { ok: false, code: 'ADDRESS_OVERLAP', message: `Channels ${range.start}–${range.end} overlap ${collision.fixture} (channels ${collision.start}–${collision.end}).`, details: { fixture: fixture.name, other: collision.fixture } };
    ranges.push(range);
  }
  return { ok: true };
}

function clamp(value: number) { return Math.max(0, Math.min(1, value)); }
function interpolate(a: number, b: number, p: number) { return a + (b - a) * p; }

export class LightingEngine {
  private readonly clock: Clock; private readonly profiles: FixtureProfile[]; private fixtures: PatchedFixture[]; private scenes: Scene[];
  private values: Record<string, Record<string, number>> = {}; private fade?: { from: Record<string, Record<string, number>>; to: Record<string, Record<string, number>>; started: number; duration: number };
  private seen = new Set<string>(); private revision = 1; private mode: Snapshot['mode'] = 'manual'; private blackout = false; private master = 0.82; private activeSceneId = 'house'; private cueIndex = 0; private music = { running: false, rms: 0, bass: 0, onset: false };
  constructor(options: { clock: Clock; profiles?: FixtureProfile[]; fixtures?: PatchedFixture[]; scenes?: Scene[] }) { this.clock = options.clock; this.profiles = options.profiles ?? genericProfiles; this.fixtures = options.fixtures ?? [{ id: 'left', name: 'Left PAR', profileId: 'generic-rgbw', modeId: 'rgbw-4', universe: 1, address: 1, groupIds: ['all', 'left'], enabled: true }, { id: 'right', name: 'Right PAR', profileId: 'generic-rgbw', modeId: 'rgbw-4', universe: 1, address: 5, groupIds: ['all', 'right'], enabled: true }]; this.scenes = options.scenes ?? [{ id: 'house', name: 'House', builtin: true, values: { left: { red: .85, green: .55, blue: .25, white: .4 }, right: { red: .85, green: .55, blue: .25, white: .4 } }, clearOthers: false, revision: 1 }]; for (const f of this.fixtures) this.values[f.id] = {}; }
  dispatch(command: Command): { ok: true; revision: number } | { ok: false; code: string; message: string } { if (this.seen.has(command.id)) return { ok: true, revision: this.revision }; this.seen.add(command.id); switch (command.type) {
    case 'master.set': this.master = command.value; break;
    case 'blackout.set': this.blackout = command.on; if (!command.on) this.mode = 'manual'; break;
    case 'scene.activate': { const scene = this.scenes.find(s => s.id === command.sceneId); if (!scene) return { ok: false, code: 'NOT_FOUND', message: 'Scene not found.' }; if (this.mode !== 'manual' && !command.takeover) return { ok: false, code: 'MODE_ACTIVE', message: 'Take manual control to edit the current look.' }; this.mode = 'manual'; this.activeSceneId = scene.id; const from = structuredClone(this.values); const to = structuredClone(this.values); for (const [fixtureId, attrs] of Object.entries(scene.values)) { for (const [attribute, value] of Object.entries(attrs)) (to[fixtureId] ??= {})[attribute] = clamp(value as number); } this.fade = { from, to, started: this.clock.now(), duration: command.fadeMs }; if (command.fadeMs === 0) this.values = to; break; }
    case 'show.go': this.mode = 'show'; this.cueIndex++; break;
    case 'show.back': this.mode = 'show'; this.cueIndex = Math.max(0, this.cueIndex - 1); break;
    case 'show.stop': this.mode = 'manual'; break;
    case 'music.start': this.mode = 'music'; this.music.running = true; break;
    case 'music.stop': this.mode = 'manual'; this.music.running = false; break;
  } this.revision++; return { ok: true, revision: this.revision }; }
  setAudio(features: { rms: number; bass: number; onset: boolean }) { this.music = { ...features, running: this.music.running }; }
  tick(now = this.clock.now()): Uint8Array { if (this.fade) { const progress = this.fade.duration === 0 ? 1 : clamp((now - this.fade.started) / this.fade.duration); const next: typeof this.values = {}; for (const [id, attrs] of Object.entries(this.fade.from)) { next[id] = {}; for (const key of new Set([...Object.keys(attrs), ...Object.keys(this.fade.to[id] ?? {})])) next[id][key] = interpolate(attrs[key] ?? 0, this.fade.to[id]?.[key] ?? attrs[key] ?? 0, progress); } this.values = next; if (progress >= 1) this.fade = undefined; }
    if (this.mode === 'music' && this.music.running) { const envelope = this.music.onset ? 1 : this.music.rms; for (const id of Object.keys(this.values)) { const base = this.values[id]; for (const attr of SYSTEM_ATTRIBUTES) if (base[attr] !== undefined) base[attr] = clamp(base[attr] + envelope * .35); } }
    const frame = new Uint8Array(512); for (const fixture of this.fixtures.filter(f => f.enabled)) { const profile = this.profiles.find(p => p.id === fixture.profileId)!; const mode = profile.modes.find(m => m.id === fixture.modeId)!; for (const channel of mode.channels) { let value = this.values[fixture.id]?.[channel.attribute] ?? channel.default / 255; if (this.blackout && SYSTEM_ATTRIBUTES.has(channel.attribute)) value = (channel.blackoutValue ?? 0) / 255; if (channel.attribute === 'dimmer' || channel.attribute === 'red' || channel.attribute === 'green' || channel.attribute === 'blue' || channel.attribute === 'white') value *= this.master; frame[fixture.address + channel.offset - 2] = Math.round(clamp(value) * 255); } } return frame; }
  snapshot(): Snapshot { const progress = this.fade ? clamp((this.clock.now() - this.fade.started) / Math.max(1, this.fade.duration)) : 1; return { schemaVersion: 1, revision: this.revision, mode: this.mode, blackout: this.blackout, master: this.master, activeSceneId: this.activeSceneId, show: { currentCueIndex: this.cueIndex, phase: this.fade ? 'fading' : 'idle' }, music: this.music, fixtures: structuredClone(this.values), controller: { roomName: 'Detkin Lab', driver: 'simulator', tickHz: 40 } }; }
}
