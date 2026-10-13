import assert from 'node:assert/strict';
import { readdir, readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.version, pkg.version, 'Manifest and package versions must match');
for (const file of [manifest.js, manifest.css, 'LICENSE', 'fonts/Cinzel.ttf', 'fonts/Cinzel-OFL.txt', 'fonts/CrimsonPro-Italic.ttf', 'fonts/CrimsonPro-OFL.txt', 'server-plugin/index.mjs']) {
    await access(path.join(root, file));
}

async function checkDirectory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (['.git', 'node_modules', 'test-results', 'playwright-report'].includes(entry.name)) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await checkDirectory(file);
        else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) {
            const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
            if (result.error) throw result.error;
            assert.equal(result.status, 0, `Syntax check failed: ${path.relative(root, file)}`);
        }
    }
}
await checkDirectory(root);
console.log('Package files, versions and JavaScript syntax verified.');
