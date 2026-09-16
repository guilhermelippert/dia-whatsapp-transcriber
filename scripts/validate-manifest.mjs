import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(root, "extension");
const manifestPath = path.join(extensionRoot, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

assert.equal(manifest.manifest_version, 3, "O Dia exige Manifest V3.");
assert.equal(
  manifest.background?.service_worker,
  "background.js",
  "O background do Dia/Chromium MV3 deve usar service_worker.",
);
assert.equal(manifest.background?.scripts, undefined, "background.scripts é exclusivo do Firefox.");
assert.ok(manifest.permissions?.includes("storage"), "A permissão storage é necessária.");
assert.ok(
  manifest.host_permissions?.includes("https://web.whatsapp.com/*"),
  "A permissão do WhatsApp Web é necessária.",
);
assert.ok(
  manifest.host_permissions?.includes("http://127.0.0.1:43110/*"),
  "A permissão do serviço local é necessária.",
);

const referencedFiles = [
  manifest.background.service_worker,
  manifest.action?.default_popup,
  ...manifest.content_scripts.flatMap((script) => [...(script.js || []), ...(script.css || [])]),
];

for (const relativePath of referencedFiles) {
  assert.ok(
    fs.existsSync(path.join(extensionRoot, relativePath)),
    `Arquivo referenciado pelo manifest não existe: ${relativePath}`,
  );
}

const mainWorldBridge = manifest.content_scripts.find((script) => script.js?.includes("page-bridge.js"));
assert.equal(mainWorldBridge?.world, "MAIN", "O bridge precisa rodar no mundo principal.");
assert.equal(mainWorldBridge?.run_at, "document_start", "O bridge precisa iniciar antes do WhatsApp.");

console.log("Manifesto Chromium/Dia válido.");
