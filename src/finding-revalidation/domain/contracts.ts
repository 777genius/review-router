import type {
  LifecycleVerificationEvidenceV1,
  LifecycleVerificationResultV1,
} from '../../control-plane/generated/review-action-v2/companion-contracts';

export type RevalidationSeverity = 'critical' | 'major' | 'minor' | 'unknown';
export type RevalidationVerdict = LifecycleVerificationResultV1['verdict'];
export type RevalidationScope = Readonly<{
  workspaceId: string;
  repositoryConnectionId: string;
  repository: string;
  pullRequestNumber: number;
  baseSha: string;
  mergeBaseSha: string;
  headSha: string;
  reviewRevisionHash: string;
}>;

/** Facts supplied by the trusted inventory/history adapters, never inferred from prose. */
export type PriorResolutionFact = Readonly<{
  historyCut: string;
  guardVersion: string;
  state:
    | 'no_prior_since_creation'
    | 'before_cut_unobserved'
    | 'previously_resolved'
    | 'effect_unknown'
    | 'unavailable';
}>;
export type RevalidationTarget = Readonly<{
  targetId: string;
  threadId: string;
  fingerprint: string;
  parentId: string;
  parentCreatedAt: string;
  parentUpdatedAt: string;
  parentBodyHash: string;
  claimHash: string;
  commentStateHash: string;
  ledgerWatermark: string;
  originalPath: string;
  currentPath: string | null;
  originalLine: number | null;
  currentLine: number | null;
  severity: RevalidationSeverity;
  title: string;
  message: string;
  diffHunk: string | null;
  isResolved: boolean;
  trusted: boolean;
  hasHumanReply: boolean;
  parentEdited: boolean;
  markerAmbiguous: boolean;
  commandDismissed: boolean;
}>;
export type TargetWitness = Readonly<{
  targetId: string;
  threadId: string;
  fingerprint: string;
  parentId: string;
  parentCreatedAt: string;
  parentUpdatedAt: string;
  parentBodyHash: string;
  claimHash: string;
  commentStateHash: string;
  ledgerWatermark: string;
  originalPath: string;
  currentPath: string | null;
  originalLine: number | null;
  currentLine: number | null;
  severity: RevalidationSeverity;
  resolutionHistory: PriorResolutionFact;
}>;
export type ImmutableSource = Readonly<{
  headSha: string;
  path: string;
  blobOid: string;
  contentHash: string;
  content: string;
  byteCount: number;
  lineCount: number;
  complete: true;
  inclusionReason: 'target_file' | 'native_rename';
}>;
export type SourceReadResult =
  | Readonly<{
      kind: 'file';
      headSha: string;
      path: string;
      blobOid: string;
      bytes: Uint8Array;
    }>
  | Readonly<{ kind: 'missing' | 'unsupported' | 'oversized' }>;
export interface ImmutableSourceReader {
  read(
    input: Readonly<{ headSha: string; path: string; maxBytes: number }>
  ): Promise<SourceReadResult>;
}
export interface PriorResolutionHistory {
  read(
    target: RevalidationTarget,
    scope: RevalidationScope
  ): Promise<PriorResolutionFact>;
}
export type RevalidationParticipant = Readonly<{
  voteIdentityHash: string;
  capabilityDigest: string;
  model: string;
}>;
export type PacketTarget = Readonly<{
  witness: TargetWitness;
  claim: Readonly<{ title: string; message: string; diffHunk: string | null }>;
  sourcePath: string;
}>;
export type VerifyPacket = Readonly<{
  version: 1;
  promptVersion: string;
  outputSchemaVersion: 1;
  sourcePolicyVersion: 'target-file-only.v1';
  omissions: readonly never[];
  scope: RevalidationScope;
  participant: RevalidationParticipant;
  targets: readonly PacketTarget[];
  sources: readonly ImmutableSource[];
  policyDigest: string;
  resolveConfidenceThresholds: Readonly<Record<RevalidationSeverity, number>>;
  packetHash: string;
}>;
export type RevalidationReason =
  | 'native_resolved'
  | 'human_discussion'
  | 'command_dismissed'
  | 'untrusted_target'
  | 'parent_changed'
  | 'previously_resolved_thread_reopened'
  | 'resolution_effect_unknown'
  | 'verification_unavailable'
  | 'verification_configuration_invalid'
  | 'inventory_incomplete'
  | 'sensitive_context_unavailable'
  | 'context_insufficient'
  | 'unsupported_source'
  | 'claim_oversized'
  | 'source_oversized'
  | 'verification_capped'
  | 'request_oversized'
  | 'missing_or_invalid_verdict'
  | 'verification_failed'
  | 'verified';
export type TargetDisposition = Readonly<{
  targetId: string;
  disposition:
    | 'eligible'
    | 'manual'
    | 'unsupported'
    | 'capped'
    | 'unavailable'
    | 'resolved';
  reason: RevalidationReason;
  packetHash: string | null;
}>;
export type RevalidationPlan = Readonly<{
  packets: readonly VerifyPacket[];
  dispositions: readonly TargetDisposition[];
  inventoryHash: string;
  inventoryCount: number;
  participantRoster: readonly RevalidationParticipant[];
  outputCap: number;
  maxResponseBytes: number;
}>;
export type RevalidationLimits = Readonly<{
  gatewayOutputTokens: number;
  modelOutputTokens: number;
  remainingWorkSlots: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxFileBytes?: number;
  maxSourceBytes?: number;
  maxClaimBytes?: number;
}>;
export type PreparedPacket = Readonly<{
  packet: VerifyPacket;
  request: Readonly<Record<string, unknown>>;
  requestBytes: Uint8Array;
  requestHash: string;
  outputCap: number;
}>;
export type LifecycleInferenceResult = Readonly<{
  body: Uint8Array;
  actualModel: string;
  requestHash: string;
  nativeUsage?: Readonly<{
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    reasoningTokens?: number;
  }>;
}>;
/** The adapter owns lease, dispatch admission and one-shot transport. */
export interface LifecycleInference {
  infer(
    prepared: PreparedPacket,
    signal: AbortSignal
  ): Promise<LifecycleInferenceResult>;
}
export type RevalidationEvidence = LifecycleVerificationEvidenceV1;
export type AcceptedRevalidation = LifecycleVerificationResultV1;
export type PacketValidation =
  | Readonly<{ valid: true; results: readonly AcceptedRevalidation[] }>
  | Readonly<{ valid: false; reason: 'missing_or_invalid_verdict' }>;
