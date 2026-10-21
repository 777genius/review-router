import { ConsensusEngine } from '../../../analysis/consensus';
import { Deduplicator } from '../../../analysis/deduplicator';
import { FindingFilter } from '../../../analysis/finding-filter';
import { SynthesisEngine } from '../../../analysis/synthesis';
import { ThreadLifecycleAggregator } from '../../../analysis/thread-lifecycle';
import { getBlockingFindingBreakdown } from '../../../output/severity-gate';
import {
  FileChange,
  Finding,
  LifecycleReasonCode,
  LifecycleTarget,
  LifecycleThreadRecord,
  PRContext,
  ProviderResult,
  Review,
  ReviewConfig,
  Severity,
} from '../../../types';
import {
  chooseBestAddedLineForComment,
  mapLinesToPositions,
} from '../../../utils/diff';
import {
  CheckConclusion,
  CurrentFindingCandidate,
  FindingOccurrence,
  FindingOccurrenceState,
  FindingPlacementDecision,
  FindingPlacementKind,
  FindingSeverity,
  LifecycleProjectionDecision,
  LifecycleRevalidationVerdict,
  LifecycleTargetDisposition,
  MergeGateConclusion,
  ProjectionCoverageState,
  RevisionFile,
  RevisionFileStatus,
  SelectedCurrentFinding,
} from '../../domain/review-projection';
import {
  findingLocationLabel,
  isReviewerSummaryIncomplete,
  limitReviewerPostedMarkdown,
  renderReviewerSummaryMarkdown,
  toReviewerSummaryFinding,
  type ReviewerLifecycleLine,
} from '../../../output/reviewer-summary';
import {
  CurrentFindingPolicyPort,
  EvaluateMergeGateQuery,
  MergeGateDecision,
  ProjectedReviewPresentation,
  ProjectLifecycleQuery,
  ProjectReviewPresentationQuery,
  ReviewLifecyclePolicyPort,
  ReviewMergeGatePolicyPort,
  ReviewPresentationPolicyPort,
  SelectCurrentFindingsQuery,
} from '../../application/review-projection-ports';

type FindingWithProjectionMetadata = Finding & {
  readonly projectionSourceFindingId: string;
  readonly projectionCategory: string;
  readonly projectionFailureModeHash: string;
  readonly projectionSymbolAnchor?: string;
  readonly projectionTrustedMarker?: string;
  readonly projectionObservationIds: readonly string[];
};

/**
 * Anti-corruption adapter for the current v1 review policies. It owns mapping
 * only; the review-projection domain remains independent of legacy Review types.
 */
export class LegacyReviewProjectionPolicyAdapter
  implements
    CurrentFindingPolicyPort,
    ReviewLifecyclePolicyPort,
    ReviewPresentationPolicyPort,
    ReviewMergeGatePolicyPort
{
  private readonly consensus: ConsensusEngine;
  private readonly synthesis: SynthesisEngine;

  constructor(private readonly config: ReviewConfig) {
    this.consensus = new ConsensusEngine({
      minAgreement: Math.max(1, config.inlineMinAgreement),
      minSeverity: 'minor',
      maxComments: config.inlineMaxComments,
    });
    this.synthesis = new SynthesisEngine(config);
  }

  async selectCurrent(
    query: SelectCurrentFindingsQuery
  ): Promise<readonly SelectedCurrentFinding[]> {
    // Provider identities here come from accepted observations. Require every
    // original contributor, since dedup can retain one source's category while
    // replacing its text with another source's explanation.
    const producerClassifiedBugIds = new Set(
      query.findings
        .filter(
          (finding) =>
            finding.category === 'bug' &&
            finding.providerIds.length > 0 &&
            finding.providerIds.every((provider) => provider === 'ocr')
        )
        .map((finding) => finding.sourceFindingId)
    );
    const legacyFindings = query.findings.map(toLegacyFinding);
    const deduped = new Deduplicator().dedupe(legacyFindings);
    const consensus = this.consensus.filter(deduped);
    const filtered = new FindingFilter().filter(consensus, query.diff, {
      allowUnanchoredFindings: true,
      isProducerClassifiedBug: (finding) => {
        const sourceIds = finding.sourceFindingIds ?? [];
        return (
          sourceIds.length > 0 &&
          sourceIds.every((id) => producerClassifiedBugIds.has(id))
        );
      },
    }).findings;

    return filtered.map((finding) => {
      const metadata = finding as FindingWithProjectionMetadata;
      const memberIds = new Set(finding.sourceFindingIds);
      const contributors = query.findings.filter((candidate) =>
        memberIds.has(candidate.sourceFindingId)
      );
      const representative =
        contributors.find(
          (candidate) =>
            candidate.sourceFindingId === metadata.projectionSourceFindingId
        ) ?? contributors[0];
      if (!representative) {
        throw new Error('legacy finding policy returned an unknown finding');
      }

      const requiresVerifiedAnchor = contributors.some(
        (candidate) => candidate.anchorVerified !== undefined
      );
      // Legacy dedup may union nearby ranges and retain only one source's
      // suggestion. A union is not proof for that replacement: every source
      // must agree with the final exact range before it can remain inline.
      const anchorVerified =
        finding.startLine !== undefined &&
        finding.endLine !== undefined &&
        contributors.every(
          (candidate) =>
            candidate.anchorVerified === true &&
            candidate.filePath === finding.file &&
            candidate.startLine === finding.startLine &&
            candidate.endLine === finding.endLine
        ) &&
        (!finding.suggestion ||
          contributors.some(
            (candidate) => candidate.suggestion === finding.suggestion
          ));
      const selected = {
        ...representative,
        sourceFindingId: representative.sourceFindingId,
        sourceFindingIds: sortedUnique(
          contributors.map((candidate) => candidate.sourceFindingId)
        ),
        ...(requiresVerifiedAnchor ? { anchorVerified } : {}),
        severity: toProjectionSeverity(finding.severity),
        title: finding.title,
        message: finding.message,
        ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
        filePath: finding.file,
        ...(finding.startLine !== undefined
          ? { startLine: finding.startLine }
          : {}),
        line: finding.line,
        ...(finding.endLine !== undefined ? { endLine: finding.endLine } : {}),
        ...(finding.confidence !== undefined
          ? { confidence: finding.confidence }
          : {}),
        providerIds: sortedUnique(
          contributors.flatMap((candidate) => candidate.providerIds)
        ),
        providerVoteKeys: sortedUnique(
          contributors.flatMap((candidate) => candidate.providerVoteKeys)
        ),
        observationIds: sortedUnique(
          contributors.flatMap((candidate) => candidate.observationIds)
        ),
      };
      if (requiresVerifiedAnchor && !anchorVerified) {
        const {
          startLine: _startLine,
          line: _line,
          endLine: _endLine,
          suggestion: _suggestion,
          ...unanchored
        } = selected;
        return unanchored;
      }
      return selected;
    });
  }

  async projectLifecycle(
    query: ProjectLifecycleQuery
  ): Promise<readonly LifecycleProjectionDecision[]> {
    const targets = query.inventory.targets
      .filter(
        (target) =>
          target.disposition !== LifecycleTargetDisposition.CommandSuppressed
      )
      .map(toLegacyLifecycleTarget);
    const skipped = query.inventory.targets
      .filter(
        (target) =>
          target.disposition === LifecycleTargetDisposition.CommandSuppressed
      )
      .map((target) =>
        legacyLifecycleRecord(toLegacyLifecycleTarget(target), [
          'command_dismissed',
        ])
      );
    const manualAttention = query.inventory.targets
      .filter(
        (target) => target.disposition === LifecycleTargetDisposition.HumanReply
      )
      .map((target) =>
        legacyLifecycleRecord(toLegacyLifecycleTarget(target), ['human_reply'])
      );
    const providerResults = lifecycleProviderResults(query);
    const lifecycle = new ThreadLifecycleAggregator().aggregate({
      mode: 'report',
      targets,
      plannedProviders: providerResults.map((result) => result.name),
      providerResults,
      currentFindings: query.findings.map(toLegacyFinding),
      initialManualAttention: manualAttention,
      skipped,
      warnings: [...query.inventory.warnings],
      inventoryFailed: !query.inventory.complete,
      config: this.config,
    });

    const decisions = new Map<string, LifecycleProjectionDecision>();
    const collect = (
      records: readonly LifecycleThreadRecord[],
      verdict: LifecycleRevalidationVerdict
    ): void => {
      for (const record of records) {
        decisions.set(record.target.targetId, {
          targetId: record.target.targetId,
          verdict,
          reasonCodes: sortedUnique(record.reasonCodes),
        });
      }
    };
    collect(
      [...lifecycle.resolvedCandidates, ...lifecycle.resolvedByLifecycle],
      LifecycleRevalidationVerdict.Resolved
    );
    collect(
      lifecycle.previousStillValid,
      LifecycleRevalidationVerdict.StillValid
    );
    collect(
      [
        ...lifecycle.previousUncertain,
        ...lifecycle.manualAttention,
        ...lifecycle.skipped,
      ],
      LifecycleRevalidationVerdict.Uncertain
    );

    return Array.from(decisions.values()).sort((left, right) =>
      left.targetId.localeCompare(right.targetId)
    );
  }

  async projectPresentation(
    query: ProjectReviewPresentationQuery
  ): Promise<ProjectedReviewPresentation> {
    const activeOccurrences = query.occurrences.filter(
      (occurrence) =>
        occurrence.state !== FindingOccurrenceState.Resolved &&
        occurrence.state !== FindingOccurrenceState.SuppressedByHuman
    );
    const currentOccurrences = activeOccurrences.filter(isCurrentOccurrence);
    const legacyFindings = new Map(
      currentOccurrences.map((occurrence) => [
        occurrence,
        toLegacyFinding(occurrence),
      ])
    );
    const pr = toLegacyPrContext(query);
    const review = this.synthesis.synthesizeWithProviderExecutionSummary(
      [...legacyFindings.values()],
      pr,
      {
        planned: query.providerExecution.plannedProviders,
        succeeded: query.providerExecution.succeededProviders,
      }
    );
    const placements = query.occurrences.map((occurrence) =>
      this.placeOccurrence(
        occurrence,
        review,
        query.revisionFiles,
        legacyFindings.get(occurrence)
      )
    );
    const incomplete = isReviewerSummaryIncomplete({
      incomplete: query.coverage.state === ProjectionCoverageState.Partial,
      metrics: review.metrics,
    });
    const summaryBody = limitReviewerPostedMarkdown(
      renderReviewerSummaryMarkdown({
        language: this.config.outputLanguage,
        findings: currentOccurrences
          .map(toLegacyFinding)
          .map(toReviewerSummaryFinding),
        metrics: review.metrics,
        incomplete,
        coverage: {
          complete: query.coverage.state === ProjectionCoverageState.Complete,
          totalFiles: query.coverage.totalFiles,
          reviewedFiles: query.coverage.reviewedFiles,
          unreviewedFiles: query.coverage.unreviewedFiles,
          mode: query.coverage.mode,
          limitations: query.coverage.limitations,
          files: query.coverage.files,
        },
        lifecycle: lifecycleLinesForSummary(query.occurrences, query.lifecycle),
      })
    );

    return {
      summaryBody,
      checkName: 'ReviewRouter',
      checkTitle: incomplete
        ? query.coverage.state === ProjectionCoverageState.Partial
          ? 'Review incomplete - partial coverage'
          : 'Review incomplete - no successful providers'
        : 'Review completed',
      checkSummary: summaryBody,
      checkConclusion: incomplete ? CheckConclusion.Neutral : undefined,
      placements,
    };
  }

  evaluateMergeGate(query: EvaluateMergeGateQuery): MergeGateDecision {
    const eligible = query.occurrences.filter(isCurrentOccurrence);
    const threshold = query.failOnSeverity;
    const blockingLineageIds = threshold
      ? eligible
          .filter((occurrence) =>
            this.isBlockingOccurrence(occurrence, threshold)
          )
          .map((occurrence) => occurrence.lineageId)
      : [];
    const incomplete =
      query.coverage.state === ProjectionCoverageState.Partial ||
      !query.lifecycleInventoryComplete;

    if (blockingLineageIds.length > 0) {
      return {
        conclusion: MergeGateConclusion.Fail,
        blockingLineageIds: sortedUnique(blockingLineageIds),
        reasonCodes: [
          'blocking_current_findings',
          ...(incomplete ? ['partial_coverage'] : []),
        ],
      };
    }
    if (incomplete) {
      return {
        conclusion: MergeGateConclusion.Inconclusive,
        blockingLineageIds: [],
        reasonCodes: ['partial_coverage'],
      };
    }
    return {
      conclusion: MergeGateConclusion.Pass,
      blockingLineageIds: [],
      reasonCodes: [],
    };
  }

  private isBlockingOccurrence(
    occurrence: FindingOccurrence,
    threshold: FindingSeverity
  ): boolean {
    const review = minimalLegacyReview([toLegacyFinding(occurrence)]);
    return (
      getBlockingFindingBreakdown(review, toLegacySeverity(threshold)).total > 0
    );
  }

  private placeOccurrence(
    occurrence: FindingOccurrence,
    review: Review,
    revisionFiles: readonly RevisionFile[],
    sourceFinding: Finding | undefined
  ): FindingPlacementDecision {
    if (!isCurrentOccurrence(occurrence)) {
      return summaryPlacement(occurrence, 'historical lifecycle occurrence');
    }
    const revisionFile = findRevisionFile(occurrence.filePath, revisionFiles);
    if (!revisionFile) {
      return summaryPlacement(occurrence, 'file is outside the current diff');
    }
    if (revisionFile.status === RevisionFileStatus.Removed) {
      return summaryPlacement(occurrence, 'file was deleted');
    }
    if (occurrence.anchorVerified === false) {
      return {
        lineageId: occurrence.lineageId,
        kind: FindingPlacementKind.File,
        path: revisionFile.path,
        reason: 'finding has no verified current span',
      };
    }
    const line = occurrence.line ?? occurrence.endLine;
    if (line === undefined) {
      return {
        lineageId: occurrence.lineageId,
        kind: FindingPlacementKind.File,
        path: revisionFile.path,
        reason: 'finding has no current line anchor',
      };
    }
    const inline = review.inlineComments.find(
      (comment) =>
        sourceFinding !== undefined &&
        this.synthesis.sourceFindingForInlineComment(comment) === sourceFinding
    );
    if (!inline) {
      return {
        lineageId: occurrence.lineageId,
        kind: FindingPlacementKind.File,
        path: revisionFile.path,
        reason: 'legacy synthesis did not select inline placement',
      };
    }
    if (occurrence.anchorVerified === true) {
      // §8.2: a verified HEAD span must survive to the final placement
      // verbatim; chooseBestAddedLineForComment may never move it to a
      // neighboring added line. If the full range is not provably placeable
      // in the current diff, degrade to file placement without the
      // committable suggested patch.
      const positions = mapLinesToPositions(revisionFile.patch);
      const rangeStart = occurrence.startLine ?? line;
      const rangeEnd = occurrence.endLine ?? line;
      const low = Math.min(rangeStart, rangeEnd);
      const high = Math.max(rangeStart, rangeEnd);
      let rangePlaceable = positions.has(line);
      for (let current = low; rangePlaceable && current <= high; current += 1) {
        rangePlaceable = positions.has(current);
      }
      if (!rangePlaceable) {
        return {
          lineageId: occurrence.lineageId,
          kind: FindingPlacementKind.File,
          path: revisionFile.path,
          reason:
            'verified span range is not provably placeable in the current diff',
        };
      }
      return {
        lineageId: occurrence.lineageId,
        kind: FindingPlacementKind.Inline,
        path: revisionFile.path,
        ...(rangeStart < rangeEnd ? { startLine: rangeStart } : {}),
        // GitHub's publication line is the end of a multiline range.
        line: rangeEnd,
        endLine: rangeEnd,
        body: inline.body,
      };
    }
    const correctedLine = chooseBestAddedLineForComment(
      revisionFile.patch,
      inline.line,
      inline.body
    );
    if (!mapLinesToPositions(revisionFile.patch).has(correctedLine)) {
      return {
        lineageId: occurrence.lineageId,
        kind: FindingPlacementKind.File,
        path: revisionFile.path,
        reason: 'line is not provably placeable in the current diff',
      };
    }
    return {
      lineageId: occurrence.lineageId,
      kind: FindingPlacementKind.Inline,
      path: revisionFile.path,
      ...(inline.startLine !== undefined
        ? { startLine: inline.startLine }
        : {}),
      line: correctedLine,
      ...(inline.endLine !== undefined ? { endLine: inline.endLine } : {}),
      body: inline.body,
    };
  }
}

function lifecycleLinesForSummary(
  occurrences: readonly FindingOccurrence[],
  lifecycle?: ProjectReviewPresentationQuery['lifecycle']
): ReviewerLifecycleLine[] {
  const lines: ReviewerLifecycleLine[] = [];
  const representedTargetIds = new Set<string>();
  const attentionReasons = new Map(
    (lifecycle?.facts ?? []).map((fact) => [
      fact.targetId,
      fact.reasonCodes.includes('human_reply')
        ? 'human discussion; no automatic resolution'
        : fact.reasonCodes.includes('outside_review_scope')
          ? 'outside review scope; not revalidated'
          : 'resolution not established',
    ])
  );
  for (const occurrence of occurrences) {
    const kind = lifecycleKindForSummary(occurrence.state);
    if (!kind) {
      continue;
    }
    // Only an actually emitted historical line with an unambiguous lineage
    // join represents a lifecycle target. Current findings are not attention.
    const matchingFacts = (lifecycle?.facts ?? []).filter(
      (fact) =>
        fact.lineageId === occurrence.lineageId &&
        fact.verdict === LifecycleRevalidationVerdict.Uncertain
    );
    const fact = matchingFacts.length === 1 ? matchingFacts[0] : undefined;
    if (fact) representedTargetIds.add(fact.targetId);
    lines.push({
      kind,
      title: occurrence.title,
      message: fact
        ? `${occurrence.message} (${attentionReasons.get(fact.targetId)})`
        : occurrence.message,
      locationLabel: findingLocationLabel({
        file: occurrence.filePath,
        line: occurrence.line ?? occurrence.endLine ?? 1,
        ...(occurrence.startLine !== undefined
          ? { startLine: occurrence.startLine }
          : {}),
        ...(occurrence.endLine !== undefined
          ? { endLine: occurrence.endLine }
          : {}),
      }),
    });
  }
  for (const fact of lifecycle?.facts ?? []) {
    if (
      fact.verdict !== LifecycleRevalidationVerdict.Uncertain ||
      representedTargetIds.has(fact.targetId)
    )
      continue;
    const target = lifecycle?.targets.find(
      (candidate) => candidate.targetId === fact.targetId
    );
    if (!target) continue;
    lines.push({
      kind: 'uncertain',
      title: target.title,
      message: `${target.message} (${attentionReasons.get(fact.targetId)})`,
      locationLabel: findingLocationLabel({
        file: target.currentPath ?? target.originalPath,
        line: target.currentLine ?? target.originalLine ?? 1,
      }),
    });
    representedTargetIds.add(fact.targetId);
  }
  return lines;
}

function lifecycleKindForSummary(
  state: FindingOccurrenceState
): ReviewerLifecycleLine['kind'] | null {
  switch (state) {
    case FindingOccurrenceState.Resolved:
      return 'resolved';
    case FindingOccurrenceState.CarriedUnverified:
      return 'carried';
    case FindingOccurrenceState.Uncertain:
      return 'uncertain';
    case FindingOccurrenceState.SuppressedByHuman:
      return 'suppressed';
    default:
      return null;
  }
}

function toLegacyFinding(
  finding: CurrentFindingCandidate | SelectedCurrentFinding | FindingOccurrence
): FindingWithProjectionMetadata {
  const occurrence = 'lineageId' in finding ? finding : undefined;
  const sourceFindingId =
    'sourceFindingId' in finding
      ? finding.sourceFindingId
      : (occurrence?.sourceFindingIds[0] ??
        occurrence?.lineageId ??
        'historical');
  return {
    file: 'filePath' in finding ? finding.filePath : '',
    ...(finding.startLine !== undefined
      ? { startLine: finding.startLine }
      : {}),
    line:
      finding.line ??
      finding.endLine ??
      (finding.anchorVerified === false ? 0 : 1),
    ...(finding.endLine !== undefined ? { endLine: finding.endLine } : {}),
    severity: toLegacySeverity(finding.severity),
    title: finding.title,
    message: finding.message,
    ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
    provider: 'providerIds' in finding ? finding.providerIds[0] : undefined,
    providers: 'providerIds' in finding ? [...finding.providerIds] : undefined,
    providerVoteKeys: [...finding.providerVoteKeys],
    confidence: 'confidence' in finding ? finding.confidence : undefined,
    category: finding.category,
    sourceFindingIds:
      'sourceFindingIds' in finding
        ? [...finding.sourceFindingIds]
        : [sourceFindingId],
    projectionSourceFindingId: sourceFindingId,
    projectionCategory: finding.category,
    projectionFailureModeHash: finding.normalizedFailureModeHash,
    ...(finding.symbolAnchor
      ? { projectionSymbolAnchor: finding.symbolAnchor }
      : {}),
    ...(finding.trustedMarker
      ? { projectionTrustedMarker: finding.trustedMarker }
      : {}),
    projectionObservationIds: [...finding.observationIds],
  };
}

function lifecycleProviderResults(
  query: ProjectLifecycleQuery
): ProviderResult[] {
  const byProvider = new Map<string, typeof query.revalidations>();
  for (const revalidation of query.revalidations) {
    const existing = byProvider.get(revalidation.providerVoteKey) ?? [];
    byProvider.set(revalidation.providerVoteKey, [...existing, revalidation]);
  }
  return Array.from(byProvider.entries()).map(([provider, revalidations]) => ({
    name: provider,
    status: 'success',
    durationSeconds: 0,
    lifecycleAssignedTargetIds: revalidations.map(
      (revalidation) => revalidation.targetId
    ),
    result: {
      content: '',
      revalidations: revalidations.map((revalidation) => ({
        targetId: revalidation.targetId,
        verdict: revalidation.verdict,
        ...(revalidation.confidence !== undefined
          ? { confidence: revalidation.confidence }
          : {}),
        ...(revalidation.rationale
          ? { rationale: revalidation.rationale }
          : {}),
      })),
    },
  }));
}

function toLegacyLifecycleTarget(
  target: ProjectLifecycleQuery['inventory']['targets'][number]
): LifecycleTarget {
  return {
    targetId: target.targetId,
    threadId: target.threadId,
    fingerprint: target.trustedMarker,
    severity: target.severity,
    title: target.title,
    message: target.message,
    originalPath: target.originalPath,
    ...(target.currentPath ? { currentPath: target.currentPath } : {}),
    ...(target.originalLine !== undefined
      ? { originalLine: target.originalLine }
      : {}),
    ...(target.currentLine !== undefined
      ? { currentLine: target.currentLine }
      : {}),
    parentCommentId: target.targetId,
    parentCommentUpdatedAt: target.parentCommentUpdatedAt,
    threadCommentCount: target.threadCommentCount,
    viewerCanResolve: target.viewerCanResolve,
    hasHumanReply: target.disposition === LifecycleTargetDisposition.HumanReply,
    trustedAuthor: true,
  };
}

function legacyLifecycleRecord(
  target: LifecycleTarget,
  reasonCodes: LifecycleReasonCode[]
): LifecycleThreadRecord {
  return { target, reasonCodes };
}

function toLegacyPrContext(query: ProjectReviewPresentationQuery): PRContext {
  return {
    number: query.scope.pullRequestNumber,
    title: query.presentation.title,
    body: '',
    author: query.presentation.author,
    draft: false,
    labels: [],
    files: query.revisionFiles.map(toLegacyFileChange),
    diff: query.revisionFiles
      .map((file) => file.patch ?? '')
      .filter(Boolean)
      .join('\n'),
    additions: query.presentation.additions,
    deletions: query.presentation.deletions,
    baseSha: query.scope.baseSha,
    headSha: query.scope.reviewedHeadSha,
  };
}

function toLegacyFileChange(file: RevisionFile): FileChange {
  return {
    filename: file.path,
    status: file.status,
    additions: 0,
    deletions: 0,
    changes: 0,
    ...(file.patch ? { patch: file.patch } : {}),
    ...(file.previousPath ? { previousFilename: file.previousPath } : {}),
  };
}

function minimalLegacyReview(findings: Finding[]): Review {
  return {
    summary: '',
    findings,
    inlineComments: [],
    actionItems: [],
    metrics: {
      totalFindings: findings.length,
      critical: findings.filter((finding) => finding.severity === 'critical')
        .length,
      major: findings.filter((finding) => finding.severity === 'major').length,
      minor: findings.filter((finding) => finding.severity === 'minor').length,
      providersUsed: 0,
      providersSuccess: 0,
      providersFailed: 0,
      totalTokens: 0,
      totalCost: 0,
      durationSeconds: 0,
    },
  };
}

function findRevisionFile(
  path: string,
  revisionFiles: readonly RevisionFile[]
): RevisionFile | undefined {
  const normalized = normalizePath(path);
  return revisionFiles.find(
    (file) =>
      normalizePath(file.path) === normalized ||
      (file.previousPath && normalizePath(file.previousPath) === normalized)
  );
}

function summaryPlacement(
  occurrence: FindingOccurrence,
  reason: string
): FindingPlacementDecision {
  return {
    lineageId: occurrence.lineageId,
    kind: FindingPlacementKind.Summary,
    path: occurrence.filePath,
    reason,
  };
}

function isCurrentOccurrence(occurrence: FindingOccurrence): boolean {
  return (
    occurrence.state === FindingOccurrenceState.New ||
    occurrence.state === FindingOccurrenceState.Reconfirmed ||
    occurrence.state === FindingOccurrenceState.Changed
  );
}

function toProjectionSeverity(severity: Severity): FindingSeverity {
  return severity as FindingSeverity;
}

function toLegacySeverity(severity: FindingSeverity): Severity {
  return severity as Severity;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function sortedUnique(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right)
  );
}
