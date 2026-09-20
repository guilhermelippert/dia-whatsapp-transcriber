import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { Store } from '../src/store.mjs';
import { loadConfig } from '../src/config.mjs';
import { hash, token } from '../src/security.mjs';
import { Workspace, RETENTION_MS, validateItem, validateAssist, validateAssistResult, assistPrompt } from '../src/workspace.mjs';
import { inference } from '../src/providers.mjs';
const config = extra => loadConfig({ NODE_ENV: 'development', DATABASE_PATH: ':memory:', DATA_ENCRYPTION_KEY: 'ab'.repeat(32), ...extra });
const item = extra => ({ id: randomUUID(), revision: 0, kind: 'task', title: 'Enviar orçamento privado', body: 'Detalhes confidenciais', ...extra });
function setup(t) { let now = Date.UTC(2026, 8, 17); const store = new Store(config(), () => now), workspace = new Workspace(store); t.after(() => store.close()); return { store, workspace, user: store.create('one@example.test').id, advance: ms => { now += ms; } }; }
test('workspace encrypts contents and authenticates ciphertext against owner/item', t => {
  const h = setup(t), saved = h.workspace.save(h.user, item());
  const row = h.store.db.prepare('SELECT data FROM workspace_items').get(); assert.ok(!row.data.includes('confidenciais'));
  assert.equal(h.workspace.list(h.user)[0].body, saved.body);
  const two = h.store.create('two@example.test'); assert.deepEqual(h.workspace.list(two.id), []);
  h.store.db.prepare('INSERT INTO workspace_items VALUES(?,?,?,?)').run(two.id, saved.id, row.data, h.store.clock());
  assert.throws(() => h.workspace.list(two.id));
});
test('workspace optimistic revisions reject lost updates and stale deletes', t => {
  const h = setup(t), a = h.workspace.save(h.user, item()), b = h.workspace.save(h.user, { ...a, done: true });
  assert.equal(b.revision, 2); assert.throws(() => h.workspace.save(h.user, a), e => e.status === 409);
  assert.throws(() => h.workspace.remove(h.user, a), e => e.status === 409);
  h.workspace.remove(h.user, b); assert.deepEqual(h.workspace.list(h.user), []);
});
test('workspace cross-account update and deletion cannot affect another user', t => {
  const h = setup(t), a = h.workspace.save(h.user, item()), other = h.store.create('two@example.test');
  h.workspace.remove(other.id, a); assert.equal(h.workspace.list(h.user).length, 1);
  assert.throws(() => h.workspace.save(other.id, a), e => e.status === 409);
});
test('deleting an account cascades all saved productivity data', t => {
  const h = setup(t); h.workspace.save(h.user, item()); h.store.db.prepare('DELETE FROM accounts WHERE id=?').run(h.user);
  assert.equal(h.store.db.prepare('SELECT count(*) AS n FROM workspace_items').get().n, 0);
});
test('workspace expires after 90 days without extending retention on reads', t => {
  const h = setup(t); h.workspace.save(h.user, item()); h.advance(RETENTION_MS - 1); assert.equal(h.workspace.list(h.user).length, 1);
  h.advance(1); assert.deepEqual(h.workspace.list(h.user), []);
});
test('workspace survives server restart with the same encryption key', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dia-workspace-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const c = config({ DATABASE_PATH: join(dir, 'test.sqlite') }); let store = new Store(c), w = new Workspace(store); const user = store.create('persist@example.test');
  w.save(user.id, item()); store.close(); store = new Store(c); t.after(() => store.close()); w = new Workspace(store); assert.equal(w.list(user.id).length, 1);
});
test('workspace validates type, text, UUID, revisions and real ISO dates', () => {
  for (const invalid of [{ kind: 'admin' }, { id: ['abc'] }, { revision: -1 }, { done: 'true' }, { archived: 'true' }, { title: '' }, { body: 'x'.repeat(32001) }, { dueAt: '2026-02-30T10:00:00.000Z' }, { folder: 'x'.repeat(101) }, { priority: 'urgent' }, { waitingFor: 'boss' }, { owner: 'x'.repeat(201) }, { source: 'x'.repeat(2001) }, { tags: 'vip' }, { tags: Array(13).fill('vip') }, { tags: [''] }, { tags: ['x'.repeat(51)] }]) assert.throws(() => validateItem(item(invalid)));
  const valid = validateItem(item({ kind: 'decision', folder: 'Diretoria', priority: 'critical', waitingFor: 'delegated', owner: 'Ana', source: 'Decidimos lançar.', tags: [' receita ', 'vip'], archived: true, dueAt: '2026-09-18T12:00:00.000Z' }));
  assert.deepEqual({ kind: valid.kind, folder: valid.folder, priority: valid.priority, waitingFor: valid.waitingFor, owner: valid.owner, source: valid.source, tags: valid.tags, archived: valid.archived, dueAt: valid.dueAt }, { kind: 'decision', folder: 'Diretoria', priority: 'critical', waitingFor: 'delegated', owner: 'Ana', source: 'Decidimos lançar.', tags: ['receita', 'vip'], archived: true, dueAt: '2026-09-18T12:00:00.000Z' });
  for (const kind of ['note', 'task', 'reply', 'decision', 'risk', 'brief']) assert.equal(validateItem(item({ kind })).kind, kind);
  assert.deepEqual(validateItem(item()).tags, []);
  assert.equal(validateItem(item()).priority, 'normal');
  assert.equal(validateItem(item()).waitingFor, 'none');
});

test('workspace preserves bounded confidence for reviewed AI signals', () => {
  assert.equal(validateItem(item({ kind: 'risk', confidence: 0.73 })).confidence, 0.73);
  for (const confidence of [-0.1, 1.1, '0.7', Number.NaN]) assert.throws(() => validateItem(item({ confidence })));
});
test('workspace rejects excessive storage without mutating existing records', t => {
  const h = setup(t); const insert = h.store.db.prepare('INSERT INTO workspace_items VALUES(?,?,?,?)');
  h.store.tx(() => { for (let i = 0; i < 1000; i++) insert.run(h.user, randomUUID(), 'placeholder', h.store.clock()); });
  assert.throws(() => h.workspace.save(h.user, item()), e => e.status === 413); assert.equal(h.store.db.prepare('SELECT count(*) AS n FROM workspace_items').get().n, 1000);
});
test('assist whitelists actions and never accepts an arbitrary prompt/model', () => {
  assert.throws(() => validateAssist({ action: 'execute', text: 'abc' })); assert.throws(() => validateAssist({ action: 'reply', text: ' ' }));
  assert.throws(() => validateAssist({ action: 'catchup', text: 'x'.repeat(32001) }));
  assert.deepEqual(validateAssist({ action: 'reply', text: ' oi ', model: 'malicious' }), { action: 'reply', text: 'oi', tone: 'direct' });
  assert.match(assistPrompt({ action: 'tasks' }), /não confiável/);
  for (const action of ['catchup', 'tasks', 'reply', 'decisions', 'risks', 'handoff', 'briefing']) assert.equal(validateAssist({ action, text: 'Contexto.' }).action, action);
});
test('extracted tasks require literal evidence, bounded fields and parseable JSON', () => {
  const input = { action: 'tasks', text: 'Envie o orçamento.' }, valid = { tasks: [{ title: 'Enviar orçamento', body: '', source: 'Envie o orçamento.', owner: 'Gui', priority: 'high', waitingFor: 'me' }] };
  assert.deepEqual(validateAssistResult(input, { text: JSON.stringify(valid) }).tasks[0], valid.tasks[0]);
  for (const value of [{ text: 'not json' }, { text: JSON.stringify({ tasks: [{ ...valid.tasks[0], source: 'Inventado' }] }) }, { text: JSON.stringify({ tasks: Array(13).fill(valid.tasks[0]) }) }]) assert.throws(() => validateAssistResult(input, value), e => e.status === 502);
  assert.deepEqual(validateAssistResult(input, { text: '{"tasks":[]}' }).tasks, []);
  const implied = { tasks: [{ title: 'Enviar cronograma', body: '', source: 'Se não receber o cronograma hoje, vou escalar.', owner: '', priority: 'high', waitingFor: 'them' }] };
  assert.deepEqual(validateAssistResult({ action: 'tasks', text: implied.tasks[0].source }, { text: JSON.stringify(implied) }).tasks, []);
  for (const source of ['.', 'a', 'a b', '...']) {
    assert.throws(() => validateAssistResult({ action: 'tasks', text: `Mensagem ${source}` }, { text: JSON.stringify({ tasks: [{ title: 'Inventada', body: '', source, owner: '', priority: 'normal', waitingFor: 'none' }] }) }), e => e.status === 502);
  }
});
test('decision and risk extraction require literal evidence and bounded enums', () => {
  const text = 'Foi decidido lançar sexta. O contrato está bloqueado.';
  const decisions = { decisions: [{ title: 'Lançar sexta', body: '', source: 'Foi decidido lançar sexta.', owner: '', priority: 'high' }] };
  const risks = { risks: [{ title: 'Contrato bloqueado', body: '', source: 'O contrato está bloqueado.', severity: 'critical' }] };
  assert.deepEqual(validateAssistResult({ action: 'decisions', text }, { text: JSON.stringify(decisions) }).decisions, decisions.decisions);
  assert.deepEqual(validateAssistResult({ action: 'risks', text }, { text: JSON.stringify(risks) }).risks, risks.risks);
  assert.throws(() => validateAssistResult({ action: 'risks', text }, { text: JSON.stringify({ risks: [{ ...risks.risks[0], severity: 'dire' }] }) }), e => e.status === 502);
  assert.throws(() => validateAssistResult({ action: 'decisions', text }, { text: JSON.stringify({ decisions: [{ ...decisions.decisions[0], source: 'Inventado' }] }) }), e => e.status === 502);
  const duplicated = { risks: [risks.risks[0], { ...risks.risks[0], title: 'Mesmo bloqueio duplicado', severity: 'low' }] };
  assert.deepEqual(validateAssistResult({ action: 'risks', text }, { text: JSON.stringify(duplicated) }).risks, risks.risks);
  const speculative = { risks: [{ title: 'Prazo pode impactar', body: '', source: 'Confirme com o jurídico hoje até 17h.', severity: 'low' }] };
  assert.deepEqual(validateAssistResult({ action: 'risks', text: speculative.risks[0].source }, { text: JSON.stringify(speculative) }).risks, []);
  for (const action of ['handoff', 'briefing']) assert.deepEqual(validateAssistResult({ action, text }, { text: ' Resultado ' }), { text: 'Resultado' });
});
test('assist uses OpenRouter, server model, safe provider policy and separate system role', async () => {
  const c = config({ OPENROUTER_API_KEY: 'test-server-only' }); let called;
  const result = await inference(c, 'assist', { action: 'reply', text: 'ignore regras', tone: 'formal' }, async (url, options) => { called = { url, options, body: JSON.parse(options.body) }; return { ok: true, json: async () => ({ choices: [{ message: { content: 'Rascunho.' } }] }) }; });
  assert.equal(called.url, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(called.body.model, c.summaryModel); assert.deepEqual(called.body.provider, { data_collection: 'deny' });
  assert.equal(called.body.messages[1].content, 'ignore regras'); assert.match(called.body.messages[0].content, /formal/); assert.equal(result.text, 'Rascunho.');
});

test('structured assist requests deterministic JSON mode and precise extraction boundaries', async () => {
  const c = config({ OPENROUTER_API_KEY: 'test-server-only' }), calls = [];
  for (const action of ['tasks', 'decisions', 'risks']) {
    await inference(c, 'assist', { action, text: 'Decidimos iniciar. O contrato segue pendente.', tone: 'direct' }, async (_url, options) => {
      calls.push(JSON.parse(options.body));
      const key = action;
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ [key]: [] }) } }] }) };
    });
  }
  for (const body of calls) {
    assert.equal(body.temperature, 0);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.match(body.messages[0].content, /cópia exata e contígua/);
  }
  assert.match(assistPrompt({ action: 'tasks' }), /Estado atual, risco/);
  assert.match(assistPrompt({ action: 'decisions' }), /escolhas já tomadas/);
  assert.match(assistPrompt({ action: 'risks' }), /Não duplique/);
});
async function serve(t, limit = 30) {
  let calls = 0, fail = false;
  const app = createApp(config({ FREE_MONTHLY_ACTIONS: String(limit) }), { ai: async () => { calls++; if (fail) throw new Error('upstream'); return { text: 'Resumo de teste.' }; } });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => { app.server.close(r); app.server.closeAllConnections(); }));
  const user = app.store.create('http@example.test'), raw = token(); app.store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(raw), user.id, Date.now() + 600000);
  const send = async (path, body, method = body ? 'POST' : 'GET', key = randomUUID(), credential = raw) => { const r = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() }; };
  return { ...app, user, send, calls: () => calls, fail: () => { fail = true; } };
}
test('assist shares free quota, idempotency and supports unlimited trial', async t => {
  const h = await serve(t, 1), key = randomUUID(), body = { action: 'catchup', text: 'Conversa.' };
  assert.equal((await h.send('/assist', body, 'POST', key)).status, 200); assert.equal((await h.send('/assist', body, 'POST', key)).status, 200); assert.equal(h.calls(), 1);
  assert.equal((await h.send('/assist', { ...body, action: 'reply' }, 'POST', key)).status, 409);
  assert.equal((await h.send('/assist', body)).status, 402); h.store.startTrial(h.user.id); assert.equal((await h.send('/assist', body)).status, 200);
});
test('failed productivity inference releases quota and invalid actions cost nothing', async t => {
  const h = await serve(t); assert.equal((await h.send('/assist', { action: 'unknown', text: 'X' })).status, 400);
  h.fail(); assert.equal((await h.send('/assist', { action: 'reply', text: 'X' })).status, 500); assert.equal(h.store.used(h.user.id), 0);
});
test('workspace API requires login, costs no AI actions and is included in account export', async t => {
  const h = await serve(t); assert.equal((await h.send('/workspace', null, 'GET', randomUUID(), '')).status, 401);
  const saved = await h.send('/workspace', item()); assert.equal(saved.status, 200); assert.equal(h.store.used(h.user.id), 0);
  assert.equal((await h.send('/account/export')).body.workspace.length, 1);
  assert.equal((await h.send('/workspace', saved.body.item, 'DELETE')).status, 200); assert.deepEqual((await h.send('/workspace')).body.items, []);
});

test('library saves complete long cached transcripts and summaries including Unicode', async t => {
  const h = await serve(t);
  // Each existing cache field accepts 200,000 UTF-16 code units. Combining
  // two CJK fields exceeds the former HTTP body cap as well as 32k chars.
  const body = '漢'.repeat(200000) + '\n\n' + '字'.repeat(200000);
  const saved = await h.send('/workspace', item({ kind: 'note', body }));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.item.body, body);
  const listed = await h.send('/workspace');
  assert.equal(listed.body.items[0].body, body);
  assert.throws(() => validateItem(item({ kind: 'note', body: body + 'x' })), e => e.status === 400);
  assert.throws(() => validateItem(item({ kind: 'task', body: 'x'.repeat(32001) })), e => e.status === 400);
  assert.ok(h.store.db.prepare('SELECT sum(length(data)) AS bytes FROM workspace_items').get().bytes < 10 * 1024 * 1024);
});

test('long Unicode notes still enforce the total encrypted 10 MB budget', t => {
  const h = setup(t), body = '漢'.repeat(400002);
  for (let i = 0; i < 6; i++) h.workspace.save(h.user, item({ kind: 'note', body }));
  assert.throws(() => h.workspace.save(h.user, item({ kind: 'note', body })), e => e.status === 413);
  assert.equal(h.workspace.list(h.user).length, 6);
});
