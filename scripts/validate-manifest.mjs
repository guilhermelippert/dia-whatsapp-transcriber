import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.join(root, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

assert.equal(manifest.version, pkg.version, "A versão do pacote e a do manifesto devem coincidir.");
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.background?.service_worker, "background.js");
assert.deepEqual(manifest.permissions, ["storage"]);
assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1:43110/*"]);

for (const script of manifest.content_scripts) {
  assert.deepEqual(script.matches, ["https://web.whatsapp.com/*"]);
}
const bridge = manifest.content_scripts.find(script => script.js.includes("page-bridge.js"));
assert.equal(bridge?.world, "MAIN");
assert.equal(bridge?.run_at, "document_start");

const files = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...manifest.content_scripts.flatMap(script => [...script.js, ...(script.css || [])]),
];
for (const size of [16, 32, 48, 128]) {
  const file = manifest.icons[size];
  const png = fs.readFileSync(path.join(extension, file));
  assert.equal(png.subarray(1, 4).toString(), "PNG", file);
  assert.equal(png.readUInt32BE(16), size, file);
  assert.equal(png.readUInt32BE(20), size, file);
}
for (const file of files) assert.ok(fs.statSync(path.join(extension, file)).isFile(), file);
console.log("Manifesto Chromium válido.");
