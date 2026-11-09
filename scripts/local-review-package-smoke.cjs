/* Verify packaged CLI entry points are present; works on every CI platform. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const npmCli = process.env.npm_execpath;
assert(npmCli, 'npm_execpath is required for deterministic npm invocation');
const p = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: process.cwd(), encoding: 'utf8', timeout: 120_000,
});
assert.equal(p.status, 0, p.stderr || String(p.error));
const packages = JSON.parse(p.stdout);
assert.equal(packages.length, 1);
const files = new Set(packages[0].files.map(file => file.path));
for (const required of ['bin/mpr', 'dist/cli/index.js', 'package.json', 'docs/local-review-cli.md']) {
  assert(files.has(required), `Required CLI artifact missing from npm pack: ${required}`);
}
assert(packages[0].size > 0, 'npm package must have nonzero size');
console.log('PASS npm pack includes CLI binary, built bundle and local usage documentation');
