import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const paths = ['server.mjs'];
for (const dir of ['src', 'extension', 'scripts', 'tests']) for (const f of readdirSync(dir)) if (/\.(mjs|js)$/.test(f)) paths.push(`${dir}/${f}`);
for (const file of paths) { const r = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' }); if (r.status) process.exit(r.status); }
const r = spawnSync(process.execPath, ['scripts/validate-manifest.mjs'], { stdio: 'inherit' }); process.exit(r.status);
