import fs from 'node:fs';
import path from 'node:path';
import { deflateSync, deflateRawSync } from 'node:zlib';
import { parseEnvFile } from '../src/server-utils.mjs';
const root = path.resolve(import.meta.dirname, '..');
export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(size) {
  const chunk = (name, bytes) => {
    const type = Buffer.from(name), out = Buffer.alloc(bytes.length + 12);
    out.writeUInt32BE(bytes.length); type.copy(out, 4); bytes.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([type, bytes])), bytes.length + 8); return out;
  };
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const pos = y * (size * 4 + 1) + 1 + x * 4;
    const wave = [0.25, 0.4, 0.65, 0.4, 0.25].some((height, i) => Math.abs(x / size - (0.25 + i * 0.125)) < 0.035 && Math.abs(y / size - 0.5) < height / 2);
    pixels.set(wave ? [255, 255, 255, 255] : [18, 90, 74, 255], pos);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
export function writeZip(files, destination) {
  let offset = 0; const parts = [], directory = [];
  for (const [name, data] of files) {
    const filename = Buffer.from(name), compressed = deflateRawSync(data), checksum = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20,4); local.writeUInt16LE(8,8); local.writeUInt16LE(33,12);
    local.writeUInt32LE(checksum,14); local.writeUInt32LE(compressed.length,18); local.writeUInt32LE(data.length,22); local.writeUInt16LE(filename.length,26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6); central.writeUInt16LE(8,10); central.writeUInt16LE(33,14);
    central.writeUInt32LE(checksum,16); central.writeUInt32LE(compressed.length,20); central.writeUInt32LE(data.length,24); central.writeUInt16LE(filename.length,28); central.writeUInt32LE(offset,42);
    parts.push(local, filename, compressed); directory.push(central, filename); offset += local.length + filename.length + compressed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10); end.writeUInt32LE(central.length,12); end.writeUInt32LE(offset,16);
  fs.writeFileSync(destination, Buffer.concat([...parts, central, end]));
}
export function build({ release = false, origin } = {}) {
  if (release) {
    const url = new URL(origin || 'invalid:');
    if (url.protocol !== 'https:' || url.origin !== origin || /localhost|127\.0\.0\.1|example\.|\.example$|\.invalid$/.test(url.hostname)) throw new Error('Build de publicação exige PUBLIC_BASE_URL HTTPS real, sem caminho ou barra final.');
  }
  const source = path.join(root, 'extension'), destination = path.join(root, 'dist', release ? 'chrome-store' : 'development');
  fs.mkdirSync(path.join(source, 'icons'), { recursive: true });
  for (const size of [16,32,48,128]) fs.writeFileSync(path.join(source, 'icons', `${size}.png`), png(size));
  fs.rmSync(destination, { recursive: true, force: true }); fs.cpSync(source, destination, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json')));
  const endpoint = release ? origin : 'http://127.0.0.1:43110';
  manifest.host_permissions = ['https://web.whatsapp.com/*', `${endpoint}/*`];
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(destination, 'config.js'), `export const CONFIG = Object.freeze(${JSON.stringify({endpoint,release})});\n`);
  const files = [];
  function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute); else files.push([path.relative(destination, absolute).split(path.sep).join('/'), fs.readFileSync(absolute)]);
  } }
  walk(destination);
  if (files.some(([name]) => !/\.(js|json|html|css|png)$/.test(name))) throw new Error('Arquivo não permitido no pacote.');
  const zip = `${destination}.zip`; writeZip(files, zip); return zip;
}
if (process.argv[1] === import.meta.filename) {
  const env = { ...(fs.existsSync('.env.local') ? parseEnvFile(fs.readFileSync('.env.local','utf8')) : {}), ...process.env };
  console.log(build({ release: process.argv.includes('--release'), origin: env.PUBLIC_BASE_URL }));
}
