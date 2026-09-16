import fs from 'node:fs';
import { parseEnvFile } from './server-utils.mjs';

export function loadConfig(overrides = {}) {
  const env = { ...(fs.existsSync('.env.local') ? parseEnvFile(fs.readFileSync('.env.local', 'utf8')) : {}), ...process.env, ...overrides };
  const integer = (key, fallback, min, max) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Configuração inválida: ${key}`);
    return value;
  };
  const production = env.NODE_ENV === 'production';
  const config = {
    trustedProxies: (env.TRUSTED_PROXY_IPS || '').split(',').map(s => s.trim()).filter(Boolean),
    production, port: integer('PORT', 43110, 0, 65535), host: env.HOST || '127.0.0.1',
    baseUrl: env.PUBLIC_BASE_URL || 'http://127.0.0.1:43110',
    origins: (env.EXTENSION_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    database: env.DATABASE_PATH || './data/dia.sqlite', encryptionKey: env.DATA_ENCRYPTION_KEY || '',
    openrouterKey: env.OPENROUTER_API_KEY || '', model: env.TRANSCRIPTION_MODEL || 'openai/whisper-large-v3',
    summaryModel: env.SUMMARY_MODEL || 'google/gemini-2.5-flash-lite',
    stripeKey: env.STRIPE_SECRET_KEY || '', stripePrice: env.STRIPE_PRICE_ID || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '', stripeVersion: '2026-08-26.dahlia',
    emailKey: env.RESEND_API_KEY || '', emailFrom: env.EMAIL_FROM || '',
    supportEmail: env.SUPPORT_EMAIL || '', publisher: env.PUBLISHER_NAME || '',
    trialDays: integer('TRIAL_DAYS', 14, 7, 14), freeLimit: integer('FREE_MONTHLY_ACTIONS', 30, 1, 10000),
    aiRate: integer('AI_REQUESTS_PER_MINUTE', 20, 1, 120), concurrency: integer('GLOBAL_AI_CONCURRENCY', 12, 1, 100),
  };
  if (![7, 14].includes(config.trialDays)) throw new Error('TRIAL_DAYS deve ser 7 ou 14.');
  const url = new URL(config.baseUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('PUBLIC_BASE_URL deve ser uma origem, sem caminho.');
  config.baseUrl = url.origin;
  if (!/^[a-f0-9]{64}$/i.test(config.encryptionKey)) throw new Error('DATA_ENCRYPTION_KEY deve conter 64 caracteres hexadecimais aleatórios.');
  if (config.origins.some(o => !/^chrome-extension:\/\/[a-p]{32}$/.test(o))) throw new Error('EXTENSION_ORIGINS deve listar IDs exatos do Chrome.');
  if (production) {
    for (const key of ['openrouterKey', 'stripeKey', 'stripePrice', 'webhookSecret', 'emailKey', 'emailFrom', 'supportEmail', 'publisher']) {
      if (!config[key]) throw new Error(`Configuração de produção ausente: ${key}`);
    }
    if (url.protocol !== 'https:' || /localhost|127\.0\.0\.1|\.example$|example\.(com|org|net)$/.test(url.hostname) || !config.origins.length || config.database === ':memory:') throw new Error('Produção exige HTTPS público, ID da extensão e banco persistente.');
  } else if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('HTTP permitido apenas em localhost.');
  }
  return config;
}
