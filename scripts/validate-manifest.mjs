import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
export function validateManifest(directory = 'extension') {
  directory = path.resolve(directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, 'module');
  assert.match(manifest.minimum_chrome_version, /^\d+(?:\.\d+){0,3}$/);
  assert.ok(Number(manifest.minimum_chrome_version.split('.')[0]) >= 120);
  assert.ok(!manifest.externally_connectable);
  assert.ok(!manifest.web_accessible_resources);
  assert.deepEqual(manifest.content_scripts.map(s => s.matches), [['https://web.whatsapp.com/*'], ['https://web.whatsapp.com/*']]);
  assert.ok(manifest.permissions.every(p => ['storage', 'alarms'].includes(p)));
  assert.ok((manifest.optional_permissions || []).every(p => p === 'notifications'));
  assert.equal(manifest.host_permissions.length, 2);
  assert.ok(manifest.host_permissions.every(p => p !== '<all_urls>' && !p.includes('*://')));
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'none'");
  const files = [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(s => [...(s.js || []), ...(s.css || [])])];
  for (const filename of files) {
    const absolute = path.resolve(directory, filename);
    assert.ok(absolute.startsWith(directory + path.sep), `Caminho fora do pacote: ${filename}`);
    assert.ok(fs.existsSync(absolute), `Arquivo ausente: ${filename}. Execute npm run build.`);
  }
  function visit(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      assert.ok(!entry.isSymbolicLink(), `Link simbólico não permitido: ${file}`);
      if (entry.isDirectory()) { visit(file); continue; }
      if (!/\.(js|mjs|html|json|css)$/.test(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!/\beval\s*\(|new\s+Function\s*\(|<script[^>]+src=["']https?:/i.test(text), `Código remoto/eval em ${file}`);
      assert.ok(!/sk_(live|test)_[a-zA-Z0-9]{12}|sk-or-v1-[a-f0-9]{20}|whsec_[a-zA-Z0-9]{15}/.test(text), `Segredo em ${file}`);
    }
  }
  visit(directory);
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  validateManifest(process.argv[2]);
  console.log('Manifesto, permissões, arquivos e varredura recursiva: OK');
}
