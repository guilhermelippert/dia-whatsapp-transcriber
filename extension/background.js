import { CONFIG } from './config.js';
import { readVault, changeVault, clearVaults } from './vault.js';
const api = globalThis.chrome;
const ready = (async () => {
  await api.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await api.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  // Remove legacy unencrypted communications and obsolete user-controlled API/model settings.
  await api.storage.local.remove(['wppTranscriber.transcripts.v1', 'wppTranscriber.summaries.v1', 'endpoint', 'model']);
})();
async function preferences() { return api.storage.local.get({ consent: false, automatic: false, language: 'pt', token: '', accountId: '', epoch: 0 }); }
async function request(path, body, method = body ? 'POST' : 'GET', idempotencyKey) {
  const settings = await preferences();
  const response = await fetch(`${CONFIG.endpoint}${path}`, {
    method, cache: 'no-store', credentials: 'omit', redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...(settings.token ? { Authorization: `Bearer ${settings.token}` } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(27000),
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && settings.token) {
    await api.storage.local.remove(['token', 'accountId']); await clearLocal();
    if (path === '/auth/logout') return {};
  }
  if (!response.ok) throw new Error(payload.error || 'Não foi possível acessar o serviço.');
  if (settings.token && path !== '/auth/verify' && (await preferences()).token !== settings.token) throw new Error('A sessão mudou. Tente novamente.');
  return payload;
}
async function clearLocal() {
  const settings = await preferences();
  await api.storage.local.set({ epoch: settings.epoch + 1 });
  await clearVaults();
  const tabs = await api.tabs.query({ url: 'https://web.whatsapp.com/*' });
  await Promise.allSettled(tabs.map(tab => api.tabs.sendMessage(tab.id, { type: 'dia:clear' })));
}
async function contentAccess() {
  const settings = await preferences();
  if (!settings.consent) throw new Error('Abra a extensão e autorize o processamento por IA antes de transcrever.');
  if (!settings.token) throw new Error('Abra a extensão e entre na sua conta.');
  return settings;
}
async function handle(message, sender) {
  await ready;
  if (sender.id !== api.runtime.id) throw new Error('Origem não permitida.');
  const popup = sender.url === api.runtime.getURL('popup.html');
  const whatsapp = Boolean(sender.tab) && sender.url?.startsWith('https://web.whatsapp.com/');
  if (!popup && !whatsapp) throw new Error('Origem não permitida.');
  const type = message?.type;
  if (type === 'settings') {
    const s = await preferences(); return { consent: s.consent, automatic: s.automatic, language: s.language, loggedIn: Boolean(s.token) };
  }
  if (whatsapp && type === 'access') {
    await contentAccess(); const { account } = await request('/me');
    if (!account.unlimited && account.used >= account.limit) throw new Error('Cota gratuita atingida. Abra a extensão para iniciar o trial ou assinar.');
    return { context: `${(await preferences()).accountId}:${(await preferences()).epoch}` };
  }
  if (whatsapp && ['transcribe', 'summarize'].includes(type)) {
    const settings = await contentAccess();
    if (message.context !== `${settings.accountId}:${settings.epoch}`) throw new Error('A sessão mudou. Recarregue o WhatsApp.');
    const result = await request(`/${type}`, type === 'transcribe' ? { data: message.data, format: message.format, language: settings.language } : { text: message.text }, 'POST', crypto.randomUUID());
    const current = await contentAccess();
    if (message.context !== `${current.accountId}:${current.epoch}`) throw new Error('A sessão mudou. Recarregue o WhatsApp.');
    return result;
  }
  if (whatsapp && ['cache:get', 'cache:put'].includes(type)) {
    await contentAccess();
    if (type === 'cache:get') return { cache: await readVault('transcripts', {}) };
    const settings = await contentAccess();
    if (message.context !== `${settings.accountId}:${settings.epoch}`) throw new Error('A sessão mudou.');
    if (['__proto__', 'constructor', 'prototype'].includes(message.key) || typeof message.key !== 'string' || message.key.length > 1000 || typeof message.transcript !== 'string' || message.transcript.length > 200000 || typeof message.summary !== 'string' || message.summary.length > 200000) throw new Error('Resultado inválido.');
    await changeVault('transcripts', {}, cache => {
      delete cache[message.key];
      cache[message.key] = { transcript: message.transcript, summary: message.summary, savedAt: Date.now() };
      while (Object.keys(cache).length > 100 || JSON.stringify(cache).length > 450000) delete cache[Object.keys(cache)[0]];
      return cache;
    }); return {};
  }
  if (!popup) throw new Error('Ação não permitida.');
  switch (type) {
    case 'plan': return request('/plan');
    case 'account': return request('/me');
    case 'request-code': return request('/auth/request-code', { email: message.email });
    case 'verify': {
      const result = await request('/auth/verify', { email: message.email, code: message.code });
      const old = await api.storage.local.get('accountId');
      if (old.accountId !== result.account.id) await clearLocal();
      await api.storage.local.set({ token: result.token, accountId: result.account.id });
      return { account: result.account };
    }
    case 'save-settings': {
      if (typeof message.consent !== 'boolean' || typeof message.automatic !== 'boolean') throw new Error('Preferências inválidas.');
      await api.storage.local.set({ consent: message.consent, consentVersion: '2026-09-16', automatic: message.consent && message.automatic });
      if (!message.consent) await clearLocal();
      // Reload is explicit in UI; content re-checks consent before each new operation.
      return {};
    }
    case 'trial': return request('/trial', {});
    case 'checkout': return request('/billing/checkout', {});
    case 'portal': return request('/billing/portal', {});
    case 'clear-local': await clearLocal(); return {};
    case 'export': return request('/account/export');
    case 'delete-account': {
      await request('/account', { confirm: message.confirm }, 'DELETE');
      await clearLocal(); await api.storage.local.remove(['token', 'accountId']); return {};
    }
    case 'logout': {
      // Do not silently leave a valid server session behind if revocation fails.
      await request('/auth/logout', {}); await clearLocal(); await api.storage.local.remove(['token', 'accountId']); return {};
    }
    default: throw new Error('Ação desconhecida.');
  }
}
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender).then(result => sendResponse({ ...result, ok: true }), error => sendResponse({ ok: false, error: error.message || 'Falha no serviço.' }));
  return true;
});
