import assert from 'node:assert/strict';
import test from 'node:test';
import { SimulatorDriver, buildSacnDataPacket } from '../packages/drivers/src/index.js';

test('simulator driver keeps the latest exact 512-slot frame', async () => { const driver = new SimulatorDriver(); await driver.open(); const frame = new Uint8Array(512); frame[17] = 255; driver.send(1, frame); assert.equal(driver.latest[17], 255); assert.equal(driver.history.length, 1); });
test('sACN builder emits a full universe packet with sequence and universe', () => { const packet = buildSacnDataPacket(1, new Uint8Array(512), 7); assert.equal(packet.length, 638); assert.equal(packet[112], 7); assert.equal(new DataView(packet.buffer).getUint16(113), 1); });
