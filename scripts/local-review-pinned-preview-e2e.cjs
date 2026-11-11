/* Model-free E2E against the actual pinned ReviewRouter OCR native executable from CI. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const binary = process.env.REVIEWROUTER_OCR_BINARY;
assert(binary && path.isAbsolute(binary) && fs.existsSync(binary), 'CI must supply a built pinned native OCR binary');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewrouter-pinned-ocr-'));
const git = (...args) => execFileSync('git', args, {cwd: tmp, encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
try {
  git('init', '-q');
  git('config', 'user.name', 'Local Preview Test');
  git('config', 'user.email', 'local-preview@example.invalid');
  fs.writeFileSync(path.join(tmp, 'sample.go'), 'package sample\nfunc Old() int { return 1 }\n');
  git('add', 'sample.go');
  git('commit', '-qm', 'initial');
  fs.writeFileSync(path.join(tmp, 'sample.go'), 'package sample\nfunc Old() int { return 2 }\n');
  const result = spawnSync(process.execPath, [path.join(root,'bin','mpr'),'review','--engine','ocr','--preview','--format=json'], {
    cwd: tmp, encoding:'utf8', timeout:120000, env:{...process.env,REVIEWROUTER_OCR_BINARY:binary},
  });
  assert(!result.error, String(result.error));
  assert.equal(result.status,0, result.stderr || result.stdout);
  const data = JSON.parse(result.stdout);
  assert.equal(data.engine.id,'ocr');
  assert.equal(data.status,'skipped','preview must not claim reviewed/clean');
  assert(data.coverage.selected >= 1, JSON.stringify(data));
  assert.equal(data.coverage.reviewed,0);
  assert.equal(data.coverage.complete,false);
  console.log('PASS pinned native OCR 1.13.1-rr.* preview; no provider credentials or inference');
} finally {
  fs.rmSync(tmp,{recursive:true,force:true});
}
