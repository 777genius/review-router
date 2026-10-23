import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPO_ROOT = path.resolve(__dirname, '..', '..');

export const SUPPORTED_CONTRACT = {
  protocolVersion: '2',
  schemaDigest: 'a'.repeat(64),
  canonicalizerDigest: 'b'.repeat(64),
} as const;

export const OTHER_CONTRACT = {
  protocolVersion: '2',
  schemaDigest: 'c'.repeat(64),
  canonicalizerDigest: 'd'.repeat(64),
} as const;

export const MANIFEST_PATH =
  'src/control-plane/generated/review-action-v2/manifest.json';

export interface ContractTriple {
  readonly protocolVersion: string;
  readonly schemaDigest: string;
  readonly canonicalizerDigest: string;
}

/** Synthetic manifest in the shipped shape (protocolVersion is a JSON number). */
export function manifestSource(contract: ContractTriple = SUPPORTED_CONTRACT): string {
  return (
    JSON.stringify(
      {
        contractSourceVersion: 1,
        protocolVersion: Number(contract.protocolVersion),
        schemaDigest: contract.schemaDigest,
        canonicalizerDigest: contract.canonicalizerDigest,
      },
      null,
      2
    ) + '\n'
  );
}

export function protocolInfoBody(contracts: readonly ContractTriple[]): string {
  return JSON.stringify({ infoVersion: 1, contracts });
}

export interface ScratchChannelOptions {
  /** Manifest at the candidate commit tagged v1.9.9. */
  targetManifest?: string;
  /** Manifest at the channel commit tagged workflow-v1; null deletes the file. */
  channelManifest?: string | null;
}

export interface ScratchChannel {
  readonly remoteDir: string;
  readonly workDir: string;
  readonly binDir: string;
  readonly channelSha: string;
  readonly targetSha: string;
  dispose(): void;
}

export interface ScriptResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1048576,
  }).trim();
}

function scratchGit(hooksDir: string, cwd: string, args: string[]): string {
  return git(
    [
      '-c',
      'user.email=protocol-compat-test@example.invalid',
      '-c',
      'user.name=protocol-compat-test',
      '-c',
      'commit.gpgsign=false',
      '-c',
      `core.hooksPath=${hooksDir}`,
      ...args,
    ],
    cwd
  );
}

function writeManifest(workDir: string, source: string): void {
  const target = path.join(workDir, MANIFEST_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
}

function writeGhStub(binDir: string, releaseTag: string): void {
  const stub = path.join(binDir, 'gh');
  fs.writeFileSync(
    stub,
    `#!/bin/sh\necho '{"tag_name":"${releaseTag}","draft":false,"prerelease":false,"published_at":"2026-10-23T00:00:00.000Z"}'\n`
  );
  fs.chmodSync(stub, 0o755);
}

const scratchRoots: string[] = [];

/**
 * Scratch Git channel: a bare remote plus a clone with three commits.
 * The real runtime workflow file is committed so the promotion ABI check
 * runs against production content. Tags are lightweight so ls-remote
 * reports commit SHAs directly.
 */
export function createScratchChannel(
  options: ScratchChannelOptions = {}
): ScratchChannel {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'review-router-protocol-compat-')
  );
  scratchRoots.push(root);
  const remoteDir = path.join(root, 'remote.git');
  const workDir = path.join(root, 'work');
  const binDir = path.join(root, 'bin');
  const hooksDir = path.join(root, 'hooks');
  fs.mkdirSync(binDir);
  fs.mkdirSync(hooksDir);
  writeGhStub(binDir, 'v1.9.9');

  git(['init', '--bare', remoteDir], root);
  git(['clone', remoteDir, workDir], root);

  const workflowSource = fs.readFileSync(
    path.join(REPO_ROOT, '.github', 'workflows', 'reviewrouter-runtime.yml'),
    'utf8'
  );
  const workflowTarget = path.join(
    workDir,
    '.github',
    'workflows',
    'reviewrouter-runtime.yml'
  );
  fs.mkdirSync(path.dirname(workflowTarget), { recursive: true });
  fs.writeFileSync(workflowTarget, workflowSource);
  scratchGit(hooksDir, workDir, ['add', '.']);
  scratchGit(hooksDir, workDir, ['commit', '-m', 'base']);

  writeManifest(workDir, options.targetManifest ?? manifestSource());
  scratchGit(hooksDir, workDir, ['add', '.']);
  scratchGit(hooksDir, workDir, ['commit', '-m', 'candidate']);
  scratchGit(hooksDir, workDir, ['tag', 'v1.9.9']);
  const targetSha = scratchGit(hooksDir, workDir, ['rev-parse', 'HEAD']);

  if (options.channelManifest === null) {
    fs.rmSync(path.join(workDir, MANIFEST_PATH));
    scratchGit(hooksDir, workDir, ['add', '-u']);
    scratchGit(hooksDir, workDir, ['commit', '-m', 'channel']);
  } else if (typeof options.channelManifest === 'string') {
    writeManifest(workDir, options.channelManifest);
    scratchGit(hooksDir, workDir, ['add', '.']);
    scratchGit(hooksDir, workDir, ['commit', '-m', 'channel']);
  } else {
    fs.writeFileSync(path.join(workDir, 'channel-marker.txt'), 'channel\n');
    scratchGit(hooksDir, workDir, ['add', '.']);
    scratchGit(hooksDir, workDir, ['commit', '-m', 'channel']);
  }
  scratchGit(hooksDir, workDir, ['tag', 'workflow-v1']);
  const channelSha = scratchGit(hooksDir, workDir, ['rev-parse', 'HEAD']);

  scratchGit(hooksDir, workDir, ['push', 'origin', '--all']);
  scratchGit(hooksDir, workDir, ['push', 'origin', '--tags']);

  return {
    remoteDir,
    workDir,
    binDir,
    channelSha,
    targetSha,
    dispose(): void {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function remoteTagSha(remoteDir: string, tag: string): string {
  return git(['ls-remote', '--exit-code', remoteDir, `refs/tags/${tag}`], remoteDir)
    .split('\t')[0];
}

export function runScript(
  script: string,
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Extracts the first JSON record from a script output line. */
export function parseJsonLine(output: string): Record<string, unknown> {
  for (const line of output.split('\n')) {
    const candidate = line.trim();
    if (!candidate.startsWith('{')) continue;
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      // Keep looking; tooling warnings may share the stream.
    }
  }
  throw new Error(`no JSON record in output: ${output}`);
}

export function disposeScratchChannels(): void {
  for (const root of scratchRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
