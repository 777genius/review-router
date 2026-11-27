import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const repository = 'agent-teams-ai/open-code-review';
const profileRef = 'ocr-managed-v6';
const manifestPath =
  'tools/ocr/qualifications/managed-tracked-inventory-v1.manifest';
const binaryName = 'opencodereview-linux-amd64';
const binaryLimit = 128 * 1024 * 1024;
let phase = 'identity';

function need(value: unknown): asserts value {
  if (!value) throw new Error('native_ocr_download_rejected');
}

function record(value: unknown): Record<string, unknown> {
  need(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function download(url: string, limit: number): Promise<Buffer> {
  const response = await fetch(url, {
    credentials: 'omit',
    headers: { Accept: 'application/octet-stream' },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    need(false);
  }
  const reader = response.body.getReader();
  try {
    const declared = response.headers.get('content-length');
    if (declared !== null)
      need(/^[0-9]+$/.test(declared) && Number(declared) <= limit);
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      need(size <= limit);
      chunks.push(Buffer.from(next.value));
    }
    need(size > 0);
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function main(): Promise<void> {
  need(process.argv.length === 3);
  need(process.platform === 'linux' && process.arch === 'x64');
  const output = path.resolve(process.argv[2]!);
  need(!fs.lstatSync(output, { throwIfNoEntry: false }));
  const manifest = fs.readFileSync(manifestPath);
  const fields: Record<string, string> = {};
  for (const line of manifest.toString('utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    need(index > 0);
    const key = line.slice(0, index);
    need(!Object.hasOwn(fields, key));
    fields[key] = line.slice(index + 1);
  }
  need(
    fields.manifest_schema === 'open-code-review.build/v1' &&
      fields.repository === repository &&
      /^[a-f0-9]{40}$/.test(fields.source_commit ?? '') &&
      /^[a-f0-9]{40}$/.test(fields.source_tree ?? '') &&
      /^go[0-9]+\.[0-9]+\.[0-9]+$/.test(fields.toolchain ?? '') &&
      fields.goos === 'linux' &&
      fields.goarch === 'amd64' &&
      /^[0-9]+\.[0-9]+\.[0-9]+-rr\.[0-9]+$/.test(
        fields.release_version ?? ''
      ) &&
      fields.release_version !== '1.13.1-rr.6' &&
      fields.outcome_schema_version === 'reviewrouter.ocr-outcome/v1' &&
      fields.binary_name === binaryName &&
      /^[a-f0-9]{64}$/.test(fields.binary_sha256 ?? '') &&
      /^[1-9][0-9]*$/.test(fields.binary_size_bytes ?? '') &&
      Number(fields.binary_size_bytes) <= binaryLimit
  );
  const profiles: unknown = JSON.parse(
    fs.readFileSync('src/control-plane/review-agent-profiles.json', 'utf8')
  );
  need(Array.isArray(profiles));
  const matching = profiles
    .map(record)
    .filter((profile) => profile.profileRef === profileRef);
  need(matching.length === 1);
  need(
    matching[0]!.agentKind === 'ocr' &&
      matching[0]!.reviewSkillsVersion === 1 &&
      matching[0]!.packageVersion === fields.release_version &&
      matching[0]!.binarySha256 === fields.binary_sha256
  );
  const baseUrl = `https://github.com/${repository}/releases/download/ocr-v${fields.release_version}`;
  phase = 'manifest';
  need((await download(`${baseUrl}/MANIFEST`, 16_384)).equals(manifest));
  phase = 'qualification';
  const qualification = await download(`${baseUrl}/qualification.json`, 65_536);
  const receipt = record(JSON.parse(qualification.toString('utf8')));
  need(
    receipt.schema_version === 'opencodereview.managed-qualification/v1' &&
      receipt.passed === true &&
      receipt.model_free === true &&
      receipt.source_commit === fields.source_commit &&
      receipt.release_version === fields.release_version &&
      receipt.binary_sha256 === fields.binary_sha256 &&
      receipt.manifest_sha256 === digest(manifest) &&
      receipt.outcome_schema_version === fields.outcome_schema_version &&
      Array.isArray(receipt.qualification_cases) &&
      receipt.qualification_cases.length === 4 &&
      receipt.qualification_cases.every((item) => record(item).passed === true)
  );

  fs.mkdirSync(path.dirname(output), { recursive: true });
  const staging = fs.mkdtempSync(
    path.join(path.dirname(output), '.ocr-download-')
  );
  try {
    fs.writeFileSync(path.join(staging, 'MANIFEST'), manifest);
    fs.writeFileSync(path.join(staging, 'qualification.json'), qualification);
    phase = 'binary';
    const binary = await download(`${baseUrl}/${binaryName}`, binaryLimit);
    need(
      binary.length === Number(fields.binary_size_bytes) &&
        digest(binary) === fields.binary_sha256 &&
        binary.length >= 20 &&
        binary.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) &&
        binary.readUInt16LE(18) === 62
    );
    const checksum = await download(`${baseUrl}/${binaryName}.sha256`, 256);
    need(
      checksum.toString('utf8') ===
        `${fields.binary_sha256}  ${binaryName}\n`
    );
    const binaryPath = path.join(staging, binaryName);
    fs.writeFileSync(binaryPath, binary, { mode: 0o700 });
    fs.writeFileSync(`${binaryPath}.sha256`, checksum);
    for (const [name, field] of [
      ['LICENSE', 'license_sha256'],
      ['NOTICE', 'notice_sha256'],
      ['ReviewRouter-LICENSE', 'reviewrouter_license_sha256'],
    ]) {
      need(/^[a-f0-9]{64}$/.test(fields[field!] ?? ''));
      const bytes = await download(`${baseUrl}/${name}`, 65_536);
      need(digest(bytes) === fields[field!]);
      fs.writeFileSync(path.join(staging, name!), bytes);
    }
    phase = 'version';
    const version = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 16_384,
      env: { PATH: process.env.PATH, HOME: staging },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    need(
      version.split('\n')[0]?.trim() ===
        `open-code-review ${fields.release_version} linux/amd64`
    );
    need(!fs.lstatSync(output, { throwIfNoEntry: false }));
    fs.renameSync(staging, output);
    process.stdout.write(
      JSON.stringify({
        repository,
        sourceSha: fields.source_commit,
        binarySha256: fields.binary_sha256,
        downloadVerified: true,
      }) + '\n'
    );
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

main().catch(() => {
  process.stderr.write(
    JSON.stringify({ code: 'native_ocr_download_rejected', phase }) + '\n'
  );
  process.exitCode = 1;
});
