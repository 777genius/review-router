import { createHash } from 'crypto';
import {
  canonicalizeProviderInvocationManifestV1,
  providerInvocationIdentityPreimageV1,
} from '../../../src/control-plane/generated/review-action-v2/provider-invocation-manifest-v1';
import {
  createPreparedProviderInvocation,
  ProviderKind,
} from '../../../src/providers/prepared-invocation';
import type { CodexProvider } from '../../../src/providers/codex';
import type { PromptBuilder } from '../../../src/analysis/llm/prompt-builder';
import type { ReviewConfig } from '../../../src/types';
import {
  ReviewExecutionProviderKind,
  ReviewTaskKind,
  type ReviewRunAuthorization,
} from '../../../src/review-orchestration/application';
import {
  CodexReviewInvocationAdapter,
  CooperativeReviewLeaseSupervisor,
  GeneratedProviderInvocationManifestAssembler,
} from '../../../src/review-orchestration/infrastructure';
import { createReviewPromptCoverageManifest } from '../../../src/review-orchestration/domain';

describe('Codex T0 prepared invocation', () => {
  it('executes the exact branded object that was prepared', async () => {
    const prepared = createPreparedProviderInvocation({
      providerKind: ProviderKind.CodexCli,
      providerName: 'codex/gpt-test',
      requestedModel: 'gpt-test',
      timeoutMs: 10_000,
      request: {
        prompt: 'prepared prompt',
        outputSchema: { type: 'object' },
        environment: { PATH: '/usr/bin' },
      },
    });
    const provider = {
      name: 'codex/gpt-test',
      prepareInvocation: jest.fn().mockResolvedValue(prepared),
      executePreparedInvocation: jest.fn(async (actual) => {
        expect(actual).toBe(prepared);
        return { content: '{}', findings: [], revalidations: [] };
      }),
    } as unknown as CodexProvider;
    const promptBuilder = {
      buildPreparedV2: jest.fn().mockResolvedValue({
        version: 'prepared_review_prompt.v2',
        prompt: 'prepared prompt',
        pathCoverage: [],
      }),
    } as unknown as PromptBuilder;
    const adapter = new CodexReviewInvocationAdapter(
      provider,
      promptBuilder,
      [assignment],
      10_000,
      true
    );

    const invocation = await adapter.prepare({
      workSlot: assignment.workSlot,
      attemptOrdinal: 1,
    });
    const observation = await adapter.execute({
      invocation,
      lease: leaseFixture,
      signal: new AbortController().signal,
    });

    expect(invocation.immutableRequest).toBe(prepared);
    expect(provider.executePreparedInvocation).toHaveBeenCalledWith(
      prepared,
      undefined,
      expect.any(AbortSignal)
    );
    expect(observation.schemaValidated).toBe(true);
  });

  it('derives manifest and provider invocation keys only from generated canonicalizers', async () => {
    const adapter = new GeneratedProviderInvocationManifestAssembler(
      authorization,
      {} as ReviewConfig,
      hash('compatibility')
    );
    const invocation = {
      workSlotId: 'slot-1',
      attemptOrdinal: 1,
      provider: 'codex/gpt-test',
      requestedModel: 'gpt-test',
      immutableRequest: Object.freeze({}),
      coverageManifest: createReviewPromptCoverageManifest({
        workSlotId: 'slot-1',
        reviewRevisionHash: hash('revision'),
        assignedPaths: [],
        pathCoverage: [],
      }),
      manifestFacts: {
        taskKindSet: [ReviewTaskKind.FindingDiscovery],
        providerKind: ReviewExecutionProviderKind.Codex,
        providerCapabilityHash: hash('capability'),
        providerRequestEnvelopeHash: hash('request'),
        outputSchemaHash: hash('schema'),
        filePatchManifestHash: hash('patch'),
        contextManifestHash: hash('context'),
        lifecycleTargetSetHash: null,
        liveLifecycleStateHash: null,
        toolPolicyHash: hash('tool'),
        executionProfile: 'agentic_unbounded_v1' as const,
        baseTreeHash: null,
        environmentContractHash: hash('environment'),
      },
    };

    const manifest = await adapter.assemble(invocation);
    const manifestInput = JSON.parse(manifest.manifestCanonicalJson);
    const expectedManifestKey = hashBytes(
      canonicalizeProviderInvocationManifestV1(manifestInput)
    );
    const expectedInvocationKey = hashBytes(
      providerInvocationIdentityPreimageV1(
        expectedManifestKey,
        authorization.facts.providerVoteLanes[0].providerVoteIdentityHash
      )
    );

    expect(manifest.manifestKey).toBe(expectedManifestKey);
    expect(manifest.providerInvocationKey).toBe(expectedInvocationKey);
  });

  it('clears the pending renewal timer when execution finishes', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-23T11:00:00.000Z'));
    try {
      const supervisor = new CooperativeReviewLeaseSupervisor();

      await expect(
        supervisor.run({
          lease: leaseFixture,
          renew: jest.fn(),
          operation: async () => 'completed',
        })
      ).resolves.toBe('completed');

      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('aborts the operation immediately when lease renewal fails', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-23T11:00:00.000Z'));
    try {
      const supervisor = new CooperativeReviewLeaseSupervisor();
      const renewalError = new Error('lease_renewal_lost');
      let operationSignal: AbortSignal | undefined;
      const operation = jest.fn(
        (signal: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            operationSignal = signal;
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          })
      );
      const running = supervisor.run({
        lease: leaseFixture,
        renew: jest.fn().mockRejectedValue(renewalError),
        operation,
      });
      const rejected = expect(running).rejects.toBe(renewalError);

      await jest.advanceTimersByTimeAsync(30_000);

      await rejected;
      expect(operationSignal?.aborted).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not renew beyond the fixed ceiling and aborts at expiry', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-23T11:00:00.000Z'));
    try {
      const supervisor = new CooperativeReviewLeaseSupervisor();
      const renew = jest.fn();
      const running = supervisor.run({
        lease: {
          ...leaseFixture,
          expiresAt: '2026-07-23T11:00:01.000Z',
          renewalCeilingReached: true,
        },
        renew,
        operation: (signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
      });
      const rejected = expect(running).rejects.toThrow(
        'review_action_v2_lease_expired'
      );

      await jest.advanceTimersByTimeAsync(1_000);

      await rejected;
      expect(renew).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

const workSlot = Object.freeze({
  workSlotId: 'slot-1',
  taskKind: ReviewTaskKind.FindingDiscovery,
  providerKind: ReviewExecutionProviderKind.Codex,
  providerVoteIdentityHash: hash('vote'),
  shardKey: 'batch-1',
  required: true,
  attemptBudget: 1,
  retryPolicyVersion: 'retry-v1',
});

const assignment = Object.freeze({
  workSlot,
  reviewRevisionHash: hash('revision'),
  context: {
    number: 252,
    title: 'PR',
    body: '',
    author: 'author',
    draft: false,
    labels: [],
    files: [],
    diff: '',
    additions: 0,
    deletions: 0,
    baseSha: '1'.repeat(40),
    headSha: '3'.repeat(40),
  },
  lifecycleTargets: [],
  liveLifecycleStateHash: hash('lifecycle'),
});

const authorization: ReviewRunAuthorization = {
  authorizationId: 'authorization-1',
  authorizationToken: 'authorization.token',
  producerReleaseId: 'release-1',
  protocolLimitsProfileId: 'limits-1',
  operationalSloProfileId: 'slo-1',
  mutationEpoch: '1',
  expiresAt: '2026-07-24T00:00:00.000Z',
  limits: {
    maxWorkSlots: 10,
    maxAttemptsPerSlot: 3,
    maxObservationBytes: 100_000,
    maxObservationFindings: 100,
    maxProjectionBytes: 200_000,
    maxProjectionFindings: 100,
    maxPublicationOperations: 100,
    maxPublicationChunks: 20,
    maxPublicationBodyBytes: 200_000,
    maxRequestBatchSize: 20,
    maxLeaseDurationMs: 60_000,
    maxResultReportDurationMs: 60_000,
    maxReconciliationDurationMs: 60_000,
  },
  facts: {
    workspaceId: 'workspace-1',
    repositoryConnectionId: 'connection-1',
    scmRepositoryIdentityId: 'repository-1',
    pullRequestNumber: 252,
    sourceRunId: 'run-1',
    sourceRunAttempt: '1',
    baseSha: '1'.repeat(40),
    mergeBaseSha: '2'.repeat(40),
    headSha: '3'.repeat(40),
    reviewRevisionHash: hash('revision'),
    trustDomain: 'github-actions',
    producerReleaseId: 'release-1',
    selectedProtocolVersion: 'review-action-v2',
    schemaDigest: hash('schema-digest'),
    providerVoteLanes: [
      {
        providerKind: ReviewExecutionProviderKind.Codex,
        providerVoteIdentityHash: hash('vote'),
      },
    ],
  },
};

const leaseFixture = {
  leaseId: 'lease-1',
  attemptId: 'attempt-1',
  leaseCapability: 'lease.capability',
  fencingToken: '1',
  expiresAt: '2026-07-23T12:00:00.000Z',
  resultReportUntil: '2026-07-23T12:10:00.000Z',
  renewalCeilingReached: false,
};

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
