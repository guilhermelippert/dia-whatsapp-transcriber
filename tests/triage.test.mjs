import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { hash, token } from '../src/security.mjs';
import { CATEGORIES, CONFLICT_LEVELS, URGENCY_LEVELS, derivePriority, jevTriage, triageQuestions, validateTriageInput, validateTriageResult } from '../src/triage.mjs';

const config = extra => loadConfig({ NODE_ENV: 'development', DATABASE_PATH: ':memory:', DATA_ENCRYPTION_KEY: 'ab'.repeat(32), TYPESAFE_API_KEY: '', ...extra });
const payload = (extra = {}) => ({
  model: 'jev-1.13.0',
  answers: {
    urgency: { type: 'score', score: 2.8, confidence: 0.92, legend: Object.fromEntries(URGENCY_LEVELS.map((v, i) => [String(i), v])), probabilities: { 0: 0, 1: 0, 2: 0.2, 3: 0.8 } },
    conflict: { type: 'score', score: 1.2, confidence: 0.7, legend: Object.fromEntries(CONFLICT_LEVELS.map((v, i) => [String(i), v])), probabilities: { 0: 0, 1: 0.8, 2: 0.2, 3: 0 } },
    needs_response: { type: 'noul', noul: 0.87 },
    category: { type: 'choice', choice: 'revenue', confidence: 0.81, probabilities: { people: 0, customer: 0.1, revenue: 0.8, operation: 0.1, other: 0 } },
  },
  usage: { input_tokens: 100, output_tokens: 20 },
  ...extra,
});

test('triage validates input and defines four independent typed judgments', () => {
  assert.deepEqual(validateTriageInput({ text: '  preciso hoje  ', model: 'attacker' }), { text: 'preciso hoje' });
  for (const text of ['', ' ', 'x'.repeat(32001)]) assert.throws(() => validateTriageInput({ text }));
  const questions = triageQuestions();
  assert.deepEqual(Object.keys(questions), ['urgency', 'conflict', 'needs_response', 'category']);
  assert.equal(questions.urgency.type, 'score'); assert.equal(questions.urgency.criteria.length, 4);
  assert.equal(questions.conflict.type, 'score'); assert.equal(questions.conflict.criteria.length, 4);
  assert.equal(questions.needs_response.type, 'noul');
  assert.deepEqual(Object.keys(questions.category.criteria), Object.keys(CATEGORIES));
});

test('triage validates the complete TypeSafe response and derives priority in code', () => {
  assert.deepEqual(validateTriageResult(payload()), {
    model: 'jev-1.13.0', urgency: { score: 2.8, confidence: 0.92 }, conflict: { score: 1.2, confidence: 0.7 },
    needsResponse: { probability: 0.87 }, category: { choice: 'revenue', confidence: 0.81 }, priority: 'critical',
  });
  assert.equal(derivePriority({ urgency: 0, conflict: 0, needsResponse: 0.1 }), 'low');
  assert.equal(derivePriority({ urgency: 0.6, conflict: 0, needsResponse: 0.1 }), 'normal');
  assert.equal(derivePriority({ urgency: 1.5, conflict: 0, needsResponse: 0.1 }), 'high');
  assert.equal(derivePriority({ urgency: 0, conflict: 2.75, needsResponse: 0.1 }), 'critical');
});

test('triage rejects malformed, partial and extra provider answers', () => {
  const cases = [
    { ...payload(), model: '' },
    { ...payload(), answers: { ...payload().answers, extra: { type: 'noul', noul: 1 } } },
    { ...payload(), answers: { ...payload().answers, urgency: { ...payload().answers.urgency, type: 'choice' } } },
    { ...payload(), answers: { ...payload().answers, conflict: { ...payload().answers.conflict, probabilities: { 0: 0.2, 1: 0.2, 2: 0.2, 3: 0.2 } } } },
    { ...payload(), answers: { ...payload().answers, needs_response: { type: 'noul', noul: 2 } } },
    { ...payload(), answers: { ...payload().answers, category: { ...payload().answers.category, choice: 'secret' } } },
    { ...payload(), answers: { ...payload().answers, urgency: { ...payload().answers.urgency, score: 3, probabilities: { 0: 1, 1: 0, 2: 0, 3: 0 } } } },
    { ...payload(), answers: { ...payload().answers, category: { ...payload().answers.category, choice: 'other', probabilities: { people: 0, customer: 0, revenue: 1, operation: 0, other: 0 } } } },
    { ...payload(), answers: { ...payload().answers, conflict: { ...payload().answers.conflict, legend: { ...payload().answers.conflict.legend, 2: 'Injected label' } } } },
  ];
  for (const value of cases) assert.throws(() => validateTriageResult(value), e => e.status === 502);
});

test('Jev provider uses only the official endpoint, server model and bearer key', async () => {
  const c = config({ TYPESAFE_API_KEY: 'ts_secret', TYPESAFE_MODEL: 'jev-latest' }); let call;
  const result = await jevTriage(c, { text: 'Resolver agora.' }, async (url, options) => { call = { url, options, body: JSON.parse(options.body) }; return new Response(JSON.stringify(payload())); });
  assert.equal(call.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(call.options.headers.Authorization, 'Bearer ts_secret');
  assert.equal(call.body.model, 'jev-latest'); assert.equal(call.body.state, 'Resolver agora.');
  assert.deepEqual(Object.keys(call.body.questions), ['urgency', 'conflict', 'needs_response', 'category']);
  assert.equal(result.priority, 'critical');
  await assert.rejects(jevTriage(config(), { text: 'x' }, async () => { throw new Error('must not call'); }), e => e.status === 503 && e.code === 'TRIAGE_UNAVAILABLE');
  await assert.rejects(jevTriage(c, { text: 'x' }, async () => new Response('{"secret":"leak"}', { status: 401 })), e => e.status === 502 && !e.message.includes('leak'));
});

test('TypeSafe key stays optional in production configuration', () => {
  const c = loadConfig({ NODE_ENV: 'production', DATABASE_PATH: '/tmp/dia-prod.sqlite', DATA_ENCRYPTION_KEY: 'ab'.repeat(32), OPENROUTER_API_KEY: 'or', STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_PRICE_ID: 'price_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', RESEND_API_KEY: 're_x', EMAIL_FROM: 'Dia <dia@real-domain.com>', SUPPORT_EMAIL: 'support@real-domain.com', PUBLISHER_NAME: 'Dia', PUBLIC_BASE_URL: 'https://dia.real-domain.com', EXTENSION_ORIGINS: `chrome-extension://${'a'.repeat(32)}`, TYPESAFE_API_KEY: '' });
  assert.equal(c.typesafeKey, ''); assert.equal(c.typesafeModel, 'jev-latest');
});

test('HTTP triage shares quota, idempotency and fingerprints with AI actions', async t => {
  let calls = 0;
  const app = createApp(config({ FREE_MONTHLY_ACTIONS: '1' }), { triage: async () => { calls++; return validateTriageResult(payload()); } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const user = app.store.create('triage@example.test'), raw = token();
  app.store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(raw), user.id, Date.now() + 600000);
  const send = async (text, key = randomUUID()) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/triage`, { method: 'POST', headers: { Authorization: `Bearer ${raw}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ text }) });
    return { status: response.status, body: await response.json() };
  };
  const key = randomUUID(), first = await send('Preciso disso agora.', key), replay = await send('Preciso disso agora.', key);
  assert.equal(first.status, 200); assert.deepEqual(replay.body, first.body); assert.equal(calls, 1); assert.equal(app.store.used(user.id), 1);
  assert.equal((await send('Outro conteúdo.', key)).status, 409);
  assert.equal((await send('Novo pedido.')).status, 402); assert.equal(calls, 1);
});

test('HTTP triage refunds quota after TypeSafe rate limit, overload and timeout', async t => {
  const c = config({ FREE_MONTHLY_ACTIONS: '1', TYPESAFE_API_KEY: 'ts_secret' }); let mode = 429;
  const triage = input => {
    if (mode === 'timeout') throw Object.assign(new Error('private input must not leak'), { name: 'TimeoutError' });
    if (mode === 'ok') return validateTriageResult(payload());
    return jevTriage(c, input, async () => new Response(JSON.stringify({ detail: 'upstream secret' }), { status: mode }));
  };
  const app = createApp(c, { triage });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const user = app.store.create('failures@example.test'), raw = token();
  app.store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(raw), user.id, Date.now() + 600000);
  const send = async () => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/triage`, { method: 'POST', headers: { Authorization: `Bearer ${raw}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ text: 'conteúdo privado' }) });
    return { status: response.status, text: await response.text() };
  };
  for (const [failure, status] of [[429, 429], [529, 502], ['timeout', 504]]) {
    mode = failure; const response = await send(); assert.equal(response.status, status); assert.ok(!response.text.includes('secret')); assert.ok(!response.text.includes('privado')); assert.equal(app.store.used(user.id), 0);
  }
  mode = 'ok'; assert.equal((await send()).status, 200); assert.equal(app.store.used(user.id), 1);
});
