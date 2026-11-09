/* Cross-platform built CLI E2E with real Git and a deterministic model-free OCR fixture. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');
const projectRoot = path.resolve(__dirname, '..');
const fixtureGo = path.join(__dirname, 'local-review-fake-ocr.go');
const executable = process.platform === 'win32' ? 'ocr-fixture.exe' : 'ocr-fixture';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewrouter-cli-e2e-'));
const binary = path.join(temp, executable);
const repo = path.join(temp, 'repo');
const git = (...args) => execFileSync('git', args, {cwd:repo, encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function run(args, env={}) {
  const r=spawnSync(process.execPath,[path.join(projectRoot,'bin','mpr'),...args],
    {cwd:repo,encoding:'utf8',timeout:30000,env:{...process.env,REVIEWROUTER_OCR_BINARY:binary,...env}});
  assert(!r.error, String(r.error));
  return r;
}
function outcome(args, env={}) {
  const r=run(['review','--engine','ocr','--format=json',...args],env);
  assert.doesNotThrow(()=>JSON.parse(r.stdout),`stdout must be exactly JSON; got ${r.stdout.slice(0,200)}`);
  return {code:r.status,...JSON.parse(r.stdout)};
}
try {
 fs.mkdirSync(repo);
 const go=spawnSync('go',['build','-o',binary,fixtureGo],{cwd:temp,encoding:'utf8',timeout:60000,env:{...process.env,GO111MODULE:'off'}});
 assert.equal(go.status,0,go.stderr);
 git('init','-q');git('config','user.name','RR E2E');git('config','user.email','rr@example.invalid');
 fs.mkdirSync(path.join(repo,'src'));
 fs.writeFileSync(path.join(repo,'src','example.ts'),'export const x=1;\n');
 git('add','.');git('commit','-qm','initial');
 fs.writeFileSync(path.join(repo,'src','example.ts'),'export const x=2;\n');
 const before=git('status','--porcelain');
 const complete=outcome([]);
 assert.equal(complete.code,1);assert.equal(complete.status,'complete');
 assert.equal(complete.engine.id,'ocr');assert.equal(complete.summary.major,1);
 assert(!JSON.stringify(complete).includes('must not escape'));
 assert.equal(git('status','--porcelain'),before,'CLI must not write to reviewed sources');
 const partial=outcome([], {RR_FAKE_OCR_STATUS:'partial'});
 assert.equal(partial.code,3);assert.equal(partial.status,'partial');
 const warning=outcome([], {RR_FAKE_OCR_MODE:'warning'});
 assert.equal(warning.code,3);assert.equal(warning.status,'partial');
 const malformed=outcome([], {RR_FAKE_OCR_MODE:'malformed'});
 assert.equal(malformed.code,3);assert.equal(malformed.status,'failed');
 const stale=outcome([], {RR_FAKE_OCR_MODE:'stale'});
 assert.equal(stale.code,3);assert.equal(stale.status,'stale');
 fs.writeFileSync(path.join(repo,'src','example.ts'),'export const x=2;\n');
 fs.writeFileSync(path.join(repo,'src','new.ts'),'export const hidden=1;\n');
 const privacy=outcome([]);
 assert.equal(privacy.code,4);assert.equal(privacy.status,'failed');
 assert.match(privacy.error.message,/untracked/);
 const opted=outcome(['--include-untracked']);
 assert.equal(opted.status,'complete'); assert.equal(opted.coverage.selected,2); assert.equal(opted.coverage.reviewed,2);
 git('add','.'); git('commit','-qm','feature changes');
 const branch=outcome(['--scope=branch','--base=HEAD~1']);
 assert.equal(branch.status,'complete'); assert.equal(branch.input.scope,'branch');
 const commit=outcome(['--scope=commit','--ref=HEAD']);
 assert.equal(commit.status,'complete'); assert.equal(commit.input.scope,'commit');
 const outside=spawnSync(process.execPath,[path.join(projectRoot,'bin','mpr'),'help'],{cwd:temp,encoding:'utf8',timeout:30000});
 assert.equal(outside.status,0,'help must work outside a Git repository');
 const help=run(['help']);assert.equal(help.status,0);
 const version=run(['version']);assert.equal(version.status,0); const doctor=run(['doctor']);assert.equal(doctor.status,0,doctor.stderr);
 console.log('PASS built CLI: complete, partial, privacy consent, opted-in untracked, branch/commit, unchanged tree, help/version/doctor');
} catch(error) {
 console.error(error); process.exitCode=1;
} finally {fs.rmSync(temp,{recursive:true,force:true});}
