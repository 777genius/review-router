import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../..');
const script = path.join(repoRoot, 'scripts/publish-native-ocr.mts');
const sourceSha = 'a'.repeat(40);
const tag = 'ocr-v1.13.1-rr.6';

// The actual Node entrypoint runs with a no-network subprocess boundary. Remote
// state evolves across calls, including partial writes and uncertain outcomes.
const preload = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = process.env.RR_PUBLICATION_FIXTURE;
const scenario = process.env.RR_PUBLICATION_SCENARIO;
process.stdout.write = (value) => { fs.appendFileSync(path.join(root, 'stdout'), value); return true; };
process.stderr.write = (value) => { fs.appendFileSync(path.join(root, 'stderr'), value); return true; };
const sha = 'a'.repeat(40);
let tagExists = scenario === 'existing-tag';
let draftCreated = false;
let published = false;
let uploads = [];
let mainReads = 0;
function log(command, args) {
  fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({command, args}) + '\n');
}
function output(value, options) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  return options && options.encoding ? bytes.toString(options.encoding) : bytes;
}
function release() {
  return {id: 71, tag_name: 'ocr-v1.13.1-rr.6', target_commitish: scenario === 'metadata-default-branch' ? 'main' : sha,
    draft: !published, prerelease: true};
}
cp.spawnSync = (command, args) => {
  log(command, args);
  if (scenario === 'tag-lookup-failed') return {status: 1, stdout: 'HTTP/2.0 500 Server Error\n\n{}'};
  if (!tagExists) return {status: 1, stdout: 'HTTP/2.0 404 Not Found\n\n{}'};
  return {status: 0, stdout: 'HTTP/2.0 200 OK\n\n' + JSON.stringify({ref: 'refs/tags/ocr-v1.13.1-rr.6',
    object: {type: 'commit', sha: published && scenario === 'wrong-final-tag' ? 'b'.repeat(40) : sha}})};
};
cp.execFileSync = (command, args, options) => {
  log(command, args);
  if (command === 'git') {
    if (args[0] === 'rev-parse') return output(sha + '\n', options);
    if (args[0] === 'ls-remote') {
      mainReads++;
      const moved = scenario === 'main-moved' && mainReads > 1;
      return output((moved ? 'b'.repeat(40) : sha) + '\trefs/heads/main\n', options);
    }
    if (args[0] === 'show') {
      const file = args[1].endsWith('/MANIFEST') || args[1].endsWith('.manifest') ? 'MANIFEST' : 'profiles.json';
      return output(fs.readFileSync(path.join(root, file)), options);
    }
    throw Error('unexpected_git');
  }
  if (command.endsWith('/opencodereview')) {
    if (options.env.GH_TOKEN || options.env.GITHUB_TOKEN) throw Error('native_received_mutation_token');
    return output('open-code-review 1.13.1-rr.6 linux/amd64\nhttps://github.com/alibaba/open-code-review\n', options);
  }
  if (command !== 'gh') throw Error('unexpected_command');
  if (args[0] === 'run') {
    if (args[2] !== '17' || args[args.indexOf('--name') + 1] !== 'native-runtime-candidate-' + sha) throw Error('wrong_artifact');
    const directory = args[args.indexOf('--dir') + 1];
    for (const name of ['MANIFEST', 'opencodereview', 'opencodereview.sha256'])
      fs.copyFileSync(path.join(root, name), path.join(directory, name));
    if (scenario === 'artifact-mismatch') fs.appendFileSync(path.join(directory, 'opencodereview'), 'drift');
    return output('', options);
  }
  if (args[0] === 'api') {
    const endpoint = args[3];
    if (endpoint.endsWith('/git/refs')) {
      if (tagExists) throw Error('tag_already_exists');
      tagExists = true;
      return output({}, options);
    }
    if (endpoint.endsWith('/releases?per_page=100')) {
      if (scenario === 'release-lookup-failed') throw Error('network_failure');
      return output([draftCreated || scenario === 'existing-release' ? [release()] : []], options);
    }
    if (endpoint.endsWith('/releases/71')) return output(release(), options);
    if (endpoint.endsWith('/releases/71/assets?per_page=100')) {
      const inventory = uploads.map((file, index) => ({id: index + 1, name: path.basename(file),
        state: 'uploaded', size: fs.statSync(file).size}));
      if (scenario === 'extra-asset') inventory.push({id: 9, name: 'unexpected', state: 'uploaded', size: 1});
      return output([inventory], options);
    }
    if (endpoint.includes('/releases/assets/')) {
      const id = Number(endpoint.split('/').pop());
      const bytes = fs.readFileSync(uploads[id - 1]);
      if (scenario === 'remote-byte-mismatch' && id === 1) bytes[0] ^= 1;
      return output(bytes, options);
    }
    throw Error('unexpected_api');
  }
  if (args[0] === 'release' && args[1] === 'create') {
    if (!tagExists || !args.includes('--verify-tag') || !args.includes('--draft')) throw Error('draft_boundary');
    draftCreated = true;
    return output('draft-url\n', options);
  }
  if (args[0] === 'release' && args[1] === 'upload') {
    uploads = args.slice(args.indexOf('--repo') + 2);
    if (scenario === 'interrupted-upload') { uploads = uploads.slice(0, 1); throw Error('upload_interrupted'); }
    return output('', options);
  }
  if (args[0] === 'release' && args[1] === 'edit') {
    if (uploads.length !== 3) throw Error('partial_publish');
    published = true;
    if (scenario === 'uncertain-publish') throw Error('publish_connection_lost');
    return output('', options);
  }
  throw Error('unexpected_gh');
};
require('node:module').syncBuiltinESMExports();
`;

describe('native OCR publication entrypoint', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-native-publish-'));
    const binary = Buffer.alloc(32);
    Buffer.from([127, 69, 76, 70, 2, 1]).copy(binary);
    binary.writeUInt16LE(62, 18);
    const digest = createHash('sha256').update(binary).digest('hex');
    fs.writeFileSync(path.join(directory, 'opencodereview'), binary);
    fs.writeFileSync(
      path.join(directory, 'opencodereview.sha256'),
      `${digest}  opencodereview\n`
    );
    fs.writeFileSync(
      path.join(directory, 'MANIFEST'),
      `release_version=1.13.1-rr.6\nbinary=opencodereview\nbinary_sha256=${digest}\n`
    );
    fs.writeFileSync(
      path.join(directory, 'profiles.json'),
      JSON.stringify([
        {
          profileRef: 'ocr-managed-v5',
          agentKind: 'ocr',
          packageVersion: '1.13.1-rr.6',
          binarySha256: digest,
        },
      ])
    );
    fs.writeFileSync(path.join(directory, 'preload.cjs'), preload);
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  async function run(scenario = 'success', overrides: NodeJS.ProcessEnv = {}) {
    const result = await new Promise<{
      status: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--require', path.join(directory, 'preload.cjs'), script],
        {
          cwd: repoRoot,
          timeout: 20_000,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            GH_TOKEN: 'synthetic-publication-token',
            GITHUB_REPOSITORY: '777genius/review-router',
            GITHUB_EVENT_NAME: 'workflow_dispatch',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_SHA: sourceSha,
            EXPECTED_SOURCE_SHA: sourceSha,
            GITHUB_RUN_ID: '17',
            RUNNER_TEMP: directory,
            RR_PUBLICATION_FIXTURE: directory,
            RR_PUBLICATION_SCENARIO: scenario,
            ...overrides,
          },
        }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (value: string) => {
        stdout += value;
      });
      child.stderr.on('data', (value: string) => {
        stderr += value;
      });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    const filename = path.join(directory, 'calls.jsonl');
    const calls = fs.existsSync(filename)
      ? fs
          .readFileSync(filename, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(
            (line) => JSON.parse(line) as { command: string; args: string[] }
          )
      : [];
    return {
      result: {
        ...result,
        stdout: fs.existsSync(path.join(directory, 'stdout'))
          ? fs.readFileSync(path.join(directory, 'stdout'), 'utf8')
          : result.stdout,
        stderr: fs.existsSync(path.join(directory, 'stderr'))
          ? fs.readFileSync(path.join(directory, 'stderr'), 'utf8')
          : result.stderr,
      },
      calls,
    };
  }

  it('creates one exact tag, verifies all remote draft bytes, then publishes and reads back', async () => {
    const { result, calls } = await run();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      tag,
      sourceSha,
      published: true,
    });
    const create = calls.findIndex((call) => call.args.includes('POST'));
    const draft = calls.findIndex(
      (call) => call.args[0] === 'release' && call.args[1] === 'create'
    );
    const publish = calls.findIndex(
      (call) => call.args[0] === 'release' && call.args[1] === 'edit'
    );
    expect(create).toBeGreaterThan(0);
    expect(draft).toBeGreaterThan(create);
    expect(calls[create].args).toEqual(
      expect.arrayContaining([`ref=refs/tags/${tag}`, `sha=${sourceSha}`])
    );
    expect(calls[draft].args).toEqual(
      expect.arrayContaining([
        '--draft',
        '--verify-tag',
        '--prerelease',
        '--latest=false',
      ])
    );
    expect(calls[publish].args).toEqual(
      expect.arrayContaining([
        '--draft=false',
        '--verify-tag',
        '--prerelease',
        '--latest=false',
      ])
    );
    expect(
      calls
        .slice(0, publish)
        .filter((call) =>
          call.args.some((arg) => arg.includes('/releases/assets/'))
        )
    ).toHaveLength(3);
    expect(
      calls
        .slice(publish + 1)
        .filter((call) =>
          call.args.some((arg) => arg.includes('/releases/assets/'))
        )
    ).toHaveLength(3);
    expect(calls.flatMap((call) => call.args).join(' ')).not.toMatch(
      /--force|--clobber|workflow-v1|refs\/tags\/v1\b/
    );
    expect(
      fs
        .readdirSync(directory)
        .some((name) => name.startsWith('reviewrouter-native-release-'))
    ).toBe(false);
  });

  it('accepts default-branch release metadata when the actual remote tag matches', async () => {
    const { result } = await run('metadata-default-branch');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      tag,
      sourceSha,
      published: true,
    });
  });

  it.each([
    'existing-tag',
    'existing-release',
    'tag-lookup-failed',
    'release-lookup-failed',
    'main-moved',
    'artifact-mismatch',
  ])('performs no remote write when %s rejects preflight', async (scenario) => {
    const { result, calls } = await run(scenario);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      writeIssued: false,
      outcome: 'not_issued',
    });
    expect(
      calls.some(
        (call) => call.args.includes('POST') || call.args[0] === 'release'
      )
    ).toBe(false);
  });

  it.each(['interrupted-upload', 'remote-byte-mismatch', 'extra-asset'])(
    'leaves a partial or unverified draft unpublished after %s',
    async (scenario) => {
      const { result, calls } = await run(scenario);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        writeIssued: true,
        outcome: 'inspection_required',
      });
      expect(
        calls.filter(
          (call) => call.args[0] === 'release' && call.args[1] === 'create'
        )
      ).toHaveLength(1);
      expect(
        calls.some(
          (call) => call.args[0] === 'release' && call.args[1] === 'edit'
        )
      ).toBe(false);
    }
  );

  it.each(['uncertain-publish', 'wrong-final-tag'])(
    'requires inspection after %s without retrying or declaring success',
    async (scenario) => {
      const { result, calls } = await run(scenario);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        writeIssued: true,
        outcome: 'inspection_required',
      });
      expect(
        calls.filter(
          (call) => call.args[0] === 'release' && call.args[1] === 'edit'
        )
      ).toHaveLength(1);
    }
  );

  it.each([
    { GITHUB_REF: 'refs/heads/feature' },
    { EXPECTED_SOURCE_SHA: 'main' },
    { GITHUB_SHA: 'b'.repeat(40) },
    { GITHUB_EVENT_NAME: 'pull_request' },
  ])(
    'rejects a substituted dispatch source before any subprocess',
    async (overrides) => {
      const { result, calls } = await run('success', overrides);
      expect(result.status).toBe(1);
      expect(calls).toEqual([]);
    }
  );
});
