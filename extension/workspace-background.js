import { readVault } from './vault.js';
export async function workspaceAction(message, { request, preferences, contentAccess }) {
  const before = await preferences();
  if (!before.token) throw new Error('Entre na sua conta pelo popup da extensão.');
  const context = `${before.accountId}:${before.epoch}`;
  if (message.type !== 'workspace:init' && message.context !== context) throw new Error('A sessão mudou. Atualize o painel.');
  const verify = async () => {
    const after = await preferences();
    if (after.token !== before.token || `${after.accountId}:${after.epoch}` !== context) throw new Error('A sessão mudou. Atualize o painel.');
  };
  let result;
  switch (message.type) {
    case 'workspace:init': {
      const { items } = await request('/workspace');
      result = { items, cache: before.consent ? await readVault('transcripts', {}) : {}, context, consent: before.consent };
      break;
    }
    case 'workspace:tabs': {
      await contentAccess();
      const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
      result = { tabs: tabs.map(t => ({ id: t.id, title: (t.title || 'WhatsApp Web').slice(0, 200) })) }; break;
    }
    case 'workspace:capture': {
      await contentAccess();
      if (!Number.isSafeInteger(message.tabId)) throw new Error('Selecione uma aba do WhatsApp.');
      const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
      if (!tabs.some(t => t.id === message.tabId)) throw new Error('A aba escolhida não está disponível.');
      const snapshot = await chrome.tabs.sendMessage(message.tabId, { type: 'dia:conversation' });
      if (!snapshot?.ok || typeof snapshot.text !== 'string' || snapshot.text.length > 32000 || typeof snapshot.title !== 'string' || snapshot.title.length > 200) throw new Error(snapshot?.error || 'Não foi possível ler a conversa. Recarregue o WhatsApp.');
      await contentAccess(); result = { text: snapshot.text, title: snapshot.title, truncated: snapshot.truncated === true }; break;
    }
    case 'workspace:assist':
      await contentAccess();
      result = await request('/assist', { action: message.action, text: message.text, tone: message.tone }, 'POST', crypto.randomUUID());
      await contentAccess(); break;
    case 'workspace:save':
      if (message.storageConsent !== true) throw new Error('Confirme o armazenamento antes de salvar.');
      result = await request('/workspace', message.item); break;
    case 'workspace:delete':
      result = await request('/workspace', { id: message.id, revision: message.revision }, 'DELETE'); break;
    case 'workspace:export':
      result = { ...await request('/account/export'), localCache: before.consent ? await readVault('transcripts', {}) : {} }; break;
    default: throw new Error('Ação desconhecida.');
  }
  await verify(); return result;
}
