import {
  parseReviewComparisonBaseline,
  CurrentReviewProjector,
  deriveReviewPresentation,
  FindingOccurrenceState,
  FindingSeverity,
  LifecycleRevalidationVerdict,
  LifecycleTargetDisposition,
  ProjectionCoverageState,
  type PriorLineageHint,
  type CurrentLifecycleInventory,
  type ReviewComparisonBaseline,
} from '../../../src/review-projection/domain';

const lineageId = `rrl_${'a'.repeat(32)}`;
const head = (n: number) => String(n).repeat(40);
const hint: PriorLineageHint = {
  lineageId,
  category: 'correctness',
  normalizedFailureModeHash: 'a'.repeat(64),
  severity: FindingSeverity.Major,
  title: 'Original finding',
  message: 'Full original explanation.',
  filePath: 'a.ts',
  line: 1,
  firstSeenHeadSha: head(1),
  lastSeenHeadSha: head(1),
  active: true,
};
const baseline: ReviewComparisonBaseline = {
  schemaVersion: 'comparison_baseline.v1',
  appliedResolutions: [],
  sourceReviewedHeadSha: head(1),
  sourceReviewRevisionHash: 'b'.repeat(64),
  sourceExecutionGeneration: '1',
  snapshotVersion: 1,
  projectionPolicyVersion: 'review-projection-policy.v5-t0',
  projectionEnvelopeVersion: 'review_projection.v1',
  priorLineageHints: [hint],
};
const coverage = {
  state: ProjectionCoverageState.Complete,
  mode: 'full' as const,
  totalFiles: 1,
  reviewedFiles: 1,
  unreviewedFiles: 0,
  limitations: [],
};
const inventory = (currentHead: string): CurrentLifecycleInventory => ({
  inventoryVersion: 'review_lifecycle_inventory.v1',
  loadedForHeadSha: currentHead,
  lifecycleStateHash: 'c'.repeat(64),
  commandLedgerWatermark: '0',
  complete: true,
  warnings: [],
  targets: [],
});
const scope = (n: number) => ({
  scmRepositoryIdentityId: 'repo',
  pullRequestNumber: 2,
  baseSha: head(0),
  reviewedHeadSha: head(n),
  reviewRevisionHash: 'd'.repeat(64),
});

describe('authoritative review comparison', () => {
  it('keeps valid empty history explicit and falls back on malformed or unsupported history', () => {
    expect(
      parseReviewComparisonBaseline(
        JSON.stringify({ ...baseline, priorLineageHints: [] })
      )
    ).toEqual({ ...baseline, priorLineageHints: [] });
    for (const bad of [
      { ...baseline, extra: 1 },
      { ...baseline, sourceReviewedHeadSha: 'main' },
      { ...baseline, sourceExecutionGeneration: '01' },
      { ...baseline, sourceExecutionGeneration: '9223372036854775808' },
      { ...baseline, appliedResolutions: undefined },
      {
        ...baseline,
        appliedResolutions: [
          {
            lineageId,
            targetId: 't',
            threadId: 'th',
            markerFingerprint: lineageId,
            resolvedAt: '2026-10-22T01:00:00Z',
          },
        ],
      },
      { ...baseline, priorLineageHints: [hint, hint] },
      { ...baseline, priorLineageHints: [{ ...hint, secret: true }] },
      { ...baseline, projectionPolicyVersion: 'unknown' },
    ])
      expect(parseReviewComparisonBaseline(JSON.stringify(bad))).toBeNull();
    expect(
      Object.isFrozen(
        parseReviewComparisonBaseline(JSON.stringify(baseline))
          ?.priorLineageHints
      )
    ).toBe(true);
  });

  it('accepts bounded receipt authority only for unique known lineage identities', () => {
    const receipt = {
      lineageId,
      targetId: 'rrt_target',
      threadId: 'thread',
      markerFingerprint: lineageId,
      resolvedAt: '2026-10-22T01:00:00.000Z',
    };
    const value = { ...baseline, appliedResolutions: [receipt] };
    expect(
      parseReviewComparisonBaseline(JSON.stringify(value))?.appliedResolutions
    ).toEqual([receipt]);
    expect(
      parseReviewComparisonBaseline(
        JSON.stringify({
          ...value,
          priorLineageHints: [{ ...hint, active: false }],
        })
      )?.appliedResolutions
    ).toEqual([receipt]);
    for (const bad of [
      { ...value, appliedResolutions: [receipt, receipt] },
      { ...value, priorLineageHints: [] },
      {
        ...value,
        appliedResolutions: [{ ...receipt, markerFingerprint: 'b'.repeat(24) }],
      },
      {
        ...value,
        appliedResolutions: [{ ...receipt, threadId: 'a'.repeat(65_001) }],
      },
      { ...value, appliedResolutions: [{ ...receipt, secret: true }] },
    ])
      expect(parseReviewComparisonBaseline(JSON.stringify(bad))).toBeNull();
  });

  it('retains active -> pending candidate -> confirmed resolution over three heads', () => {
    const projector = new CurrentReviewProjector();
    const pendingInventory = {
      ...inventory(head(2)),
      targets: [
        {
          targetId: 'target',
          threadId: 'thread',
          trustedMarker: lineageId,
          title: hint.title,
          message: hint.message,
          severity: hint.severity,
          originalPath: hint.filePath,
          parentCommentUpdatedAt: '2026-10-22T00:00:00Z',
          threadCommentCount: 1,
          threadStateHash: 'f'.repeat(64),
          disposition: LifecycleTargetDisposition.Active,
          viewerCanResolve: true,
        },
      ],
    };
    const pending = projector.projectOccurrences({
      scope: scope(2),
      selectedFindings: [],
      priorLineageHints: [hint],
      inventory: pendingInventory,
      lifecycleDecisions: [
        {
          targetId: 'target',
          verdict: LifecycleRevalidationVerdict.Resolved,
          reasonCodes: ['candidate_only'],
        },
      ],
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      state: FindingOccurrenceState.CarriedUnverified,
      message: hint.message,
    });
    expect(
      deriveReviewPresentation({
        reviewedHeadSha: head(2),
        baseline,
        coverage,
        incomplete: false,
        occurrences: pending,
      }).changes
    ).toEqual({ new: 0, resolved: 0, open: 1, unverified: 1 });
    const confirmed = projector.projectOccurrences({
      scope: scope(3),
      selectedFindings: [],
      priorLineageHints: [{ ...hint, lastSeenHeadSha: head(2), active: true }],
      inventory: {
        ...inventory(head(3)),
        resolvedObservations: [
          { lineageId, trustedMarker: lineageId, confirmed: true },
        ],
      },
      lifecycleDecisions: [],
    });
    expect(confirmed[0].state).toBe(FindingOccurrenceState.Resolved);
    expect(
      deriveReviewPresentation({
        reviewedHeadSha: head(3),
        baseline,
        coverage,
        incomplete: false,
        occurrences: confirmed,
      }).changes
    ).toEqual({ new: 0, resolved: 1, open: 0, unverified: 0 });
  });

  it('retains summary-only history and rejects duplicate, unconfirmed or partial resolution observations', () => {
    const projector = new CurrentReviewProjector();
    for (const inv of [
      inventory(head(2)),
      {
        ...inventory(head(2)),
        resolvedObservations: [
          { lineageId, trustedMarker: lineageId, confirmed: false },
        ],
      },
      {
        ...inventory(head(2)),
        complete: false,
        resolvedObservations: [
          { lineageId, trustedMarker: lineageId, confirmed: true },
        ],
      },
      {
        ...inventory(head(2)),
        resolvedObservations: [
          { lineageId, trustedMarker: lineageId, confirmed: true },
          { lineageId, trustedMarker: lineageId, confirmed: true },
        ],
      },
    ]) {
      const occurrences = projector.projectOccurrences({
        scope: scope(2),
        selectedFindings: [],
        priorLineageHints: [hint],
        inventory: inv,
        lifecycleDecisions: [],
      });
      expect(occurrences[0].state).toBe(
        FindingOccurrenceState.CarriedUnverified
      );
    }
  });

  it.each([
    LifecycleTargetDisposition.Active,
    LifecycleTargetDisposition.HumanReply,
    LifecycleTargetDisposition.CommandSuppressed,
  ])(
    'keeps a %s exact-marker thread unresolved when another historical thread is closed',
    (disposition) => {
      const occurrences = new CurrentReviewProjector().projectOccurrences({
        scope: scope(2),
        selectedFindings: [],
        priorLineageHints: [hint],
        inventory: {
          ...inventory(head(2)),
          targets: [
            {
              targetId: 'open-target',
              threadId: 'open-thread',
              trustedMarker: lineageId,
              title: hint.title,
              message: hint.message,
              severity: hint.severity,
              originalPath: hint.filePath,
              parentCommentUpdatedAt: '2026-10-22T00:00:00.000Z',
              threadCommentCount: 1,
              threadStateHash: 'a'.repeat(64),
              disposition,
              viewerCanResolve: true,
            },
          ],
          resolvedObservations: [
            { lineageId, trustedMarker: lineageId, confirmed: true },
          ],
        },
        lifecycleDecisions: [],
      });
      expect(occurrences[0].state).toBe(
        disposition === LifecycleTargetDisposition.CommandSuppressed
          ? FindingOccurrenceState.SuppressedByHuman
          : FindingOccurrenceState.Uncertain
      );
      expect(
        deriveReviewPresentation({
          reviewedHeadSha: head(2),
          baseline,
          coverage,
          incomplete: false,
          occurrences,
        }).changes
      ).toEqual({
        new: 0,
        resolved: 0,
        open:
          disposition === LifecycleTargetDisposition.CommandSuppressed ? 0 : 1,
        unverified:
          disposition === LifecycleTargetDisposition.CommandSuppressed ? 0 : 1,
      });
    }
  );

  it('never suppresses a different lineage merely because its location matches an old thread', () => {
    const occurrences = new CurrentReviewProjector().projectOccurrences({
      scope: scope(2),
      selectedFindings: [
        {
          ...hint,
          trustedMarker: undefined,
          sourceFindingId: 'current',
          sourceFindingIds: ['current'],
          providerIds: [],
          providerVoteKeys: [],
          observationIds: [],
        },
      ],
      priorLineageHints: [],
      inventory: {
        ...inventory(head(2)),
        targets: [
          {
            targetId: 'old',
            threadId: 'old',
            trustedMarker: lineageId,
            title: hint.title,
            message: hint.message,
            severity: hint.severity,
            originalPath: hint.filePath,
            currentPath: hint.filePath,
            currentLine: hint.line,
            parentCommentUpdatedAt: '2026-10-22T00:00:00.000Z',
            threadCommentCount: 1,
            threadStateHash: 'a'.repeat(64),
            disposition: LifecycleTargetDisposition.CommandSuppressed,
            viewerCanResolve: true,
          },
        ],
      },
      lifecycleDecisions: [],
    });
    expect(occurrences[0].state).toBe(FindingOccurrenceState.New);
    expect(occurrences[0].trustedMarker).toBe(occurrences[0].lineageId);
    expect(occurrences[0].lineageId).not.toBe(lineageId);
  });

  it.each([FindingSeverity.Major, FindingSeverity.Minor])(
    'does not count a contradictory %s current finding as resolved or newly introduced',
    (severity) => {
      const occurrences = new CurrentReviewProjector().projectOccurrences({
        scope: scope(2),
        selectedFindings: [
          {
            ...hint,
            severity,
            trustedMarker: lineageId,
            sourceFindingId: 'new-observation',
            sourceFindingIds: ['new-observation'],
            providerIds: [],
            providerVoteKeys: [],
            observationIds: [],
          },
        ],
        priorLineageHints: [hint],
        inventory: {
          ...inventory(head(2)),
          resolvedObservations: [
            { lineageId, trustedMarker: lineageId, confirmed: true },
          ],
        },
        lifecycleDecisions: [],
      });
      const present = deriveReviewPresentation({
        reviewedHeadSha: head(2),
        baseline,
        coverage,
        incomplete: false,
        occurrences: [...occurrences, ...occurrences],
      });
      expect(present.changes).toEqual({
        new: 0,
        resolved: 0,
        open: 1,
        unverified: 0,
      });
      expect(present.severity[severity]).toBe(1);
      expect(
        deriveReviewPresentation({
          reviewedHeadSha: head(1),
          baseline,
          coverage,
          incomplete: false,
          occurrences,
        }).variant
      ).toBe('first');
      expect(
        deriveReviewPresentation({
          reviewedHeadSha: head(2),
          coverage,
          incomplete: false,
          occurrences,
        }).changes
      ).toBeUndefined();
      expect(
        deriveReviewPresentation({
          reviewedHeadSha: head(2),
          baseline: { ...baseline, priorLineageHints: [] },
          coverage,
          incomplete: true,
          occurrences,
        })
      ).toMatchObject({
        variant: 'update',
        state: 'incomplete',
        changes: { new: 1, resolved: 0, open: 1, unverified: 0 },
      });
    }
  );
});
