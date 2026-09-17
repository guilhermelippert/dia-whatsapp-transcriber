import { createHash } from 'node:crypto';
export const REQUIRED_WEBHOOK_EVENTS = Object.freeze([
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'customer.subscription.paused', 'customer.subscription.resumed', 'invoice.paid', 'invoice.payment_failed',
  'checkout.session.completed', 'checkout.session.expired',
]);
export const hasRequiredEvents = endpoint => Array.isArray(endpoint?.enabled_events) &&
  (endpoint.enabled_events.includes('*') || REQUIRED_WEBHOOK_EVENTS.every(e => endpoint.enabled_events.includes(e)));
export const webhookReady = (endpoint, config) => endpoint?.url === `${config.baseUrl}/stripe/webhook` && endpoint.status === 'enabled' && hasRequiredEvents(endpoint);
export async function listWebhooks(request) {
  const all = []; let cursor = '';
  for (let page = 0; page < 10; page++) {
    const result = await request(`/webhook_endpoints?limit=100${cursor}`);
    if (!Array.isArray(result.data)) throw new Error('Resposta de webhooks inválida.');
    all.push(...result.data);
    if (!result.has_more) return all;
    if (!result.data.length) break;
    cursor = `&starting_after=${encodeURIComponent(result.data.at(-1).id)}`;
  }
  throw new Error('Lista de webhooks incompleta. Nenhuma alteração realizada.');
}
export async function ensureWebhook(request, config) {
  const url = `${config.baseUrl}/stripe/webhook`;
  const endpoints = await listWebhooks(request);
  const existing = endpoints.find(e => webhookReady(e, config)) || endpoints.find(e => e.url === url);
  if (existing && webhookReady(existing, config)) return existing;
  const events = existing?.enabled_events?.includes('*') ? ['*'] : [...new Set([...(existing?.enabled_events || []), ...REQUIRED_WEBHOOK_EVENTS])];
  const values = Object.fromEntries(events.map((e, i) => [`enabled_events[${i}]`, e]));
  if (existing) return request(`/webhook_endpoints/${encodeURIComponent(existing.id)}`, { ...values, disabled: 'false' });
  const key = createHash('sha256').update(url).digest('hex').slice(0, 24);
  return request('/webhook_endpoints', { ...values, url, api_version: config.stripeVersion }, `dia-webhook-${key}`);
}
