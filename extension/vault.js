const api = globalThis.chrome;
let queue = Promise.resolve();
const encode = bytes => btoa(String.fromCharCode(...bytes));
const decode = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
async function key() {
  let { vaultKey } = await api.storage.local.get('vaultKey');
  if (!vaultKey) { vaultKey = encode(crypto.getRandomValues(new Uint8Array(32))); await api.storage.local.set({ vaultKey }); }
  return crypto.subtle.importKey('raw', decode(vaultKey), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function readVault(name, fallback = {}) {
  const saved = (await api.storage.local.get(`vault:${name}`))[`vault:${name}`];
  if (!saved) return structuredClone(fallback);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(saved.iv), additionalData: new TextEncoder().encode(name) }, await key(), decode(saved.data));
  return JSON.parse(new TextDecoder().decode(plaintext));
}
export function changeVault(name, fallback, update) {
  const operation = queue.catch(() => {}).then(async () => {
    const value = await update(await readVault(name, fallback));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    if (plaintext.byteLength > 2 * 1024 * 1024) throw new Error('Armazenamento local cheio. Apague itens antigos.');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(name) }, await key(), plaintext);
    // Avoid spread over large ciphertexts (V8 call-stack limit).
    let binary = ''; const bytes = new Uint8Array(data);
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    await api.storage.local.set({ [`vault:${name}`]: { iv: encode(iv), data: btoa(binary) } }); return value;
  });
  queue = operation; return operation;
}
export function clearVaults() {
  const operation = queue.catch(() => {}).then(async () => {
    const all = await api.storage.local.get(null);
    await api.storage.local.remove(Object.keys(all).filter(k => k.startsWith('vault:') || k === 'vaultKey'));
  });
  queue = operation; return operation;
}
