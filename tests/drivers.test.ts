import assert from 'node:assert/strict';
import test from 'node:test';
import dgram from 'node:dgram';
import { SimulatorDriver, SacnDriver, buildSacnDataPacket } from '../packages/drivers/src/index.js';

// Independent receiver parser: validates lengths and vectors before exposing slots.
function decode(packet: Buffer) {
  assert.equal(packet.length, 638);
  assert.equal(packet.readUInt16BE(0), 16);
  assert.equal(packet.subarray(4, 16).toString('ascii'), 'ASC-E1.17\0\0\0');
  for (const offset of [16, 38, 115]) {
    assert.equal(packet.readUInt16BE(offset) >> 12, 7);
    assert.equal(packet.readUInt16BE(offset) & 0x0fff, packet.length - offset);
  }
  assert.equal(packet.readUInt32BE(18), 4);
  assert.equal(packet.readUInt32BE(40), 2);
  assert.equal(packet[117], 2); assert.equal(packet[118], 0xa1);
  assert.equal(packet.readUInt16BE(119), 0);
  assert.equal(packet.readUInt16BE(121), 1);
  assert.equal(packet.readUInt16BE(123), 513);
  assert.equal(packet[125], 0);
  return { slots: packet.subarray(126), sequence: packet[111], universe: packet.readUInt16BE(113), terminated: !!(packet[112] & 0x40) };
}

test('simulator stores independent frame copies and bounds history', async () => {
  const driver = new SimulatorDriver(); await driver.open();
  const frame = new Uint8Array(512); frame[17] = 255; driver.send(1, frame); frame[17] = 0;
  assert.equal(driver.latest[17], 255);
  for (let i = 0; i < 150; i++) driver.send(1, frame);
  assert.equal(driver.history.length, 120);
  driver.send(2, frame); assert.equal(driver.status().status, 'degraded');
  await driver.close(); assert.equal(driver.status().status, 'down');
});
test('E1.31 fields decode according to independent receiver layout', () => {
  const frame = Uint8Array.from({ length: 512 }, (_, index) => index & 255);
  const packet = Buffer.from(buildSacnDataPacket(257, frame, 257, '00112233-4455-6677-8899-aabbccddeeff'));
  const result = decode(packet);
  assert.equal(result.sequence, 1); assert.equal(result.universe, 257);
  assert.deepEqual(result.slots, Buffer.from(frame));
  assert.equal(packet.subarray(22, 38).toString('hex'), '00112233445566778899aabbccddeeff');
  assert.equal(packet[108], 100); assert.equal(result.terminated, false);
  assert.throws(() => buildSacnDataPacket(0, frame, 1));
  assert.throws(() => buildSacnDataPacket(1, new Uint8Array(511), 1));
  assert.throws(() => buildSacnDataPacket(1, frame, 1, 'bad-cid'));
});
test('actual UDP driver reaches a receiver and sends three termination packets', { timeout: 3000 }, async () => {
  const receiver = dgram.createSocket('udp4'); const packets: Buffer[] = [];
  receiver.on('message', packet => packets.push(packet));
  await new Promise<void>(resolve => receiver.bind(5568, '127.0.0.1', resolve));
  const driver = new SacnDriver();
  try {
    await driver.open({ id: 'network', kind: 'sacn', universe: 1, name: 'test', target: { ip: '127.0.0.1' } });
    const frame = new Uint8Array(512); frame[0] = 201; frame[511] = 73;
    driver.send(1, frame);
    await new Promise<void>(resolve => { const check = () => packets.length ? resolve() : setTimeout(check, 5); check(); });
    assert.equal(decode(packets[0]).slots[0], 201);
    assert.equal(decode(packets[0]).slots[511], 73);
    await driver.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(packets.length, 4);
    assert(packets.slice(1).every(packet => decode(packet).terminated));
  } finally { receiver.close(); }
});
