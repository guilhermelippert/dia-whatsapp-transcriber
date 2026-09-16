import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError, hash, hmac, seal, unseal } from './security.mjs';
const DAY = 86400000;
export class Store {
  constructor(config, clock = Date.now) {
    this.config = config; this.clock = clock; this.key = config.encryptionKey;
    if (config.database !== ':memory:') mkdirSync(dirname(config.database), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(config.database);
    if (config.database !== ':memory:') chmodSync(config.database, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, email_hash TEXT UNIQUE NOT NULL, customer_hash TEXT UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT REFERENCES accounts(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS codes(email_hash TEXT PRIMARY KEY, digest TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS trial_claims(email_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage(user_id TEXT REFERENCES accounts(id) ON DELETE CASCADE, request_id TEXT, fingerprint TEXT, status TEXT, created INTEGER, result TEXT, PRIMARY KEY(user_id,request_id));
      CREATE INDEX IF NOT EXISTS usage_period ON usage(user_id,created,status);
      CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY, reset INTEGER, count INTEGER);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, created INTEGER);
      PRAGMA user_version=1;`);
    this.cleanup();
  }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  cleanup() {
    const now = this.clock();
    this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(now);
    this.db.prepare('DELETE FROM codes WHERE expires <= ?').run(now);
    this.db.prepare('DELETE FROM limits WHERE reset <= ?').run(now);
    this.db.prepare('DELETE FROM trial_claims WHERE expires <= ?').run(now);
    this.db.prepare('DELETE FROM events WHERE created < ?').run(now - 90 * DAY);
    this.db.prepare('DELETE FROM usage WHERE created < ?').run(now - 90 * DAY);
    this.db.prepare("DELETE FROM usage WHERE status='reserved' AND created < ?").run(now - 120000);
    this.db.prepare('UPDATE usage SET result=NULL WHERE result IS NOT NULL AND created < ?').run(now - 600000);
  }
  emailHash(email) { return hmac(this.key, `email:${email}`); }
  account(id) {
    const row = this.db.prepare('SELECT data FROM accounts WHERE id=?').get(id);
    return row ? unseal(this.key, row.data, id) : null;
  }
  accountByEmail(email) {
    const row = this.db.prepare('SELECT id FROM accounts WHERE email_hash=?').get(this.emailHash(email));
    return row ? this.account(row.id) : null;
  }
  accountByCustomer(customer) {
    const row = this.db.prepare('SELECT id FROM accounts WHERE customer_hash=?').get(hash(customer));
    return row ? this.account(row.id) : null;
  }
  save(account) {
    this.db.prepare('INSERT INTO accounts(id,email_hash,customer_hash,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET customer_hash=excluded.customer_hash,data=excluded.data')
      .run(account.id, this.emailHash(account.email), account.customer ? hash(account.customer) : null, seal(this.key, account, account.id));
    return account;
  }
  create(email) {
    const claimed = this.db.prepare('SELECT 1 FROM trial_claims WHERE email_hash=? AND expires>?').get(this.emailHash(email), this.clock());
    return this.save({ id: randomUUID(), email, created: this.clock(), trialUsed: Boolean(claimed), trialEnd: 0, customer: null, subscription: null, billingStatus: 'free', paidUntil: 0, synced: 0 });
  }
  session(raw) {
    const row = this.db.prepare('SELECT user_id FROM sessions WHERE hash=? AND expires>?').get(hash(raw), this.clock());
    if (!row) throw new HttpError(401, 'Entre na sua conta para continuar.', 'AUTH_REQUIRED');
    return this.account(row.user_id);
  }
  rate(key, limit, interval) {
    const reset = Math.floor(this.clock() / interval) * interval + interval;
    const row = this.db.prepare('INSERT INTO limits(key,reset,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN limits.reset=excluded.reset THEN limits.count+1 ELSE 1 END,reset=excluded.reset RETURNING count').get(key, reset);
    if (row.count > limit) throw new HttpError(429, 'Muitas tentativas. Aguarde e tente novamente.', 'RATE_LIMIT');
  }
  entitlement(account) {
    const pro = ['active', 'trialing'].includes(account.billingStatus) && account.paidUntil > this.clock();
    const trial = account.trialEnd > this.clock();
    return { plan: pro ? 'pro' : trial ? 'trial' : 'free', unlimited: pro || trial };
  }
  startTrial(id) {
    return this.tx(() => {
      const a = this.account(id);
      if (a.trialUsed || this.entitlement(a).unlimited) throw new HttpError(409, 'O período de teste já foi utilizado ou existe acesso ativo.');
      a.trialUsed = true; a.trialEnd = this.clock() + this.config.trialDays * DAY;
      this.db.prepare('INSERT OR REPLACE INTO trial_claims VALUES(?,?)').run(this.emailHash(a.email), this.clock() + 180 * DAY);
      return this.save(a);
    });
  }
  month() { const d = new Date(this.clock()); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
  used(id) {
    return this.db.prepare("SELECT count(*) AS n FROM usage WHERE user_id=? AND created>=? AND (status='done' OR (status='reserved' AND created>?))").get(id, this.month(), this.clock() - 120000).n;
  }
  reserve(id, requestId, fingerprint) {
    return this.tx(() => {
      this.cleanup();
      const a = this.account(id);
      if (!a || a.deleting) throw new HttpError(401, 'Conta indisponível.');
      const old = this.db.prepare('SELECT * FROM usage WHERE user_id=? AND request_id=?').get(id, requestId);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new HttpError(409, 'Identificador reutilizado com outro conteúdo.');
        if (old.status === 'reserved') throw new HttpError(409, 'Solicitação ainda em andamento.', 'IN_PROGRESS');
        if (!old.result) throw new HttpError(409, 'Resultado expirado. Inicie uma nova solicitação.', 'RESULT_EXPIRED');
        return unseal(this.key, old.result, `${id}:${requestId}`);
      }
      const busy = this.db.prepare("SELECT count(*) AS n FROM usage WHERE status='reserved'").get().n;
      const own = this.db.prepare("SELECT count(*) AS n FROM usage WHERE user_id=? AND status='reserved'").get(id).n;
      if (busy >= this.config.concurrency || own >= 2) throw new HttpError(429, 'Há solicitações em andamento. Aguarde.', 'BUSY');
      if (!this.entitlement(a).unlimited && this.used(id) >= this.config.freeLimit) throw new HttpError(402, 'Limite gratuito atingido. Ative o trial ou assine o Pro.', 'QUOTA_EXCEEDED');
      this.db.prepare("INSERT INTO usage(user_id,request_id,fingerprint,status,created) VALUES(?,?,?,'reserved',?)").run(id, requestId, fingerprint, this.clock());
      return null;
    });
  }
  finish(id, requestId, result) {
    this.db.prepare("UPDATE usage SET status='done',result=? WHERE user_id=? AND request_id=?").run(seal(this.key, result, `${id}:${requestId}`), id, requestId);
  }
  release(id, requestId) { this.db.prepare("DELETE FROM usage WHERE user_id=? AND request_id=? AND status='reserved'").run(id, requestId); }
  close() { this.db.close(); }
}
