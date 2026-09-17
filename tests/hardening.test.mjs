import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { capacityGate, isCanonicalBase64, hmacParts, hash } from '../src/security.mjs';
import { Billing } from '../src/providers.mjs';
import { REQUIRED_WEBHOOK_EVENTS, hasRequiredEvents, webhookReady, ensureWebhook } from '../src/billing-config.mjs';
import { validateManifest } from '../scripts/validate-manifest.mjs';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
const key = 'ab'.repeat(32);
const c = extra => loadConfig({ NODE_ENV: 'development', DATABASE_PATH: ':memory:', DATA_ENCRYPTION_KEY: key, ...extra });
const pause = ms => new Promise(r => setTimeout(r, ms));
const price = { active: true, type: 'recurring', recurring: { interval: 'month', interval_count: 1 }, unit_amount: 2990, currency: 'brl' };

test('base64 validation preserves canonical pad bits and rejects malformed audio', () => {
  for (let size = 1; size < 256; size++) assert.ok(isCanonicalBase64(randomBytes(size).toString('base64')));
  for (const text of ['', 'A', 'AAAA=', 'AA=A', 'AA==\n', '====', 'AB==', 'AAB=', '-AAA', 'AA A']) assert.equal(isCanonicalBase64(text), false, text);
  assert.ok(isCanonicalBase64('AA==')); assert.ok(isCanonicalBase64('AAA='));
});
test('incremental fingerprint length framing prevents collisions between fields', () => {
  assert.notEqual(hmacParts(key, ['ab', 'c']), hmacParts(key, ['a', 'bc']));
  assert.notEqual(hmacParts(key, ['á', '']), hmacParts(key, ['', 'á']));
  assert.equal(hmacParts(key, ['audio', 'x'.repeat(100000)]), hmacParts(key, ['audio', 'x'.repeat(100000)]));
});
test('body-capacity gate enforces both limits and releases exactly once', () => {
  const enter = capacityGate(3), a = enter('a'), b = enter('a'), other = enter('b');
  assert.throws(() => enter('a'), e => e.code === 'BUSY');
  assert.throws(() => enter('c'), e => e.code === 'BUSY');
  a(); a(); const next = enter('c'); assert.throws(() => enter('d'));
  b(); other(); next(); enter('a')();
});
test('price cache coalesces requests and backs off failures for ten seconds', async () => {
  let now = 1, calls = 0, failing = true;
  const billing = new Billing({ stripePrice: 'price_test' }, { clock: () => now }, async () => { calls++; await pause(5); if (failing) throw new Error('unavailable'); return price; });
  assert.ok((await Promise.allSettled(Array.from({ length: 12 }, () => billing.price()))).every(r => r.status === 'rejected'));
  assert.equal(calls, 1); await assert.rejects(billing.price()); assert.equal(calls, 1);
  now += 10000; failing = false;
  const values = await Promise.all(Array.from({ length: 12 }, () => billing.price()));
  assert.equal(calls, 2); assert.equal(values[0].amount, 2990); await billing.price(); assert.equal(calls, 2);
  now += 300001; await billing.price(); assert.equal(calls, 3);
});
test('webhook readiness checks every event and supports wildcard subscriptions', () => {
  assert.ok(hasRequiredEvents({ enabled_events: ['*'] }));
  assert.ok(hasRequiredEvents({ enabled_events: REQUIRED_WEBHOOK_EVENTS }));
  assert.equal(hasRequiredEvents({ enabled_events: REQUIRED_WEBHOOK_EVENTS.slice(1) }), false);
  assert.equal(webhookReady({ url: 'https://dia.test/stripe/webhook', status: 'disabled', enabled_events: ['*'] }, { baseUrl: 'https://dia.test' }), false);
});
test('setup repairs disabled or incomplete webhook without creating a duplicate', async () => {
  const calls = [], config = { baseUrl: 'https://dia.test', stripeVersion: 'test' };
  const request = async (path, values) => { calls.push({ path, values }); return values ? { id: 'we_1', ...values } : { data: [{ id: 'we_1', url: `${config.baseUrl}/stripe/webhook`, status: 'disabled', enabled_events: ['invoice.created'] }], has_more: false }; };
  await ensureWebhook(request, config);
  assert.equal(calls.length, 2); assert.equal(calls[1].path, '/webhook_endpoints/we_1');
  assert.equal(calls[1].values.disabled, 'false');
  const events = Object.values(calls[1].values); for (const e of REQUIRED_WEBHOOK_EVENTS) assert.ok(events.includes(e)); assert.ok(events.includes('invoice.created'));
});
test('setup paginates existing webhooks and leaves a complete endpoint unchanged', async () => {
  const calls = []; const config = { baseUrl: 'https://dia.test' };
  const request = async path => { calls.push(path); return calls.length === 1 ? { data: [{ id: 'we_other', url: 'https://other.test' }], has_more: true } : { data: [{ id: 'we_right', url: `${config.baseUrl}/stripe/webhook`, status: 'enabled', enabled_events: ['*'] }], has_more: false }; };
  const result = await ensureWebhook(request, config); assert.equal(result.id, 'we_right'); assert.equal(calls.length, 2); assert.match(calls[1], /starting_after=we_other/);
});
test('release validator compares Chrome versions numerically and scans nested source', t => {
  const directory = mkdtempSync(join(tmpdir(), 'dia-manifest-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync('extension', directory, { recursive: true });
  const file = join(directory, 'manifest.json'), original = JSON.parse(readFileSync(file));
  writeFileSync(file, JSON.stringify({ ...original, minimum_chrome_version: '99' })); assert.throws(() => validateManifest(directory));
  writeFileSync(file, JSON.stringify({ ...original, minimum_chrome_version: '120' })); validateManifest(directory);
  mkdirSync(join(directory, 'nested')); writeFileSync(join(directory, 'nested', 'bad.js'), 'eval("secret")'); assert.throws(() => validateManifest(directory), /eval/);
  writeFileSync(join(directory, 'nested', 'bad.js'), `const secret = "sk_live_${'x'.repeat(16)}"`); assert.throws(() => validateManifest(directory), /Segredo/);
});
function area(initial = {}) {
  let data = structuredClone(initial);
  return { get: async keys => keys === null ? structuredClone(data) : typeof keys === 'string' ? { [keys]: data[keys] } : { ...keys, ...data }, set: async value => { Object.assign(data, structuredClone(value)); }, remove: async keys => { for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; } };
}
test('vault key lives in session; cache survives worker restart but not browser restart', async t => {
  const original = globalThis.chrome; t.after(() => { globalThis.chrome = original; });
  const local = area({ vaultKey: 'obsolete', 'vault:legacy': { data: 'old' } }), session = area(); globalThis.chrome = { storage: { local, session } };
  const a = await import(`../extension/vault.js?a=${Date.now()}`); await a.changeVault('test', {}, () => ({ text: 'private text' }));
  assert.equal((await local.get(null)).vaultKey, undefined); assert.equal((await local.get(null))['vault:legacy'], undefined);
  assert.ok((await session.get(null)).vaultKey); assert.ok(!JSON.stringify(await local.get(null)).includes('private text'));
  const b = await import(`../extension/vault.js?b=${Date.now()}`); assert.deepEqual(await b.readVault('test'), { text: 'private text' });
  globalThis.chrome = { storage: { local, session: area() } };
  const fresh = await import(`../extension/vault.js?c=${Date.now()}`); assert.deepEqual(await fresh.readVault('test'), {});
  await fresh.changeVault('test', {}, () => ({ text: 'new' })); await fresh.clearVaults(); assert.deepEqual(await fresh.readVault('test'), {});
});
async function serve(t, extra = {}) {
  const app = createApp(c(extra), { clock: () => Date.UTC(2026, 8, 17), stripe: async () => price, ai: async () => ({ text: 'ok' }) });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { app.server.close(r); app.server.closeAllConnections(); }));
  return { ...app, base: `http://127.0.0.1:${app.server.address().port}` };
}
test('public plan endpoint rate-limits before requesting a price', async t => {
  const h = await serve(t); let calls = 0; h.billing.price = async () => { calls++; return { amount: 2990 }; };
  for (let i = 0; i < 30; i++) assert.equal((await fetch(h.base + '/plan')).status, 200);
  assert.equal((await fetch(h.base + '/plan')).status, 429); assert.equal(calls, 30);
});
test('slow upload bodies occupy capacity before JSON parsing and release on abort', async t => {
  const h = await serve(t), a = h.store.create('upload@example.test'), raw = randomBytes(32).toString('base64url');
  h.store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(raw), a.id, h.store.clock() + 100000);
  let received = 0; h.server.on('request', () => { received++; });
  const open = n => { const req = http.request(h.base + '/transcribe', { method: 'POST', headers: { Authorization: `Bearer ${raw}`, 'Content-Type': 'application/json', 'Idempotency-Key': `incomplete-upload-${n}` } }); req.on('error', () => {}); req.write('{'); return req; };
  const one = open(1), two = open(2); t.after(() => { one.destroy(); two.destroy(); });
  for (let i = 0; received < 2 && i < 100; i++) await pause(5); assert.equal(received, 2);
  const send = () => fetch(h.base + '/transcribe', { method: 'POST', headers: { Authorization: `Bearer ${raw}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'complete-upload-request' }, body: JSON.stringify({ data: 'AA==', format: 'wav' }) });
  assert.equal((await send()).status, 429); assert.equal(h.store.used(a.id), 0);
  one.destroy(); two.destroy(); await pause(30); assert.equal((await send()).status, 200);
});
