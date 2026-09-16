import { CONFIG } from './config.js';
const $ = id => document.getElementById(id);
const api = chrome;
async function send(type, extra = {}) {
  const r = await api.runtime.sendMessage({ type, ...extra });
  if (!r?.ok) throw new Error(r?.error || 'Não foi possível concluir.'); return r;
}
async function run(fn, button) {
  $('status').textContent = ''; if (button) button.disabled = true;
  try { await fn(); } catch (e) { $('status').textContent = e.message; } finally { if (button) button.disabled = false; }
}
async function refresh() {
  const settings = await send('settings');
  $('consent').checked = settings.consent; $('automatic').checked = settings.automatic;
  $('login').hidden = settings.loggedIn; $('account').hidden = !settings.loggedIn;
  if (!settings.loggedIn) return;
  let a;
  try { ({ account: a } = await send('account')); } catch (e) {
    const current = await send('settings');
    $('login').hidden = current.loggedIn; $('account').hidden = !current.loggedIn; throw e;
  }
  $('identity').textContent = a.email;
  $('plan-name').textContent = a.plan === 'pro' ? 'Pro' : a.plan === 'trial' ? 'Trial Pro' : 'Gratuito';
  $('usage').textContent = a.unlimited ? 'Sem cota mensal de ações de IA.' : `${a.used} de ${a.limit} ações utilizadas. Renova em ${new Date(a.resetsAt).toLocaleDateString('pt-BR')}.`;
  $('meter').hidden = a.unlimited; $('meter').max = a.limit; $('meter').value = a.used;
  $('trial').hidden = a.trialUsed || a.unlimited; $('trial').textContent = `Experimentar Pro por ${a.trialDays} dias, sem cartão`;
  $('trial-status').textContent = a.plan === 'trial' ? `Teste até ${new Date(a.trialEnd).toLocaleString('pt-BR')}. Depois você volta ao gratuito.` : a.cancelAtPeriodEnd ? 'Cancelamento agendado para o fim do período pago.' : '';
  $('subscribe').hidden = a.plan === 'pro';
}
for (const path of ['privacy', 'terms', 'support']) $(path).href = `${CONFIG.endpoint}/${path}`;
$('request-form').onsubmit = event => { event.preventDefault(); run(async () => { await send('request-code', { email: $('email').value }); $('verify-form').hidden = false; $('status').textContent = 'Código enviado. Confira também o spam.'; }, event.submitter); };
$('verify-form').onsubmit = event => { event.preventDefault(); run(async () => { await send('verify', { email: $('email').value, code: $('code').value }); $('code').value = ''; await refresh(); }, event.submitter); };
$('save-settings').onclick = event => run(async () => { await send('save-settings', { consent: $('consent').checked, automatic: $('automatic').checked }); $('status').textContent = 'Preferências salvas. Recarregue o WhatsApp para atualizar o modo automático.'; }, event.target);
$('refresh').onclick = () => run(refresh);
$('trial').onclick = event => run(async () => { await send('trial'); await refresh(); }, event.target);
for (const [id, type] of [['subscribe', 'checkout'], ['portal', 'portal']]) $(id).onclick = event => run(async () => {
  const { url } = await send(type); const target = new URL(url);
  if (target.protocol !== 'https:' || !['checkout.stripe.com', 'billing.stripe.com'].includes(target.hostname)) throw new Error('URL de cobrança inválida.');
  await api.tabs.create({ url: target.href });
}, event.target);
$('clear-local').onclick = () => run(async () => { if (confirm('Apagar transcrições, resumos e outros dados locais salvos pela extensão?')) { await send('clear-local'); $('status').textContent = 'Dados locais apagados.'; } });
$('export').onclick = () => run(async () => {
  const r = await send('export'); const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'dia-minha-conta.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
});
$('logout').onclick = () => run(async () => { await send('logout'); await refresh(); });
$('delete-account').onclick = () => run(async () => {
  if (prompt('Isto cancela sua assinatura e exclui a conta. Digite EXCLUIR para confirmar:') !== 'EXCLUIR') return;
  await send('delete-account', { confirm: 'EXCLUIR' }); await refresh(); $('status').textContent = 'Conta excluída.';
});
run(refresh);
run(async () => {
  const p = await send('plan'), price = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: p.currency }).format(p.amount / 100);
  $('subscribe').textContent = `Assinar Pro por ${price}/mês`; $('subscribe').disabled = false;
  $('plan-details').textContent = `${p.freeLimit} ações/mês grátis. Pro: ${price}/mês. Trial de ${p.trialDays} dias.`;
});
