const api = globalThis.chrome;
let queue = Promise.resolve();
let keyPending;
const encode = bytes => btoa(String.fromCharCode(...bytes));
const decode = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
function serial(operation) {
  const pending = queue.catch(() => {}).then(operation);
  queue = pending; return pending;
}
async function key() {
  if (!keyPending) keyPending = (async () => {
    let { vaultKey } = await api.storage.session.get('vaultKey');
    // Keys never persist next to ciphertext. A fresh browser session discards old cache.
    if (!vaultKey) {
      const all = await api.storage.local.get(null);
      await api.storage.local.remove(Object.keys(all).filter(k => k.startsWith('vault:') || k === 'vaultKey'));
      vaultKey = encode(crypto.getRandomValues(new Uint8Array(32)));
      await api.storage.session.set({ vaultKey });
    } else await api.storage.local.remove('vaultKey');
    return crypto.subtle.importKey('raw', decode(vaultKey), 'AES-GCM', false, ['encrypt', 'decrypt']);
  })().catch(error => { keyPending = undefined; throw error; });
  return keyPending;
}
async function read(name, fallback) {
  const encryptionKey = await key();
  const saved = (await api.storage.local.get(`vault:${name}`))[`vault:${name}`];
  if (!saved) return structuredClone(fallback);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(saved.iv), additionalData: new TextEncoder().encode(name) }, encryptionKey, decode(saved.data));
  return JSON.parse(new TextDecoder().decode(plaintext));
}
export function readVault(name, fallback = {}) { return serial(() => read(name, fallback)); }
export function changeVault(name, fallback, update) {
  return serial(async () => {
    const value = await update(await read(name, fallback));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    if (plaintext.byteLength > 2 * 1024 * 1024) throw new Error('Armazenamento local cheio. Apague itens antigos.');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(name) }, await key(), plaintext);
    let binary = ''; const bytes = new Uint8Array(data);
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    await api.storage.local.set({ [`vault:${name}`]: { iv: encode(iv), data: btoa(binary) } }); return value;
  });
}
export function clearVaults() {
  return serial(async () => {
    const all = await api.storage.local.get(null);
    await api.storage.local.remove(Object.keys(all).filter(k => k.startsWith('vault:') || k === 'vaultKey'));
    await api.storage.session.remove('vaultKey'); keyPending = undefined;
  });
}
