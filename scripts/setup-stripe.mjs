import { loadConfig } from '../src/config.mjs';
import { stripeClient } from '../src/providers.mjs';
import { ensureWebhook } from '../src/billing-config.mjs';
const c = loadConfig(), request = stripeClient(c);
if (!process.argv.includes('--apply')) throw new Error('Execute com --apply para criar produto/preço/portal/webhook na conta Stripe configurada. Use test primeiro.');
const amount = Number(process.env.PRO_MONTHLY_AMOUNT || 2990);
if (!Number.isSafeInteger(amount) || amount < 100) throw new Error('PRO_MONTHLY_AMOUNT inválido (centavos).');
const lookup = `dia_pro_brl_monthly_${amount}`;
const found = await request(`/prices?lookup_keys[]=${lookup}&active=true&limit=1`);
let price = found.data?.[0];
if (!price) {
  const product = await request('/products', { name: 'Dia Pro', description: 'Transcrições e resumos sem cota mensal. Uso pessoal; proteções técnicas e antiabuso.' }, 'dia-pro-product-v1');
  price = await request('/prices', { product: product.id, unit_amount: String(amount), currency: 'brl', 'recurring[interval]': 'month', lookup_key: lookup }, `dia-price-${lookup}`);
}
await request('/billing_portal/configurations', { 'business_profile[headline]': 'Gerencie sua assinatura Dia Pro', 'business_profile[privacy_policy_url]': `${c.baseUrl}/privacy`, 'business_profile[terms_of_service_url]': `${c.baseUrl}/terms`, 'features[subscription_cancel][enabled]': 'true', 'features[subscription_cancel][mode]': 'at_period_end', 'features[payment_method_update][enabled]': 'true', 'features[invoice_history][enabled]': 'true' }, 'dia-portal-v1');
console.log(`STRIPE_PRICE_ID=${price.id}`);
const webhook = await ensureWebhook(request, c);
if (webhook.secret) console.log(`STRIPE_WEBHOOK_SECRET=${webhook.secret}`);
else console.log('Webhook existente validado/atualizado. Preserve seu STRIPE_WEBHOOK_SECRET.');
console.log('Não compartilhe esta saída. Configure o portal padrão e a URL de termos em Stripe > Settings > Business > Public details antes de aceitar pagamentos.');
