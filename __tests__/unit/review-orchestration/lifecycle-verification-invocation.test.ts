import { GeneratedProviderInvocationManifestAssembler } from '../../../src/review-orchestration/infrastructure/codex-review-invocation-adapter';
import { DEFAULT_CONFIG } from '../../../src/config/defaults';
import type { ReviewRunAuthorization } from '../../../src/review-orchestration/application';
import { createHash } from 'crypto';
import {
  planFindingRevalidation,
  type RevalidationTarget,
} from '../../../src/finding-revalidation';
import {
  lifecycleVerificationContract as contract,
  lifecycleVerificationDescriptorDigest,
  type LifecycleVerificationCapabilityV1,
} from '../../../src/control-plane/generated/review-action-v2/companion-contracts';
import {
  ReviewExecutionProviderKind,
  ReviewTaskKind,
  type PreparedReviewInvocationPort,
} from '../../../src/review-orchestration/application';
import { createStableReviewWorkPlan } from '../../../src/review-orchestration/domain';
import {
  appendLifecycleWorkPlan,
  compositeLifecycleInvocations,
  lifecycleHash,
  readLifecycleCapability,
} from '../../../src/review-orchestration/infrastructure/lifecycle-verification-invocation';
import type { LocalGatewayModelTransport } from '../../../src/review-orchestration/infrastructure/account-gateway-model-transport';
import { priorResolutionFact } from '../../../src/review-orchestration/infrastructure/lifecycle-verification-planning';

const hash = 'a'.repeat(64);
const capability: LifecycleVerificationCapabilityV1 = {
  extensionId: contract.extensionId,
  descriptorDigest: lifecycleVerificationDescriptorDigest,
  executor: contract.executor,
  modelTransport: 'account_gateway',
  providerIndex: 0,
  providerKind: 'ocr',
  model: 'saved-model',
  maxDispatches: 2,
  maxPromptBytes: contract.maxPromptBytes,
  maxResponseBytes: contract.maxResponseBytes,
  maxOutputTokens: 4096,
  deadlineMs: 60000,
  attemptBudget: 1,
};
const target: RevalidationTarget = {
  targetId: 'target-1',
  threadId: 'thread-1',
  fingerprint: 'b'.repeat(32),
  parentId: 'parent-1',
  parentCreatedAt: '2026-10-25T00:00:00.000Z',
  parentUpdatedAt: '2026-10-25T00:00:00.000Z',
  parentBodyHash: hash,
  claimHash: hash,
  commentStateHash: hash,
  ledgerWatermark: '0',
  originalPath: 'src/tax.ts',
  currentPath: 'src/tax.ts',
  originalLine: 1,
  currentLine: 1,
  severity: 'major',
  title: 'Negative tax',
  message: 'Negative input must not create negative tax',
  diffHunk: null,
  isResolved: false,
  trusted: true,
  hasHumanReply: false,
  parentEdited: false,
  markerAmbiguous: false,
  commandDismissed: false,
};
const basePlan = (paths = ['src/tax.ts']) =>
  createStableReviewWorkPlan({
    reviewRevisionHash: hash,
    compatibilityKey: hash,
    providers: [
      {
        providerName: 'ocr/managed',
        providerKind: ReviewExecutionProviderKind.Ocr,
        providerVoteIdentityHash: hash,
        required: true,
        attemptBudget: 3,
        retryPolicyVersion: 'discovery-v1',
      },
    ],
    batches: [
      {
        batchId: 'discovery',
        taskKind: ReviewTaskKind.FindingDiscovery,
        required: true,
        paths,
        schedulingOrdinal: 0,
      },
      {
        batchId: 'description',
        taskKind: ReviewTaskKind.PrDescription,
        required: false,
        paths: [],
        schedulingOrdinal: 1,
      },
    ],
    eligiblePaths: paths,
    uncoveredPaths: [],
    excludedPaths: [],
    maxWorkSlots: 4,
    maxAttemptsPerSlot: 3,
  });
async function plan(targets = [target], history?: readonly unknown[]) {
  return planFindingRevalidation(
    {
      scope: {
        workspaceId: 'workspace',
        repositoryConnectionId: 'connection',
        repository: 'owner/repo',
        pullRequestNumber: 1,
        baseSha: 'b'.repeat(40),
        mergeBaseSha: 'c'.repeat(40),
        headSha: 'd'.repeat(40),
        reviewRevisionHash: hash,
      },
      participant: {
        voteIdentityHash: hash,
        capabilityDigest: lifecycleHash(capability),
        model: 'saved-model',
      },
      inventoryComplete: true,
      targets,
      limits: {
        gatewayOutputTokens: 4096,
        modelOutputTokens: 4096,
        remainingWorkSlots: 2,
      },
      policyDigest: hash,
    },
    {
      sourceReader: {
        read: async ({ headSha, path }) => ({
          kind: 'file',
          headSha,
          path,
          blobOid: 'e'.repeat(40),
          bytes: Buffer.from('return Math.max(0, amount) * 0.2;'),
        }),
      },
      priorResolutionHistory: {
        read: async (candidate) =>
          history
            ? priorResolutionFact(candidate, history)
            : {
                historyCut: '2026-10-24T00:00:00.000Z',
                guardVersion: '1',
                state: 'no_prior_since_creation',
              },
      },
      isPathAllowed: () => true,
    }
  );
}
async function composed(targets = [target], paths?: string[]) {
  return appendLifecycleWorkPlan({
    plan: basePlan(paths),
    revalidation: await plan(targets),
    capability,
    reviewRevisionHash: hash,
    compatibilityKey: hash,
    maxWorkSlots: 4,
    maxAttemptsPerSlot: 3,
    policyDigest: hash,
    liveLifecycleStateHash: hash,
  });
}
const discovery = {
  prepare: jest.fn(),
  execute: jest.fn(),
} as unknown as PreparedReviewInvocationPort;

test('captured capability is explicit, route/model bound, and output bounded', () => {
  expect(
    readLifecycleCapability(
      undefined,
      'saved-model',
      ReviewExecutionProviderKind.Ocr
    )
  ).toBeUndefined();
  expect(
    readLifecycleCapability(
      JSON.stringify(capability),
      'other',
      ReviewExecutionProviderKind.Ocr
    )
  ).toBeUndefined();
  expect(
    readLifecycleCapability(
      JSON.stringify({ ...capability, maxOutputTokens: 4097 }),
      'saved-model',
      ReviewExecutionProviderKind.Ocr
    )
  ).toBeUndefined();
  expect(
    readLifecycleCapability(
      JSON.stringify(capability),
      'saved-model',
      ReviewExecutionProviderKind.Ocr
    )
  ).toEqual(capability);
});

test('keeps discovery identity/budget and schedules optional parent lifecycle before description', async () => {
  const result = await composed();
  expect(
    result.plan.assignments.map((value) => value.workSlot.taskKind)
  ).toEqual(['finding_discovery', 'lifecycle_revalidation', 'pr_description']);
  expect(result.plan.assignments[0].workSlot).toEqual(
    basePlan().assignments[0].workSlot
  );
  expect(result.plan.assignments[1].workSlot).toMatchObject({
    required: false,
    attemptBudget: 1,
    providerVoteIdentityHash: hash,
  });
  const metadata = JSON.parse(result.plan.assignmentManifestCanonicalJson);
  expect(metadata.manifestVersion).toBe(2);
  expect(metadata.lifecyclePlan.targets[0]).not.toHaveProperty('message');
  expect(result.plan.assignmentManifestHash).toBe(
    createHash('sha256')
      .update(
        `rr.review-assignment-manifest.v2\0${result.plan.assignmentManifestCanonicalJson}`
      )
      .digest('hex')
  );
});

test('zero eligible targets creates no lifecycle slots or model calls', async () => {
  const result = await composed([]);
  expect(result.packetsByWorkSlotId.size).toBe(0);
  expect(
    result.plan.assignments.map((value) => value.workSlot.taskKind)
  ).toEqual(['finding_discovery', 'pr_description']);
  expect(
    JSON.parse(result.plan.assignmentManifestCanonicalJson).lifecyclePlan
      .inventoryCount
  ).toBe(0);
});

test('validates packet citations before normalized zero-finding evidence and sends lease context only to transport', async () => {
  const result = await composed();
  const slot = result.plan.assignments[1].workSlot;
  const packet = result.packetsByWorkSlotId.get(slot.workSlotId)!;
  const generate = jest.fn(
    async ({ requestBody }: { requestBody: Uint8Array }) => ({
      body: Buffer.from(
        JSON.stringify({
          version: 1,
          packetHash: packet.packetHash,
          results: [
            {
              targetId: target.targetId,
              fingerprint: target.fingerprint,
              verdict: 'resolved',
              confidence: 0.99,
              scopeSufficient: true,
              failureCondition:
                'Negative input previously produced negative tax',
              fixExplanation: 'The zero floor clamps the taxable base',
              evidence: [
                {
                  path: 'src/tax.ts',
                  blobOid: 'e'.repeat(40),
                  startLine: 1,
                  endLine: 1,
                  quote: 'Math.max(0, amount)',
                  reason: 'Clamps negative input',
                },
              ],
            },
          ],
        })
      ),
      actualModel: 'saved-model',
      providerRequestEnvelopeHash: createHash('sha256')
        .update(requestBody)
        .digest('hex'),
    })
  );
  const invocations = compositeLifecycleInvocations({
    discovery,
    packetsByWorkSlotId: result.packetsByWorkSlotId,
    capability,
    outputCap: 4096,
    reviewRevisionHash: hash,
    liveLifecycleStateHash: hash,
    transport: {
      generateLifecycleVerification: generate,
    } as unknown as LocalGatewayModelTransport,
  });
  const invocation = await invocations.prepare({
    workSlot: slot,
    attemptOrdinal: 1,
  });
  const assembled = await new GeneratedProviderInvocationManifestAssembler(
    {
      facts: {
        pullRequestNumber: 1,
        workspaceId: 'workspace',
        repositoryConnectionId: 'connection',
        scmRepositoryIdentityId: 'repository',
        producerReleaseId: 'release',
        selectedProtocolVersion: 'review-action-v2',
        providerVoteLanes: [
          {
            providerKind: ReviewExecutionProviderKind.Ocr,
            providerVoteIdentityHash: hash,
          },
        ],
      },
    } as unknown as ReviewRunAuthorization,
    DEFAULT_CONFIG,
    hash
  ).assemble(invocation);
  expect(JSON.parse(assembled.manifestCanonicalJson)).toMatchObject({
    taskKindSet: ['lifecycle_revalidation'],
    providerKind: 'ocr',
    providerPolicyVersion: contract.policyVersion,
    providerCapabilityHash: lifecycleHash(capability),
    contextManifestHash: packet.packetHash,
  });
  const observation = await invocations.execute({
    invocation,
    manifest: {
      manifestCanonicalJson: '{}',
      manifestKey: hash,
      providerInvocationKey: hash,
      providerVoteIdentityHash: hash,
    },
    lease: {
      leaseId: 'lease',
      attemptId: 'attempt',
      leaseCapability: 'secret-parent-lease',
      fencingToken: '1',
      expiresAt: '2026-10-26T00:00:00.000Z',
      resultReportUntil: '2026-10-26T00:00:00.000Z',
      renewalCeilingReached: false,
    },
    sourceExecutionId: 'execution',
    sourceReviewRevisionHash: hash,
    signal: new AbortController().signal,
  });
  expect(observation.findingCount).toBe(0);
  expect(
    JSON.parse(observation.payloadCanonicalJson)
      .normalizedLifecycleRevalidations[0].verdict
  ).toBe('resolved');
  expect(generate).toHaveBeenCalledTimes(1);
  expect(generate.mock.calls[0][0]).toMatchObject({
    dispatch: {
      executionId: 'execution',
      workSlotId: slot.workSlotId,
      leaseCapability: 'secret-parent-lease',
      preparedManifestKey: hash,
    },
  });
  expect(
    Buffer.from(invocation.immutableRequest as Uint8Array).toString()
  ).not.toContain('secret-parent-lease');
  generate.mockResolvedValueOnce({
    body: Buffer.from('{"version":1,"packetHash":"wrong","results":[]}'),
    actualModel: 'saved-model',
    providerRequestEnvelopeHash:
      invocation.manifestFacts.providerRequestEnvelopeHash,
  });
  await expect(
    invocations.execute({
      invocation,
      manifest: {
        manifestCanonicalJson: '{}',
        manifestKey: hash,
        providerInvocationKey: hash,
        providerVoteIdentityHash: hash,
      },
      lease: {
        leaseId: 'lease',
        attemptId: 'attempt',
        leaseCapability: 'secret',
        fencingToken: '1',
        expiresAt: '',
        resultReportUntil: '',
        renewalCeilingReached: false,
      },
      sourceExecutionId: 'execution',
      sourceReviewRevisionHash: hash,
      signal: new AbortController().signal,
    })
  ).rejects.toThrow('response_invalid');
});

test('near manifest limit disables companion without displacing discovery', async () => {
  const paths = Array.from(
    { length: 259 },
    (_, i) => `src/${String(i).padStart(4, '0')}${'a'.repeat(1000)}`
  );
  const original = basePlan(paths);
  const result = await composed([target], paths);
  expect(result.plan.assignmentManifestHash).toBe(
    original.assignmentManifestHash
  );
  expect(result.packetsByWorkSlotId.size).toBe(0);
});

test('unknown/unqualified history fails closed, retained confirmed and pending facts veto unresolved inference', () => {
  expect(priorResolutionFact(target, []).state).toBe('unavailable');
  const bound = {
    targetId: target.targetId,
    threadId: target.threadId,
    parentCommentId: target.parentId,
    parentCreatedAt: target.parentCreatedAt,
    parentBodyHash: target.parentBodyHash,
    history: {
      threadId: target.threadId,
      version: 1,
      historyCut: {
        activatedAt: '2026-10-24T00:00:00.000Z',
        activationVersion: 1,
        writerDigest: hash,
      },
      confirmed: null,
      pending: [],
    },
  };
  expect(priorResolutionFact(target, [bound]).state).toBe(
    'no_prior_since_creation'
  );
  expect(
    priorResolutionFact(target, [
      {
        ...bound,
        history: { ...bound.history, confirmed: { effectId: 'effect' } },
      },
    ]).state
  ).toBe('previously_resolved');
  expect(
    priorResolutionFact(target, [
      {
        ...bound,
        history: { ...bound.history, pending: [{ state: 'effect_unknown' }] },
      },
    ]).state
  ).toBe('effect_unknown');
});

test('retirement bootstrap quarantines native pre-cut and exact-cut parents, including late-visible targets', async () => {
  const cut = '2026-10-25T00:00:00.000Z';
  const bootstrap = {
    qualificationSource: 'retired_legacy_writers_quarantine.v1',
    executorSetHash: hash,
    proofHash: hash,
    retiredAt: '2026-10-24T23:59:59.000Z',
    activationCut: cut,
  };
  const bound = (candidate: RevalidationTarget, includeBootstrap = true) => ({
    targetId: candidate.targetId,
    threadId: candidate.threadId,
    parentCommentId: candidate.parentId,
    parentCreatedAt: candidate.parentCreatedAt,
    parentBodyHash: candidate.parentBodyHash,
    history: {
      threadId: candidate.threadId,
      version: 1,
      historyCut: {
        activatedAt: cut,
        activationVersion: 1,
        writerDigest: hash,
        ...(includeBootstrap ? { bootstrap } : {}),
      },
      confirmed: null,
      pending: [],
    },
  });
  for (const parentCreatedAt of ['2026-10-24T23:59:59.999Z', cut]) {
    const old = { ...target, parentCreatedAt };
    const facts = [bound(old)];
    expect(priorResolutionFact(old, facts).state).toBe('effect_unknown');
    const result = await plan([old], facts);
    expect(result.packets).toHaveLength(0);
    expect(result.dispositions[0].reason).toBe('resolution_effect_unknown');
  }
  const fresh = { ...target, parentCreatedAt: '2026-10-25T00:00:00.001Z' };
  expect(priorResolutionFact(fresh, [bound(fresh)]).state).toBe(
    'no_prior_since_creation'
  );
  expect((await plan([fresh], [bound(fresh)])).packets).toHaveLength(1);
  const old = { ...target, parentCreatedAt: '2026-10-24T23:59:59.999Z' };
  expect(priorResolutionFact(old, [bound(old, false)]).state).toBe(
    'before_cut_unobserved'
  );
  const malformed = bound(fresh);
  malformed.history.historyCut.bootstrap = {
    ...bootstrap,
    proofHash: 'invalid',
  };
  expect(priorResolutionFact(fresh, [malformed]).state).toBe('unavailable');
});
