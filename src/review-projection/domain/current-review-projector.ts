import {
  CurrentLifecycleInventory,
  FindingOccurrence,
  FindingOccurrenceState,
  FindingPlacementKind,
  LifecycleProjectionDecision,
  LifecycleRevalidationVerdict,
  LifecycleResolutionMarkerTrust,
  LifecycleTargetDisposition,
  PriorLineageHint,
  ReviewProjectionScope,
  SelectedCurrentFinding,
} from './review-projection';
import { hashProjectionFact } from './review-projection-canonicalizer';

export interface ProjectCurrentOccurrencesInput {
  readonly scope: ReviewProjectionScope;
  readonly selectedFindings: readonly SelectedCurrentFinding[];
  readonly priorLineageHints: readonly PriorLineageHint[];
  readonly inventory: CurrentLifecycleInventory;
  readonly lifecycleDecisions: readonly LifecycleProjectionDecision[];
}

/** Domain service and sole owner of lineage assignment and occurrence state. */
export class CurrentReviewProjector {
  projectOccurrences(
    input: ProjectCurrentOccurrencesInput
  ): FindingOccurrence[] {
    const occurrences: FindingOccurrence[] = [];
    const matchedLineages = new Set<string>();

    for (const finding of input.selectedFindings) {
      const hint = this.matchPriorLineage(finding, input.priorLineageHints);
      const lineageId =
        hint?.lineageId ?? this.createLineageId(input.scope, finding);
      if (hint) matchedLineages.add(hint.lineageId);

      const target = this.findTargetForLineage(
        lineageId,
        input.inventory.targets
      );
      const suppressed =
        target?.disposition === LifecycleTargetDisposition.CommandSuppressed;
      const state = suppressed
        ? FindingOccurrenceState.SuppressedByHuman
        : hint
          ? hint.severity === finding.severity
            ? FindingOccurrenceState.Reconfirmed
            : FindingOccurrenceState.Changed
          : FindingOccurrenceState.New;

      occurrences.push({
        lineageId,
        sourceFindingIds: sortedUnique(finding.sourceFindingIds),
        state,
        severity: finding.severity,
        ...(hint && hint.severity !== finding.severity
          ? { previousSeverity: hint.severity }
          : {}),
        category: finding.category,
        normalizedFailureModeHash: finding.normalizedFailureModeHash,
        ...(finding.symbolAnchor ? { symbolAnchor: finding.symbolAnchor } : {}),
        trustedMarker: lineageId,
        ...(finding.anchorVerified !== undefined
          ? { anchorVerified: finding.anchorVerified }
          : {}),
        title: finding.title,
        message: finding.message,
        ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
        filePath: finding.filePath,
        ...(finding.startLine !== undefined
          ? { startLine: finding.startLine }
          : {}),
        ...(finding.line !== undefined ? { line: finding.line } : {}),
        ...(finding.endLine !== undefined ? { endLine: finding.endLine } : {}),
        placement: summaryPlacement(lineageId, finding.filePath, 'pending'),
        providerVoteKeys: sortedUnique(finding.providerVoteKeys),
        observationIds: sortedUnique(finding.observationIds),
        firstSeenHeadSha: hint?.firstSeenHeadSha ?? input.scope.reviewedHeadSha,
        sourceHeadSha: input.scope.reviewedHeadSha,
        blocking: false,
      });
    }

    const decisionByTarget = new Map(
      input.lifecycleDecisions.map((decision) => [decision.targetId, decision])
    );
    for (const hint of input.priorLineageHints) {
      if (matchedLineages.has(hint.lineageId) || !hint.active) continue;
      const target = this.findTargetForLineage(
        hint.lineageId,
        input.inventory.targets
      );
      const decision = target
        ? decisionByTarget.get(target.targetId)
        : undefined;
      const observations = (input.inventory.resolvedObservations ?? []).filter(
        (item) =>
          item.lineageId === hint.lineageId &&
          item.trustedMarker === hint.lineageId
      );
      const confirmedClosed =
        input.inventory.complete &&
        !input.inventory.targets.some(
          (item) => item.trustedMarker === hint.lineageId
        ) &&
        observations.length === 1 &&
        observations[0].confirmed;
      const state = confirmedClosed
        ? FindingOccurrenceState.Resolved
        : target
          ? this.priorOccurrenceState(target, decision?.verdict)
          : FindingOccurrenceState.CarriedUnverified;

      occurrences.push({
        lineageId: hint.lineageId,
        sourceFindingIds: [],
        state,
        severity: hint.severity,
        category: hint.category,
        normalizedFailureModeHash: hint.normalizedFailureModeHash,
        ...(hint.symbolAnchor ? { symbolAnchor: hint.symbolAnchor } : {}),
        trustedMarker: hint.lineageId,
        title: hint.title,
        message: hint.message,
        filePath: target?.currentPath ?? hint.filePath,
        ...(hint.startLine !== undefined ? { startLine: hint.startLine } : {}),
        ...(target?.currentLine !== undefined
          ? { line: target.currentLine }
          : hint.line !== undefined
            ? { line: hint.line }
            : {}),
        ...(hint.endLine !== undefined ? { endLine: hint.endLine } : {}),
        placement: summaryPlacement(
          hint.lineageId,
          target?.currentPath ?? hint.filePath,
          'historical occurrence'
        ),
        providerVoteKeys: [],
        observationIds: [],
        firstSeenHeadSha: hint.firstSeenHeadSha,
        sourceHeadSha: input.scope.reviewedHeadSha,
        blocking: false,
      });
    }

    return sortOccurrences(occurrences);
  }

  private priorOccurrenceState(
    target: CurrentLifecycleInventory['targets'][number],
    verdict?: LifecycleRevalidationVerdict
  ): FindingOccurrenceState {
    if (target.disposition === LifecycleTargetDisposition.CommandSuppressed) {
      return FindingOccurrenceState.SuppressedByHuman;
    }
    if (target.disposition === LifecycleTargetDisposition.HumanReply) {
      return FindingOccurrenceState.Uncertain;
    }
    if (hasValidTrustedResolutionMarker(target)) {
      return FindingOccurrenceState.CarriedUnverified;
    }
    if (verdict === LifecycleRevalidationVerdict.Resolved) {
      return FindingOccurrenceState.CarriedUnverified;
    }
    if (verdict === LifecycleRevalidationVerdict.StillValid) {
      return FindingOccurrenceState.CarriedUnverified;
    }
    return FindingOccurrenceState.Uncertain;
  }

  private matchPriorLineage(
    finding: SelectedCurrentFinding,
    hints: readonly PriorLineageHint[]
  ): PriorLineageHint | undefined {
    const byMarker = finding.trustedMarker
      ? hints.filter(
          (hint) =>
            hint.trustedMarker === finding.trustedMarker &&
            hint.normalizedFailureModeHash === finding.normalizedFailureModeHash
        )
      : [];
    if (byMarker.length === 1) return byMarker[0];
    if (byMarker.length > 1) return undefined;

    const byAnchor = hints.filter(
      (hint) =>
        hint.category === finding.category &&
        hint.normalizedFailureModeHash === finding.normalizedFailureModeHash &&
        Boolean(hint.symbolAnchor) &&
        hint.symbolAnchor === finding.symbolAnchor
    );
    if (byAnchor.length === 1) return byAnchor[0];
    if (byAnchor.length > 1) return undefined;

    const byLocation = hints.filter(
      (hint) =>
        hint.category === finding.category &&
        hint.normalizedFailureModeHash === finding.normalizedFailureModeHash &&
        normalizePath(hint.filePath) === normalizePath(finding.filePath) &&
        hint.line !== undefined &&
        finding.line !== undefined &&
        Math.abs(hint.line - finding.line) <= 2
    );
    return byLocation.length === 1 ? byLocation[0] : undefined;
  }

  private findTargetForLineage(
    lineageId: string,
    targets: CurrentLifecycleInventory['targets']
  ): CurrentLifecycleInventory['targets'][number] | undefined {
    const matches = targets.filter(
      (target) => target.trustedMarker === lineageId
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  private createLineageId(
    scope: ReviewProjectionScope,
    finding: SelectedCurrentFinding
  ): string {
    return `rrl_${hashProjectionFact({
      scmRepositoryIdentityId: scope.scmRepositoryIdentityId,
      pullRequestNumber: scope.pullRequestNumber,
      category: finding.category,
      normalizedFailureModeHash: finding.normalizedFailureModeHash,
      symbolAnchor: finding.symbolAnchor ?? null,
      firstSeenHeadSha: scope.reviewedHeadSha,
      trustedMarker: finding.trustedMarker ?? null,
    }).slice(0, 32)}`;
  }
}

export function hasValidTrustedResolutionMarker(
  target: CurrentLifecycleInventory['targets'][number]
): boolean {
  const marker = target.resolutionMarker;
  return Boolean(
    marker &&
    marker.trust === LifecycleResolutionMarkerTrust.Trusted &&
    marker.schemaVersion === 'reviewrouter-lifecycle-resolution.v1' &&
    marker.targetId === target.targetId &&
    marker.fingerprint === target.trustedMarker
  );
}

function summaryPlacement(lineageId: string, path: string, reason: string) {
  return {
    lineageId,
    kind: FindingPlacementKind.Summary,
    path,
    reason,
  } as const;
}

function sortOccurrences(
  occurrences: readonly FindingOccurrence[]
): FindingOccurrence[] {
  const stateOrder: Record<FindingOccurrenceState, number> = {
    [FindingOccurrenceState.New]: 0,
    [FindingOccurrenceState.Changed]: 1,
    [FindingOccurrenceState.Reconfirmed]: 2,
    [FindingOccurrenceState.CarriedUnverified]: 3,
    [FindingOccurrenceState.Uncertain]: 4,
    [FindingOccurrenceState.Resolved]: 5,
    [FindingOccurrenceState.SuppressedByHuman]: 6,
  };
  const severityOrder = {
    critical: 0,
    major: 1,
    minor: 2,
  } as const;
  return [...occurrences].sort(
    (left, right) =>
      stateOrder[left.state] - stateOrder[right.state] ||
      severityOrder[left.severity] - severityOrder[right.severity] ||
      left.filePath.localeCompare(right.filePath) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.lineageId.localeCompare(right.lineageId)
  );
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function sortedUnique(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right)
  );
}
