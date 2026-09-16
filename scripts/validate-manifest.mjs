import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const directory = path.resolve(process.argv[2] || 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.background.type, 'module');
assert.ok(manifest.minimum_chrome_version >= '120');
assert.ok(!manifest.externally_connectable);
assert.ok(!manifest.web_accessible_resources);
assert.deepEqual(manifest.content_scripts.map(s => s.matches), [['https://web.whatsapp.com/*'], ['https://web.whatsapp.com/*']]);
assert.ok(manifest.permissions.every(p => ['storage', 'alarms'].includes(p)));
assert.ok((manifest.optional_permissions || []).every(p => p === 'notifications'));
assert.equal(manifest.host_permissions.length, 2);
assert.ok(manifest.host_permissions.every(p => p !== '<all_urls>' && !p.includes('*://')));
assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'none'");
const files = [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(s => [...(s.js || []), ...(s.css || [])])];
for (const filename of files) assert.ok(fs.existsSync(path.join(directory, filename)), `Arquivo ausente: ${filename}. Execute npm run build.`);
for (const filename of fs.readdirSync(directory).filter(f => /\.(js|html)$/.test(f))) {
  const text = fs.readFileSync(path.join(directory, filename), 'utf8');
  assert.ok(!/\beval\s*\(|new\s+Function\s*\(|<script[^>]+src=["']https?:/.test(text), `Código remoto/eval em ${filename}`);
  assert.ok(!/sk_(live|test)_[a-zA-Z0-9]{12}|sk-or-v1-[a-f0-9]{20}|whsec_[a-zA-Z0-9]{15}/.test(text), `Segredo em ${filename}`);
}
console.log('Manifesto, permissões, arquivos e ausência de código remoto: OK');
