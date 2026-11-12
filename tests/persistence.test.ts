import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtomicStore } from '../apps/server/persistence.js';

const validate = (input: unknown) => {
  if (typeof input !== 'object' || input === null || !('revision' in input) || !Number.isInteger(input.revision)) throw new Error('Invalid configuration');
  return input as { revision: number };
};
test('atomic store persists validated configuration and recovers a corrupt primary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flashify-store-'));
  const store = new AtomicStore(directory, 'config.json', validate);
  await store.load(() => ({ revision: 1 }));
  await store.save({ revision: 2 });
  await store.save({ revision: 3 });
  await writeFile(join(directory, 'config.json'), '{broken JSON');
  const recovered = new AtomicStore(directory, 'config.json', validate);
  assert.deepEqual(await recovered.load(() => ({ revision: 0 })), { revision: 2 });
  assert.equal(recovered.recovered, true);
  await assert.rejects(() => recovered.save({ revision: NaN }));
  assert.deepEqual(recovered.get(), { revision: 2 });
});
test('queued writes survive a failed validation and retain last good backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flashify-queue-'));
  const store = new AtomicStore(directory, 'config.json', validate);
  await store.load(() => ({ revision: 1 }));
  await Promise.all([store.save({ revision: 2 }), store.save({ revision: 3 }), store.save({ revision: 4 })]);
  const loaded = new AtomicStore(directory, 'config.json', validate);
  assert.deepEqual(await loaded.load(() => ({ revision: 0 })), { revision: 4 });
  const envelope = JSON.parse(await readFile(join(directory, 'config.json.bak'), 'utf8'));
  assert.deepEqual(JSON.parse(envelope.payload), { revision: 3 });
});
