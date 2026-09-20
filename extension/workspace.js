const $ = id => document.getElementById(id);
let items = [], cache = {}, context = null, generation = 0, sourceVersion = 0, briefingPreviewVersion = 0, currentTriage = null;

const KINDS = { note: 'Nota', task: 'Tarefa', reply: 'Resposta', decision: 'Decisão', risk: 'Risco', brief: 'Briefing' };
const PRIORITIES = { critical: 'Crítica', high: 'Alta', normal: 'Normal', low: 'Baixa' };
const WAITING = { none: 'Ninguém', me: 'Minha ação', them: 'Terceiros', delegated: 'Delegado' };
const fold = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
const cleanTags = value => [...new Set((Array.isArray(value) ? value : String(value ?? '').split(',')).map(tag => String(tag).trim()).filter(Boolean))].slice(0, 12);
const isOverdue = item => !item.done && !item.archived && Boolean(item.dueAt) && Date.parse(item.dueAt) < Date.now();

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function option(value, label, selected = false) {
  const item = new Option(label, value, false, selected);
  return item;
}
function selectField(labelText, values, selected, ariaLabel) {
  const label = node('label', labelText);
  const select = node('select');
  select.setAttribute('aria-label', ariaLabel || labelText);
  for (const [value, labelTextValue] of Object.entries(values)) select.append(option(value, labelTextValue, value === selected));
  label.append(select);
  return { label, select };
}
async function rpc(type, data = {}) {
  const started = generation;
  const result = await chrome.runtime.sendMessage({ type: `workspace:${type}`, context, ...data });
  if (generation !== started) throw new Error('A sessão mudou. Atualize o painel.');
  if (!result?.ok) throw new Error(result?.error || 'Não foi possível concluir.');
  return result;
}
async function run(operation, button) {
  const controls = [...document.querySelectorAll('button')].map(control => [control, control.disabled]);
  const originalLabel = button?.textContent;
  $('status').textContent = 'Processando…';
  $('status').setAttribute('aria-busy', 'true');
  for (const [control] of controls) control.disabled = true;
  if (button) button.textContent = 'Processando…';
  try {
    const message = await operation();
    $('status').textContent = typeof message === 'string' && message ? message : 'Concluído.';
  } catch (error) {
    $('status').textContent = error.message;
  } finally {
    $('status').removeAttribute('aria-busy');
    for (const [control, disabled] of controls) if (control.isConnected) control.disabled = disabled;
    if (button?.isConnected && originalLabel !== undefined) button.textContent = originalLabel;
  }
}
function action(label, fn, className = 'secondary') {
  const button = node('button', label, className);
  button.type = 'button';
  button.onclick = () => run(fn, button);
  return button;
}
function normalizeItem(item) {
  return {
    ...item,
    folder: item.folder || '',
    priority: item.priority || 'normal',
    waitingFor: item.waitingFor || 'none',
    owner: item.owner || '',
    source: item.source || '',
    tags: cleanTags(item.tags),
    archived: item.archived === true,
    done: item.done === true,
  };
}
function newItem(kind, title, body = '', dueAt = '', extras = {}) {
  return normalizeItem({
    id: crypto.randomUUID(), revision: 0, kind, title, body, dueAt, done: false,
    conversation: $('conversation-title').value.trim(), folder: $('context-folder').value.trim(),
    priority: 'normal', waitingFor: 'none', owner: '', source: '', tags: [], archived: false,
    ...extras,
  });
}
async function save(item) {
  if (!$('storage-consent').checked) throw new Error('Marque a autorização de armazenamento antes de salvar.');
  const result = await rpc('save', { item: normalizeItem(item), storageConsent: true });
  items = [normalizeItem(result.item), ...items.filter(existing => existing.id !== item.id)];
  render();
  return result.item;
}
async function remove(item) {
  if (!confirm(`Excluir "${item.title}" da biblioteca?`)) return;
  await rpc('delete', { id: item.id, revision: item.revision });
  items = items.filter(existing => existing.id !== item.id);
  render();
}
async function copy(text) {
  if (!String(text).trim()) throw new Error('Não há texto para copiar.');
  await navigator.clipboard.writeText(text);
}
function chip(text, className = '') {
  return node('span', text, `chip ${className}`.trim());
}
function compactCard(item) {
  const box = node('article', undefined, `compact-card priority-${item.priority}`);
  const top = node('div', undefined, 'compact-card-top');
  top.append(node('strong', item.title));
  if (item.priority === 'critical' || item.priority === 'high') top.append(chip(PRIORITIES[item.priority], `priority ${item.priority}`));
  box.append(top);
  const details = [];
  if (item.conversation) details.push(item.conversation);
  if (item.owner) details.push(item.owner);
  if (item.dueAt) details.push(new Date(item.dueAt).toLocaleString('pt-BR'));
  box.append(node('span', details.join(' · ') || KINDS[item.kind], 'meta'));
  return box;
}
function card(item, temporary = false) {
  const box = node('article', undefined, `card kind-${item.kind} priority-${item.priority}`);
  if (item.done) box.classList.add('done');
  if (item.archived) box.classList.add('archived');
  if (isOverdue(item)) box.classList.add('overdue');

  const heading = node('div', undefined, 'card-heading');
  heading.append(node('h3', item.title));
  const chips = node('div', undefined, 'chips');
  chips.append(chip(KINDS[item.kind] || item.kind, 'kind'));
  if (item.priority) chips.append(chip(PRIORITIES[item.priority] || item.priority, `priority ${item.priority}`));
  if (item.folder) chips.append(chip(item.folder, 'folder'));
  if (item.done) chips.append(chip(item.kind === 'risk' ? 'Mitigado' : 'Concluído', 'status done'));
  else if (isOverdue(item)) chips.append(chip('Atrasado', 'status overdue'));
  if (item.archived) chips.append(chip('Arquivado', 'status archived'));
  heading.append(chips);
  box.append(heading);

  const detail = [];
  if (item.conversation) detail.push(`Conversa: ${item.conversation}`);
  if (item.owner) detail.push(`Responsável: ${item.owner}`);
  if (item.waitingFor && item.waitingFor !== 'none') detail.push(`Aguardando: ${WAITING[item.waitingFor] || item.waitingFor}`);
  if (item.dueAt) detail.push(`Prazo: ${new Date(item.dueAt).toLocaleString('pt-BR')}`);
  if (temporary) detail.push('Cache desta sessão');
  else if (item.expiresAt) detail.push(`Salvo até ${new Date(item.expiresAt).toLocaleDateString('pt-BR')}`);
  box.append(node('div', detail.join(' · '), 'meta'));

  if (item.body) box.append(node('p', item.body.slice(0, 900) + (item.body.length > 900 ? '\n… Copiar inclui o texto completo.' : '')));
  if (item.source) {
    const evidence = node('div', undefined, 'evidence');
    evidence.append(node('strong', 'Evidência '), node('span', item.source));
    box.append(evidence);
  }
  const extra = node('div', undefined, 'card-extra');
  if (item.confidence !== undefined && item.confidence !== '') {
    const numeric = Number(item.confidence);
    extra.append(chip(`Confiança: ${Number.isFinite(numeric) ? `${Math.round(numeric <= 1 ? numeric * 100 : numeric)}%` : item.confidence}`, 'confidence'));
  }
  for (const tag of cleanTags(item.tags)) extra.append(chip(`#${tag}`, 'tag'));
  if (extra.children.length) box.append(extra);

  const buttons = node('div', undefined, 'actions');
  buttons.append(action('Copiar', () => copy(item.body || item.title)));
  if (temporary) {
    const label = item.body.length > 32000 ? `Salvar texto completo (${item.body.length.toLocaleString('pt-BR')} caracteres)` : 'Salvar na biblioteca';
    buttons.append(action(label, () => save(newItem('note', item.title, item.body))));
  } else {
    if (['task', 'decision', 'risk'].includes(item.kind)) buttons.append(action(item.done ? 'Reabrir' : item.kind === 'risk' ? 'Marcar mitigado' : 'Concluir', () => save({ ...item, done: !item.done })));
    buttons.append(action('Editar', () => editItem(box, item)));
    buttons.append(action(item.archived ? 'Desarquivar' : 'Arquivar', () => save({ ...item, archived: !item.archived })));
    buttons.append(action('Excluir', () => remove(item)));
  }
  box.append(buttons);
  return box;
}
function editItem(box, item) {
  const form = node('form', undefined, 'edit-form');
  const title = node('input'), body = node('textarea'), folder = node('input'), owner = node('input'), tags = node('input'), due = node('input');
  title.value = item.title; title.maxLength = 200; title.required = true;
  body.value = item.body || ''; body.maxLength = item.kind === 'note' ? 400002 : 32000; body.rows = 5;
  folder.value = item.folder || ''; folder.maxLength = 100; folder.setAttribute('list', 'folder-options');
  owner.value = item.owner || ''; owner.maxLength = 200;
  tags.value = cleanTags(item.tags).join(', '); tags.maxLength = 700;
  due.type = 'datetime-local';
  if (item.dueAt) { const parsed = new Date(item.dueAt); if (Number.isFinite(+parsed)) due.value = new Date(+parsed - parsed.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
  const priority = selectField('Prioridade', PRIORITIES, item.priority, 'Prioridade do item');
  const waiting = selectField('Aguardando', WAITING, item.waitingFor, 'Aguardando do item');
  const fields = node('div', undefined, 'field-grid two');
  for (const [labelText, input] of [['Título', title], ['Pasta', folder], ['Responsável', owner], ['Tags', tags], ['Prazo', due]]) { const label = node('label', labelText); label.append(input); fields.append(label); }
  fields.append(priority.label, waiting.label);
  const bodyLabel = node('label', 'Detalhes'); bodyLabel.append(body);
  const actions = node('div', undefined, 'actions');
  const saveButton = node('button', 'Salvar alterações'); saveButton.type = 'submit';
  const cancel = node('button', 'Cancelar', 'secondary'); cancel.type = 'button'; cancel.onclick = render;
  actions.append(saveButton, cancel); form.append(fields, bodyLabel, actions);
  form.onsubmit = event => {
    event.preventDefault();
    run(() => save({ ...item, title: title.value, body: body.value, folder: folder.value.trim(), owner: owner.value.trim(), tags: cleanTags(tags.value), dueAt: localDue(due.value), priority: priority.select.value, waitingFor: waiting.select.value }), saveButton);
  };
  box.replaceChildren(form); title.focus();
}
function list(id, entries, temporary = false, compact = false) {
  const target = $(id);
  target.replaceChildren();
  if (!entries.length) target.append(node('p', 'Nenhum item encontrado.', 'empty'));
  else for (const item of entries) target.append(compact ? compactCard(item) : card(item, temporary));
}
function searchable(item) {
  return fold([
    item.title, item.body, item.conversation, item.folder, item.owner, item.source,
    PRIORITIES[item.priority], WAITING[item.waitingFor], KINDS[item.kind], ...cleanTags(item.tags),
  ].join(' '));
}
function attentionScore(item) {
  let score = { critical: 400, high: 300, normal: 200, low: 100 }[item.priority] || 0;
  if (isOverdue(item)) score += 1000;
  if (item.waitingFor === 'me') score += 180;
  if (item.waitingFor === 'them' || item.waitingFor === 'delegated') score += 120;
  if (item.done) score -= 500;
  if (item.archived) score -= 1000;
  return score;
}
function updateFolderControls() {
  const folders = [...new Set(items.map(item => item.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const datalist = $('folder-options');
  datalist.replaceChildren(...folders.map(folder => option(folder, folder)));
  for (const id of ['filter-folder', 'briefing-folder']) {
    const select = $(id), current = select.value;
    const first = id === 'filter-folder' ? 'Todas' : 'Todas as pastas';
    select.replaceChildren(option('', first), ...folders.map(folder => option(folder, folder)));
    if (folders.includes(current)) select.value = current;
  }
}
function renderMetrics(active) {
  const definitions = [
    ['critical', 'Críticos', active.filter(item => item.priority === 'critical' && !item.done).length],
    ['overdue', 'Atrasados', active.filter(isOverdue).length],
    ['waiting-me', 'Aguardando você', active.filter(item => item.waitingFor === 'me' && !item.done).length],
    ['waiting-them', 'Aguardando terceiros', active.filter(item => ['them', 'delegated'].includes(item.waitingFor) && !item.done).length],
    ['decisions', 'Decisões abertas', active.filter(item => item.kind === 'decision' && !item.done).length],
  ];
  const target = $('metrics');
  target.replaceChildren();
  for (const [id, label, value] of definitions) {
    const metric = node('div', undefined, 'metric');
    metric.id = `metric-${id}`;
    metric.append(node('strong', String(value)), node('span', label));
    target.append(metric);
  }
}
function renderLibrary() {
  const search = fold($('library-search').value), folder = $('filter-folder').value, kind = $('filter-kind').value;
  const status = $('filter-status').value, priority = $('filter-priority').value, waiting = $('filter-waiting').value;
  const notes = [
    ...items.map(item => ({ item, temporary: false })),
    ...Object.values(cache).map((value, index) => ({ temporary: true, item: normalizeItem({ title: `Áudio da sessão ${index + 1}`, body: `${value.transcript || ''}${value.summary ? '\n\n' + value.summary : ''}`, conversation: '', kind: 'note' }) })),
  ];
  const filtered = notes.filter(({ item, temporary }) => {
    if (search && !searchable(item).includes(search)) return false;
    if (folder && item.folder !== folder) return false;
    if (kind && item.kind !== kind) return false;
    if (priority && item.priority !== priority) return false;
    if (waiting && item.waitingFor !== waiting) return false;
    if (status === 'open' && (item.done || item.archived)) return false;
    if (status === 'done' && !item.done) return false;
    if (status === 'archived' && !item.archived) return false;
    if (status === 'overdue' && !isOverdue(item)) return false;
    return temporary || status !== 'archived' || item.archived;
  });
  const sorter = $('filter-sort').value;
  filtered.sort((a, b) => {
    if (sorter === 'recent') return (b.item.updated || 0) - (a.item.updated || 0);
    if (sorter === 'due') return (Date.parse(a.item.dueAt) || Infinity) - (Date.parse(b.item.dueAt) || Infinity);
    if (sorter === 'title') return a.item.title.localeCompare(b.item.title, 'pt-BR');
    return attentionScore(b.item) - attentionScore(a.item) || (b.item.updated || 0) - (a.item.updated || 0);
  });
  const target = $('library-list');
  target.replaceChildren();
  for (const entry of filtered) target.append(card(entry.item, entry.temporary));
  if (!target.children.length) target.append(node('p', 'Nenhum item encontrado.', 'empty'));
}
function render() {
  items = items.map(normalizeItem);
  updateFolderControls();
  const active = items.filter(item => !item.archived);
  renderMetrics(active);
  const radar = active.filter(item => ['task', 'risk'].includes(item.kind) && !item.done).sort((a, b) => attentionScore(b) - attentionScore(a) || (Date.parse(a.dueAt) || Infinity) - (Date.parse(b.dueAt) || Infinity)).slice(0, 6);
  const decisions = active.filter(item => item.kind === 'decision').sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, 5);
  list('radar-list', radar, false, true);
  list('recent-decisions', decisions, false, true);
  const tasks = active.filter(item => item.kind === 'task').sort((a, b) => Number(a.done) - Number(b.done) || attentionScore(b) - attentionScore(a) || (Date.parse(a.dueAt) || Infinity) - (Date.parse(b.dueAt) || Infinity));
  list('task-list', tasks);
  list('decision-list', active.filter(item => item.kind === 'decision'));
  list('risk-list', active.filter(item => item.kind === 'risk').sort((a, b) => attentionScore(b) - attentionScore(a)));
  list('reply-list', active.filter(item => item.kind === 'reply'));
  renderLibrary();
}
async function refresh() {
  const result = await rpc('init');
  items = (result.items || []).map(normalizeItem);
  cache = result.cache || {};
  context = result.context;
  render();
  const select = $('conversation-tab');
  select.replaceChildren();
  if (!result.consent) {
    select.append(option('', 'Autorize a IA no popup para carregar conversas'));
    return;
  }
  const { tabs } = await rpc('tabs');
  for (const tab of tabs) select.append(option(String(tab.id), tab.title));
  if (!tabs.length) select.append(option('', 'Abra o WhatsApp Web e atualize o painel'));
}
function sourceChanged() {
  sourceVersion++;
  currentTriage = null;
  for (const id of ['digest-box', 'briefing-box', 'handoff-box', 'triage-box', 'extracted-box', 'decisions-box', 'risks-box']) $(id).hidden = true;
  for (const id of ['digest-result', 'briefing-result', 'handoff-result']) $(id).value = '';
  for (const id of ['triage-result', 'extracted-tasks', 'extracted-decisions', 'extracted-risks']) $(id).replaceChildren();
}
$('context').oninput = sourceChanged;
$('conversation-title').oninput = sourceChanged;
function currentSource(version) {
  if (version !== sourceVersion) throw new Error('O trecho mudou durante o processamento. Revise e solicite novamente.');
}
function source() {
  const text = $('context').value.trim();
  if (!text) throw new Error('Carregue ou cole um trecho e revise antes de usar a IA.');
  return text;
}
function localDue(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(+date)) throw new Error('Prazo inválido.');
  return date.toISOString();
}
function addEvidence(box, value) {
  const evidence = node('p', undefined, 'hint evidence-preview');
  evidence.append(node('strong', 'Evidência: '), node('span', value || 'Não informada'));
  box.append(evidence);
}
function suggestionFields(suggestion, kind) {
  const box = node('article', undefined, 'card suggestion');
  const title = node('input'), body = node('textarea'), owner = node('input'), folder = node('input');
  title.value = suggestion.title || ''; title.maxLength = 200; title.setAttribute('aria-label', `Título de ${KINDS[kind].toLocaleLowerCase('pt-BR')} sugerida`);
  body.value = suggestion.body || ''; body.maxLength = kind === 'task' ? 2000 : 32000; body.setAttribute('aria-label', `Detalhes de ${KINDS[kind].toLocaleLowerCase('pt-BR')} sugerida`);
  owner.value = suggestion.owner || ''; owner.maxLength = 120; owner.placeholder = 'Responsável, se confirmado'; owner.setAttribute('aria-label', 'Responsável sugerido');
  folder.value = $('context-folder').value; folder.maxLength = 100; folder.setAttribute('list', 'folder-options'); folder.setAttribute('aria-label', 'Pasta do item sugerido');
  box.append(title, body);
  addEvidence(box, suggestion.source);
  const fields = node('div', undefined, 'field-grid two compact-fields');
  const riskPriority = suggestion.severity === 'medium' ? 'normal' : suggestion.severity;
  const priority = selectField('Prioridade', PRIORITIES, suggestion.priority || riskPriority || (kind === 'risk' ? 'high' : 'normal'), 'Prioridade sugerida');
  const waiting = selectField('Aguardando', WAITING, suggestion.waitingFor || 'none', 'Aguardando sugerido');
  const ownerLabel = node('label', 'Responsável'); ownerLabel.append(owner);
  const folderLabel = node('label', 'Pasta'); folderLabel.append(folder);
  fields.append(priority.label, waiting.label, ownerLabel, folderLabel);
  box.append(fields);
  const due = node('input'); due.type = 'datetime-local'; due.setAttribute('aria-label', 'Prazo opcional, horário local');
  if (kind === 'task' && suggestion.dueAt) {
    const parsed = new Date(suggestion.dueAt);
    if (Number.isFinite(+parsed)) due.value = new Date(+parsed - parsed.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  if (kind === 'task') { const dueLabel = node('label', 'Prazo, opcional'); dueLabel.append(due); box.append(dueLabel); }
  const saveButton = action(`Salvar ${KINDS[kind].toLocaleLowerCase('pt-BR')} revisada`, async () => {
    if (!title.value.trim()) throw new Error('Dê um título ao item antes de salvar.');
    await save(newItem(kind, title.value, body.value, kind === 'task' ? localDue(due.value) : '', {
      folder: folder.value.trim(), owner: owner.value.trim(), source: suggestion.source || '',
      confidence: suggestion.confidence ?? '', priority: priority.select.value, waitingFor: waiting.select.value,
      tags: cleanTags(suggestion.tags),
    }));
    box.replaceChildren(node('p', `${KINDS[kind]} salva. Você pode gerenciá-la no painel.`));
  });
  box.append(saveButton);
  return box;
}
async function runExtraction(actionName, resultKey, targetId, boxId, kind, button) {
  await run(async () => {
    const version = sourceVersion;
    const result = await rpc('assist', { action: actionName, text: source() });
    currentSource(version);
    const target = $(targetId); target.replaceChildren(); $(boxId).hidden = false;
    const suggestions = result[resultKey] || [];
    if (!suggestions.length) target.append(node('p', `Nenhuma ${KINDS[kind].toLocaleLowerCase('pt-BR')} explícita encontrada.`));
    for (const suggestion of suggestions) target.append(suggestionFields(suggestion, kind));
  }, button);
}
function showTextResult(actionName, resultId, boxId, button, text = source(), guard) {
  return run(async () => {
    const version = sourceVersion;
    const result = await rpc('assist', { action: actionName, text });
    if (text === $('context').value.trim()) currentSource(version);
    if (guard) guard();
    $(resultId).value = result.text;
    $(boxId).hidden = false;
    $(resultId).focus();
  }, button);
}
function renderTriage(result) {
  const data = result.triage || result;
  currentTriage = data;
  const categories = { people: 'Pessoas', customer: 'Cliente', revenue: 'Receita', operation: 'Operação', other: 'Outros' };
  const percent = value => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return value;
    return `${Math.round(numeric <= 1 ? numeric * 100 : numeric)}%`;
  };
  const withConfidence = (value, confidence) => {
    const main = value === undefined || value === '' ? 'Não informado' : percent(value);
    return confidence === undefined || confidence === '' ? String(main) : `${main} · confiança ${percent(confidence)}`;
  };
  const rows = [
    ['Categoria', typeof data.category === 'object' ? withConfidence(categories[data.category.choice] || data.category.choice, data.category.confidence) : data.category || data.categoria],
    ['Urgência', typeof data.urgency === 'object' ? `${Number(data.urgency.score).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} de 3 · confiança ${percent(data.urgency.confidence)}` : data.urgency || data.urgencia],
    ['Conflito', typeof data.conflict === 'object' ? `${Number(data.conflict.score).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} de 3 · confiança ${percent(data.conflict.confidence)}` : data.conflict ?? data.conflito],
    ['Resposta necessária', typeof data.needsResponse === 'object' ? withConfidence(data.needsResponse.probability) : data.responseNeeded ?? data.needsReply ?? data.respostaNecessaria],
    ['Prioridade', PRIORITIES[data.priority] || data.priority],
    ['Modelo', data.model],
  ];
  const target = $('triage-result'); target.replaceChildren();
  for (const [label, raw] of rows) {
    const value = typeof raw === 'boolean' ? (raw ? 'Sim' : 'Não') : raw;
    const cell = node('div', undefined, 'triage-cell');
    cell.append(node('span', label, 'meta'), node('strong', value === undefined || value === '' ? 'Não informado' : String(value)));
    target.append(cell);
  }
  $('triage-box').hidden = false;
}
function savedBriefingPreview() {
  const folder = $('briefing-folder').value;
  const selected = items.filter(item => !item.archived && (!folder || item.folder === folder));
  if (!selected.length) throw new Error('Não há itens salvos nesta seleção.');
  const lines = selected.sort((a, b) => attentionScore(b) - attentionScore(a)).map((item, index) => {
    const meta = [KINDS[item.kind], item.priority && `prioridade ${PRIORITIES[item.priority]}`, item.conversation && `conversa ${item.conversation}`, item.folder && `pasta ${item.folder}`, item.owner && `responsável ${item.owner}`, item.dueAt && `prazo ${new Date(item.dueAt).toLocaleString('pt-BR')}`, item.waitingFor !== 'none' && `aguardando ${WAITING[item.waitingFor]}`, item.done && 'concluído'].filter(Boolean).join('; ');
    return `${index + 1}. ${item.title}\nMetadados: ${meta}\nConteúdo: ${item.body || 'Sem detalhes'}${item.source ? `\nEvidência: ${item.source}` : ''}`;
  });
  const kept = [], max = 31750;
  for (const line of lines) {
    const candidate = [...kept, line].join('\n\n');
    if (candidate.length > max) continue;
    kept.push(line);
  }
  const omitted = lines.length - kept.length;
  const notice = omitted ? `[Prévia limitada: ${kept.length} de ${lines.length} itens incluídos. ${omitted} omitidos por limite de tamanho.]\n\n` : '';
  const text = `${notice}${kept.join('\n\n')}`;
  if (!kept.length) throw new Error('Os itens selecionados excedem o limite individual. Reduza o conteúdo antes de gerar o briefing.');
  $('briefing-source-preview').value = text;
  briefingPreviewVersion++;
  $('run-saved-briefing').disabled = false;
  return omitted ? `Prévia montada com ${kept.length} de ${lines.length} itens. Revise os itens omitidos antes de gerar.` : 'Prévia completa montada. Revise antes de gerar.';
}

$('refresh').onclick = event => run(refresh, event.target);
$('load-conversation').onclick = event => run(async () => {
  const tab = $('conversation-tab').value;
  if (!tab) throw new Error('Selecione uma aba disponível.');
  const result = await rpc('capture', { tabId: Number(tab) });
  sourceChanged();
  $('context').value = result.text;
  $('conversation-title').value = result.title;
  $('context').focus();
  $('context').setAttribute('aria-label', result.truncated ? 'Trecho limitado. Revise antes de enviar à IA.' : 'Trecho da conversa para revisão.');
  return result.truncated ? 'Conversa carregada com limite de 50 mensagens ou 32.000 caracteres. Revise o início e o fim do trecho antes de usar IA.' : 'Conversa carregada para revisão. Nada foi enviado à IA.';
}, event.target);
$('digest').onclick = event => showTextResult('catchup', 'digest-result', 'digest-box', event.target);
$('save-digest').onclick = event => run(() => save(newItem('note', $('conversation-title').value || 'Resumo de conversa', $('digest-result').value, '', { tags: ['resumo'] })), event.target);
$('extract-tasks').onclick = event => runExtraction('tasks', 'tasks', 'extracted-tasks', 'extracted-box', 'task', event.target);
$('extract-decisions').onclick = event => runExtraction('decisions', 'decisions', 'extracted-decisions', 'decisions-box', 'decision', event.target);
$('extract-risks').onclick = event => runExtraction('risks', 'risks', 'extracted-risks', 'risks-box', 'risk', event.target);
$('generate-briefing').onclick = event => showTextResult('briefing', 'briefing-result', 'briefing-box', event.target);
$('save-briefing').onclick = event => run(() => save(newItem('brief', `${$('conversation-title').value || 'Conversa'} · Briefing`, $('briefing-result').value, '', { tags: ['briefing'] })), event.target);
$('generate-handoff').onclick = event => showTextResult('handoff', 'handoff-result', 'handoff-box', event.target);
$('save-handoff').onclick = event => run(() => save(newItem('brief', `${$('conversation-title').value || 'Conversa'} · Handoff`, $('handoff-result').value, '', { tags: ['handoff'] })), event.target);
$('copy-handoff').onclick = event => run(() => copy($('handoff-result').value), event.target);
$('jev-triage').onclick = event => run(async () => {
  const version = sourceVersion;
  const result = await rpc('triage', { text: source() });
  currentSource(version);
  renderTriage(result);
}, event.target);
$('save-triage').onclick = event => run(() => {
  if (!currentTriage) throw new Error('Execute a triagem antes de salvar.');
  const category = currentTriage.category?.choice || 'other';
  const confidence = Math.min(currentTriage.urgency?.confidence ?? 0, currentTriage.conflict?.confidence ?? 0, Math.abs((currentTriage.needsResponse?.probability ?? .5) - .5) * 2);
  const body = `Categoria: ${category}\nUrgência: ${currentTriage.urgency?.score ?? 'n/d'} de 3\nConflito: ${currentTriage.conflict?.score ?? 'n/d'} de 3\nProbabilidade de resposta necessária: ${Math.round((currentTriage.needsResponse?.probability ?? 0) * 100)}%\nModelo: ${currentTriage.model || 'Jev'}`;
  return save(newItem('risk', `${$('conversation-title').value || 'Conversa'} · Sinal de atenção`, body, '', { priority: currentTriage.priority || 'normal', confidence, tags: ['jev', category] }));
}, event.target);
$('prepare-saved-briefing').onclick = event => run(async () => savedBriefingPreview(), event.target);
$('briefing-source-preview').oninput = () => { briefingPreviewVersion++; $('run-saved-briefing').disabled = !$('briefing-source-preview').value.trim(); };
$('run-saved-briefing').onclick = event => {
  const text = $('briefing-source-preview').value.trim();
  if (!text) return run(async () => { throw new Error('Monte ou escreva uma prévia antes de gerar.'); }, event.target);
  const version = briefingPreviewVersion;
  return showTextResult('briefing', 'briefing-result', 'briefing-box', event.target, text, () => {
    if (version !== briefingPreviewVersion) throw new Error('A prévia mudou durante o processamento. Gere o briefing novamente.');
  });
};
$('draft-reply').onclick = event => run(async () => {
  const version = sourceVersion;
  const result = await rpc('assist', { action: 'reply', text: source(), tone: $('reply-tone').value });
  currentSource(version);
  $('reply-body').value = result.text;
  if (!$('reply-title').value) $('reply-title').value = $('conversation-title').value || 'Resposta sugerida';
  $('reply-body').focus();
}, event.target);
$('task-form').onsubmit = event => {
  event.preventDefault();
  run(async () => {
    await save(newItem('task', $('task-title').value, '', localDue($('task-due').value), {
      priority: $('task-priority').value, waitingFor: $('task-waiting').value, owner: $('task-owner').value.trim(),
      folder: $('task-folder').value.trim(), tags: cleanTags($('task-tags').value),
    }));
    $('task-form').reset();
  }, event.submitter);
};
$('reply-form').onsubmit = event => {
  event.preventDefault();
  run(async () => {
    await save(newItem('reply', $('reply-title').value, $('reply-body').value, '', { folder: $('reply-folder').value.trim() }));
    $('reply-form').reset();
  }, event.submitter);
};
$('copy-draft').onclick = event => run(() => copy($('reply-body').value), event.target);
for (const id of ['library-search', 'filter-folder', 'filter-kind', 'filter-status', 'filter-priority', 'filter-waiting', 'filter-sort']) $(id).addEventListener(id === 'library-search' ? 'input' : 'change', renderLibrary);
$('export').onclick = event => run(async () => {
  const data = await rpc('export');
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const anchor = node('a'); anchor.href = url; anchor.download = 'dia-biblioteca-e-conta.json'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}, event.target);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !['accountId', 'token', 'epoch', 'consent'].some(key => key in changes)) return;
  generation++; sourceVersion++; context = null; items = []; cache = {}; render();
  for (const id of ['context', 'conversation-title', 'context-folder', 'digest-result', 'briefing-result', 'handoff-result', 'briefing-source-preview', 'task-title', 'task-due', 'task-owner', 'task-folder', 'task-tags', 'reply-title', 'reply-body', 'reply-folder']) $(id).value = '';
  for (const id of ['triage-result', 'extracted-tasks', 'extracted-decisions', 'extracted-risks']) $(id).replaceChildren();
  for (const id of ['digest-box', 'briefing-box', 'handoff-box', 'triage-box', 'extracted-box', 'decisions-box', 'risks-box']) $(id).hidden = true;
  $('run-saved-briefing').disabled = true;
  $('storage-consent').checked = false;
  $('status').textContent = 'Sessão ou consentimento alterado. Atualize o painel para continuar.';
});
run(refresh);
