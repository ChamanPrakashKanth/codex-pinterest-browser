import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'extension', 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
const extension = join(root, 'extension');
for (const file of [manifest.background.service_worker, ...manifest.content_scripts.flatMap(entry => entry.js),
  'review.html', 'review.css', 'review.js']) {
  await readFile(join(extension, file));
}
const dirs = ['bridge', 'extension', 'scripts', 'tests'];
for (const dir of dirs) {
  for (const file of await readdir(join(root, dir))) {
    if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', join(root, dir, file)], { stdio: 'inherit' });
  }
}
const skill = await readFile(join(root, 'SKILL.md'), 'utf8');
assert.match(skill, /^---\r?\nname: codex-pinterest-browser\r?\ndescription: .+\r?\n---/);
console.log('Skill, manifest, and JavaScript syntax checks passed.');
