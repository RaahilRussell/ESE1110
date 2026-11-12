import { z } from 'zod';

export const Attribute = z.enum(['dimmer', 'red', 'green', 'blue', 'white', 'amber', 'uv', 'cct', 'pan', 'tilt', 'strobe', 'control']);
export type Attribute = z.infer<typeof Attribute>;
export const ProtocolVersion = 1 as const;
const Id = z.string().min(1).max(128).refine(id => !['__proto__', 'prototype', 'constructor'].includes(id), 'Reserved identifier');
const Name = z.string().trim().min(1).max(80);
const Byte = z.number().int().min(0).max(255);
const Level = z.number().finite().min(0).max(1);
const FadeMs = z.number().int().min(0).max(600000);
export const AttributeValues = z.partialRecord(Attribute, Level);
export const INTENSITY_ATTRIBUTES: ReadonlySet<Attribute> = new Set(['dimmer', 'red', 'green', 'blue', 'white', 'amber', 'uv']);

export const ChannelDef = z.object({
  offset: z.number().int().min(1).max(512), attribute: Attribute, default: Byte,
  home: Byte.optional(), blackoutValue: Byte.optional(),
  ranges: z.array(z.object({ from: Byte, to: Byte, label: Name, safe: z.boolean() }).strict()).max(256).optional()
}).strict().superRefine((channel, ctx) => {
  const ranges = [...(channel.ranges ?? [])].sort((a, b) => a.from - b.from);
  for (let i = 0; i < ranges.length; i++) {
    if (ranges[i].from > ranges[i].to || (i > 0 && ranges[i].from <= ranges[i - 1].to)) ctx.addIssue({ code: 'custom', message: 'Channel ranges must be ordered intervals without overlap.' });
  }
  for (const value of [channel.default, channel.home, channel.blackoutValue]) {
    if (value !== undefined && ranges.some(r => !r.safe && value >= r.from && value <= r.to)) ctx.addIssue({ code: 'custom', message: 'Default, home and blackout values must be safe.' });
  }
  if (INTENSITY_ATTRIBUTES.has(channel.attribute) || channel.attribute === 'strobe') {
    if ((channel.blackoutValue !== undefined && channel.blackoutValue !== 0) || ranges.some(r => !r.safe && r.from === 0)) ctx.addIssue({ code: 'custom', message: 'Intensity and strobe channels must support a safe zero blackout.' });
  }
});
export const ProfileMode = z.object({ id: Id, name: Name, channelCount: z.number().int().min(1).max(512), channels: z.array(ChannelDef).min(1).max(512) }).strict().superRefine((mode, ctx) => {
  if (mode.channels.some(c => c.offset > mode.channelCount)) ctx.addIssue({ code: 'custom', message: 'Channel offsets exceed channelCount.' });
  if (new Set(mode.channels.map(c => c.offset)).size !== mode.channels.length || new Set(mode.channels.map(c => c.attribute)).size !== mode.channels.length) ctx.addIssue({ code: 'custom', message: 'Channel offsets and attributes must be unique within a mode.' });
});
export const FixtureProfile = z.object({ id: Id, manufacturer: Name, model: Name, source: z.enum(['builtin', 'ofl', 'custom']), profileVersion: z.number().int().positive(), modes: z.array(ProfileMode).min(1).max(128) }).strict().superRefine((profile, ctx) => {
  if (new Set(profile.modes.map(m => m.id)).size !== profile.modes.length) ctx.addIssue({ code: 'custom', message: 'Mode IDs must be unique.' });
});
export type FixtureProfile = z.infer<typeof FixtureProfile>;
export const PatchedFixture = z.object({ id: Id, name: z.string().trim().min(1).max(32), profileId: Id, modeId: Id, universe: z.literal(1), address: z.number().int().min(1).max(512), groupIds: z.array(Id).max(128), enabled: z.boolean() }).strict();
export type PatchedFixture = z.infer<typeof PatchedFixture>;
export const Scene = z.object({ id: Id, name: Name, builtin: z.boolean(), values: z.record(Id, AttributeValues), clearOthers: z.boolean().default(false), revision: z.number().int().positive() }).strict();
export type Scene = z.infer<typeof Scene>;
export const Cue = z.object({ id: Id, name: Name, sceneId: Id, fadeMs: FadeMs }).strict();
export type Cue = z.infer<typeof Cue>;

export const Configuration = z.object({
  schemaVersion: z.literal(1), roomName: z.string().trim().min(1).max(40).default('Detkin Lab'),
  profiles: z.array(FixtureProfile).max(512), fixtures: z.array(PatchedFixture).max(512), scenes: z.array(Scene).max(2048),
  cues: z.array(Cue).max(4096).default([]), master: Level.default(.82)
}).strict().superRefine((config, ctx) => {
  for (const [name, entries] of Object.entries({ profiles: config.profiles, fixtures: config.fixtures, scenes: config.scenes, cues: config.cues })) {
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) ctx.addIssue({ code: 'custom', path: [name], message: 'IDs must be unique.' });
  }
  const occupied = new Set<number>();
  for (const fixture of config.fixtures) {
    const mode = config.profiles.find(p => p.id === fixture.profileId)?.modes.find(m => m.id === fixture.modeId);
    if (!mode) { ctx.addIssue({ code: 'custom', path: ['fixtures'], message: `Unknown profile/mode for ${fixture.id}.` }); continue; }
    if (fixture.address + mode.channelCount - 1 > 512) ctx.addIssue({ code: 'custom', path: ['fixtures'], message: `Fixture ${fixture.id} exceeds the universe.` });
    if (fixture.enabled) for (let channel = fixture.address; channel < fixture.address + mode.channelCount; channel++) {
      if (occupied.has(channel)) ctx.addIssue({ code: 'custom', path: ['fixtures'], message: `Overlapping address ${channel}.` });
      occupied.add(channel);
    }
  }
  for (const scene of config.scenes) for (const [id, attrs] of Object.entries(scene.values)) {
    const fixture = config.fixtures.find(f => f.id === id);
    const mode = fixture && config.profiles.find(p => p.id === fixture.profileId)?.modes.find(m => m.id === fixture.modeId);
    if (!mode || Object.keys(attrs).some(attr => !(mode.channels.some(c => c.attribute === attr) || (attr === 'dimmer' && mode.channels.some(c => INTENSITY_ATTRIBUTES.has(c.attribute)))))) ctx.addIssue({ code: 'custom', path: ['scenes'], message: `Unknown fixture or unsupported attribute in scene ${scene.id}: ${id}.` });
  }
  if (config.cues.some(c => !config.scenes.some(s => s.id === c.sceneId))) ctx.addIssue({ code: 'custom', path: ['cues'], message: 'Cues must reference an existing scene.' });
});
export type Configuration = z.infer<typeof Configuration>;
export const EngineConfiguration = Configuration;
export type EngineConfiguration = Configuration;
export const AudioFeatures = z.object({ rms: Level, bass: Level, onset: z.boolean(), source: z.enum(['simulated', 'external']) }).strict();
export type AudioFeatures = z.infer<typeof AudioFeatures>;

export const Command = z.discriminatedUnion('type', [
  z.object({ type: z.literal('scene.activate'), id: Id, sceneId: Id, fadeMs: FadeMs, groupIds: z.array(Id).max(128).default([]), takeover: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('scene.upsert'), id: Id, scene: Scene }).strict(),
  z.object({ type: z.literal('scene.save'), id: Id, sceneId: Id, name: Name, clearOthers: z.boolean().default(true) }).strict(),
  z.object({ type: z.literal('scene.delete'), id: Id, sceneId: Id }).strict(),
  z.object({ type: z.literal('cue.upsert'), id: Id, cue: Cue, index: z.number().int().min(0).optional() }).strict(),
  z.object({ type: z.literal('cue.delete'), id: Id, cueId: Id }).strict(),
  z.object({ type: z.literal('fixture.set'), id: Id, fixtureId: Id, values: AttributeValues, fadeMs: FadeMs.default(0), takeover: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('group.set'), id: Id, groupId: Id, values: AttributeValues, fadeMs: FadeMs.default(0), takeover: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('fixture.identify'), id: Id, fixtureId: Id, durationMs: z.number().int().min(1).max(10000).default(1000) }).strict(),
  z.object({ type: z.literal('master.set'), id: Id, value: Level }).strict(),
  z.object({ type: z.literal('blackout.set'), id: Id, on: z.boolean() }).strict(),
  z.object({ type: z.literal('show.go'), id: Id }).strict(),
  z.object({ type: z.literal('show.back'), id: Id }).strict(),
  z.object({ type: z.literal('show.stop'), id: Id }).strict(),
  z.object({ type: z.literal('music.start'), id: Id }).strict(),
  z.object({ type: z.literal('music.stop'), id: Id }).strict(),
  z.object({ type: z.literal('audio.set'), id: Id, rms: Level, bass: Level, onset: z.boolean(), source: z.enum(['simulated', 'external']) }).strict()
]);
export type Command = z.infer<typeof Command>;
export type CommandResult = { ok: true; revision: number } | { ok: false; code: string; message: string };
export type Snapshot = {
  schemaVersion: 1; revision: number; mode: 'manual' | 'show' | 'music'; blackout: boolean; master: number; activeSceneId: string;
  show: { currentCueIndex: number; currentCueId?: string; nextCueId?: string; phase: 'idle' | 'fading' | 'complete' | 'paused' };
  music: { running: boolean; rms: number; bass: number; onset: boolean; source: 'none' | 'simulated' | 'external'; stale: boolean };
  fixtures: Record<string, Record<string, number>>; configuration: Configuration;
  identify?: { fixtureId: string; expiresAt: number };
  controller: { roomName: string; driver: string; tickHz: number };
};
