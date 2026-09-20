import test from 'node:test';
import assert from 'node:assert/strict';

async function worker(t, read, fetcher) {
  const previous = { chrome: globalThis.chrome, fetch: globalThis.fetch };
  let listener;
  const removed = [];
  const session = {};
  globalThis.chrome = {
    runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: { addListener(fn) { listener = fn; } } },
    storage: {
      local: { async setAccessLevel() {}, async remove(keys) { removed.push(keys); }, get: read },
      session: {
        async setAccessLevel() {},
        async get(key) { if (key === null) return { ...session }; return typeof key === 'string' ? { [key]: session[key] } : {}; },
        async set(values) { Object.assign(session, values); },
      },
    },
  };
  globalThis.fetch = fetcher;
  t.after(() => { globalThis.chrome = previous.chrome; globalThis.fetch = previous.fetch; });
  await import(`../extension/background.js?test=${crypto.randomUUID()}`);
  const send = (message, sender = { id: 'test', url: 'chrome-extension://test/workspace.html' }) => new Promise(resolve => listener(message, sender, resolve));
  return { send, removed, session };
}
const accountA = { token: 'token-A', accountId: 'A', epoch: 1, consent: true };
const accountB = { token: 'token-B', accountId: 'B', epoch: 2, consent: true };
const save = { type: 'workspace:save', context: 'A:1', storageConsent: true, item: { body: 'Private A content' } };

test('workspace rejects account switching before sending private content', async t => {
  let reads = 0, calls = 0;
  const h = await worker(t, async () => ({ ...(reads++ === 0 ? accountA : accountB) }), async () => { calls++; throw new Error('must not send'); });
  const result = await h.send(save);
  assert.equal(result.ok, false); assert.match(result.error, /sessão mudou/); assert.equal(calls, 0);
});

test('workspace keeps the original credential for a send and discards results after a switch', async t => {
  let current = accountA;
  const h = await worker(t, async () => ({ ...current }), async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer token-A');
    current = accountB;
    return { status: 200, ok: true, async json() { return { item: save.item }; } };
  });
  const result = await h.send(save);
  assert.equal(result.ok, false); assert.match(result.error, /sessão mudou/);
});

test('an old account 401 cannot remove a newly signed-in account', async t => {
  let current = accountA;
  const h = await worker(t, async () => ({ ...current }), async () => {
    current = accountB;
    return { status: 401, ok: false, async json() { return { error: 'Expired old session' }; } };
  });
  const result = await h.send(save);
  assert.equal(result.ok, false);
  assert.equal(h.removed.some(keys => keys.includes('token')), false);
});

test('transport retry reuses one idempotency key while a new UI invocation gets a new key', async t => {
  const keys = [];
  const h = await worker(t, async () => ({ ...accountA }), async (_url, options) => {
    keys.push(options.headers['Idempotency-Key']);
    if (keys.length === 1) throw new TypeError('connection lost after request upload');
    if (keys.length === 2) return { status: 409, ok: false, async json() { return { error: 'still running', code: 'IN_PROGRESS' }; } };
    if (keys.length === 4) return { status: 503, ok: false, async json() { return { error: 'temporarily unavailable' }; } };
    return { status: 200, ok: true, async json() { return { text: 'Recovered briefing' }; } };
  });
  const message = { type: 'workspace:assist', context: 'A:1', action: 'briefing', text: 'Synthetic context' };
  assert.equal((await h.send(message)).ok, true);
  assert.equal((await h.send(message)).ok, true);
  assert.equal(keys.length, 5);
  assert.equal(keys[0], keys[1]); assert.equal(keys[1], keys[2]);
  assert.equal(keys[3], keys[4]);
  assert.notEqual(keys[0], keys[3]);
  assert.match(keys[0], /^[0-9a-f-]{36}$/);
});

test('WhatsApp content is not sent with a newly switched account', async t => {
  let reads = 0, calls = 0;
  const h = await worker(t, async () => ({ ...(reads++ === 0 ? accountA : accountB) }), async () => { calls++; throw new Error('must not send'); });
  const sender = { id: 'test', url: 'https://web.whatsapp.com/', tab: { id: 7 } };
  const result = await h.send({ type: 'summarize', context: 'A:1', text: 'Private A content' }, sender);
  assert.equal(result.ok, false); assert.match(result.error, /sessão mudou/); assert.equal(calls, 0);
});
