import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  CONTEXT_GATEWAY_POLICY_VERSION,
  canonicalJson,
  sha256,
} from '../../../src/context-gateway/context-gateway-contract';
import {
  ReviewExecutionProviderKind,
  type ContextDependencyReplayCandidate,
} from '../../../src/review-orchestration/application';
import { ContextAttestationReplayRunner } from '../../../src/review-orchestration/infrastructure';

const execFileAsync = promisify(execFile);

describe('ContextAttestationReplayRunner', () => {
  let root: string;
  let gatewayBundlePath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'rr-context-replay-test-'));
    gatewayBundlePath = path.join(root, 'context-gateway.js');
    await writeFile(gatewayBundlePath, 'gateway-v1', 'utf8');
    await git(root, ['init', '--initial-branch=main']);
    await git(root, ['config', 'user.email', 'test@reviewrouter.local']);
    await git(root, ['config', 'user.name', 'ReviewRouter Test']);
    await writeFile(path.join(root, 'src.ts'), 'export const value = 1;\n');
    await git(root, ['add', 'src.ts']);
    await git(root, ['commit', '-m', 'test: seed']);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('replays a source file dependency against immutable target Git objects', async () => {
    const headSha = await revParse(root, 'HEAD');
    const operation = {
      kind: 'file_read' as const,
      path: 'src.ts',
      startByte: 0,
      maxBytes: 4096,
    };
    const candidate = replayCandidate({
      gatewayBinaryHash: sha256('gateway-v1'),
      dependencies: [
        {
          sequence: 1,
          operationKey: sha256(canonicalJson(operation)),
          operation,
          replayQuery: null,
        },
      ],
    });
    const runner = new ContextAttestationReplayRunner({
      checkoutRoot: root,
      gatewayBundlePath,
    });

    const result = await runner.replay({
      candidate,
      targetRevision: {
        baseSha: headSha,
        mergeBaseSha: headSha,
        headSha,
        reviewRevisionHash: '4'.repeat(64),
      },
    });

    expect(result).not.toBeNull();
    expect(result?.replayResultHash).toBe(
      sha256(result!.replayResultCanonicalJson)
    );
    const manifest = JSON.parse(result!.replayResultCanonicalJson);
    expect(manifest.checkoutTreeOid).toBe(await revParse(root, 'HEAD^{tree}'));
    expect(manifest.dependencies[0].operation).toEqual(operation);
    expect(manifest.dependencies[0].result).toMatchObject({
      kind: 'file_read',
      contentHash: sha256('export const value = 1;\n'),
      complete: true,
      truncated: false,
    });
  });

  it('denies replay when the trusted gateway binary changed', async () => {
    const headSha = await revParse(root, 'HEAD');
    const operation = {
      kind: 'file_read' as const,
      path: 'src.ts',
      startByte: 0,
      maxBytes: 4096,
    };
    const runner = new ContextAttestationReplayRunner({
      checkoutRoot: root,
      gatewayBundlePath,
    });

    await expect(
      runner.replay({
        candidate: replayCandidate({
          gatewayBinaryHash: '9'.repeat(64),
          dependencies: [
            {
              sequence: 1,
              operationKey: sha256(canonicalJson(operation)),
              operation,
              replayQuery: null,
            },
          ],
        }),
        targetRevision: {
          baseSha: headSha,
          mergeBaseSha: headSha,
          headSha,
          reviewRevisionHash: '4'.repeat(64),
        },
      })
    ).resolves.toBeNull();
  });
});

function replayCandidate(input: {
  gatewayBinaryHash: string;
  dependencies: readonly {
    sequence: number;
    operationKey: string;
    operation: Readonly<Record<string, unknown>>;
    replayQuery: string | null;
  }[];
}): ContextDependencyReplayCandidate {
  const attestationId = 'attestation-test';
  const attestationHash = 'a'.repeat(64);
  const replayPlanCanonicalJson = canonicalJson({
    planVersion: 1,
    attestationId,
    attestationHash,
    gatewayPolicyVersion: CONTEXT_GATEWAY_POLICY_VERSION,
    gatewayBinaryHash: input.gatewayBinaryHash,
    sourceDependencies: input.dependencies,
  });
  return {
    observation: {
      observationId: 'observation-test',
      payloadCanonicalJson: '{}',
      payloadHash: sha256('{}'),
      byteCount: 2,
      findingCount: 0,
      actualModel: 'gpt-5.6-sol',
      qualityFlags: [],
      transportAttemptCount: 1,
      schemaValidated: true,
      fullyConsumed: true,
      contextDependencyAttestationId: attestationId,
      contextDependencyAttestationHash: attestationHash,
      eligibilityPolicyVersion: 'reuse-policy-v1',
      providerKind: ReviewExecutionProviderKind.Codex,
      providerInvocationKey: 'b'.repeat(64),
      providerVoteIdentityHash: 'c'.repeat(64),
    },
    attestationId,
    attestationHash,
    replayCapability: 'replay-capability',
    replayPlanCanonicalJson,
    replayPlanHash: sha256(replayPlanCanonicalJson),
  };
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function revParse(cwd: string, spec: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', spec], { cwd });
  return stdout.trim().toLowerCase();
}
