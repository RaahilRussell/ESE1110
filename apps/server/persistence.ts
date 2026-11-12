import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, chmod, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export class StoreCorruptError extends Error {}
export class AtomicStore<T> {
  private value?: T;
  private queue = Promise.resolve();
  recovered = false;
  quarantined?: string;
  constructor(readonly directory: string, readonly name: string, private readonly validate: (value: unknown) => T, private readonly options: { failClosed?: boolean; resetCorrupt?: boolean } = {}) {}
  private encode(value: T) {
    const payload = JSON.stringify(value);
    return JSON.stringify({ version: 1, checksum: createHash('sha256').update(payload).digest('hex'), payload });
  }
  private decode(raw: string) {
    const envelope = JSON.parse(raw);
    if (envelope.version !== 1 || typeof envelope.payload !== 'string' || envelope.checksum !== createHash('sha256').update(envelope.payload).digest('hex')) throw new StoreCorruptError('Invalid persisted checksum');
    return this.validate(JSON.parse(envelope.payload));
  }
  async load(initial: () => T): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    let missing = false;
    try { this.value = this.decode(await readFile(join(this.directory, this.name), 'utf8')); }
    catch (error) {
      missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (!missing && this.options.failClosed) throw new StoreCorruptError(`Corrupt ${this.name}; authentication is locked until restored.`);
      if (missing && this.options.failClosed) {
        // Never restore an older credential or a pre-pairing null record when the primary disappears.
        let backupExists = false;
        try { await readFile(join(this.directory, `${this.name}.bak`)); backupExists = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (backupExists) throw new StoreCorruptError(`Missing ${this.name}; authentication is locked until restored.`);
      }
      if (!missing) {
        this.quarantined = `${this.name}.corrupt-${Date.now()}-${randomBytes(4).toString('hex')}`;
        await rename(join(this.directory, this.name), join(this.directory, this.quarantined));
      }
      try { this.value = this.decode(await readFile(join(this.directory, `${this.name}.bak`), 'utf8')); this.recovered = true; }
      catch (backupError) {
        if ((!missing || (backupError as NodeJS.ErrnoException).code !== 'ENOENT') && !this.options.resetCorrupt) throw new StoreCorruptError(`Cannot recover ${this.name}; preserve files and restore a known-good backup.`);
        this.value = this.validate(initial());
        this.recovered = !missing || (backupError as NodeJS.ErrnoException).code !== 'ENOENT';
      }
      // Never overwrite the last known-good backup with a corrupt primary.
      await this.writeFile(this.name, this.encode(this.value));
    }
    return structuredClone(this.value);
  }
  get(): T { if (this.value === undefined) throw new Error('Store not loaded'); return structuredClone(this.value); }
  async save(value: T): Promise<void> {
    const next = this.validate(structuredClone(value));
    const operation = this.queue.then(async () => {
      if (this.value !== undefined) await this.writeFile(`${this.name}.bak`, this.encode(this.value));
      await this.writeFile(this.name, this.encode(next));
      this.value = structuredClone(next);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  private async writeFile(name: string, content: string) {
    const temporary = join(this.directory, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    try { await rename(temporary, join(this.directory, name)); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
