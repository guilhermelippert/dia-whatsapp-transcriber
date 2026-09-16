import { isIP } from 'node:net';
import http from 'node:http';
import { randomInt } from 'node:crypto';
import { Store } from './store.mjs';
import { Billing, inference, sendCode } from './providers.mjs';
import { HttpError, emailAddress, equal, hash, hmac, token, readBody, jsonBody, serialQueue } from './security.mjs';
import { validateSummaryInput, validateTranscriptionInput } from './server-utils.mjs';
import { publicPage } from './pages.mjs';

export function createApp(config, dependencies = {}) {
  const store = dependencies.store || new Store(config, dependencies.clock);
  const billing = dependencies.billing || new Billing(config, store, dependencies.stripe);
  const mail = dependencies.mail || ((email, code) => sendCode(config, email, code));
  const ai = dependencies.ai || ((kind, input) => inference(config, kind, input));
  const serial = serialQueue();
  const view = a => ({ id: a.id, email: a.email, ...store.entitlement(a), trialUsed: a.trialUsed, trialEnd: a.trialEnd,
    trialDays: config.trialDays, used: store.used(a.id), limit: config.freeLimit, billingStatus: a.billingStatus, cancelAtPeriodEnd: a.cancelAtPeriodEnd || false,
    resetsAt: Date.UTC(new Date(store.clock()).getUTCFullYear(), new Date(store.clock()).getUTCMonth() + 1, 1) });
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const allowed = !origin || config.origins.includes(origin) || (!config.production && /^chrome-extension:\/\/[a-p]{32}$/.test(origin));
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'", 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      ...(config.production ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
      ...(allowed && origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}) };
    const reply = (status, body) => { if (!res.destroyed) { res.writeHead(status, headers); res.end(JSON.stringify(body)); } };
    let reserved = null;
    try {
      if (!allowed) throw new HttpError(403, 'Origem não permitida.');
      const path = new URL(req.url, config.baseUrl).pathname;
      if (req.method === 'OPTIONS') { res.writeHead(204, { ...headers, 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' }); return res.end(); }
      if (req.method === 'GET' && path === '/health') return reply(200, { ok: true });
      if (req.method === 'GET' && ['/', '/privacy', '/terms', '/support', '/billing/return', '/billing/cancel'].includes(path)) {
        res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }); return res.end(publicPage(path, config));
      }
      if (req.method === 'GET' && path === '/plan') return reply(200, { ...await billing.price(), trialDays: config.trialDays, freeLimit: config.freeLimit });
      // Trust only an explicitly configured reverse proxy that overwrites X-Real-IP.
      const peer = req.socket.remoteAddress;
      const ip = config.trustedProxies.includes(peer) && isIP(req.headers['x-real-ip'] || '') ? req.headers['x-real-ip'] : peer;
      const ipKey = hmac(config.encryptionKey, `ip:${ip}`);
      if (req.method === 'POST' && path === '/stripe/webhook') {
        const raw = await readBody(req, 1024 * 1024);
        const event = billing.webhook(raw, req.headers['stripe-signature']);
        const supported = /^(customer\.subscription\.(created|updated|deleted|paused|resumed)|invoice\.(paid|payment_failed)|checkout\.session\.(completed|expired))$/;
        const customer = event.data?.object?.customer;
        const a = typeof customer === 'string' ? store.accountByCustomer(customer) : null;
        await serial(a?.id || event.id, async () => {
          if (store.db.prepare('SELECT 1 FROM events WHERE id=?').get(event.id)) return;
          if (a && supported.test(event.type)) await billing.sync(a.id);
          store.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?)').run(event.id, store.clock());
        });
        return reply(200, { received: true });
      }
      if (req.method === 'POST' && ['/auth/request-code', '/auth/verify'].includes(path)) {
        store.rate(`auth-ip:${ipKey}`, 30, 3600000);
        const body = jsonBody(await readBody(req)); const email = emailAddress(body.email), eh = store.emailHash(email);
        if (path === '/auth/request-code') {
          store.rate(`code:${eh}`, 3, 900000);
          const code = String(randomInt(0, 100000000)).padStart(8, '0');
          store.db.prepare('INSERT OR REPLACE INTO codes VALUES(?,?,?,0)').run(eh, hmac(config.encryptionKey, `${eh}:${code}`), store.clock() + 600000);
          await mail(email, code);
          return reply(202, { ok: true, message: 'Confira seu e-mail. O código expira em 10 minutos.' });
        }
        store.rate(`verify:${eh}`, 15, 900000);
        const saved = store.db.prepare('SELECT * FROM codes WHERE email_hash=?').get(eh);
        if (!saved || saved.expires <= store.clock() || saved.attempts >= 5) throw new HttpError(400, 'Código inválido ou expirado.');
        store.db.prepare('UPDATE codes SET attempts=attempts+1 WHERE email_hash=?').run(eh);
        if (typeof body.code !== 'string' || !/^\d{8}$/.test(body.code) || !equal(saved.digest, hmac(config.encryptionKey, `${eh}:${body.code}`))) throw new HttpError(400, 'Código inválido ou expirado.');
        const result = store.tx(() => {
          store.db.prepare('DELETE FROM codes WHERE email_hash=?').run(eh);
          const a = store.accountByEmail(email) || store.create(email), raw = token();
          if (a.deleting) throw new HttpError(409, 'Conta em processo de exclusão. Contate o suporte.');
          store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(raw), a.id, store.clock() + 30 * 86400000);
          return { token: raw, account: view(a) };
        });
        return reply(200, result);
      }
      const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (!bearer) throw new HttpError(401, 'Entre na sua conta para continuar.', 'AUTH_REQUIRED');
      let account = store.session(bearer);
      store.rate(`api:${account.id}`, 120, 60000);
      if (req.method === 'POST' && path === '/auth/logout') {
        store.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(bearer)); return reply(200, { ok: true });
      }
      if (req.method === 'DELETE' && path === '/account') {
        const body = jsonBody(await readBody(req));
        if (body.confirm !== 'EXCLUIR') throw new HttpError(400, 'Confirme a exclusão.');
        await serial(account.id, async () => {
          // Read the latest account INSIDE the customer lock: a queued checkout may have created a customer.
          const current = billing.patch(account.id, { deleting: true });
          if (current.customer) await billing.request(`/customers/${encodeURIComponent(current.customer)}`, null, `dia-delete-${account.id}`, 'DELETE');
          store.tx(() => {
            store.db.prepare('INSERT OR REPLACE INTO trial_claims VALUES(?,?)').run(store.emailHash(account.email), store.clock() + 180 * 86400000);
            store.db.prepare('DELETE FROM accounts WHERE id=?').run(account.id);
            store.db.prepare('DELETE FROM codes WHERE email_hash=?').run(store.emailHash(account.email));
          });
        });
        return reply(200, { ok: true });
      }
      if (account.deleting) throw new HttpError(409, 'Exclusão de conta em andamento.');
      if (req.method === 'GET' && path === '/account/export') return reply(200, { account: view(account), created: account.created, usage: store.db.prepare('SELECT request_id,status,created FROM usage WHERE user_id=?').all(account.id) });
      if (account.customer && account.synced < store.clock() - 300000) {
        await serial(account.id, () => billing.sync(account.id)); account = store.account(account.id);
      }
      if (req.method === 'GET' && path === '/me') return reply(200, { account: view(account) });
      if (req.method === 'POST' && path === '/trial') return reply(200, { account: view(store.startTrial(account.id)) });
      if (req.method === 'POST' && ['/billing/checkout', '/billing/portal'].includes(path)) {
        store.rate(`billing:${account.id}`, 10, 60000);
        return reply(200, await serial(account.id, () => path.endsWith('checkout') ? billing.checkout(account.id) : billing.portal(account.id)));
      }
      if (req.method !== 'POST' || !['/transcribe', '/summarize'].includes(path)) throw new HttpError(404, 'Rota não encontrada.');
      if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Envie JSON.');
      const requestId = req.headers['idempotency-key'];
      if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)) throw new HttpError(400, 'Idempotency-Key obrigatório.');
      store.rate(`ai:${account.id}`, config.aiRate, 60000);
      const body = jsonBody(await readBody(req, path === '/transcribe' ? 34 * 1024 * 1024 : 256 * 1024));
      const kind = path.slice(1); let input;
      try { input = kind === 'transcribe' ? validateTranscriptionInput(body) : validateSummaryInput(body); }
      catch (e) { throw new HttpError(e.status || 400, e.message); }
      // The commercial service chooses the model; never honor client-supplied model IDs.
      if (kind === 'transcribe') { input.model = config.model; if ((input.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data) || Buffer.from(input.data, 'base64').toString('base64') !== input.data)) throw new HttpError(400, 'Áudio base64 inválido.'); }
      const cached = store.reserve(account.id, requestId, hmac(config.encryptionKey, JSON.stringify({ kind, input })));
      if (cached) return reply(200, cached);
      reserved = [account.id, requestId];
      const result = await ai(kind, input);
      store.finish(account.id, requestId, result); reserved = null;
      return reply(200, result);
    } catch (e) {
      if (reserved) store.release(...reserved);
      const timedOut = ['AbortError', 'TimeoutError'].includes(e?.name);
      const status = timedOut ? 504 : e.status || 500;
      // Do not expose SDK/upstream messages, credentials, email, audio or transcripts in logs/errors.
      return reply(status, { error: timedOut ? 'O processamento demorou demais. Tente novamente.' : status < 500 ? e.message : 'Serviço temporariamente indisponível.', code: e.code || 'REQUEST_FAILED' });
    }
  });
  server.requestTimeout = 70000; server.headersTimeout = 15000; server.maxHeadersCount = 32;
  const cleanup = setInterval(() => store.cleanup(), 60000); cleanup.unref();
  server.on('close', () => { clearInterval(cleanup); store.close(); });
  return { server, store, billing };
}
