import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repository = '777genius/review-router';
const version = '1.13.1-rr.6';
const tag = `ocr-v${version}`;
const assetName = 'opencodereview-linux-amd64';
const manifestPath =
  'tools/ocr/qualifications/unified-model-routes-v3.manifest';
const maximumBytes = 128 * 1024 * 1024;
let phase = 'validate';
let writeIssued = false;

function need(value: unknown): asserts value {
  if (!value) throw new Error('native_ocr_publication_rejected');
}

function record(value: unknown): Record<string, unknown> {
  need(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function run(command: string, args: string[]): Buffer {
  return execFileSync(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: maximumBytes,
    timeout: 180_000,
  });
}

function git(...args: string[]): string {
  return run('git', args).toString('utf8').trim();
}

function api(endpoint: string, args: string[] = []): unknown {
  return JSON.parse(
    run('gh', ['api', '--hostname', 'github.com', endpoint, ...args]).toString(
      'utf8'
    )
  );
}

function pages(endpoint: string): unknown[] {
  const value = api(endpoint, ['--paginate', '--slurp']);
  need(Array.isArray(value) && value.every(Array.isArray));
  return value.flat();
}

/** Only an actual HTTP 404 proves absence; transport/auth failures stop writes. */
function remoteTag(): string | null {
  const result = spawnSync(
    'gh',
    [
      'api',
      '--hostname',
      'github.com',
      '--include',
      `repos/${repository}/git/ref/tags/${tag}`,
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30_000 }
  );
  const status = /^HTTP\/\S+ (\d{3})\b/m.exec(result.stdout ?? '')?.[1];
  if (!result.error && result.status !== 0 && status === '404') return null;
  need(!result.error && result.status === 0 && status === '200');
  const separator = /\r?\n\r?\n/.exec(result.stdout);
  need(separator);
  const value = record(
    JSON.parse(result.stdout.slice(separator.index + separator[0].length))
  );
  const object = record(value.object);
  need(value.ref === `refs/tags/${tag}` && object.type === 'commit');
  need(typeof object.sha === 'string' && /^[a-f0-9]{40}$/.test(object.sha));
  return object.sha;
}

function readCandidate(directory: string, name: string): Buffer {
  const filename = path.join(directory, name);
  const stat = fs.lstatSync(filename);
  need(stat.isFile() && stat.size > 0 && stat.size <= maximumBytes);
  return fs.readFileSync(filename);
}

function publish(): void {
  const expected = process.env.EXPECTED_SOURCE_SHA ?? '';
  need(
    process.env.GITHUB_REPOSITORY === repository &&
      process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      process.env.GITHUB_REF === 'refs/heads/main' &&
      /^[a-f0-9]{40}$/.test(expected) &&
      process.env.GITHUB_SHA === expected &&
      /^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ID ?? '') &&
      process.env.GH_TOKEN &&
      process.platform === 'linux' &&
      process.arch === 'x64'
  );
  need(git('rev-parse', 'HEAD') === expected);
  const checkMain = () =>
    need(
      git('ls-remote', '--exit-code', 'origin', 'refs/heads/main') ===
        `${expected}\trefs/heads/main`
    );
  checkMain();
  const committed = (filename: string) =>
    run('git', ['show', `${expected}:${filename}`]);
  const manifest = committed(manifestPath);
  const fields = Object.fromEntries(
    manifest
      .toString('utf8')
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => [
        line.slice(0, line.indexOf('=')),
        line.slice(line.indexOf('=') + 1),
      ])
  );
  need(
    fields.release_version === version && fields.binary === 'opencodereview'
  );
  const profiles: unknown = JSON.parse(
    committed('src/control-plane/review-agent-profiles.json').toString('utf8')
  );
  need(Array.isArray(profiles));
  const matching = profiles
    .map(record)
    .filter((profile) => profile.profileRef === 'ocr-managed-v5');
  need(matching.length === 1);
  const profile = matching[0]!;
  need(
    profile.agentKind === 'ocr' &&
      profile.packageVersion === version &&
      profile.binarySha256 === fields.binary_sha256 &&
      /^[a-f0-9]{64}$/.test(fields.binary_sha256 ?? '')
  );

  const directory = fs.mkdtempSync(
    path.join(
      process.env.RUNNER_TEMP || os.tmpdir(),
      'reviewrouter-native-release-'
    )
  );
  try {
    phase = 'download-qualified-artifact';
    run('gh', [
      'run',
      'download',
      process.env.GITHUB_RUN_ID!,
      '--repo',
      repository,
      '--name',
      `native-runtime-candidate-${expected}`,
      '--dir',
      directory,
    ]);
    need(
      JSON.stringify(fs.readdirSync(directory).sort()) ===
        JSON.stringify(['MANIFEST', 'opencodereview', 'opencodereview.sha256'])
    );
    const binary = readCandidate(directory, 'opencodereview');
    need(readCandidate(directory, 'MANIFEST').equals(manifest));
    need(
      createHash('sha256').update(binary).digest('hex') ===
        profile.binarySha256 &&
        readCandidate(directory, 'opencodereview.sha256').toString('utf8') ===
          `${profile.binarySha256}  opencodereview\n`
    );
    // ELF64, little-endian, x86-64; verify its digest before executing --version.
    need(
      binary.length >= 20 &&
        binary.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) &&
        binary.readUInt16LE(18) === 62
    );
    const binaryPath = path.join(directory, 'opencodereview');
    fs.chmodSync(binaryPath, 0o700);
    need(
      execFileSync(binaryPath, ['--version'], {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 16_384,
        env: { PATH: process.env.PATH, HOME: directory },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
        .split('\n')[0]
        ?.trim() === `open-code-review ${version} linux/amd64`
    );
    const localAssets = new Map([
      [assetName, binary],
      [
        `${assetName}.sha256`,
        Buffer.from(`${profile.binarySha256}  ${assetName}\n`),
      ],
      ['MANIFEST', manifest],
    ]);
    for (const [name, bytes] of localAssets)
      fs.writeFileSync(path.join(directory, name), bytes, { mode: 0o600 });

    phase = 'preflight';
    need(remoteTag() === null);
    need(
      !pages(`repos/${repository}/releases?per_page=100`).some(
        (release) => record(release).tag_name === tag
      )
    );
    checkMain();
    phase = 'create-tag';
    writeIssued = true;
    api(`repos/${repository}/git/refs`, [
      '--method',
      'POST',
      '-f',
      `ref=refs/tags/${tag}`,
      '-f',
      `sha=${expected}`,
    ]);
    need(remoteTag() === expected);
    phase = 'create-draft';
    run('gh', [
      'release',
      'create',
      tag,
      '--repo',
      repository,
      '--verify-tag',
      '--target',
      expected,
      '--draft',
      '--prerelease',
      '--latest=false',
      '--title',
      `ReviewRouter OCR ${version}`,
      '--notes',
      `Qualified native OCR bytes from ${expected}; publication does not register or activate a producer.`,
    ]);
    const releases = pages(`repos/${repository}/releases?per_page=100`)
      .map(record)
      .filter((release) => release.tag_name === tag);
    need(releases.length === 1 && Number.isSafeInteger(releases[0]!.id));
    const releaseId = releases[0]!.id as number;
    const verifyRelease = (draft: boolean) => {
      const release = record(api(`repos/${repository}/releases/${releaseId}`));
      need(
        release.tag_name === tag &&
          release.target_commitish === expected &&
          release.draft === draft &&
          release.prerelease === true
      );
      need(remoteTag() === expected);
    };
    verifyRelease(true);
    phase = 'upload';
    run('gh', [
      'release',
      'upload',
      tag,
      '--repo',
      repository,
      ...[...localAssets.keys()].map((name) => path.join(directory, name)),
    ]);
    const verifyAssets = () => {
      const assets = pages(
        `repos/${repository}/releases/${releaseId}/assets?per_page=100`
      ).map(record);
      need(
        JSON.stringify(assets.map((asset) => asset.name).sort()) ===
          JSON.stringify([...localAssets.keys()].sort())
      );
      for (const asset of assets) {
        const bytes = localAssets.get(asset.name as string)!;
        need(
          asset.state === 'uploaded' &&
            asset.size === bytes.length &&
            Number.isSafeInteger(asset.id)
        );
        const remote = run('gh', [
          'api',
          '--hostname',
          'github.com',
          `repos/${repository}/releases/assets/${asset.id}`,
          '-H',
          'Accept: application/octet-stream',
        ]);
        need(remote.equals(bytes));
      }
    };
    phase = 'verify-draft';
    verifyAssets();
    verifyRelease(true);
    checkMain();
    phase = 'publish';
    run('gh', [
      'release',
      'edit',
      tag,
      '--repo',
      repository,
      '--verify-tag',
      '--draft=false',
      '--prerelease',
      '--latest=false',
    ]);
    phase = 'readback';
    verifyRelease(false);
    verifyAssets();
    process.stdout.write(
      JSON.stringify({
        tag,
        sourceSha: expected,
        binarySha256: profile.binarySha256,
        published: true,
      }) + '\n'
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

try {
  need(process.argv.length === 2);
  publish();
} catch {
  process.stderr.write(
    JSON.stringify({
      code: 'native_ocr_publication_rejected',
      phase,
      writeIssued,
      outcome: writeIssued ? 'inspection_required' : 'not_issued',
    }) + '\n'
  );
  process.exitCode = 1;
}
