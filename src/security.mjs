import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED') { super(message); this.status = status; this.code = code; }
}
export const hash = value => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export const hmac = (key, value) => createHmac('sha256', Buffer.from(key, 'hex')).update(value).digest('hex');
export function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function seal(key, value, context) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
export function unseal(key, value, context) {
  const data = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), data.subarray(0, 12));
  decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
}
export function emailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value.trim())) throw new HttpError(400, 'Informe um e-mail válido.');
  return value.trim().toLowerCase();
}
export function verifyStripeSignature(raw, header, secret, now = Date.now()) {
  if (typeof header !== 'string' || !secret) throw new HttpError(400, 'Assinatura inválida.');
  const pairs = header.split(',').map(x => x.trim().split('='));
  const timestamps = pairs.filter(([k]) => k === 't');
  const ts = Number(timestamps[0]?.[1]);
  if (timestamps.length !== 1 || !Number.isSafeInteger(ts) || Math.abs(now / 1000 - ts) > 300) throw new HttpError(400, 'Assinatura expirada.');
  const expected = createHmac('sha256', secret).update(`${ts}.`).update(raw).digest('hex');
  if (!pairs.some(([k, v]) => k === 'v1' && /^[a-f0-9]{64}$/.test(v || '') && equal(expected, v))) throw new HttpError(400, 'Assinatura inválida.');
}
export function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0, failed = false;
    req.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) { failed = true; chunks = []; reject(new HttpError(413, 'Conteúdo grande demais.')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
    req.on('aborted', () => reject(new HttpError(400, 'Requisição interrompida.')));
  });
}
export function jsonBody(raw) {
  try { const value = JSON.parse(raw); if (!value || Array.isArray(value) || typeof value !== 'object') throw 0; return value; }
  catch { throw new HttpError(400, 'JSON inválido.'); }
}
// Serializes customer updates through upstream awaits; deployment is deliberately single-replica.
export function serialQueue() {
  const tails = new Map();
  return async (key, task) => {
    const prior = tails.get(key) || Promise.resolve();
    const current = prior.catch(() => {}).then(task); tails.set(key, current);
    try { return await current; } finally { if (tails.get(key) === current) tails.delete(key); }
  };
}

// Check canonical padding bits without decoding and duplicating large audio buffers.
export function isCanonicalBase64(value) {
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (value.endsWith('==')) return (alphabet.indexOf(value.at(-3)) & 15) === 0;
  if (value.endsWith('=')) return (alphabet.indexOf(value.at(-2)) & 3) === 0;
  return true;
}
// Length framing prevents ambiguous concatenations and avoids one large JSON copy.
export function hmacParts(key, parts) {
  const mac = createHmac('sha256', Buffer.from(key, 'hex'));
  for (const part of parts) {
    if (typeof part !== 'string') throw new TypeError('Fingerprint parts must be strings.');
    const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(Buffer.byteLength(part)));
    mac.update(size).update(part);
  }
  return mac.digest('hex');
}
// Acquire before reading bodies, not only after JSON/base64 processing.
export function capacityGate(maximum, perAccount = 2) {
  let active = 0; const accounts = new Map();
  return id => {
    const own = accounts.get(id) || 0;
    if (active >= maximum || own >= perAccount) throw new HttpError(429, 'Há solicitações em andamento. Aguarde.', 'BUSY');
    active++; accounts.set(id, own + 1); let released = false;
    return () => {
      if (released) return; released = true; active--;
      const left = accounts.get(id) - 1;
      if (left) accounts.set(id, left); else accounts.delete(id);
    };
  };
}
