/* Cross-platform npm package smoke: real tarball + isolated installed consumer. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewrouter-package-'));
const consumer = path.join(temp, 'consumer');
fs.mkdirSync(consumer);

function npm(args) {
  const result = spawnSync(npmCommand, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 180_000,
    shell: process.platform === 'win32',
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
}

try {
  const packages = JSON.parse(npm([
    'pack', '--json', '--ignore-scripts', '--pack-destination', temp,
  ]));
  assert.equal(packages.length, 1);
  const files = new Set(packages[0].files.map(file => file.path));
  for (const required of ['bin/mpr', 'dist/cli/index.js', 'package.json', 'docs/local-review-cli.md']) {
    assert(files.has(required), `Required CLI artifact missing from npm pack: ${required}`);
  }
  assert(packages[0].size > 0, 'npm package must have nonzero size');

  const tarball = path.join(temp, packages[0].filename);
  assert(fs.existsSync(tarball), 'npm pack must materialize its tarball');
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock',
    '--prefix', consumer, tarball]);

  const installedCli = path.join(consumer, 'node_modules', 'review-router', 'bin', 'mpr');
  assert(fs.existsSync(installedCli), 'CLI executable missing from installed tarball');
  const help = spawnSync(process.execPath, [installedCli, 'help'], {
    cwd: temp, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(help.status, 0, help.stderr || String(help.error));
  assert.match(help.stdout, /ReviewRouter CLI/);

  const version = spawnSync(process.execPath, [installedCli, 'version'], {
    cwd: temp, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(version.status, 0, version.stderr || String(version.error));
  assert.match(version.stdout, /review-router v[0-9]/);
  console.log('PASS npm tarball: CLI bundle, installed consumer help/version outside Git');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
