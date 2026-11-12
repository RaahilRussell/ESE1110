import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { AtomicStore } from './persistence.js';
import { validatePin } from '../../packages/engine/src/wizard.js';
const scrypt = promisify(scryptCallback);
const AuthRecord = z.object({ salt: z.string().regex(/^[a-f0-9]{32}$/), hash: z.string().regex(/^[a-f0-9]{128}$/) }).strict();
type Session = { id: string; expiresAt: number };
export class Auth {
  private store: AtomicStore<z.infer<typeof AuthRecord> | null>;
  private record: z.infer<typeof AuthRecord> | null = null;
  private sessions = new Map<string, Session>();
  private attempts = new Map<string, { count: number; until: number }>();
  private busy = false;
  private verifying = 0;
  bootstrapToken = randomBytes(32).toString('hex');
  lease?: { sessionId: string; expiresAt: number };
  constructor(directory: string, readonly now: () => number, readonly sessionMs = 8 * 60 * 60 * 1000, readonly leaseMs = 15_000) {
    this.store = new AtomicStore(directory, 'auth.json', value => AuthRecord.nullable().parse(value), { failClosed: true });
  }
  async init() { this.record = await this.store.load(() => null); }
  get setupRequired() { return this.record === null; }
  private key(token: string) { return createHash('sha256').update(token).digest('hex'); }
  private equal(a: string, b: string) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
  rateLimit(address: string) {
    const now = this.now();
    for (const [key, entry] of this.attempts) if (entry.until <= now) this.attempts.delete(key);
    if (this.attempts.size >= 2048 && !this.attempts.has(address)) throw new AuthError(429, 'RATE_LIMITED', 'Too many authentication attempts.');
    const entry = this.attempts.get(address) ?? { count: 0, until: now + 60_000 };
    entry.count++; this.attempts.set(address, entry);
    if (entry.count > 5) throw new AuthError(429, 'RATE_LIMITED', 'Try again in a minute.');
  }
  async bootstrap(pin: string, token: string) {
    if (!this.setupRequired) throw new AuthError(409, 'ALREADY_CONFIGURED', 'The controller is already paired.');
    if (this.busy) throw new AuthError(409, 'BUSY', 'Setup is in progress.');
    if (!this.equal(token, this.bootstrapToken)) throw new AuthError(401, 'UNAUTHORIZED', 'Invalid setup token.');
    const invalid = validatePin(pin); if (invalid) throw new AuthError(400, 'VALIDATION', invalid);
    this.busy = true;
    try {
      const salt = randomBytes(16).toString('hex');
      const record = { salt, hash: ((await scrypt(pin, salt, 64)) as Buffer).toString('hex') };
      await this.store.save(record); this.record = record; this.bootstrapToken = '';
      return this.issue();
    } finally { this.busy = false; }
  }
  async login(pin: string) {
    if (!this.record) throw new AuthError(409, 'SETUP_REQUIRED', 'Complete local setup first.');
    if (this.verifying >= 4) throw new AuthError(429, 'RATE_LIMITED', 'Authentication is busy.');
    this.verifying++;
    try {
      const hash = ((await scrypt(pin, this.record.salt, 64)) as Buffer).toString('hex');
      if (!this.equal(hash, this.record.hash)) throw new AuthError(401, 'UNAUTHORIZED', 'Invalid PIN.');
      return this.issue();
    } finally { this.verifying--; }
  }
  private issue() {
    this.sweep();
    if (this.sessions.size >= 128) throw new AuthError(429, 'SESSION_LIMIT', 'Too many sessions.');
    const token = randomBytes(32).toString('base64url');
    const session = { id: randomBytes(16).toString('hex'), expiresAt: this.now() + this.sessionMs };
    this.sessions.set(this.key(token), session);
    return { token, sessionId: session.id, expiresAt: session.expiresAt, role: 'viewer' as const };
  }
  authenticate(token?: string): Session {
    this.sweep(); const session = token ? this.sessions.get(this.key(token)) : undefined;
    if (!session) throw new AuthError(401, 'UNAUTHORIZED', 'Pair or sign in to the controller.');
    return session;
  }
  revoke(token: string) { const session = this.authenticate(token); this.sessions.delete(this.key(token)); if (this.lease?.sessionId === session.id) this.lease = undefined; }
  sweep() { for (const [key, value] of this.sessions) if (value.expiresAt <= this.now()) { this.sessions.delete(key); if (this.lease?.sessionId === value.id) this.lease = undefined; } if (this.lease && this.lease.expiresAt <= this.now()) this.lease = undefined; }
  role(sessionId: string) { this.sweep(); return this.lease?.sessionId === sessionId ? 'operator' : 'viewer'; }
  acquire(sessionId: string) {
    this.sweep(); if (this.lease && this.lease.sessionId !== sessionId) throw new AuthError(409, 'LEASE_HELD', 'Another operator owns control.');
    this.lease = { sessionId, expiresAt: this.now() + this.leaseMs }; return { role: 'operator', lease: this.lease };
  }
  operator(sessionId: string) { if (this.role(sessionId) !== 'operator') throw new AuthError(403, 'LEASE_REQUIRED', 'Acquire operator control first.'); }
  heartbeat(sessionId: string) { this.operator(sessionId); return this.acquire(sessionId); }
  release(sessionId: string) { this.operator(sessionId); this.lease = undefined; }
}
export class AuthError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
