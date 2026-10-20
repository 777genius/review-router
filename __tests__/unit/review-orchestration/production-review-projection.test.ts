import { DEFAULT_CONFIG } from '../../../src/config/defaults';
import { acceptOcrManagedReviewResult } from '../../../src/review-orchestration/infrastructure/ocr-review-managed-run';
import type { OcrNativeComment } from '../../../src/review-orchestration/infrastructure/ocr-review-outcome-contract';
import { normalizeReviewObservation } from '../../../src/review-orchestration/infrastructure/review-observation-normalizer';
import { mapLinesToPositions } from '../../../src/utils/diff';
import {
  ReviewExecutionProviderKind,
  ReviewTaskKind,
} from '../../../src/review-orchestration/application';
import {
  createReviewPromptCoverageManifest,
  ReviewPromptPathCoverageKind,
} from '../../../src/review-orchestration/domain';
import { createProductionReviewProjectionBuilder } from '../../../src/review-orchestration/infrastructure/production-review-projection';
import {
  CheckConclusion,
  FindingSeverity,
  LifecycleTargetDisposition,
} from '../../../src/review-projection/domain';

describe('production review projection coverage', () => {
  it.each([
    LifecycleTargetDisposition.Active,
    LifecycleTargetDisposition.HumanReply,
  ])(
    'retains off-diff %s history visibly without failing complete current coverage',
    async (disposition) => {
      const target = {
        targetId: 'old-caller',
        threadId: 'thread-old',
        trustedMarker: 'a'.repeat(24),
        title: 'Old caller lifecycle finding',
        message: 'The obsolete caller used the wrong runtime.',
        severity: FindingSeverity.Major,
        originalPath: '.github/workflows/reviewrouter-codex.yml',
        parentCommentUpdatedAt: '2026-07-22T00:00:00Z',
        threadCommentCount: 1,
        threadStateHash: 'a'.repeat(64),
        disposition,
        viewerCanResolve: true,
      };
      const inventory = completeLifecycleInventory();
      const load = jest
        .spyOn(inventory, 'loadCurrent')
        .mockImplementation(async () => ({
          inventoryVersion: 'review_lifecycle_inventory.v1',
          loadedForHeadSha: authorizationFacts.headSha,
          lifecycleStateHash: 'state',
          commandLedgerWatermark: 'ledger',
          complete: true,
          warnings: [],
          targets: [target],
        }));
      const builder = createProductionReviewProjectionBuilder({
        authorizationFacts,
        pr,
        config: DEFAULT_CONFIG,
        protocolLimits,
        assignments: [assignment('required-slot', true)],
        uncoveredPaths: [],
        uncoveredLifecycleTargetIds: [],
        lifecycleInventory: inventory,
      });
      const result = await builder.build({
        acceptedEvidence: [
          acceptedEvidence(
            'required-slot',
            fullCoverageManifest('required-slot')
          ),
        ],
        exhaustedWorkSlotIds: [],
        reviewRevisionHash: authorizationFacts.reviewRevisionHash,
      });
      const envelope = JSON.parse(result.projectionEnvelopeCanonicalJson);
      expect(load).toHaveBeenCalledTimes(1);
      expect(envelope.coverage.state).toBe('complete');
      expect(envelope.occurrences).toEqual([]);
      expect(envelope.publishing.summary.allClear).toBe(false);
      expect(envelope.publishing.summary.body).toContain(target.title);
      expect(envelope.publishing.summary.body).toContain(target.originalPath);
      expect(envelope.publishing.summary.body).toContain(
        disposition === LifecycleTargetDisposition.HumanReply
          ? 'human discussion'
          : 'outside review scope'
      );
      expect(envelope.publishing.summary.body).not.toMatch(/all clear/i);
      expect(envelope.publishing.lifecycle).toEqual([
        expect.objectContaining({
          targetId: target.targetId,
          verdict: 'uncertain',
          mutationEligible: false,
          reasonCodes: expect.arrayContaining(['outside_review_scope']),
        }),
      ]);
    }
  );

  it('marks OCR verified spans and never re-anchors them through projection', async () => {
    // §8.2: an OCR verified HEAD span keeps its exact range in the final
    // placement. The colliding patch makes the legacy heuristic prefer the
    // added line 2 (see the Codex control below).
    const ocrFacts = {
      ...authorizationFacts,
      providerVoteLanes: [
        {
          providerKind: ReviewExecutionProviderKind.Ocr,
          providerVoteIdentityHash: '6'.repeat(64),
        },
      ],
    };
    const builder = createProductionReviewProjectionBuilder({
      authorizationFacts: ocrFacts,
      pr: collidingPr(),
      config: DEFAULT_CONFIG,
      protocolLimits,
      assignments: [
        {
          workSlotId: 'ocr-slot',
          taskKind: ReviewTaskKind.FindingDiscovery,
          providerKind: ReviewExecutionProviderKind.Ocr,
          required: true,
          filePaths: ['src/a.ts'],
        },
      ],
      uncoveredPaths: [],
      uncoveredLifecycleTargetIds: [],
      lifecycleInventory: completeLifecycleInventory(),
    });
    const result = await builder.build({
      acceptedEvidence: [
        spanEvidence(
          'ocr-slot',
          ReviewExecutionProviderKind.Ocr,
          ocrFacts.providerVoteLanes[0].providerVoteIdentityHash
        ),
      ],
      exhaustedWorkSlotIds: [],
      reviewRevisionHash: ocrFacts.reviewRevisionHash,
    });
    const envelope = JSON.parse(result.projectionEnvelopeCanonicalJson);
    expect(envelope.occurrences).toHaveLength(1);
    expect(envelope.occurrences[0].anchorVerified).toBe(true);
    expect(envelope.occurrences[0].placement).toMatchObject({
      kind: 'inline',
      path: 'src/a.ts',
      line: 1,
      endLine: 1,
    });
  });

  it('drops committable suggestions when dedup expands separately verified OCR spans', async () => {
    const envelope = await projectNativeOcrComments([
      nativeOcrComment({
        existingCode: 'unsafe_a();',
        endLine: 1,
        suggestionCode: 'safe_a();',
      }),
      nativeOcrComment({
        existingCode: 'unsafe_b();',
        startLine: 2,
        suggestionCode: 'safe_b();',
      }),
    ]);

    expect(envelope.occurrences).toHaveLength(1);
    expect(envelope.occurrences[0].placement.kind).toBe('file');
    expect(envelope.occurrences[0].suggestion).toBeUndefined();
    expect(envelope.publishing.inlineReviewChunks).toEqual([]);
    expect(envelope.publishing.summary.body).toContain(
      'Unsafe user data corrupts stored record'
    );
  });

  it.each([
    { existingCode: null },
    { existingCode: 'old_a();' },
    { startLine: 2, endLine: 1 },
  ])(
    'keeps unverified OCR findings in file placement: %j',
    async (unverified) => {
      const envelope = await projectNativeOcrComments([
        nativeOcrComment(unverified),
      ]);

      expect(envelope.occurrences).toHaveLength(1);
      expect(envelope.occurrences[0].line).toBeUndefined();
      expect(envelope.occurrences[0].placement.kind).toBe('file');
      expect(envelope.occurrences[0].suggestion).toBeUndefined();
      expect(envelope.publishing.inlineReviewChunks).toEqual([]);
      expect(envelope.publishing.summary.body).toContain(
        'Unsafe user data corrupts stored record'
      );
      expect(envelope.publishing.summary.body).not.toContain('src/a.ts:1');
    }
  );

  it('preserves an unanchored finding when the first added line is a comment', async () => {
    const envelope = await projectNativeOcrComments(
      [nativeOcrComment({ existingCode: null })],
      '// New file header\nunsafe_b();'
    );

    expect(envelope.occurrences).toHaveLength(1);
    expect(envelope.occurrences[0].placement.kind).toBe('file');
    expect(envelope.publishing.inlineReviewChunks).toEqual([]);
    expect(envelope.publishing.summary.body).not.toContain('src/a.ts:1');
  });

  it.each([
    {
      comment: nativeOcrComment(),
      expected: { startLine: 1, line: 2, endLine: 2 },
    },
    {
      comment: nativeOcrComment({
        existingCode: 'unsafe_a();',
        endLine: 1,
        suggestionCode: 'safe_a();',
      }),
      expected: { line: 1, endLine: 1 },
    },
  ])(
    'emits the verified OCR range in publication coordinates: $expected',
    async ({ comment, expected }) => {
      const envelope = await projectNativeOcrComments([comment]);
      const [published] = envelope.publishing.inlineReviewChunks.flatMap(
        (chunk: { comments: Record<string, unknown>[] }) => chunk.comments
      );

      expect(published).toMatchObject({ path: 'src/a.ts', ...expected });
      if (!('startLine' in expected))
        expect(published.startLine).toBeUndefined();
      expect(envelope.occurrences[0].anchorVerified).toBe(true);
      expect(envelope.occurrences[0].suggestion).toBe(comment.suggestionCode);
    }
  );

  it('skips OCR comments outside assigned inventory without creating a blocking finding', async () => {
    const envelope = await projectNativeOcrComments([
      nativeOcrComment({
        path: 'src/outside.ts',
        existingCode: 'outside_unsafe();',
        startLine: 0,
        endLine: 0,
      }),
    ]);

    expect(envelope.occurrences).toEqual([]);
    expect(envelope.coverage.state).toBe('partial');
    expect(envelope.mergeGate.blockingLineageIds).toEqual([]);
    expect(envelope.publishing.inlineReviewChunks).toEqual([]);
  });

  it('keeps the legacy heuristic for non-verified Codex spans', async () => {
    // Control: without the OCR verified marker the same span is re-anchored
    // to the competing added line exactly as before (byte-identical legacy).
    const builder = createProductionReviewProjectionBuilder({
      authorizationFacts,
      pr: collidingPr(),
      config: DEFAULT_CONFIG,
      protocolLimits,
      assignments: [assignment('codex-slot', true)],
      uncoveredPaths: [],
      uncoveredLifecycleTargetIds: [],
      lifecycleInventory: completeLifecycleInventory(),
    });
    const result = await builder.build({
      acceptedEvidence: [
        spanEvidence(
          'codex-slot',
          ReviewExecutionProviderKind.Codex,
          authorizationFacts.providerVoteLanes[0].providerVoteIdentityHash
        ),
      ],
      exhaustedWorkSlotIds: [],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });
    const envelope = JSON.parse(result.projectionEnvelopeCanonicalJson);
    expect(envelope.occurrences).toHaveLength(1);
    expect(envelope.occurrences[0].anchorVerified).toBeUndefined();
    expect(envelope.occurrences[0].placement).toMatchObject({
      kind: 'inline',
      path: 'src/a.ts',
      line: 2,
    });
  });

  it('still rejects required lifecycle coverage omitted by the current-diff plan', async () => {
    const builder = createProductionReviewProjectionBuilder({
      authorizationFacts,
      pr,
      config: DEFAULT_CONFIG,
      protocolLimits,
      assignments: [assignment('required-slot', true)],
      uncoveredPaths: [],
      uncoveredLifecycleTargetIds: ['current-diff-target'],
      lifecycleInventory: completeLifecycleInventory(),
    });
    const result = await builder.build({
      acceptedEvidence: [
        acceptedEvidence(
          'required-slot',
          fullCoverageManifest('required-slot')
        ),
      ],
      exhaustedWorkSlotIds: [],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });
    const envelope = JSON.parse(result.projectionEnvelopeCanonicalJson);
    expect(envelope.coverage.state).toBe('partial');
    expect(envelope.coverage.limitations).toContain(
      'lifecycle_target_uncovered:current-diff-target'
    );
    expect(envelope.publishing.summary.allClear).toBe(false);
    expect(envelope.publishing.inlineReviewChunks).toEqual([]);
  });

  it('reports one successful required provider slot as 1/1', async () => {
    const builder = projectionBuilder([assignment('required-slot', true)]);
    const manifest = fullCoverageManifest('required-slot');

    const projection = await builder.build({
      acceptedEvidence: [acceptedEvidence('required-slot', manifest)],
      exhaustedWorkSlotIds: [],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });
    const envelope = JSON.parse(projection.projectionEnvelopeCanonicalJson);
    const summary = envelope.publishing.summary.body;

    expect(envelope.projectionPolicyVersion).toBe(
      'review-projection-policy.v5-t0'
    );
    expect(envelope.authoritativeObservationIds).toEqual([
      'observation-required-slot',
    ]);
    expect(summary).toContain('## No findings');
    expect(summary).not.toContain('failed');
  });

  it('records every accepted clean observation in deterministic authoritative lineage', async () => {
    const builder = projectionBuilder([
      assignment('z-required-slot', true),
      assignment('a-optional-slot', false),
    ]);

    const projection = await builder.build({
      acceptedEvidence: [
        acceptedEvidence(
          'z-required-slot',
          fullCoverageManifest('z-required-slot'),
          ['investigation_verified_clean']
        ),
        acceptedEvidence(
          'a-optional-slot',
          fullCoverageManifest('a-optional-slot'),
          ['investigation_verified_clean']
        ),
      ],
      exhaustedWorkSlotIds: [],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });
    const envelope = JSON.parse(projection.projectionEnvelopeCanonicalJson);

    expect(envelope.authoritativeObservationIds).toEqual([
      'observation-a-optional-slot',
      'observation-z-required-slot',
    ]);
    expect(envelope.occurrences).toEqual([]);
    expect(envelope.publishing.summary.allClear).toBe(true);
  });

  it('reports an exhausted required provider slot as 0/1', async () => {
    const builder = projectionBuilder([assignment('required-slot', true)]);

    const projection = await builder.build({
      acceptedEvidence: [],
      exhaustedWorkSlotIds: ['required-slot'],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });
    const envelope = JSON.parse(projection.projectionEnvelopeCanonicalJson);

    expect(envelope.coverage.state).toBe('partial');
    expect(envelope.publishing.summary.body).toContain(
      '1 of 1 review providers failed.'
    );
  });

  it('counts one provider across batches and fails it when one required batch is exhausted', async () => {
    const builder = projectionBuilder([
      assignment('required-slot-1', true),
      assignment('required-slot-2', true),
    ]);

    const projection = await builder.build({
      acceptedEvidence: [
        acceptedEvidence(
          'required-slot-1',
          fullCoverageManifest('required-slot-1')
        ),
      ],
      exhaustedWorkSlotIds: ['required-slot-2'],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });
    const summary = JSON.parse(projection.projectionEnvelopeCanonicalJson)
      .publishing.summary.body;

    expect(summary).toContain('1 of 1 review providers failed.');
    expect(summary).not.toContain('2 of');
  });

  it('reports 0/0 only when no required provider slots were planned', async () => {
    const builder = projectionBuilder([]);

    const projection = await builder.build({
      acceptedEvidence: [],
      exhaustedWorkSlotIds: [],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });
    const summary = JSON.parse(projection.projectionEnvelopeCanonicalJson)
      .publishing.summary.body;
    const envelope = JSON.parse(projection.projectionEnvelopeCanonicalJson);

    expect(summary).toContain('## No reportable findings in reviewed files');
    expect(summary).toContain('<!-- reviewrouter:review-status:complete -->');
    expect(summary).toContain('| Providers | 0/0 |');
    expect(envelope.coverage).toMatchObject({
      state: 'complete',
      reviewedFiles: 0,
      unreviewedFiles: 1,
    });
    expect(envelope.authoritativeObservationIds).toEqual([]);
  });

  it('makes required-slot coverage partial when context inspection is incomplete', async () => {
    const builder = projectionBuilder([assignment('required-slot', true)]);
    const manifest = fullCoverageManifest('required-slot');

    const projection = await builder.build({
      acceptedEvidence: [
        acceptedEvidence('required-slot', manifest, [
          'context_inspection_incomplete',
        ]),
      ],
      exhaustedWorkSlotIds: [],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });
    const envelope = JSON.parse(projection.projectionEnvelopeCanonicalJson);

    expect(envelope.coverage).toMatchObject({
      state: 'partial',
      limitations: ['work_slot_context_inspection_incomplete:required-slot'],
    });
    expect(envelope.publishing.summary.allClear).toBe(false);
    expect(envelope.publishing.check.conclusion).toBe(CheckConclusion.Neutral);
  });

  it('publishes investigation findings as partial when the investigation is inconclusive', async () => {
    const builder = projectionBuilder([assignment('required-slot', true)]);
    const manifest = fullCoverageManifest('required-slot');

    const projection = await builder.build({
      acceptedEvidence: [
        acceptedEvidence('required-slot', manifest, [
          'investigation_findings',
          'investigation_inconclusive',
        ]),
      ],
      exhaustedWorkSlotIds: [],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });
    const envelope = JSON.parse(projection.projectionEnvelopeCanonicalJson);

    expect(envelope.coverage).toMatchObject({
      state: 'partial',
      limitations: ['work_slot_investigation_inconclusive:required-slot'],
    });
    expect(envelope.publishing.summary.allClear).toBe(false);
    expect(envelope.publishing.check.conclusion).toBe(CheckConclusion.Neutral);
  });

  it('keeps current-head coverage complete for non-blocking quality flags', async () => {
    const builder = projectionBuilder([assignment('required-slot', true)]);
    const manifest = fullCoverageManifest('required-slot');

    const projection = await builder.build({
      acceptedEvidence: [
        acceptedEvidence('required-slot', manifest, [
          'provider_warning',
          'cross_revision_reuse_disabled',
        ]),
      ],
      exhaustedWorkSlotIds: [],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });

    expect(projection.coverageComplete).toBe(true);
    expect(
      JSON.parse(projection.projectionEnvelopeCanonicalJson).coverage
    ).toMatchObject({ state: 'complete', limitations: [] });
  });

  it('keeps coverage complete for paths explicitly excluded by review policy', async () => {
    const builder = projectionBuilder([assignment('required-slot', true)]);
    const manifest = createReviewPromptCoverageManifest({
      workSlotId: 'required-slot',
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
      assignedPaths: ['src/a.ts'],
      pathCoverage: [
        {
          path: 'src/a.ts',
          kind: ReviewPromptPathCoverageKind.PolicyExcluded,
          contentHash: null,
        },
      ],
    });

    const projection = await builder.build({
      acceptedEvidence: [acceptedEvidence('required-slot', manifest)],
      exhaustedWorkSlotIds: [],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });
    const envelope = JSON.parse(projection.projectionEnvelopeCanonicalJson);

    expect(projection.coverageComplete).toBe(true);
    expect(envelope.coverage).toMatchObject({
      state: 'complete',
      totalFiles: 1,
      reviewedFiles: 0,
      unreviewedFiles: 0,
      limitations: [],
    });
  });

  it('does not downgrade required coverage for incomplete optional evidence', async () => {
    const builder = projectionBuilder([
      assignment('required-slot', true),
      assignment('optional-slot', false),
    ]);

    const projection = await builder.build({
      acceptedEvidence: [
        acceptedEvidence(
          'required-slot',
          fullCoverageManifest('required-slot')
        ),
        acceptedEvidence(
          'optional-slot',
          fullCoverageManifest('optional-slot'),
          ['context_inspection_incomplete']
        ),
      ],
      exhaustedWorkSlotIds: [],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
    });
    const envelope = JSON.parse(projection.projectionEnvelopeCanonicalJson);

    expect(envelope.coverage).toMatchObject({
      state: 'complete',
      limitations: [],
    });
    expect(envelope.publishing.summary.body).toContain('## No findings');
  });

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
          providerKind: ReviewExecutionProviderKind.Codex,
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
      acceptedEvidence: [acceptedEvidence('slot-1', coverageManifest)],
      exhaustedWorkSlotIds: [],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
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
          providerKind: ReviewExecutionProviderKind.Codex,
          required: true,
          filePaths: ['src/a.ts'],
        },
        {
          workSlotId: 'optional-slot',
          taskKind: ReviewTaskKind.FindingDiscovery,
          providerKind: ReviewExecutionProviderKind.Codex,
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
      acceptedEvidence: [acceptedEvidence('required-slot', requiredManifest)],
      exhaustedWorkSlotIds: ['optional-slot'],
      reviewRevisionHash: authorizationFacts.reviewRevisionHash,
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
          providerKind: ReviewExecutionProviderKind.Codex,
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
        acceptedEvidence: [
          acceptedEvidence('optional-slot', {
            ...optionalManifest,
            coverageHash: '0'.repeat(64),
          }),
        ],
        exhaustedWorkSlotIds: [],
        reviewRevisionHash: authorizationFacts.reviewRevisionHash,
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

function projectionBuilder(
  assignments: Array<{
    workSlotId: string;
    taskKind: ReviewTaskKind;
    providerKind: ReviewExecutionProviderKind;
    required: boolean;
    filePaths: string[];
  }>
) {
  return createProductionReviewProjectionBuilder({
    authorizationFacts,
    pr,
    config: DEFAULT_CONFIG,
    protocolLimits,
    assignments,
    uncoveredPaths: [],
    uncoveredLifecycleTargetIds: [],
    lifecycleInventory: completeLifecycleInventory(),
  });
}

function assignment(workSlotId: string, required: boolean) {
  return {
    workSlotId,
    taskKind: ReviewTaskKind.FindingDiscovery,
    providerKind: ReviewExecutionProviderKind.Codex,
    required,
    filePaths: ['src/a.ts'],
  };
}

function fullCoverageManifest(workSlotId: string) {
  return createReviewPromptCoverageManifest({
    workSlotId,
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
}

function acceptedEvidence(
  workSlotId: string,
  coverageManifest: ReturnType<typeof createReviewPromptCoverageManifest>,
  qualityFlags: string[] = []
) {
  const payloadCanonicalJson = JSON.stringify({
    payloadVersion: 2,
    normalizedFindings: [],
    normalizedLifecycleRevalidations: [],
  });
  return {
    workSlotId,
    coverageManifest,
    observation: {
      observationId: `observation-${workSlotId}`,
      eligibilityPolicyVersion: 'eligibility.v1',
      providerKind: ReviewExecutionProviderKind.Codex,
      providerInvocationKey: '7'.repeat(64),
      providerVoteIdentityHash:
        authorizationFacts.providerVoteLanes[0].providerVoteIdentityHash,
      payloadCanonicalJson,
      payloadHash: '8'.repeat(64),
      byteCount: Buffer.byteLength(payloadCanonicalJson),
      findingCount: 0,
      actualModel: 'gpt-5.6-sol',
      qualityFlags,
      transportAttemptCount: 1,
      schemaValidated: true,
      fullyConsumed: true,
    },
  };
}

/** PR whose diff collides: the heuristic prefers the added line 2. */
function collidingPr() {
  const patch = [
    '@@ -1,2 +1,2 @@',
    '-function old() {',
    '-  return old();',
    '+function neu() {',
    '+  return neu();',
  ].join('\n');
  return {
    ...pr,
    files: [
      {
        filename: 'src/a.ts',
        status: 'modified' as const,
        additions: 2,
        deletions: 2,
        changes: 4,
        patch,
      },
    ],
    diff: `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n${patch}`,
  };
}

/** One normalized finding with a verified single-line span at new line 1. */
function spanEvidence(
  workSlotId: string,
  providerKind: ReviewExecutionProviderKind,
  providerVoteIdentityHash: string
) {
  const payloadCanonicalJson = JSON.stringify({
    payloadVersion: 2,
    normalizedFindings: [
      {
        category: 'correctness',
        endLine: 1,
        evidence: [],
        message: 'The return value is wrong.',
        normalizedFailureModeHash: '9'.repeat(64),
        path: 'src/a.ts',
        placementConfidence: null,
        severity: 'major',
        startLine: 1,
        suggestion: 'return ok();',
        title: 'Wrong return value',
      },
    ],
    normalizedLifecycleRevalidations: [],
  });
  return {
    workSlotId,
    coverageManifest: fullCoverageManifest(workSlotId),
    observation: {
      observationId: `observation-${workSlotId}`,
      eligibilityPolicyVersion: 'eligibility.v1',
      providerKind,
      providerInvocationKey: '7'.repeat(64),
      providerVoteIdentityHash,
      payloadCanonicalJson,
      payloadHash: '8'.repeat(64),
      byteCount: Buffer.byteLength(payloadCanonicalJson),
      findingCount: 1,
      actualModel: 'observed-model',
      qualityFlags: [],
      transportAttemptCount: 1,
      schemaValidated: true,
      fullyConsumed: true,
    },
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

function nativeOcrComment(
  overrides: Partial<OcrNativeComment> = {}
): OcrNativeComment {
  return {
    path: 'src/a.ts',
    content:
      'Unsafe user data corrupts stored record\nThe changed runtime writes unsafe data and causes data loss for users.',
    existingCode: 'unsafe_a();\nunsafe_b();',
    suggestionCode: 'safe_a();\nsafe_b();',
    startLine: 1,
    endLine: 2,
    category: 'correctness',
    severity: 'high',
    ...overrides,
  };
}

async function projectNativeOcrComments(
  comments: readonly OcrNativeComment[],
  headContent = 'unsafe_a();\nunsafe_b();'
) {
  const patch = [
    '@@ -1,2 +1,2 @@',
    '-old_a();',
    '-old_b();',
    ...headContent.split('\n').map((line) => `+${line}`),
  ].join('\n');
  const context = {
    ...pr,
    files: [{ ...pr.files[0], additions: 2, deletions: 2, changes: 4, patch }],
    diff: `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n${patch}`,
  };
  const accepted = acceptOcrManagedReviewResult({
    admission: authorizationFacts,
    effectFacts: { effect: 'none' },
    process: {
      closed: true,
      exitCode: 0,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
    },
    observedActualModel: 'observed-model',
    observedRequestCount: 1,
    expectedPaths: ['src/a.ts'],
    headFiles: new Map([
      ['src/a.ts', headContent],
      ['src/outside.ts', 'outside_unsafe();'],
    ]),
    diffPositions: new Map([['src/a.ts', mapLinesToPositions(patch)]]),
    resultBytes: Buffer.from(
      JSON.stringify({
        comments: comments.map((comment) => ({
          path: comment.path,
          content: comment.content,
          existing_code: comment.existingCode,
          suggestion_code: comment.suggestionCode,
          start_line: comment.startLine,
          end_line: comment.endLine,
          category: comment.category,
          severity: comment.severity,
        })),
        manifest: {
          schema_version: 'ocr.run-manifest/v1',
          operation: 'review',
          input: {
            mode: 'range',
            resolved_base: authorizationFacts.mergeBaseSha,
            resolved_head: authorizationFacts.headSha,
          },
        },
        reviewrouter_outcome: {
          schema_version: 'reviewrouter.ocr-outcome/v1',
          run_stop_cause: null,
          grouping: { state: 'not_applicable', reason: 'single_file' },
          groups: [
            {
              paths: ['src/a.ts'],
              main_completed: true,
              stop_cause: null,
              rounds: { configured: 2, started: 1, completed: 1 },
              phases: {
                plan: { state: 'not_applicable', reason: 'threshold' },
                compression: { state: 'not_applicable', reason: 'no_zone' },
                relocation: { state: 'completed', reason: null },
                filter: { state: 'completed', reason: null },
              },
              filter_decision_valid: true,
            },
          ],
        },
      })
    ),
  });
  const payload = normalizeReviewObservation({
    workSlotId: 'ocr-slot',
    attemptOrdinal: 1,
    providerName: 'ocr/managed',
    requestedModel: 'requested-model',
    result: {
      content: '',
      findings: [...accepted.normalized.findings],
      actualModel: accepted.actualModel,
      usage: accepted.usage,
    },
    qualityFlags: accepted.partial
      ? ['context_inspection_incomplete', 'provider_warning']
      : [],
  });
  const evidence = acceptedEvidence(
    'ocr-slot',
    fullCoverageManifest('ocr-slot')
  );
  const builder = createProductionReviewProjectionBuilder({
    authorizationFacts: {
      ...authorizationFacts,
      providerVoteLanes: [
        {
          providerKind: ReviewExecutionProviderKind.Ocr,
          providerVoteIdentityHash:
            authorizationFacts.providerVoteLanes[0].providerVoteIdentityHash,
        },
      ],
    },
    pr: context,
    config: { ...DEFAULT_CONFIG, failOnSeverity: 'major' },
    protocolLimits,
    assignments: [
      {
        workSlotId: 'ocr-slot',
        taskKind: ReviewTaskKind.FindingDiscovery,
        providerKind: ReviewExecutionProviderKind.Ocr,
        required: true,
        filePaths: ['src/a.ts'],
      },
    ],
    uncoveredPaths: [],
    uncoveredLifecycleTargetIds: [],
    lifecycleInventory: completeLifecycleInventory(),
  });
  const projection = await builder.build({
    acceptedEvidence: [
      {
        ...evidence,
        observation: {
          ...evidence.observation,
          ...payload,
          providerKind: ReviewExecutionProviderKind.Ocr,
        },
      },
    ],
    exhaustedWorkSlotIds: [],
    reviewRevisionHash: authorizationFacts.reviewRevisionHash,
  });
  return JSON.parse(projection.projectionEnvelopeCanonicalJson);
}
