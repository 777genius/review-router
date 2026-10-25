import {
  CheckConclusion,
  CurrentFindingCandidate,
  CurrentLifecycleInventory,
  FindingOccurrence,
  FindingPlacementDecision,
  FindingSeverity,
  LifecycleProjectionDecision,
  LiveLifecycleTarget,
  ReviewProjectionLifecycleFact,
  LifecycleRevalidation,
  LifecycleVerificationContext,
  LifecycleVerificationFact,
  MergeGateConclusion,
  PriorLineageHint,
  ReviewCoverageFact,
  ReviewProjectionPresentationContext,
  ReviewProjectionScope,
  RevisionFile,
  SelectedCurrentFinding,
} from '../domain/review-projection';
import { ReviewProjectionLimits } from '../domain/review-projection-limits';
import type { AppliedReviewResolution } from '../domain/comparison-baseline';
import type { ReviewPresentation } from '../domain/review-presentation';

export interface LoadCurrentLifecycleInventoryQuery {
  readonly scope: ReviewProjectionScope;
  readonly priorLineageHints?: readonly PriorLineageHint[];
  readonly appliedResolutions?: readonly AppliedReviewResolution[];
}

export interface CurrentLifecycleInventoryPort {
  loadCurrent(
    query: LoadCurrentLifecycleInventoryQuery
  ): Promise<CurrentLifecycleInventory>;
}

export interface SelectCurrentFindingsQuery {
  readonly findings: readonly CurrentFindingCandidate[];
  readonly revisionFiles: readonly RevisionFile[];
  readonly diff: string;
  readonly limits: ReviewProjectionLimits;
}

export interface CurrentFindingPolicyPort {
  selectCurrent(
    query: SelectCurrentFindingsQuery
  ): Promise<readonly SelectedCurrentFinding[]>;
}

export interface ProjectLifecycleQuery {
  readonly scope: ReviewProjectionScope;
  readonly findings: readonly SelectedCurrentFinding[];
  readonly priorLineageHints: readonly PriorLineageHint[];
  readonly inventory: CurrentLifecycleInventory;
  readonly revalidations: readonly LifecycleRevalidation[];
  readonly lifecycleVerification?: LifecycleVerificationContext;
  readonly recurrenceVetoTargetIds?: readonly string[];
}

export interface ReviewLifecyclePolicyPort {
  recurrenceVetoTargetIds?(query: {
    readonly findings: readonly CurrentFindingCandidate[];
    readonly inventory: CurrentLifecycleInventory;
  }): readonly string[];
  projectLifecycle(
    query: ProjectLifecycleQuery
  ): Promise<readonly LifecycleProjectionDecision[]>;
}

export interface ProjectReviewPresentationQuery {
  readonly reviewPresentation?: ReviewPresentation;
  readonly lifecycle?: {
    readonly targets: readonly LiveLifecycleTarget[];
    readonly facts: readonly ReviewProjectionLifecycleFact[];
  };
  readonly scope: ReviewProjectionScope;
  readonly presentation: ReviewProjectionPresentationContext;
  readonly providerExecution: ProviderExecutionSummaryFact;
  readonly coverage: ReviewCoverageFact;
  readonly incompleteCauses?: readonly string[];
  readonly occurrences: readonly FindingOccurrence[];
  readonly revisionFiles: readonly RevisionFile[];
  readonly limits: ReviewProjectionLimits;
}

export interface ProviderExecutionSummaryFact {
  readonly plannedProviders: number;
  readonly succeededProviders: number;
}

export interface ProjectedReviewPresentation {
  readonly summaryBody: string;
  readonly checkName: string;
  readonly checkTitle: string;
  readonly checkSummary: string;
  readonly checkConclusion?: CheckConclusion;
  readonly placements: readonly FindingPlacementDecision[];
}

export interface ReviewPresentationPolicyPort {
  projectPresentation(
    query: ProjectReviewPresentationQuery
  ): Promise<ProjectedReviewPresentation>;
}

export interface EvaluateMergeGateQuery {
  readonly failOnSeverity?: FindingSeverity;
  readonly occurrences: readonly FindingOccurrence[];
  readonly coverage: ReviewCoverageFact;
  readonly lifecycleInventoryComplete: boolean;
  readonly lifecycleVerificationFacts?: readonly LifecycleVerificationFact[];
}

export interface MergeGateDecision {
  readonly conclusion: MergeGateConclusion;
  readonly blockingLineageIds: readonly string[];
  readonly blockingConfirmedLifecycleTargetIds?: readonly string[];
  readonly reasonCodes: readonly string[];
}

export interface ReviewMergeGatePolicyPort {
  evaluateMergeGate(query: EvaluateMergeGateQuery): MergeGateDecision;
}
