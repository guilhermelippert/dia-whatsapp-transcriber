const $ = id => document.getElementById(id);
let items = [], cache = {}, context = null, generation = 0, sourceVersion = 0;
const fold = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
function node(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; }
async function rpc(type, data = {}) {
  const started = generation;
  const result = await chrome.runtime.sendMessage({ type: `workspace:${type}`, context, ...data });
  if (generation !== started) throw new Error('A sessão mudou. Atualize o painel.');
  if (!result?.ok) throw new Error(result?.error || 'Não foi possível concluir.');
  return result;
}
async function run(operation, button) {
  $('status').textContent = 'Processando…'; if (button) button.disabled = true;
  try { await operation(); $('status').textContent = 'Concluído.'; }
  catch (e) { $('status').textContent = e.message; }
  finally { if (button) button.disabled = false; }
}
function action(label, fn) { const b = node('button', label, 'secondary'); b.type = 'button'; b.onclick = () => run(fn, b); return b; }
function newItem(kind, title, body = '', dueAt = '') {
  return { id: crypto.randomUUID(), revision: 0, kind, title, body, dueAt, done: false, conversation: $('conversation-title').value };
}
async function save(item) {
  if (!$('storage-consent').checked) throw new Error('Marque a autorização de armazenamento antes de salvar.');
  const result = await rpc('save', { item, storageConsent: true });
  items = [result.item, ...items.filter(i => i.id !== item.id)]; render(); return result.item;
}
async function remove(item) {
  if (!confirm(`Excluir "${item.title}" da biblioteca?`)) return;
  await rpc('delete', { id: item.id, revision: item.revision }); items = items.filter(i => i.id !== item.id); render();
}
async function copy(text) { if (!text.trim()) throw new Error('Não há texto para copiar.'); await navigator.clipboard.writeText(text); }
function card(item, temporary = false) {
  const box = node('article', undefined, 'card');
  if (item.done) box.classList.add('done');
  if (item.kind === 'task' && !item.done && item.dueAt && Date.parse(item.dueAt) < Date.now()) box.classList.add('overdue');
  box.append(node('h3', item.title));
  const detail = [item.conversation, temporary ? 'Cache desta sessão' : `Salvo até ${new Date(item.expiresAt).toLocaleDateString('pt-BR')}`];
  if (item.dueAt) detail.push(`Prazo: ${new Date(item.dueAt).toLocaleString('pt-BR')}`);
  if (item.kind === 'task') detail.push(item.done ? 'Concluída' : item.dueAt && Date.parse(item.dueAt) < Date.now() ? 'Atrasada' : 'Pendente');
  box.append(node('div', detail.filter(Boolean).join(' · '), 'meta'));
  if (item.body) box.append(node('p', item.body.slice(0, 700) + (item.body.length > 700 ? '\n… Copiar inclui o texto completo.' : '')));
  const buttons = node('div', undefined, 'actions');
  buttons.append(action('Copiar', () => copy(item.body || item.title)));
  if (temporary) buttons.append(action('Salvar na biblioteca', () => save(newItem('note', item.title, item.body))));
  else {
    if (item.kind === 'task') buttons.append(action(item.done ? 'Reabrir' : 'Concluir', () => save({ ...item, done: !item.done })));
    buttons.append(action('Excluir', () => remove(item)));
  }
  box.append(buttons); return box;
}
function list(id, entries, temporary = false) {
  const target = $(id); target.replaceChildren();
  if (!entries.length) target.append(node('p', 'Nenhum item encontrado.', 'empty'));
  else for (const item of entries) target.append(card(item, temporary));
}
function render() {
  const tasks = items.filter(i => i.kind === 'task').sort((a, b) => Number(a.done) - Number(b.done) || (Date.parse(a.dueAt) || Infinity) - (Date.parse(b.dueAt) || Infinity));
  list('task-list', tasks); list('reply-list', items.filter(i => i.kind === 'reply'));
  const search = fold($('library-search').value), target = $('library-list'); target.replaceChildren();
  const notes = [...items.map(item => ({ item, temporary: false })), ...Object.values(cache).map((v, index) => ({ temporary: true, item: { title: `Áudio da sessão ${index + 1}`, body: `${v.transcript || ''}${v.summary ? '\n\n' + v.summary : ''}`, conversation: '', kind: 'note' } }))];
  for (const { item, temporary } of notes) if (fold(`${item.title} ${item.body} ${item.conversation}`).includes(search)) target.append(card(item, temporary));
  if (!target.children.length) target.append(node('p', 'Nenhum item encontrado.', 'empty'));
}
async function refresh() {
  const result = await rpc('init'); items = result.items; cache = result.cache; context = result.context; render();
  const select = $('conversation-tab'); select.replaceChildren();
  if (!result.consent) { select.append(new Option('Autorize a IA no popup para carregar conversas', '')); return; }
  const { tabs } = await rpc('tabs');
  tabs.forEach(t => select.append(new Option(t.title, String(t.id))));
  if (!tabs.length) select.append(new Option('Abra o WhatsApp Web e atualize o painel', ''));
}
function sourceChanged() { sourceVersion++; $('digest-box').hidden = true; $('extracted-box').hidden = true; $('digest-result').value = ''; $('extracted-tasks').replaceChildren(); }
$('context').oninput = sourceChanged;
$('conversation-title').oninput = sourceChanged;
function currentSource(version) { if (version !== sourceVersion) throw new Error('O trecho mudou durante o processamento. Revise e solicite novamente.'); }
function source() { const text = $('context').value.trim(); if (!text) throw new Error('Carregue ou cole um trecho e revise antes de usar a IA.'); return text; }
function localDue(value) { if (!value) return ''; const date = new Date(value); if (!Number.isFinite(+date)) throw new Error('Prazo inválido.'); return date.toISOString(); }
$('refresh').onclick = event => run(refresh, event.target);
$('load-conversation').onclick = event => run(async () => {
  const tab = $('conversation-tab').value; if (!tab) throw new Error('Selecione uma aba disponível.');
  const result = await rpc('capture', { tabId: Number(tab) }); sourceChanged(); $('context').value = result.text; $('conversation-title').value = result.title;
  $('context').focus(); $('context').setAttribute('aria-label', result.truncated ? 'Trecho limitado. Revise antes de enviar à IA.' : 'Trecho da conversa para revisão.');
}, event.target);
$('digest').onclick = event => run(async () => {
  const version = sourceVersion;
  const result = await rpc('assist', { action: 'catchup', text: source() });
  currentSource(version); $('digest-result').value = result.text; $('digest-box').hidden = false;
}, event.target);
$('save-digest').onclick = event => run(() => save(newItem('note', $('conversation-title').value || 'Resumo de conversa', $('digest-result').value)), event.target);
$('extract-tasks').onclick = event => run(async () => {
  const version = sourceVersion;
  const result = await rpc('assist', { action: 'tasks', text: source() });
  currentSource(version); const target = $('extracted-tasks'); target.replaceChildren(); $('extracted-box').hidden = false;
  if (!result.tasks?.length) target.append(node('p', 'Nenhuma tarefa explícita encontrada.'));
  for (const task of result.tasks || []) {
    const box = node('article', undefined, 'card'), title = node('input'), body = node('textarea'), due = node('input');
    title.value = task.title; title.maxLength = 200; title.setAttribute('aria-label', 'Título da tarefa sugerida');
    body.value = task.body; body.maxLength = 2000; body.setAttribute('aria-label', 'Detalhes da tarefa sugerida');
    due.type = 'datetime-local'; due.setAttribute('aria-label', 'Prazo opcional, horário local');
    box.append(title, body, node('p', `Evidência: “${task.source}”`, 'hint'), due);
    box.append(action('Salvar tarefa revisada', async () => {
      await save(newItem('task', title.value, `${body.value}\nEvidência: ${task.source}`, localDue(due.value)));
      box.replaceChildren(node('p', 'Tarefa salva. Gerencie-a na seção Tarefas.'));
    })); target.append(box);
  }
}, event.target);
$('draft-reply').onclick = event => run(async () => {
  const version = sourceVersion;
  const result = await rpc('assist', { action: 'reply', text: source(), tone: $('reply-tone').value });
  currentSource(version); $('reply-body').value = result.text; if (!$('reply-title').value) $('reply-title').value = $('conversation-title').value || 'Resposta sugerida'; $('reply-body').focus();
}, event.target);
$('task-form').onsubmit = event => { event.preventDefault(); run(async () => { await save(newItem('task', $('task-title').value, '', localDue($('task-due').value))); $('task-form').reset(); }, event.submitter); };
$('reply-form').onsubmit = event => { event.preventDefault(); run(async () => { await save(newItem('reply', $('reply-title').value, $('reply-body').value)); $('reply-form').reset(); }, event.submitter); };
$('copy-draft').onclick = event => run(() => copy($('reply-body').value), event.target);
$('library-search').oninput = render;
$('export').onclick = event => run(async () => {
  const data = await rpc('export'), url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = node('a'); a.href = url; a.download = 'dia-biblioteca-e-conta.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}, event.target);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !['accountId', 'token', 'epoch', 'consent'].some(k => k in changes)) return;
  generation++; sourceVersion++; context = null; items = []; cache = {}; render();
  for (const id of ['context', 'conversation-title', 'digest-result', 'task-title', 'task-due', 'reply-title', 'reply-body']) $(id).value = '';
  $('extracted-tasks').replaceChildren(); $('digest-box').hidden = true; $('extracted-box').hidden = true; $('storage-consent').checked = false;
  $('status').textContent = 'Sessão ou consentimento alterado. Atualize o painel para continuar.';
});
run(refresh);
