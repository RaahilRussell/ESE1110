import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

export type DriverStatus = { status: 'ok' | 'degraded' | 'down'; message: string; lastSendAt?: number };
export type DriverConfig = { id: string; kind: 'simulator' | 'sacn'; universe: number; name: string; target?: { ip?: string; multicast?: boolean }; cid?: string };
export interface OutputDriver { id: string; kind: DriverConfig['kind']; open(config: DriverConfig): Promise<void>; send(universe: number, frame: Uint8Array): void; status(): DriverStatus; close(): Promise<void>; }

export class SimulatorDriver implements OutputDriver {
  id = 'simulator-1'; kind = 'simulator' as const;
  latest = new Uint8Array(512); history: Uint8Array[] = [];
  private state: DriverStatus = { status: 'down', message: 'Not opened' };
  async open(config?: DriverConfig) { if (config) this.id = config.id; this.state = { status: 'ok', message: 'Simulator ready; no physical output' }; }
  send(universe: number, frame: Uint8Array) {
    if (universe !== 1 || frame.length !== 512) { this.state = { status: 'degraded', message: 'Expected universe 1 and 512 slots' }; return; }
    this.latest = new Uint8Array(frame); this.history.push(this.latest);
    if (this.history.length > 120) this.history.shift();
    this.state = { status: 'ok', message: 'Frame stored in simulator; no physical output', lastSendAt: Date.now() };
  }
  status() { return { ...this.state }; }
  async close() { this.state = { status: 'down', message: 'Closed' }; }
}

// ANSI E1.31 data packet: root (16), framing (38), DMP (115), start code (125).
export function buildSacnDataPacket(universe: number, frame: Uint8Array, sequence: number, cid = '00000000-0000-4000-8000-000000000001', terminated = false): Uint8Array {
  if (frame.length !== 512 || !Number.isInteger(universe) || universe < 1 || universe > 63999) throw new Error('Invalid sACN universe or frame');
  const hex = cid.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('CID must be a UUID');
  const packet = Buffer.alloc(638);
  packet.writeUInt16BE(0x10, 0);
  packet.write('ASC-E1.17\0\0\0', 4, 'ascii');
  packet.writeUInt16BE(0x7000 | (638 - 16), 16);
  packet.writeUInt32BE(4, 18);
  Buffer.from(hex, 'hex').copy(packet, 22);
  packet.writeUInt16BE(0x7000 | (638 - 38), 38);
  packet.writeUInt32BE(2, 40);
  packet.write('Flashify', 44, 'utf8');
  packet[108] = 100;
  packet[111] = sequence & 255;
  packet[112] = terminated ? 0x40 : 0;
  packet.writeUInt16BE(universe, 113);
  packet.writeUInt16BE(0x7000 | (638 - 115), 115);
  packet[117] = 2; packet[118] = 0xa1;
  packet.writeUInt16BE(0, 119);
  packet.writeUInt16BE(1, 121);
  packet.writeUInt16BE(513, 123);
  packet[125] = 0;
  packet.set(frame, 126);
  return packet;
}

export class SacnDriver implements OutputDriver {
  id: string; kind = 'sacn' as const;
  private socket?: dgram.Socket; private config?: DriverConfig; private seq = 0;
  private cid: string = randomUUID(); private lastFrame = new Uint8Array(512);
  private state: DriverStatus = { status: 'down', message: 'Not opened' };
  constructor(id = 'sacn-1') { this.id = id; }
  async open(config: DriverConfig) {
    if (config.universe !== 1 || (config.target?.ip && isIP(config.target.ip) !== 4)) throw new Error('Expected universe 1 and a valid IPv4 destination');
    this.config = config; this.id = config.id; this.cid = config.cid ?? this.cid;
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', error => { this.state = { status: 'degraded', message: error.message }; });
    await new Promise<void>((resolve, reject) => { this.socket!.once('error', reject); this.socket!.bind(0, () => { this.socket!.removeListener('error', reject); resolve(); }); });
    this.state = { status: 'degraded', message: 'UDP ready; receiver presence is not verifiable via sACN' };
  }
  private host(universe: number) { return this.config?.target?.ip ?? `239.255.${universe >> 8}.${universe & 255}`; }
  send(universe: number, frame: Uint8Array) {
    try {
      if (!this.socket || !this.config) throw new Error('Driver is closed');
      const packet = buildSacnDataPacket(universe, frame, this.seq++, this.cid);
      this.lastFrame = new Uint8Array(frame);
      this.socket.send(packet, 5568, this.host(universe), error => {
        this.state = error ? { status: 'degraded', message: error.message } : { status: 'ok', message: 'UDP submitted; physical receiver and fixtures unverified', lastSendAt: Date.now() };
      });
    } catch (error) { this.state = { status: 'degraded', message: String(error) }; }
  }
  status() { return { ...this.state }; }
  async close() {
    const socket = this.socket;
    if (socket && this.config) {
      for (let i = 0; i < 3; i++) {
        const packet = buildSacnDataPacket(this.config.universe, this.lastFrame, this.seq++, this.cid, true);
        await new Promise<void>(resolve => socket.send(packet, 5568, this.host(this.config!.universe), () => resolve()));
      }
      await new Promise<void>(resolve => socket.close(resolve));
    }
    this.socket = undefined; this.state = { status: 'down', message: 'Closed' };
  }
}
