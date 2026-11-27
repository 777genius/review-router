import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = path.resolve(
  __dirname,
  '../../../scripts/native-ocr/download.ts'
);
const version = '1.14.0-rr.1';
const sourceSha = 'a'.repeat(40);
const binaryName = 'opencodereview-linux-amd64';
const manifestPath =
  'tools/ocr/qualifications/managed-tracked-inventory-v1.manifest';
const hash = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');

const preload = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = process.env.RR_NATIVE_DOWNLOAD_FIXTURE;
const scenario = process.env.RR_NATIVE_DOWNLOAD_SCENARIO;
global.fetch = async (url, options) => {
  const expected = 'https://github.com/agent-teams-ai/open-code-review/releases/download/ocr-v1.14.0-rr.1/';
  if (!url.startsWith(expected) || options.credentials !== 'omit' || options.headers.Authorization || options.headers.authorization)
    throw Error('download_authority_changed');
  const name = url.slice(expected.length);
  if (!['MANIFEST','qualification.json','opencodereview-linux-amd64','opencodereview-linux-amd64.sha256','LICENSE','NOTICE','ReviewRouter-LICENSE'].includes(name))
    throw Error('unexpected_asset');
  fs.appendFileSync(path.join(root, 'fetches'), name + '\n');
  if (scenario === 'http') return new Response('missing', {status: 404});
  let bytes = fs.readFileSync(path.join(root, 'remote', name));
  if (scenario === 'manifest' && name === 'MANIFEST') bytes = Buffer.concat([bytes, Buffer.from('# altered\n')]);
  if (scenario === 'binary' && name === 'opencodereview-linux-amd64') bytes[25] ^= 1;
  if (scenario === 'checksum' && name.endsWith('.sha256')) bytes = Buffer.from('wrong\n');
  if (scenario === 'license' && name === 'LICENSE') bytes = Buffer.from('different license');
  if (name === 'qualification.json' && scenario.startsWith('receipt-')) {
    const receipt = JSON.parse(bytes);
    if (scenario === 'receipt-source') receipt.source_commit = 'b'.repeat(40);
    if (scenario === 'receipt-manifest') receipt.manifest_sha256 = 'b'.repeat(64);
    if (scenario === 'receipt-failed') receipt.qualification_cases[0].passed = false;
    bytes = Buffer.from(JSON.stringify(receipt));
  }
  return new Response(bytes, scenario === 'oversize' && name === 'opencodereview-linux-amd64'
    ? {headers: {'content-length': String(128 * 1024 * 1024 + 1)}} : undefined);
};
cp.execFileSync = (command, args, options) => {
  if (!command.startsWith(root + path.sep) || path.basename(command) !== 'opencodereview-linux-amd64' ||
      args.length !== 1 || args[0] !== '--version' || options.env.GH_TOKEN)
    throw Error('unexpected_execution');
  fs.writeFileSync(path.join(root, 'executed'), 'version');
  return 'open-code-review ' + (scenario === 'version' ? '9.9.9' : '1.14.0-rr.1') + ' linux/amd64\n';
};
require('node:module').syncBuiltinESMExports();
`;

describe('pinned managed fork release download', () => {
  let root: string;
  let output: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-native-consumer-'));
    output = path.join(root, 'candidate');
    fs.mkdirSync(path.join(root, path.dirname(manifestPath)), { recursive: true });
    fs.mkdirSync(path.join(root, 'src/control-plane'), { recursive: true });
    fs.mkdirSync(path.join(root, 'remote'));
    const binary = Buffer.alloc(64);
    Buffer.from([127, 69, 76, 70, 2, 1]).copy(binary);
    binary.writeUInt16LE(62, 18);
    const binarySha = hash(binary);
    const licenses = {
      LICENSE: 'Apache license fixture\n',
      NOTICE: 'Upstream attribution fixture\n',
      'ReviewRouter-LICENSE': 'MIT license fixture\n',
    };
    const manifest = [
      'manifest_schema=open-code-review.build/v1',
      'repository=agent-teams-ai/open-code-review',
      `source_commit=${sourceSha}`,
      `source_tree=${'b'.repeat(40)}`,
      'upstream_repository=alibaba/open-code-review',
      `upstream_commit=${'c'.repeat(40)}`,
      'toolchain=go1.26.11',
      'goos=linux',
      'goarch=amd64',
      'goamd64=v1',
      'gofips140=off',
      'gowork=off',
      'cgo_enabled=0',
      `build_flags=-mod=readonly -trimpath -buildvcs=false -ldflags -X=main.Version=${version}`,
      `release_version=${version}`,
      'outcome_schema_version=reviewrouter.ocr-outcome/v1',
      `binary_name=${binaryName}`,
      `binary_sha256=${binarySha}`,
      `binary_size_bytes=${binary.length}`,
      `license_sha256=${hash(licenses.LICENSE)}`,
      `notice_sha256=${hash(licenses.NOTICE)}`,
      `reviewrouter_license_sha256=${hash(licenses['ReviewRouter-LICENSE'])}`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(root, manifestPath), manifest);
    const assets = {
      ...licenses,
      MANIFEST: manifest,
      [binaryName]: binary,
      [`${binaryName}.sha256`]: `${binarySha}  ${binaryName}\n`,
      'qualification.json': JSON.stringify({
        schema_version: 'opencodereview.managed-qualification/v1',
        passed: true,
        model_free: true,
        source_commit: sourceSha,
        release_version: version,
        binary_sha256: binarySha,
        manifest_sha256: hash(manifest),
        outcome_schema_version: 'reviewrouter.ocr-outcome/v1',
        qualification_cases: Array.from({ length: 4 }, () => ({ passed: true })),
      }),
    };
    for (const [name, bytes] of Object.entries(assets))
      fs.writeFileSync(path.join(root, 'remote', name), bytes);
    fs.writeFileSync(
      path.join(root, 'src/control-plane/review-agent-profiles.json'),
      JSON.stringify([
        {
          profileRef: 'ocr-managed-v6',
          agentKind: 'ocr',
          reviewSkillsVersion: 1,
          packageVersion: version,
          binarySha256: binarySha,
        },
      ])
    );
    fs.writeFileSync(path.join(root, 'preload.cjs'), preload);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function run(scenario = 'success') {
    return new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--require', path.join(root, 'preload.cjs'), script, output],
          {
            cwd: root,
            timeout: 15_000,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              GH_TOKEN: 'synthetic-must-not-reach-native',
              RR_NATIVE_DOWNLOAD_FIXTURE: root,
              RR_NATIVE_DOWNLOAD_SCENARIO: scenario,
            },
          }
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      }
    );
  }

  it('preserves the seven qualified owner assets and checks the native version last', async () => {
    const result = await run();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      repository: 'agent-teams-ai/open-code-review',
      sourceSha,
      downloadVerified: true,
    });
    expect(fs.readdirSync(output).sort()).toEqual(
      fs.readdirSync(path.join(root, 'remote')).sort()
    );
    for (const asset of fs.readdirSync(output))
      expect(fs.readFileSync(path.join(output, asset))).toEqual(
        fs.readFileSync(path.join(root, 'remote', asset))
      );
    expect(fs.statSync(path.join(output, binaryName)).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(path.join(root, 'executed'))).toBe(true);
  });

  it.each([
    'http',
    'manifest',
    'receipt-source',
    'receipt-manifest',
    'receipt-failed',
    'binary',
    'checksum',
    'license',
    'oversize',
    'version',
  ])(
    'rejects %s and removes partial output without executing unverified bytes',
    async (scenario) => {
      const result = await run(scenario);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr).code).toBe('native_ocr_download_rejected');
      expect(fs.existsSync(output)).toBe(false);
      expect(
        fs.readdirSync(root).some((name) => name.startsWith('.ocr-download-'))
      ).toBe(false);
      expect(fs.existsSync(path.join(root, 'executed'))).toBe(scenario === 'version');
    }
  );

  it.each(['missing-manifest', 'profile', 'duplicate-manifest-key', 'existing-output'])(
    'rejects local %s before any network or native execution',
    async (scenario) => {
      if (scenario === 'missing-manifest')
        fs.unlinkSync(path.join(root, manifestPath));
      if (scenario === 'profile')
        fs.writeFileSync(
          path.join(root, 'src/control-plane/review-agent-profiles.json'),
          '[]'
        );
      if (scenario === 'duplicate-manifest-key')
        fs.appendFileSync(
          path.join(root, manifestPath),
          `source_commit=${sourceSha}\n`
        );
      if (scenario === 'existing-output') fs.mkdirSync(output);
      const result = await run();
      expect(result.status).toBe(1);
      expect(fs.existsSync(path.join(root, 'fetches'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'executed'))).toBe(false);
      expect(fs.existsSync(output)).toBe(scenario === 'existing-output');
    }
  );
});
