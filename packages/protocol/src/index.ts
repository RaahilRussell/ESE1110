import { z } from 'zod';

export const Attribute = z.enum(['dimmer', 'red', 'green', 'blue', 'white', 'amber', 'uv', 'cct', 'pan', 'tilt', 'strobe', 'control']);
export type Attribute = z.infer<typeof Attribute>;
export const ProtocolVersion = 1 as const;

export const ChannelDef = z.object({
  offset: z.number().int().min(1).max(512),
  attribute: Attribute,
  default: z.number().int().min(0).max(255),
  home: z.number().int().min(0).max(255).optional(),
  blackoutValue: z.number().int().min(0).max(255).optional(),
  ranges: z.array(z.object({ from: z.number().int().min(0).max(255), to: z.number().int().min(0).max(255), label: z.string(), safe: z.boolean() })).optional()
});
export const ProfileMode = z.object({ id: z.string(), name: z.string(), channelCount: z.number().int().min(1).max(512), channels: z.array(ChannelDef) });
export const FixtureProfile = z.object({ id: z.string(), manufacturer: z.string(), model: z.string(), source: z.enum(['builtin', 'ofl', 'custom']), profileVersion: z.number().int(), modes: z.array(ProfileMode).min(1) });
export type FixtureProfile = z.infer<typeof FixtureProfile>;
export const PatchedFixture = z.object({ id: z.string(), name: z.string().min(1).max(32), profileId: z.string(), modeId: z.string(), universe: z.number().int().min(1), address: z.number().int().min(1).max(512), groupIds: z.array(z.string()), enabled: z.boolean() });
export type PatchedFixture = z.infer<typeof PatchedFixture>;
export const Scene = z.object({ id: z.string(), name: z.string(), builtin: z.boolean(), values: z.record(z.record(z.number().min(0).max(1))), clearOthers: z.boolean().default(false), revision: z.number().int() });
export type Scene = z.infer<typeof Scene>;

export const Command = z.discriminatedUnion('type', [
  z.object({ type: z.literal('scene.activate'), id: z.string(), sceneId: z.string(), fadeMs: z.number().int().min(0).max(600000), groupIds: z.array(z.string()).default([]), takeover: z.boolean().default(false) }),
  z.object({ type: z.literal('master.set'), id: z.string(), value: z.number().min(0).max(1) }),
  z.object({ type: z.literal('blackout.set'), id: z.string(), on: z.boolean() }),
  z.object({ type: z.literal('show.go'), id: z.string() }),
  z.object({ type: z.literal('show.back'), id: z.string() }),
  z.object({ type: z.literal('show.stop'), id: z.string() }),
  z.object({ type: z.literal('music.start'), id: z.string() }),
  z.object({ type: z.literal('music.stop'), id: z.string() })
]);
export type Command = z.infer<typeof Command>;

export type Snapshot = { schemaVersion: 1; revision: number; mode: 'manual' | 'show' | 'music'; blackout: boolean; master: number; activeSceneId: string; show: { currentCueIndex: number; phase: 'idle' | 'fading' | 'complete' | 'paused' }; music: { running: boolean; rms: number; bass: number; onset: boolean }; fixtures: Record<string, Record<string, number>>; controller: { roomName: string; driver: string; tickHz: number } };
