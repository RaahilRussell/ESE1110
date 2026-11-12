import dgram from 'node:dgram';

// Independent receive boundary for bench verification. Does not transmit lighting.
const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
socket.on('message', packet => {
  if (packet.length !== 638 || packet.readUInt32BE(18) !== 4 || packet.readUInt32BE(40) !== 2 ||
      packet[117] !== 2 || packet[118] !== 0xa1 || packet.readUInt16BE(123) !== 513 || packet[125] !== 0) {
    console.error('Rejected malformed E1.31 data packet'); return;
  }
  console.log(JSON.stringify({ universe: packet.readUInt16BE(113), sequence: packet[111], terminated: !!(packet[112] & 0x40), slots: [...packet.subarray(126)] }));
});
socket.bind(5568, '0.0.0.0', () => {
  if (process.env.MULTICAST !== '0') socket.addMembership('239.255.0.1');
  console.error('sACN receiver listening on UDP 5568, universe 1');
});
socket.on('error', error => { console.error(error.message); process.exitCode = 1; socket.close(); });
