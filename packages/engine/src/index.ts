import { z } from 'zod';
import {
  AudioFeatures, Command, Configuration, FixtureProfile, PatchedFixture,
  INTENSITY_ATTRIBUTES, type CommandResult, type Cue, type Scene, type Snapshot
} from '../../protocol/src/index.js';

export type Clock = { now(): number };
/** Attributes whose levels represent light output; CCT is a colour selector. */
export const SYSTEM_ATTRIBUTES = INTENSITY_ATTRIBUTES;
export const IDEMPOTENCY_LIMIT = 1024;
export const AUDIO_STALE_MS = 1000;

export const genericProfiles: FixtureProfile[] = [{ id: 'generic-rgbw', manufacturer: 'Flashify', model: 'Generic RGBW', source: 'builtin', profileVersion: 1, modes: [{ id: 'rgbw-4', name: 'RGBW 4-channel', channelCount: 4, channels: [
  { offset: 1, attribute: 'red', default: 0, blackoutValue: 0 }, { offset: 2, attribute: 'green', default: 0, blackoutValue: 0 }, { offset: 3, attribute: 'blue', default: 0, blackoutValue: 0 }, { offset: 4, attribute: 'white', default: 0, blackoutValue: 0 }
] }] }, { id: 'generic-dimmer', manufacturer: 'Flashify', model: 'Generic Dimmer', source: 'builtin', profileVersion: 1, modes: [{ id: 'dimmer-1', name: 'Dimmer 1-channel', channelCount: 1, channels: [{ offset: 1, attribute: 'dimmer', default: 0, blackoutValue: 0 }] }] }];

type Failure = { ok: false; code: string; message: string; details?: unknown };
const failure = (code: string, message: string): Failure => ({ ok: false, code, message });

export function validatePatch(fixtures: PatchedFixture[], profiles: FixtureProfile[]): { ok: true } | Failure {
  const parsedProfiles = z.array(FixtureProfile).safeParse(profiles);
  const parsedFixtures = z.array(PatchedFixture).safeParse(fixtures);
  if (!parsedProfiles.success || !parsedFixtures.success) return failure('VALIDATION', 'Invalid profile or fixture schema; only universe 1 is supported.');
  if (new Set(profiles.map(p => p.id)).size !== profiles.length || new Set(fixtures.map(f => f.id)).size !== fixtures.length) return failure('VALIDATION', 'Profile and fixture IDs must be unique.');
  const ranges: Array<{ start: number; end: number; fixture: string }> = [];
  for (const fixture of fixtures) {
    const mode = profiles.find(p => p.id === fixture.profileId)?.modes.find(m => m.id === fixture.modeId);
    if (!mode) return failure('PROFILE_INVALID', `Profile or mode is missing for ${fixture.name}.`);
    if (fixture.address + mode.channelCount - 1 > 512) return failure('ADDRESS_OUT_OF_RANGE', `${fixture.name} exceeds channel 512.`);
    if (!fixture.enabled) continue;
    const range = { start: fixture.address, end: fixture.address + mode.channelCount - 1, fixture: fixture.name };
    const collision = ranges.find(r => r.start <= range.end && range.start <= r.end);
    if (collision) return { ...failure('ADDRESS_OVERLAP', `${fixture.name} overlaps ${collision.fixture}.`), details: { fixture: fixture.name, other: collision.fixture } };
    ranges.push(range);
  }
  return { ok: true };
}

type Values = Record<string, Record<string, number>>;
type Fade = { from: Values; to: Values; started: number; duration: number };
type Options = { clock: Clock; configuration?: Configuration; profiles?: FixtureProfile[]; fixtures?: PatchedFixture[]; scenes?: Scene[]; cues?: Cue[]; roomName?: string; master?: number };
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export class LightingEngine {
  private readonly clock: Clock;
  private configuration: Configuration;
  private values: Values = {};
  private fade?: Fade;
  private readonly seen = new Map<string, CommandResult>();
  private revision = 1;
  private mode: Snapshot['mode'] = 'manual';
  private blackout = false;
  private activeSceneId = '';
  private cueIndex = -1;
  private paused = false;
  private musicRunning = false;
  private audio?: AudioFeatures;
  private audioAt = -Infinity;
  private identify?: { fixtureId: string; expiresAt: number };

  constructor(options: Options) {
    this.clock = options.clock;
    const fixtures = options.fixtures ?? [
      { id: 'left', name: 'Left PAR', profileId: 'generic-rgbw', modeId: 'rgbw-4', universe: 1, address: 1, groupIds: ['all', 'left'], enabled: true },
      { id: 'right', name: 'Right PAR', profileId: 'generic-rgbw', modeId: 'rgbw-4', universe: 1, address: 5, groupIds: ['all', 'right'], enabled: true }
    ];
    // A custom patch must not inherit references to the example fixtures.
    const scenes = options.scenes ?? (options.fixtures || options.profiles ? [] : [{ id: 'house', name: 'House', builtin: true, values: { left: { red: .85, green: .55, blue: .25, white: .4 }, right: { red: .85, green: .55, blue: .25, white: .4 } }, clearOthers: false, revision: 1 }]);
    this.configuration = Configuration.parse(options.configuration ?? {
      schemaVersion: 1, roomName: options.roomName ?? 'Detkin Lab', profiles: options.profiles ?? genericProfiles,
      fixtures, scenes, cues: options.cues ?? [], master: options.master ?? .82
    });
    this.resetValues();
  }

  /** Detached, validated data for durable storage; runtime playback is deliberately excluded. */
  exportConfiguration(): Configuration { return structuredClone(this.configuration); }
  getConfiguration(): Configuration { return this.exportConfiguration(); }
  /** Atomic replacement. Blackout stays latched across a re-patch. */
  applyConfiguration(input: unknown): CommandResult {
    const parsed = Configuration.safeParse(input);
    if (!parsed.success) return failure('VALIDATION', parsed.error.issues.map(i => i.message).join('; '));
    this.configuration = parsed.data;
    this.resetValues();
    this.fade = undefined;
    this.identify = undefined;
    this.audio = undefined;
    this.audioAt = -Infinity;
    this.musicRunning = false;
    this.mode = 'manual';
    this.activeSceneId = '';
    this.cueIndex = -1;
    this.paused = false;
    return { ok: true, revision: ++this.revision };
  }
  replaceConfiguration(input: unknown): CommandResult { return this.applyConfiguration(input); }

  dispatch(input: unknown): CommandResult {
    // Remember the original outcome, including failures, across later revisions.
    const id = input && typeof input === 'object' && 'id' in input ? input.id : undefined;
    if (typeof id === 'string' && this.seen.has(id)) return structuredClone(this.seen.get(id)!);
    const parsed = Command.safeParse(input);
    let result: CommandResult;
    if (!parsed.success) result = failure('VALIDATION', 'Command does not match protocol v1.');
    else {
      const error = this.execute(parsed.data);
      result = error ?? { ok: true, revision: ++this.revision };
    }
    if (typeof id === 'string' && id.length > 0 && id.length <= 128) {
      this.seen.set(id, structuredClone(result));
      if (this.seen.size > IDEMPOTENCY_LIMIT) this.seen.delete(this.seen.keys().next().value!);
    }
    return result;
  }

  private execute(command: Command): Failure | undefined {
    const now = this.clock.now();
    const config = this.configuration;
    switch (command.type) {
      case 'master.set': config.master = command.value; return;
      case 'blackout.set': this.blackout = command.on; return;
      case 'scene.upsert': {
        const previous = config.scenes.find(s => s.id === command.scene.id);
        const scene = { ...command.scene, revision: previous ? previous.revision + 1 : 1 };
        return this.editConfiguration({ ...config, scenes: previous ? config.scenes.map(s => s.id === scene.id ? scene : s) : [...config.scenes, scene] });
      }
      case 'scene.save': {
        const previous = config.scenes.find(s => s.id === command.sceneId);
        this.advance(now);
        const scene: Scene = { id: command.sceneId, name: command.name, builtin: false, values: structuredClone(this.values), clearOthers: command.clearOthers, revision: previous ? previous.revision + 1 : 1 };
        return this.editConfiguration({ ...config, scenes: previous ? config.scenes.map(s => s.id === scene.id ? scene : s) : [...config.scenes, scene] });
      }
      case 'scene.delete': {
        if (!config.scenes.some(s => s.id === command.sceneId)) return failure('NOT_FOUND', 'Scene not found.');
        if (config.cues.some(c => c.sceneId === command.sceneId)) return failure('SCENE_IN_USE', 'Delete referencing cues before deleting this scene.');
        const error = this.editConfiguration({ ...config, scenes: config.scenes.filter(s => s.id !== command.sceneId) });
        if (!error && this.activeSceneId === command.sceneId) this.activeSceneId = '';
        return error;
      }
      case 'cue.upsert': {
        const cues = [...config.cues];
        const existingIndex = cues.findIndex(c => c.id === command.cue.id);
        const currentId = cues[this.cueIndex]?.id;
        if (existingIndex >= 0) cues.splice(existingIndex, 1);
        const index = command.index ?? (existingIndex >= 0 ? existingIndex : cues.length);
        if (index > cues.length) return failure('VALIDATION', 'Cue index exceeds the cue list.');
        cues.splice(index, 0, command.cue);
        const error = this.editConfiguration({ ...config, cues });
        if (!error) this.cueIndex = currentId ? cues.findIndex(c => c.id === currentId) : -1;
        return error;
      }
      case 'cue.delete': {
        if (!config.cues.some(c => c.id === command.cueId)) return failure('NOT_FOUND', 'Cue not found.');
        const currentId = config.cues[this.cueIndex]?.id;
        const error = this.editConfiguration({ ...config, cues: config.cues.filter(c => c.id !== command.cueId) });
        if (!error) {
          if (currentId === command.cueId) { this.stop(now); this.cueIndex = -1; }
          else this.cueIndex = currentId ? this.configuration.cues.findIndex(c => c.id === currentId) : -1;
        }
        return error;
      }
      case 'scene.activate': {
        const scene = config.scenes.find(s => s.id === command.sceneId);
        if (!scene) return failure('NOT_FOUND', 'Scene not found.');
        const targets = this.targets(command.groupIds);
        if (command.groupIds.some(id => !config.fixtures.some(f => f.enabled && f.groupIds.includes(id)))) return failure('NOT_FOUND', 'Group not found or contains no enabled fixtures.');
        if (this.mode !== 'manual' && !command.takeover) return failure('MODE_ACTIVE', 'Take manual control to edit the current look.');
        this.manual(now);
        this.activate(scene, targets, command.fadeMs, now);
        return;
      }
      case 'fixture.set':
      case 'group.set': {
        const targets = command.type === 'fixture.set' ? config.fixtures.filter(f => f.id === command.fixtureId && f.enabled) : this.targets([command.groupId]);
        if (!targets.length) return failure('NOT_FOUND', 'Fixture or group not found or disabled.');
        if (targets.some(f => Object.keys(command.values).some(attr => !this.supports(f, attr)))) return failure('ATTRIBUTE_UNSUPPORTED', 'An attribute is unsupported by a selected fixture.');
        if (this.mode !== 'manual' && !command.takeover) return failure('MODE_ACTIVE', 'Take manual control to edit the current look.');
        this.manual(now);
        const to = structuredClone(this.values);
        for (const fixture of targets) Object.assign(to[fixture.id], command.values);
        this.startFade(to, command.fadeMs, now);
        this.activeSceneId = '';
        return;
      }
      case 'fixture.identify': {
        const fixture = config.fixtures.find(f => f.id === command.fixtureId && f.enabled);
        if (!fixture) return failure('NOT_FOUND', 'Fixture not found or disabled.');
        if (!this.fixtureMode(fixture).channels.some(c => INTENSITY_ATTRIBUTES.has(c.attribute))) return failure('ATTRIBUTE_UNSUPPORTED', 'Fixture has no intensity channel to identify safely.');
        this.identify = { fixtureId: fixture.id, expiresAt: now + command.durationMs };
        return;
      }
      case 'show.go':
      case 'show.back': {
        if (!config.cues.length) return failure('NOT_FOUND', 'The cue list is empty.');
        const index = command.type === 'show.go' ? this.cueIndex + 1 : Math.max(0, this.cueIndex - 1);
        if (index >= config.cues.length) return failure('SHOW_END', 'The last cue is already active.');
        const cue = config.cues[index];
        this.advance(now);
        this.mode = 'show';
        this.musicRunning = false;
        this.paused = false;
        this.cueIndex = index;
        this.activate(config.scenes.find(s => s.id === cue.sceneId)!, this.targets([]), cue.fadeMs, now);
        return;
      }
      case 'show.stop': this.stop(now); return;
      case 'music.start':
        this.advance(now); this.fade = undefined; this.mode = 'music'; this.musicRunning = true; this.paused = false; return;
      case 'music.stop':
        if (this.mode === 'music') this.mode = 'manual';
        this.musicRunning = false; return;
      case 'audio.set': this.storeAudio({ rms: command.rms, bass: command.bass, onset: command.onset, source: command.source }, now); return;
      default: { const unreachable: never = command; return unreachable; }
    }
  }

  /** Legacy callers without a source are explicitly classified as external input. */
  setAudio(features: { rms: number; bass: number; onset: boolean; source?: AudioFeatures['source'] }): CommandResult {
    const parsed = AudioFeatures.safeParse({ ...features, source: features.source ?? 'external' });
    if (!parsed.success) return failure('VALIDATION', 'Invalid audio features.');
    this.storeAudio(parsed.data, this.clock.now());
    return { ok: true, revision: ++this.revision };
  }
  private storeAudio(features: AudioFeatures, now: number) { this.audio = features; this.audioAt = now; }
  private editConfiguration(input: Configuration): Failure | undefined {
    const parsed = Configuration.safeParse(input);
    if (!parsed.success) return failure('VALIDATION', parsed.error.issues.map(i => i.message).join('; '));
    this.configuration = parsed.data;
  }
  private fixtureMode(fixture: PatchedFixture) { return this.configuration.profiles.find(p => p.id === fixture.profileId)!.modes.find(m => m.id === fixture.modeId)!; }
  private supports(fixture: PatchedFixture, attribute: string) {
    const channels = this.fixtureMode(fixture).channels;
    return channels.some(c => c.attribute === attribute) || (attribute === 'dimmer' && channels.some(c => INTENSITY_ATTRIBUTES.has(c.attribute)));
  }
  private defaults(fixture: PatchedFixture): Record<string, number> {
    const channels = this.fixtureMode(fixture).channels;
    const values = Object.fromEntries(channels.map(c => [c.attribute, c.default / 255]));
    if (!channels.some(c => c.attribute === 'dimmer') && channels.some(c => INTENSITY_ATTRIBUTES.has(c.attribute))) values.dimmer = 1;
    return values;
  }
  private resetValues() { this.values = Object.fromEntries(this.configuration.fixtures.map(f => [f.id, this.defaults(f)])); }
  private targets(groups: string[]) { return this.configuration.fixtures.filter(f => f.enabled && (!groups.length || groups.some(g => f.groupIds.includes(g)))); }
  private manual(now: number) { this.advance(now); this.mode = 'manual'; this.musicRunning = false; this.paused = false; }
  private stop(now: number) { this.manual(now); this.fade = undefined; this.paused = true; }
  private activate(scene: Scene, targets: PatchedFixture[], duration: number, now: number) {
    this.advance(now);
    const to = structuredClone(this.values);
    for (const fixture of targets) {
      if (scene.clearOthers) to[fixture.id] = this.defaults(fixture);
      Object.assign(to[fixture.id], scene.values[fixture.id] ?? {});
    }
    this.activeSceneId = scene.id;
    this.startFade(to, duration, now);
  }
  private startFade(to: Values, duration: number, now: number) {
    if (duration === 0) { this.values = to; this.fade = undefined; }
    else this.fade = { from: structuredClone(this.values), to, started: now, duration };
  }
  private advance(now: number) {
    if (this.identify && now >= this.identify.expiresAt) this.identify = undefined;
    if (!this.fade) return;
    const progress = clamp((now - this.fade.started) / this.fade.duration);
    for (const [id, attrs] of Object.entries(this.fade.to)) for (const [attr, value] of Object.entries(attrs)) {
      const from = this.fade.from[id]?.[attr] ?? 0;
      this.values[id][attr] = from + (value - from) * progress;
    }
    if (progress === 1) this.fade = undefined;
  }
  private musicState(now: number): Snapshot['music'] {
    const stale = !this.audio || now - this.audioAt >= AUDIO_STALE_MS;
    return { running: this.musicRunning, rms: stale ? 0 : this.audio!.rms, bass: stale ? 0 : this.audio!.bass, onset: stale ? false : this.audio!.onset, source: this.audio?.source ?? 'none', stale };
  }

  tick(now = this.clock.now()): Uint8Array {
    this.advance(now);
    const music = this.musicState(now);
    const frame = new Uint8Array(512);
    for (const fixture of this.targets([])) {
      const mode = this.fixtureMode(fixture);
      const hasDimmer = mode.channels.some(c => c.attribute === 'dimmer');
      for (const channel of mode.channels) {
        const intensity = INTENSITY_ATTRIBUTES.has(channel.attribute);
        let value = this.values[fixture.id][channel.attribute] ?? channel.default / 255;
        if (intensity && this.mode === 'music' && music.running && !music.stale) value = clamp(value + (music.onset ? 1 : Math.max(music.rms, music.bass)) * .35);
        if (intensity && this.identify?.fixtureId === fixture.id) value = 1;
        // A physical dimmer already scales its colour channels. RGB-only fixtures scale each emitter.
        if (intensity && (!hasDimmer || channel.attribute === 'dimmer')) value *= this.configuration.master * (hasDimmer || this.identify?.fixtureId === fixture.id ? 1 : this.values[fixture.id].dimmer ?? 1);
        if (this.blackout) {
          if (intensity || channel.attribute === 'strobe') value = 0;
          else if (channel.blackoutValue !== undefined) value = channel.blackoutValue / 255;
        }
        const byte = Math.round(clamp(value) * 255);
        // Enforce safety after every layer, including fades, master and effects.
        const unsafe = (candidate: number) => channel.ranges?.some(r => !r.safe && candidate >= r.from && candidate <= r.to);
        let safeByte = byte;
        if (unsafe(byte)) {
          // Never increase intensity to escape an unsafe interval.
          const candidates = [channel.home, channel.default, 0, ...(channel.ranges ?? []).flatMap(r => [r.from - 1, r.to + 1])]
            .filter((v): v is number => v !== undefined && v >= 0 && v <= 255 && !unsafe(v) && (!intensity || v <= byte));
          safeByte = candidates.sort((a, b) => Math.abs(a - byte) - Math.abs(b - byte))[0] ?? 0;
        }
        frame[fixture.address + channel.offset - 2] = safeByte;
      }
    }
    return frame;
  }

  snapshot(): Snapshot {
    const now = this.clock.now();
    this.advance(now);
    const cues = this.configuration.cues;
    return {
      schemaVersion: 1, revision: this.revision, mode: this.mode, blackout: this.blackout, master: this.configuration.master, activeSceneId: this.activeSceneId,
      show: { currentCueIndex: this.cueIndex, currentCueId: cues[this.cueIndex]?.id, nextCueId: cues[this.cueIndex + 1]?.id, phase: this.paused ? 'paused' : this.fade ? 'fading' : this.mode === 'show' ? 'complete' : 'idle' },
      music: this.musicState(now), fixtures: structuredClone(this.values), configuration: this.exportConfiguration(), identify: this.identify && { ...this.identify },
      controller: { roomName: this.configuration.roomName, driver: 'simulator', tickHz: 40 }
    };
  }
}
