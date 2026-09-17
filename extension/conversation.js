// Read only the active conversation's loaded text after an explicit extension request.
// This does not scroll, call private WhatsApp APIs, or send messages.
(() => {
  function snapshot() {
    const main = document.querySelector('#main');
    if (!main) throw new Error('Abra uma conversa no WhatsApp e tente novamente.');
    const rows = [...main.querySelectorAll('[data-pre-plain-text]')];
    let text = '', truncated = rows.length > 50;
    for (const row of rows.slice(-50)) {
      if (row.closest('[class^="wpp-transcriber"]') || row.closest('footer')) continue;
      const clone = row.cloneNode(true);
      clone.querySelectorAll('button,script,style,[class^="wpp-transcriber"],[contenteditable="true"]').forEach(n => n.remove());
      const content = (clone.textContent || '').trim();
      if (!content) continue;
      const line = `${(row.getAttribute('data-pre-plain-text') || '').slice(0, 200)}${content}\n`;
      const available = 32000 - text.length;
      if (line.length > available) { text += line.slice(0, available); truncated = true; break; }
      text += line;
    }
    if (!text.trim()) throw new Error('Nenhum texto carregado. Cole um trecho no painel ou abra uma conversa com mensagens.');
    return { ok: true, text: text.trim(), title: (main.querySelector('header [title]')?.getAttribute('title') || 'Conversa selecionada').slice(0, 200), truncated };
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'dia:conversation') return;
    try { respond(snapshot()); } catch (e) { respond({ ok: false, error: e.message }); }
  });
})();
