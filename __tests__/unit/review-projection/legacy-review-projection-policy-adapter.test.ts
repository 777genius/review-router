import { Deduplicator } from '../../../src/analysis/deduplicator';
import { BuildCurrentReviewProjection } from '../../../src/review-projection/application/build-current-review-projection';
import { DEFAULT_CONFIG } from '../../../src/config/defaults';
import {
  FindingOccurrence,
  FindingOccurrenceState,
  FindingPlacementKind,
  FindingSeverity,
  ProjectionCoverageState,
  RevisionFileStatus,
} from '../../../src/review-projection/domain/review-projection';
import { REVIEW_PROJECTION_ABSOLUTE_LIMITS } from '../../../src/review-projection/domain/review-projection-limits';
import { LegacyReviewProjectionPolicyAdapter } from '../../../src/review-projection/infrastructure/legacy/legacy-review-projection-policy-adapter';

describe('LegacyReviewProjectionPolicyAdapter', () => {
  const adapter = new LegacyReviewProjectionPolicyAdapter({
    ...DEFAULT_CONFIG,
    inlineMaxComments: 20,
    inlineMinSeverity: 'minor',
    inlineMinAgreement: 1,
  });

  it('reuses filtering and consensus while preserving projection provenance', async () => {
    const selected = await adapter.selectCurrent({
      findings: [
        candidate({ sourceFindingId: 'a', providerIds: ['codex'] }),
        candidate({
          sourceFindingId: 'b',
          providerIds: ['claude'],
          providerVoteKeys: ['claude/account-2'],
          observationIds: ['observation-2'],
        }),
      ],
      revisionFiles: [revisionFile()],
      diff: diff(),
      limits: REVIEW_PROJECTION_ABSOLUTE_LIMITS,
    });

    expect(selected).toHaveLength(1);
    expect(selected[0].sourceFindingIds).toEqual(['a', 'b']);
    expect(selected[0].providerVoteKeys).toEqual([
      'claude/account-2',
      'codex/account-1',
    ]);
    expect(selected[0].observationIds).toEqual([
      'observation-1',
      'observation-2',
    ]);
  });


  it.each([false, true])(
    'preserves exact certificate pair membership through production projection (reversed=%s)',
    async (reversed) => {
      // Sanitized attempt04 certificate: keep both evidence identities intact.
      const certificateFindings = [
        {
          fingerprint:
            '68d66f0a7f44cdaa35eb916177c25f435d274260e754483e642d9316c9ab93ed',
          severity: 'major',
          title: 'Returning a string breaks the numeric caller',
          body: '`hidden-caller.mjs` computes `changedApi() + 1`. With the previous numeric return this produced `2`; the new string return uses JavaScript concatenation and produces `"11"`, changing both the value and its type for this reachable caller.',
          path: 'samples/module-01/src/service.mjs',
          line: 1,
          evidenceReceiptIds: [
            '6c04f1974cf52a27bbbfd9bb260ca8a5d60d87186bb7793daa679cf28efe2720',
            '8d27fd04d498103e08ff56c30ed6e721f040b88f91773239a27a8cc8e3ac404d',
            '945c230d0a7b44e20648ebbdf9059059b416c0de71c3f753d6295ade21cb75d7',
          ],
        },
        {
          fingerprint:
            'ce8f807ca48fe4d706f2791f99895e10467e7ee59a5c7b4df621c07c5706e373',
          severity: 'major',
          title: 'Returning a string breaks arithmetic in the existing caller',
          body: '`hidden-caller.mjs` computes `changedApi() + 1`. With this change, JavaScript performs string concatenation and exports `"11"` instead of the previous numeric value `2`, breaking the caller\'s arithmetic contract.',
          path: 'samples/module-01/src/service.mjs',
          line: 1,
          evidenceReceiptIds: [
            '3228f4c76301b3b9e7b7c253dc85ef32c1a6b87769d4070da1cb0edfbebe9400',
            '41675ed2b36e8a6baa8c5095d9b821affe8b7ca6ef8ec96f332a88d8cde1a75a',
            'ab10aa708ff4bb0d25c60f117ec9d69fa66d21cc5d27a6acd8b4010926a186fc',
            'f9eeebd103cff020ff7046f73478d00a896242718138a06ef826e8863d383183',
          ],
        },
      ];
      const pair = certificateFindings.map((finding, index) =>
        candidate({
          sourceFindingId: finding.fingerprint,
          normalizedFailureModeHash: finding.fingerprint,
          category: 'review_investigation',
          title: finding.title,
          message: finding.body,
          filePath: finding.path,
          line: finding.line,
          startLine: finding.line,
          endLine: finding.line,
          observationIds: [`observation-${index}`, 'shared-observation'],
          evidence: finding.evidenceReceiptIds,
        })
      );
      if (reversed) pair.reverse();
      const snapshot = JSON.stringify(pair);
      const path = certificateFindings[0].path;
      const patch =
        '@@ -1 +1 @@\n-export function changedApi() { return 1; }\n+export function changedApi() { return "1"; }';
      const useCase = new BuildCurrentReviewProjection({
        lifecycleInventory: {
          loadCurrent: async () => ({
            inventoryVersion: 'review_lifecycle_inventory.v1' as const,
            loadedForHeadSha: '1'.repeat(40),
            lifecycleStateHash: 'state',
            commandLedgerWatermark: 'watermark',
            complete: true,
            warnings: [],
            targets: [],
          }),
        },
        findingPolicy: adapter,
        lifecyclePolicy: adapter,
        presentationPolicy: adapter,
        mergeGatePolicy: adapter,
        limits: REVIEW_PROJECTION_ABSOLUTE_LIMITS,
      });
      const command = {
        projectionPolicyVersion: 'projection-policy.v1',
        authoritativeObservationIds: [
          'observation-0',
          'observation-1',
          'shared-observation',
          'distinct-observation',
        ],
        scope: {
          scmRepositoryIdentityId: 'repo-1',
          pullRequestNumber: 1,
          baseSha: '0'.repeat(40),
          reviewedHeadSha: '1'.repeat(40),
          reviewRevisionHash: 'revision-1',
        },
        presentation: {
          title: 'Review',
          author: 'author',
          additions: 1,
          deletions: 1,
        },
        providerExecution: { plannedProviders: 1, succeededProviders: 1 },
        currentFindings: pair,
        priorLineageHints: [],
        lifecycleRevalidations: [],
        coverage: {
          state: ProjectionCoverageState.Complete,
          mode: 'full' as const,
          totalFiles: 1,
          reviewedFiles: 1,
          unreviewedFiles: 0,
          limitations: [],
        },
        revisionFiles: [{ path, status: RevisionFileStatus.Modified, patch }],
        diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${patch}`,
      };
      const result = await useCase.execute(command);
      expect(result.envelope.occurrences).toHaveLength(1);
      expect(result.envelope.occurrences[0]).toMatchObject({
        sourceFindingIds: certificateFindings.map((f) => f.fingerprint).sort(),
        observationIds: [
          'observation-0',
          'observation-1',
          'shared-observation',
        ],
        providerVoteKeys: ['codex/account-1'],
      });
      const distinct = candidate({
        sourceFindingId: 'distinct',
        normalizedFailureModeHash: 'distinct-failure-mode',
        filePath: path,
        line: 1,
        startLine: 1,
        endLine: 1,
        title: 'Authorization bypass exposes private records',
        message:
          'Missing permission check allows unauthorized access to private records.',
        providerIds: ['claude'],
        providerVoteKeys: ['claude/account-2'],
        observationIds: ['distinct-observation'],
      });
      const separate = await useCase.execute({
        ...command,
        currentFindings: [...pair, distinct],
      });
      expect(separate.envelope.occurrences).toHaveLength(2);
      expect(
        separate.envelope.occurrences.find((f) => f.title === distinct.title)
      ).toMatchObject({
        sourceFindingIds: ['distinct'],
        observationIds: ['distinct-observation'],
        providerVoteKeys: ['claude/account-2'],
      });
      expect(
        separate.envelope.occurrences.find((f) => f.title !== distinct.title)
      ).toMatchObject({
        sourceFindingIds: certificateFindings.map((f) => f.fingerprint).sort(),
        observationIds: [
          'observation-0',
          'observation-1',
          'shared-observation',
        ],
        providerVoteKeys: ['codex/account-1'],
      });
      expect(JSON.stringify(pair)).toBe(snapshot);
    }
  );

  it('preserves all contributors when consensus merges deduplicated groups', async () => {
    const title =
      'Numeric response conversion breaks arithmetic caller contract';
    const findings = [
      candidate({
        title: 'Stale cache',
        message: 'Cache invalidation fails.',
        sourceFindingId: 'a',
        normalizedFailureModeHash: 'failure-a',
        observationIds: ['observation-0', 'shared-observation'],
      }),
      candidate({
        title,
        message: 'Numeric addition produces concatenation.',
        sourceFindingId: 'b',
        normalizedFailureModeHash: 'failure-b',
        providerIds: ['claude'],
        providerVoteKeys: ['claude/account-2'],
        observationIds: ['observation-1', 'shared-observation'],
      }),
      candidate({
        title,
        message: 'Cache invalidation fails.',
        sourceFindingId: 'c',
        normalizedFailureModeHash: 'failure-c',
        observationIds: ['observation-2', 'shared-observation'],
      }),
    ];
    const snapshot = JSON.stringify(findings);
    // A/B stay separate; C joins A and supplies B's title. Consensus must
    // then merge [A,C] with [B], including B's observation and unique vote.
    const legacy = findings.map((f) => ({
      ...f,
      file: f.filePath,
      severity: 'major' as const,
      sourceFindingIds: [f.sourceFindingId],
    }));
    const deduplicator = new Deduplicator();
    expect(deduplicator.dedupe(legacy.slice(0, 2))).toHaveLength(2);
    expect(
      deduplicator.dedupe(legacy).map((f) => ({
        title: f.title,
        ids: f.sourceFindingIds,
      }))
    ).toEqual([
      { title, ids: ['a', 'c'] },
      { title, ids: ['b'] },
    ]);
    const path = revisionFile().path;
    const patch = revisionFile().patch;
    const useCase = new BuildCurrentReviewProjection({
      lifecycleInventory: {
        loadCurrent: async () => ({
          inventoryVersion: 'review_lifecycle_inventory.v1' as const,
          loadedForHeadSha: '1'.repeat(40),
          lifecycleStateHash: 'state',
          commandLedgerWatermark: 'watermark',
          complete: true,
          warnings: [],
          targets: [],
        }),
      },
      findingPolicy: adapter,
      lifecyclePolicy: adapter,
      presentationPolicy: adapter,
      mergeGatePolicy: adapter,
      limits: REVIEW_PROJECTION_ABSOLUTE_LIMITS,
    });
    const command = {
      projectionPolicyVersion: 'projection-policy.v1',
      authoritativeObservationIds: [
        'observation-0',
        'observation-1',
        'shared-observation',
        'distinct-observation',
        'observation-2',
      ],
      scope: {
        scmRepositoryIdentityId: 'repo-1',
        pullRequestNumber: 1,
        baseSha: '0'.repeat(40),
        reviewedHeadSha: '1'.repeat(40),
        reviewRevisionHash: 'revision-1',
      },
      presentation: {
        title: 'Review',
        author: 'author',
        additions: 1,
        deletions: 1,
      },
      providerExecution: { plannedProviders: 1, succeededProviders: 1 },
      currentFindings: findings,
      priorLineageHints: [],
      lifecycleRevalidations: [],
      coverage: {
        state: ProjectionCoverageState.Complete,
        mode: 'full' as const,
        totalFiles: 1,
        reviewedFiles: 1,
        unreviewedFiles: 0,
        limitations: [],
      },
      revisionFiles: [{ path, status: RevisionFileStatus.Modified, patch }],
      diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${patch}`,
    };
    const result = await useCase.execute(command);
    expect(result.envelope.occurrences).toHaveLength(1);
    expect(result.envelope.occurrences[0]).toMatchObject({
      sourceFindingIds: ['a', 'b', 'c'],
      normalizedFailureModeHash: 'failure-a',
      observationIds: [
        'observation-0',
        'observation-1',
        'observation-2',
        'shared-observation',
      ],
      providerVoteKeys: ['claude/account-2', 'codex/account-1'],
    });
    expect(await useCase.execute(command)).toEqual(result);
    const separate = await useCase.execute({
      ...command,
      currentFindings: [
        ...findings,
        candidate({
          sourceFindingId: 'distinct',
          normalizedFailureModeHash: 'distinct-failure',
          title: 'Authorization bypass exposes private records',
          message: 'Missing permission check allows unauthorized access.',
          observationIds: ['distinct-observation'],
          providerIds: ['gemini'],
          providerVoteKeys: ['gemini/account-3'],
        }),
      ],
    });
    expect(separate.envelope.occurrences).toHaveLength(2);
    expect(
      separate.envelope.occurrences.find((f) =>
        f.sourceFindingIds.includes('a')
      )
    ).toEqual(result.envelope.occurrences[0]);
    expect(
      separate.envelope.occurrences.find((f) =>
        f.sourceFindingIds.includes('distinct')
      )
    ).toMatchObject({
      sourceFindingIds: ['distinct'],
      observationIds: ['distinct-observation'],
      providerVoteKeys: ['gemini/account-3'],
    });
    expect(JSON.stringify(findings)).toBe(snapshot);
  });

  it('degrades rename, deletion and unplaceable findings without false inline anchors', async () => {
    const occurrences = [
      occurrence({
        lineageId: 'renamed',
        filePath: 'src/old.ts',
        line: 2,
      }),
      occurrence({
        lineageId: 'deleted',
        filePath: 'src/deleted.ts',
        line: 1,
      }),
      occurrence({
        lineageId: 'unplaceable',
        filePath: 'src/unplaceable.ts',
        line: 99,
      }),
    ];
    const projected = await adapter.projectPresentation({
      scope: {
        scmRepositoryIdentityId: 'repo-1',
        pullRequestNumber: 252,
        baseSha: '0'.repeat(40),
        reviewedHeadSha: '1'.repeat(40),
        reviewRevisionHash: 'revision-1',
      },
      presentation: {
        title: 'Large PR',
        author: 'author',
        additions: 3,
        deletions: 1,
      },
      providerExecution: {
        plannedProviders: 1,
        succeededProviders: 1,
      },
      coverage: {
        state: ProjectionCoverageState.Complete,
        mode: 'full',
        totalFiles: 3,
        reviewedFiles: 3,
        unreviewedFiles: 0,
        limitations: [],
      },
      occurrences,
      revisionFiles: [
        {
          path: 'src/new.ts',
          previousPath: 'src/old.ts',
          status: RevisionFileStatus.Renamed,
          patch: '@@ -1 +1,2 @@\n const safe = true;\n+dangerous();',
        },
        {
          path: 'src/deleted.ts',
          status: RevisionFileStatus.Removed,
          patch: '@@ -1 +0,0 @@\n-dangerous();',
        },
        {
          path: 'src/unplaceable.ts',
          status: RevisionFileStatus.Modified,
          patch: '@@ -1 +1 @@\n-safe();\n+changed();',
        },
      ],
      limits: REVIEW_PROJECTION_ABSOLUTE_LIMITS,
    });

    expect(projected.placements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lineageId: 'renamed',
          kind: FindingPlacementKind.Inline,
          path: 'src/new.ts',
        }),
        expect.objectContaining({
          lineageId: 'deleted',
          kind: FindingPlacementKind.Summary,
        }),
        expect.objectContaining({
          lineageId: 'unplaceable',
          kind: FindingPlacementKind.File,
        }),
      ])
    );
  });

  it('presents partial coverage as incomplete while preserving preliminary findings', async () => {
    const projected = await adapter.projectPresentation({
      scope: {
        scmRepositoryIdentityId: 'repo-1',
        pullRequestNumber: 46,
        baseSha: '0'.repeat(40),
        reviewedHeadSha: '1'.repeat(40),
        reviewRevisionHash: 'revision-partial',
      },
      presentation: {
        title: 'Partial review',
        author: 'author',
        additions: 1,
        deletions: 0,
      },
      providerExecution: {
        plannedProviders: 1,
        succeededProviders: 1,
      },
      coverage: {
        state: ProjectionCoverageState.Partial,
        mode: 'full',
        totalFiles: 2,
        reviewedFiles: 1,
        unreviewedFiles: 1,
        limitations: ['work_slot_coverage_incomplete:slot-2'],
      },
      occurrences: [occurrence()],
      revisionFiles: [revisionFile()],
      limits: REVIEW_PROJECTION_ABSOLUTE_LIMITS,
    });

    expect(projected.summaryBody).toContain(
      '## Review incomplete — 1 preliminary finding'
    );
    expect(projected.summaryBody).toContain(
      'Inline comments and lifecycle changes were withheld'
    );
    expect(projected.summaryBody).toContain('### Coverage not completed');
    expect(projected.summaryBody).toContain(
      '- work_slot_coverage_incomplete:slot-2'
    );
    expect(projected.summaryBody).not.toMatch(
      /^##\s+Review complete(?:d)?\b/im
    );
    expect(projected.checkTitle).toBe('Review incomplete - partial coverage');
    expect(projected.checkConclusion).toBe('neutral');
  });

  it('does not claim a clean review when partial coverage found nothing', async () => {
    const projected = await adapter.projectPresentation({
      scope: {
        scmRepositoryIdentityId: 'repo-1',
        pullRequestNumber: 46,
        baseSha: '0'.repeat(40),
        reviewedHeadSha: '1'.repeat(40),
        reviewRevisionHash: 'revision-partial-empty',
      },
      presentation: {
        title: 'Partial review',
        author: 'author',
        additions: 1,
        deletions: 0,
      },
      providerExecution: {
        plannedProviders: 1,
        succeededProviders: 1,
      },
      coverage: {
        state: ProjectionCoverageState.Partial,
        mode: 'full',
        totalFiles: 2,
        reviewedFiles: 1,
        unreviewedFiles: 1,
        limitations: ['work_slot_coverage_incomplete:slot-2'],
      },
      occurrences: [],
      revisionFiles: [revisionFile()],
      limits: REVIEW_PROJECTION_ABSOLUTE_LIMITS,
    });

    expect(projected.summaryBody).toContain(
      '## Review incomplete — 0 preliminary findings'
    );
    expect(projected.summaryBody).not.toContain('## No findings');
    expect(projected.summaryBody).toContain(
      'Inline comments and lifecycle changes were withheld'
    );
  });

  it('does not count carried occurrences as severity-gate blockers', () => {
    const decision = adapter.evaluateMergeGate({
      failOnSeverity: FindingSeverity.Major,
      occurrences: [
        occurrence({ state: FindingOccurrenceState.CarriedUnverified }),
      ],
      coverage: {
        state: ProjectionCoverageState.Complete,
        mode: 'full',
        totalFiles: 1,
        reviewedFiles: 1,
        unreviewedFiles: 0,
        limitations: [],
      },
      lifecycleInventoryComplete: true,
    });

    expect(decision).toEqual({
      conclusion: 'pass',
      blockingLineageIds: [],
      reasonCodes: [],
    });
  });
});

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    sourceFindingId: 'a',
    category: 'correctness',
    normalizedFailureModeHash: 'failure-mode-1',
    severity: FindingSeverity.Major,
    title: 'Runtime crash on valid request',
    message: 'The changed call throws when the request is valid.',
    filePath: 'src/service.ts',
    line: 2,
    providerIds: ['codex'],
    providerVoteKeys: ['codex/account-1'],
    observationIds: ['observation-1'],
    ...overrides,
  };
}

function occurrence(
  overrides: Partial<FindingOccurrence> = {}
): FindingOccurrence {
  return {
    lineageId: 'lineage-1',
    sourceFindingIds: ['finding-1'],
    state: FindingOccurrenceState.New,
    severity: FindingSeverity.Major,
    category: 'correctness',
    normalizedFailureModeHash: 'failure-mode-1',
    title: 'Runtime crash on valid request',
    message: 'The changed call throws when the request is valid.',
    filePath: 'src/service.ts',
    line: 2,
    placement: {
      lineageId: 'lineage-1',
      kind: FindingPlacementKind.Summary,
      path: 'src/service.ts',
    },
    providerVoteKeys: ['codex/account-1'],
    observationIds: ['observation-1'],
    firstSeenHeadSha: '0'.repeat(40),
    sourceHeadSha: '1'.repeat(40),
    blocking: false,
    ...overrides,
  };
}

function revisionFile() {
  return {
    path: 'src/service.ts',
    status: RevisionFileStatus.Modified,
    patch: '@@ -1 +1,2 @@\n const safe = true;\n+dangerous();',
  };
}

function diff(): string {
  return [
    'diff --git a/src/service.ts b/src/service.ts',
    '--- a/src/service.ts',
    '+++ b/src/service.ts',
    '@@ -1 +1,2 @@',
    ' const safe = true;',
    '+dangerous();',
  ].join('\n');
}
