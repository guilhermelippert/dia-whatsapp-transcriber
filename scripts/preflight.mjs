import { loadConfig } from '../src/config.mjs';
import { stripeClient } from '../src/providers.mjs';
const c = loadConfig({ NODE_ENV: 'production' });
if (!c.stripeKey.startsWith('sk_live_')) throw new Error('Publicação comercial exige chave Stripe live. Use test no ambiente de staging.');
for (const route of ['/health','/privacy','/terms','/support','/plan']) {
  const response = await fetch(`${c.baseUrl}${route}`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Endpoint público indisponível: ${route}`);
  if (route === '/plan') { const p = await response.json(); if (p.amount <= 0 || p.interval !== 'month') throw new Error('Preço público inválido.'); }
}
const request = stripeClient(c), account = await request('/account');
if (!account.charges_enabled || !account.payouts_enabled || !account.details_submitted) throw new Error('Onboarding/cobranças/saques Stripe pendentes.');
const endpoints = await request('/webhook_endpoints?limit=100');
if (!endpoints.data?.some(e => e.status === 'enabled' && e.url === `${c.baseUrl}/stripe/webhook`)) throw new Error('Webhook live ausente.');
console.log('Preflight de configuração e endpoints aprovado. Ainda exige smoke real, ficha da loja e revisão humana do Google.');
