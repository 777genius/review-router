import { execFile } from 'child_process';
import { createHash, createHmac } from 'crypto';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  canonicalizeReviewContextConfinementEvidence,
  canonicalizeReviewContextGatewayEvent,
} from '../../../src/control-plane/generated/review-action-v2/review-action-v2';
import {
  CONTEXT_GATEWAY_POLICY_VERSION,
  canonicalJson,
} from '../../../src/context-gateway/context-gateway-contract';
import type { ReviewContextAttestationPort } from '../../../src/review-orchestration/application';
import { ContextGatewayInvocationSessionFactory } from '../../../src/review-orchestration/infrastructure/context-gateway-invocation-session';

const execFileAsync = promisify(execFile);

describe('ContextGatewayInvocationSessionFactory', () => {
  it('executes an immutable gateway snapshot and emits the server wire contract', async () => {
    const checkoutRoot = await mkdtemp(
      path.join(os.tmpdir(), 'reviewrouter-gateway-session-test-')
    );
    const gatewayBundlePath = path.join(checkoutRoot, 'gateway.cjs');
    try {
      await writeFile(path.join(checkoutRoot, 'tracked.txt'), 'tracked\n');
      await writeFile(gatewayBundlePath, 'gateway-v1\n');
      await git(checkoutRoot, ['init']);
      await git(checkoutRoot, ['config', 'user.email', 'test@example.com']);
      await git(checkoutRoot, ['config', 'user.name', 'ReviewRouter Test']);
      await git(checkoutRoot, ['add', '.']);
      await git(checkoutRoot, ['commit', '-m', 'test fixture']);

      const secret = Buffer.alloc(32, 7);
      const serverSession = Object.freeze({
        sessionId: 'gateway-session-1',
        eventChainSeedHash: '0'.repeat(64),
        sealCapability: 'seal-capability',
        gatewaySessionSecret: secret.toString('base64url'),
        expiresAt: '2026-07-24T20:00:00.000Z',
      });
      const attestations = {
        openGatewaySession: jest.fn().mockResolvedValue(serverSession),
        sealGatewaySession: jest.fn().mockResolvedValue({
          attestationId: 'attestation-1',
          attestationHash: hash('attestation'),
        }),
        commitContextReplay: jest.fn(),
      } as unknown as ReviewContextAttestationPort;
      const factory = new ContextGatewayInvocationSessionFactory(attestations, {
        checkoutRoot,
        gatewayBundlePath,
      });
      const revision = {
        baseSha: (await git(checkoutRoot, ['rev-parse', 'HEAD'])).trim(),
        headSha: (await git(checkoutRoot, ['rev-parse', 'HEAD'])).trim(),
      };
      const planning = await factory.planningConfig(revision);
      const originalGatewayHash = hash('gateway-v1\n');

      await writeFile(gatewayBundlePath, 'gateway-v2-mutated\n');
      const invocationLease = {
        leaseId: 'lease-1',
        attemptId: 'attempt-1',
        leaseCapability: 'lease-capability',
        fencingToken: '3',
        expiresAt: '2026-07-24T19:00:00.000Z',
        resultReportUntil: '2026-07-24T19:10:00.000Z',
        renewalCeilingReached: false,
      };
      const opening = {
        invocationLease,
        sourceExecutionId: 'execution-1',
        sourceWorkSlotId: 'slot-1',
        sourceReviewRevisionHash: hash('revision'),
        providerKind: 'codex',
        requestedModel: 'gpt-test',
        executionProfile: 'context_gateway_v1',
        providerInvocationKey: hash('provider-invocation'),
        toolPolicyHash: hash('tool-policy'),
        revision,
      };
      const session = await factory.open(opening);

      expect(planning.gatewayBinaryHash).toBe(originalGatewayHash);
      expect(session.providerConfig.gatewayBinaryHash).toBe(
        originalGatewayHash
      );
      expect(await readFile(session.providerConfig.args[0], 'utf8')).toBe(
        'gateway-v1\n'
      );
      const checkoutTreeOid =
        session.providerConfig.runtimeEnvironment
          .REVIEWROUTER_CONTEXT_CHECKOUT_TREE_OID!;
      expect(attestations.openGatewaySession).toHaveBeenCalledWith({
        invocationLease,
        sourceExecutionId: opening.sourceExecutionId,
        sourceWorkSlotId: opening.sourceWorkSlotId,
        sourceReviewRevisionHash: opening.sourceReviewRevisionHash,
        checkoutTreeOid,
        gatewayPolicyVersion: CONTEXT_GATEWAY_POLICY_VERSION,
        gatewayBinaryHash: originalGatewayHash,
        confinementEvidenceHash: hash(
          canonicalizeReviewContextConfinementEvidence({
            attemptId: invocationLease.attemptId,
            sourceLeaseId: invocationLease.leaseId,
            sourceFencingToken: invocationLease.fencingToken,
            sourceExecutionId: opening.sourceExecutionId,
            sourceWorkSlotId: opening.sourceWorkSlotId,
            sourceReviewRevisionHash: opening.sourceReviewRevisionHash,
            checkoutTreeOid,
            providerKind: opening.providerKind,
            requestedModel: opening.requestedModel,
            executionProfile: opening.executionProfile,
            providerInvocationKey: opening.providerInvocationKey,
            toolPolicyHash: opening.toolPolicyHash,
            gatewayPolicyVersion: CONTEXT_GATEWAY_POLICY_VERSION,
            gatewayBinaryHash: originalGatewayHash,
          })
        ),
      });

      const operation = {
        kind: 'file_read',
        path: 'tracked.txt',
        startByte: 0,
        maxBytes: 64_000,
      };
      const result = {
        kind: 'file_read',
        fileKind: 'regular',
        mode: 0o100644,
        blobOid: revision.headSha,
        symlinkTargetHash: null,
        contentHash: hash('tracked'),
        byteCount: 8,
        eof: true,
        complete: true,
        truncated: false,
      };
      const eventWithoutHash = {
        sequence: 1,
        previousEventHash: serverSession.eventChainSeedHash,
        operationKey: hash(canonicalJson(operation)),
        operation,
        result,
      };
      const eventHash = createHmac('sha256', secret)
        .update(
          canonicalizeReviewContextGatewayEvent({
            sessionId: serverSession.sessionId,
            ...eventWithoutHash,
          })
        )
        .digest('hex');
      const dependency = { ...eventWithoutHash, eventHash };
      await writeFile(
        session.providerConfig.runtimeEnvironment
          .REVIEWROUTER_CONTEXT_TRANSCRIPT_PATH!,
        canonicalJson({
          transcriptVersion: 1,
          sessionId: serverSession.sessionId,
          gatewayPolicyVersion: CONTEXT_GATEWAY_POLICY_VERSION,
          gatewayBinaryHash: originalGatewayHash,
          checkoutTreeOid,
          eventChainSeedHash: serverSession.eventChainSeedHash,
          authenticatedChainHash: eventHash,
          dependencies: [dependency],
          hadFailure: false,
          updatedAtMs: 1,
        })
      );
      await writeFile(
        session.providerConfig.runtimeEnvironment
          .REVIEWROUTER_CONTEXT_REPLAY_MATERIAL_PATH!,
        canonicalJson({
          replayMaterialVersion: 1,
          sessionId: serverSession.sessionId,
          entries: [],
        })
      );

      await expect(
        session.seal({
          actualModel: 'gpt-test-actual',
          terminalOutcomeHash: hash('outcome'),
        })
      ).resolves.toMatchObject({ attestationId: 'attestation-1' });
      expect(attestations.sealGatewaySession).toHaveBeenCalledWith(
        expect.objectContaining({
          transcriptCanonicalJson: canonicalJson({
            manifestVersion: 2,
            gatewayPolicyVersion: CONTEXT_GATEWAY_POLICY_VERSION,
            gatewayBinaryHash: originalGatewayHash,
            checkoutTreeOid,
            authenticatedChainHash: eventHash,
            complete: true,
            dependencies: [dependency],
          }),
          replayMaterialCanonicalJson: canonicalJson({
            materialVersion: 1,
            sourceDependencies: [
              {
                sequence: 1,
                operationKey: eventWithoutHash.operationKey,
                replayQuery: null,
              },
            ],
          }),
        })
      );
      const snapshotPath = session.providerConfig.args[0];
      await session.dispose();
      await expect(readFile(snapshotPath)).rejects.toThrow();
    } finally {
      await rm(checkoutRoot, { recursive: true, force: true });
    }
  });
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd });
  return stdout;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
