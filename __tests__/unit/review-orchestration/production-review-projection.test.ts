import { DEFAULT_CONFIG } from '../../../src/config/defaults';
import {
  ReviewExecutionProviderKind,
  ReviewTaskKind,
} from '../../../src/review-orchestration/application';
import {
  createReviewPromptCoverageManifest,
  ReviewPromptPathCoverageKind,
} from '../../../src/review-orchestration/domain';
import { createProductionReviewProjectionBuilder } from '../../../src/review-orchestration/infrastructure/production-review-projection';
import { CheckConclusion } from '../../../src/review-projection/domain';

describe('production review projection coverage', () => {
  it('publishes only neutral coverage output when an assigned path lacks full patch proof', async () => {
    const builder = createProductionReviewProjectionBuilder({
      authorizationFacts,
      pr,
      config: DEFAULT_CONFIG,
      protocolLimits,
      assignments: [
        {
          workSlotId: 'slot-1',
          taskKind: ReviewTaskKind.FindingDiscovery,
          required: true,
          filePaths: ['src/a.ts'],
        },
      ],
      uncoveredPaths: [],
      uncoveredLifecycleTargetIds: [],
      lifecycleInventory: {
        loadCurrent: jest.fn().mockResolvedValue({
          inventoryVersion: 'review_lifecycle_inventory.v1',
          loadedForHeadSha: pr.headSha,
          lifecycleStateHash: 'lifecycle-state-1',
          commandLedgerWatermark: 'ledger-1',
          complete: true,
          warnings: [],
          targets: [],
        }),
      },
    });
    const coverageManifest = createReviewPromptCoverageManifest({
      workSlotId: 'slot-1',
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
      assignedPaths: ['src/a.ts'],
      pathCoverage: [
        {
          path: 'src/a.ts',
          kind: ReviewPromptPathCoverageKind.SummaryOnly,
          contentHash: '9'.repeat(64),
        },
      ],
    });

    const projection = await builder.build({
      observations: [],
      exhaustedWorkSlotIds: [],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
      coverageManifests: [coverageManifest],
    });
    const envelope = JSON.parse(projection.projectionEnvelopeCanonicalJson);

    expect(projection.coverageComplete).toBe(false);
    expect(envelope.coverage.state).toBe('partial');
    expect(envelope.publishing.summary.allClear).toBe(false);
    expect(envelope.publishing.check.conclusion).toBe(CheckConclusion.Neutral);
    expect(envelope.publishing.inlineReviewChunks).toEqual([]);
    expect(envelope.publishing.lifecycle).toEqual([]);
    expect(envelope.snapshot).toEqual({
      lineageHints: [],
      occurrenceProvenance: [],
    });
  });

  it('does not make coverage partial for an exhausted optional vote lane', async () => {
    const builder = createProductionReviewProjectionBuilder({
      authorizationFacts,
      pr,
      config: DEFAULT_CONFIG,
      protocolLimits,
      assignments: [
        {
          workSlotId: 'required-slot',
          taskKind: ReviewTaskKind.FindingDiscovery,
          required: true,
          filePaths: ['src/a.ts'],
        },
        {
          workSlotId: 'optional-slot',
          taskKind: ReviewTaskKind.FindingDiscovery,
          required: false,
          filePaths: ['src/a.ts'],
        },
      ],
      uncoveredPaths: [],
      uncoveredLifecycleTargetIds: [],
      lifecycleInventory: completeLifecycleInventory(),
    });
    const requiredManifest = createReviewPromptCoverageManifest({
      workSlotId: 'required-slot',
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
      assignedPaths: ['src/a.ts'],
      pathCoverage: [
        {
          path: 'src/a.ts',
          kind: ReviewPromptPathCoverageKind.FullPatch,
          contentHash: '8'.repeat(64),
        },
      ],
    });

    const projection = await builder.build({
      observations: [],
      exhaustedWorkSlotIds: ['optional-slot'],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
      coverageManifests: [requiredManifest],
    });

    expect(projection.coverageComplete).toBe(true);
    expect(
      JSON.parse(projection.projectionEnvelopeCanonicalJson).coverage
    ).toMatchObject({ state: 'complete', limitations: [] });
  });

  it('still rejects an invalid optional coverage manifest', async () => {
    const builder = createProductionReviewProjectionBuilder({
      authorizationFacts,
      pr,
      config: DEFAULT_CONFIG,
      protocolLimits,
      assignments: [
        {
          workSlotId: 'optional-slot',
          taskKind: ReviewTaskKind.FindingDiscovery,
          required: false,
          filePaths: ['src/a.ts'],
        },
      ],
      uncoveredPaths: [],
      uncoveredLifecycleTargetIds: [],
      lifecycleInventory: completeLifecycleInventory(),
    });
    const optionalManifest = createReviewPromptCoverageManifest({
      workSlotId: 'optional-slot',
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
      assignedPaths: ['src/a.ts'],
      pathCoverage: [
        {
          path: 'src/a.ts',
          kind: ReviewPromptPathCoverageKind.SummaryOnly,
          contentHash: '7'.repeat(64),
        },
      ],
    });

    await expect(
      builder.build({
        observations: [],
        exhaustedWorkSlotIds: [],
        reviewRevisionHash: authorizationFacts.reviewRevisionHash,
        coverageManifests: [
          { ...optionalManifest, coverageHash: '0'.repeat(64) },
        ],
      })
    ).rejects.toThrow('review_projection_coverage_manifest_hash_invalid');
  });
});

function completeLifecycleInventory() {
  return {
    loadCurrent: jest.fn().mockResolvedValue({
      inventoryVersion: 'review_lifecycle_inventory.v1',
      loadedForHeadSha: pr.headSha,
      lifecycleStateHash: 'lifecycle-state-1',
      commandLedgerWatermark: 'ledger-1',
      complete: true,
      warnings: [],
      targets: [],
    }),
  };
}

const authorizationFacts = {
  workspaceId: 'workspace-1',
  repositoryConnectionId: 'connection-1',
  scmRepositoryIdentityId: 'repository-1',
  pullRequestNumber: 1,
  sourceRunId: 'run-1',
  sourceRunAttempt: '1',
  baseSha: '1'.repeat(40),
  mergeBaseSha: '2'.repeat(40),
  headSha: '3'.repeat(40),
  reviewRevisionHash: '4'.repeat(64),
  trustDomain: 'github-actions',
  producerReleaseId: 'release-1',
  selectedProtocolVersion: '2',
  schemaDigest: '5'.repeat(64),
  providerVoteLanes: [
    {
      providerKind: ReviewExecutionProviderKind.Codex,
      providerVoteIdentityHash: '6'.repeat(64),
    },
  ],
};

const pr = {
  number: 1,
  title: 'Partial coverage',
  body: '',
  author: 'reviewer',
  draft: false,
  labels: [],
  files: [
    {
      filename: 'src/a.ts',
      status: 'modified' as const,
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: '@@ -1 +1 @@\n+changed',
    },
  ],
  diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+changed',
  additions: 1,
  deletions: 0,
  baseSha: authorizationFacts.baseSha,
  headSha: authorizationFacts.headSha,
};

const protocolLimits = {
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
};
