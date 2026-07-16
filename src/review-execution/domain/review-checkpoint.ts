import { z } from 'zod';
import { redactSensitiveText } from '../../utils/redaction';

export const REVIEW_CHECKPOINT_PROTOCOL_VERSION = 1 as const;
export const REVIEW_CHECKPOINT_MAX_REQUEST_BYTES = 128 * 1024;
export const REVIEW_CHECKPOINT_MAX_AGGREGATE_BYTES = 2 * 1024 * 1024;

const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const MAX_FILE_PATHS = 200;
const MAX_PLANNED_WORK_KEYS = 200;
const MAX_FINDINGS = 500;
const MAX_PROVIDER_RESULTS = 50;
const MAX_LIFECYCLE_TARGETS = 200;
const MAX_REVALIDATIONS = 200;
const MAX_REVALIDATION_EVIDENCE = 20;
const MAX_DURATION_MS = 24 * 60 * 60 * 1_000;
const MAX_TOKEN_COUNT = 1_000_000_000;

export enum ReviewCheckpointRestoreStatus {
  Found = 'found',
  Missing = 'missing',
}

export enum ReviewCheckpointStartStatus {
  Started = 'started',
  Replaced = 'replaced',
  Idempotent = 'idempotent',
  Conflict = 'conflict',
}

export enum ReviewCheckpointBatchResultStatus {
  Accepted = 'accepted',
  Idempotent = 'idempotent',
  Conflict = 'conflict',
}

export enum ReviewCheckpointFinalizeStatus {
  Finalized = 'finalized',
  Idempotent = 'idempotent',
  Conflict = 'conflict',
}

export enum ReviewCheckpointClearStatus {
  Cleared = 'cleared',
  Missing = 'missing',
  Conflict = 'conflict',
}

export enum ReviewCheckpointProviderStatus {
  Success = 'success',
  Error = 'error',
  Timeout = 'timeout',
  RateLimited = 'rate_limited',
}

export enum ReviewCheckpointFindingSeverity {
  Critical = 'critical',
  Major = 'major',
  Minor = 'minor',
}

export enum ReviewCheckpointLifecycleVerdict {
  Resolved = 'resolved',
  StillValid = 'still_valid',
  Uncertain = 'uncertain',
}

export const reviewCheckpointPlanIdentitySchema = z
  .object({
    pullRequestNumber: z.number().int().positive(),
    baseSha: z.string().regex(GIT_SHA_PATTERN),
    headSha: z.string().regex(GIT_SHA_PATTERN),
    compatibilityKey: z.string().regex(HASH_PATTERN),
    planHash: z.string().regex(HASH_PATTERN),
    workKeys: z
      .array(z.string().regex(HASH_PATTERN))
      .max(MAX_PLANNED_WORK_KEYS),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.workKeys.map((key) => key.toLowerCase())).size !==
      value.workKeys.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Checkpoint work keys must be unique',
        path: ['workKeys'],
      });
    }
  });

const checkpointFindingSchema = z
  .object({
    file: z.string().min(1).max(4_096),
    startLine: z.number().int().positive().optional(),
    line: z.number().int().positive(),
    endLine: z.number().int().positive().optional(),
    severity: z.nativeEnum(ReviewCheckpointFindingSeverity),
    title: z.string().min(1).max(1_000),
    message: z.string().min(1).max(20_000),
    provider: z.string().min(1).max(500).optional(),
    providers: z.array(z.string().min(1).max(500)).max(50).optional(),
    actualModel: z.string().min(1).max(500).optional(),
    providerVoteKeys: z.array(z.string().min(1).max(500)).max(50).optional(),
    providerPoolSize: z.number().int().positive().optional(),
    confidence: z.number().min(0).max(1).optional(),
    category: z.string().min(1).max(500).optional(),
    hasConsensus: z.boolean().optional(),
  })
  .strict();

const lifecycleEvidenceSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    reason: z.string().min(1).max(2_000),
  })
  .strict();

const lifecycleRevalidationSchema = z
  .object({
    targetId: z.string().min(1).max(500),
    fingerprint: z.string().min(1).max(500).optional(),
    verdict: z.nativeEnum(ReviewCheckpointLifecycleVerdict),
    confidence: z.number().min(0).max(1).optional(),
    evidence: z
      .array(lifecycleEvidenceSchema)
      .max(MAX_REVALIDATION_EVIDENCE)
      .optional(),
    rationale: z.string().min(1).max(2_000).optional(),
  })
  .strict();

const checkpointProviderResultSchema = z
  .object({
    name: z.string().min(1).max(500),
    status: z.nativeEnum(ReviewCheckpointProviderStatus),
    durationMs: z.number().int().min(0).max(MAX_DURATION_MS),
    errorMessage: z.string().min(1).max(1_000).optional(),
    actualModel: z.string().min(1).max(500).optional(),
    aiLikelihood: z.number().min(0).max(1).optional(),
    usage: z
      .object({
        promptTokens: z.number().int().min(0).max(MAX_TOKEN_COUNT),
        completionTokens: z.number().int().min(0).max(MAX_TOKEN_COUNT),
        totalTokens: z.number().int().min(0).max(MAX_TOKEN_COUNT),
      })
      .strict()
      .optional(),
    lifecycleAssignedTargetIds: z
      .array(z.string().min(1).max(500))
      .max(MAX_LIFECYCLE_TARGETS)
      .refine((items) => new Set(items).size === items.length)
      .optional(),
    lifecycleRevalidations: z
      .array(lifecycleRevalidationSchema)
      .max(MAX_REVALIDATIONS)
      .optional(),
  })
  .strict();

export const reviewCheckpointBatchPayloadSchema = z
  .object({
    filePaths: z
      .array(z.string().min(1).max(4_096))
      .max(MAX_FILE_PATHS)
      .refine((items) => new Set(items).size === items.length),
    findings: z.array(checkpointFindingSchema).max(MAX_FINDINGS),
    providerResults: z
      .array(checkpointProviderResultSchema)
      .max(MAX_PROVIDER_RESULTS),
  })
  .strict();

export const reviewCheckpointFinalizationMarkerSchema = z
  .object({
    protocolVersion: z.literal(REVIEW_CHECKPOINT_PROTOCOL_VERSION),
    pullRequestNumber: z.number().int().positive(),
    headSha: z.string().regex(GIT_SHA_PATTERN),
    planHash: z.string().regex(HASH_PATTERN),
    expectedVersion: z.number().int().nonnegative(),
    snapshotAdvancementRequired: z.boolean(),
  })
  .strict();

export type ReviewCheckpointPlanIdentity = z.infer<
  typeof reviewCheckpointPlanIdentitySchema
>;
export type ReviewCheckpointFinding = z.infer<typeof checkpointFindingSchema>;
export type ReviewCheckpointLifecycleRevalidation = z.infer<
  typeof lifecycleRevalidationSchema
>;
export type ReviewCheckpointProviderResult = z.infer<
  typeof checkpointProviderResultSchema
>;
export type ReviewCheckpointBatchPayload = z.infer<
  typeof reviewCheckpointBatchPayloadSchema
>;
export type ReviewCheckpointFinalizationMarker = z.infer<
  typeof reviewCheckpointFinalizationMarkerSchema
>;

export interface ReviewCheckpointAcceptedResult {
  readonly workKey: string;
  readonly payload: ReviewCheckpointBatchPayload;
}

export interface ReviewCheckpointRecord {
  readonly version: number;
  readonly plan: ReviewCheckpointPlanIdentity;
  readonly acceptedResults: readonly ReviewCheckpointAcceptedResult[];
  readonly finalized: boolean;
}

export type ReviewCheckpointRestoreResult =
  | {
      readonly status: ReviewCheckpointRestoreStatus.Missing;
      readonly expectedVersion: number;
    }
  | {
      readonly status: ReviewCheckpointRestoreStatus.Found;
      readonly expectedVersion: number;
      readonly checkpoint: ReviewCheckpointRecord;
    };

export type ReviewCheckpointStartResult =
  | {
      readonly status:
        | ReviewCheckpointStartStatus.Started
        | ReviewCheckpointStartStatus.Replaced
        | ReviewCheckpointStartStatus.Idempotent;
      readonly version: number;
      readonly headSha: string;
      readonly planHash: string;
    }
  | {
      readonly status: ReviewCheckpointStartStatus.Conflict;
      readonly currentVersion: number;
    };

export type ReviewCheckpointBatchResult =
  | {
      readonly status:
        | ReviewCheckpointBatchResultStatus.Accepted
        | ReviewCheckpointBatchResultStatus.Idempotent;
      readonly version: number;
      readonly headSha: string;
      readonly planHash: string;
      readonly workKey: string;
    }
  | {
      readonly status: ReviewCheckpointBatchResultStatus.Conflict;
      readonly currentVersion: number;
    };

export type ReviewCheckpointFinalizeResult =
  | {
      readonly status:
        | ReviewCheckpointFinalizeStatus.Finalized
        | ReviewCheckpointFinalizeStatus.Idempotent;
      readonly version: number;
      readonly headSha: string;
      readonly planHash: string;
    }
  | {
      readonly status: ReviewCheckpointFinalizeStatus.Conflict;
      readonly currentVersion: number;
    };

export type ReviewCheckpointClearResult =
  | {
      readonly status:
        | ReviewCheckpointClearStatus.Cleared
        | ReviewCheckpointClearStatus.Missing;
    }
  | {
      readonly status: ReviewCheckpointClearStatus.Conflict;
      readonly currentVersion: number;
    };

export interface ReviewCheckpointClientPort {
  restore(input: {
    readonly pullRequestNumber: number;
    readonly baseSha: string;
    readonly headSha: string;
    readonly compatibilityKey: string;
    readonly planHash: string;
  }): Promise<ReviewCheckpointRestoreResult>;

  start(input: {
    readonly expectedVersion: number;
    readonly plan: ReviewCheckpointPlanIdentity;
  }): Promise<ReviewCheckpointStartResult>;

  commitBatchResult(input: {
    readonly expectedVersion: number;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly planHash: string;
    readonly workKey: string;
    readonly batchId: string;
    readonly batchIndex: number;
    readonly payload: ReviewCheckpointBatchPayload;
  }): Promise<ReviewCheckpointBatchResult>;

  finalize(input: {
    readonly expectedVersion: number;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly planHash: string;
  }): Promise<ReviewCheckpointFinalizeResult>;

  clear(input: {
    readonly expectedVersion: number;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly planHash: string;
  }): Promise<ReviewCheckpointClearResult>;
}

export interface ReviewCheckpointFinalizationMarkerWriter {
  write(marker: ReviewCheckpointFinalizationMarker): Promise<void>;
}

export function createReviewCheckpointPlanIdentity(
  input: ReviewCheckpointPlanIdentity
): ReviewCheckpointPlanIdentity {
  const parsed = reviewCheckpointPlanIdentitySchema.parse(input);
  return Object.freeze({
    ...parsed,
    baseSha: parsed.baseSha.toLowerCase(),
    headSha: parsed.headSha.toLowerCase(),
    compatibilityKey: parsed.compatibilityKey.toLowerCase(),
    planHash: parsed.planHash.toLowerCase(),
    workKeys: parsed.workKeys.map((key) => key.toLowerCase()),
  });
}

export function normalizeReviewCheckpointBatchPayload(
  input: unknown
): ReviewCheckpointBatchPayload {
  const record = asRecord(input);
  const rawProviderResults = Array.isArray(input)
    ? input
    : Array.isArray(record?.providerResults)
      ? record.providerResults
      : [];
  assertCollectionWithinLimit(
    rawProviderResults,
    MAX_PROVIDER_RESULTS,
    'providerResults'
  );
  const providerResults = rawProviderResults
    .map(normalizeProviderResult)
    .map((result) => requireNormalized(result, 'providerResult'));
  const rawFindings = Array.isArray(record?.findings)
    ? record.findings
    : rawProviderResults.flatMap((providerResult) => {
        const provider = asRecord(providerResult);
        const result = asRecord(provider?.result);
        return Array.isArray(result?.findings) ? result.findings : [];
      });
  assertCollectionWithinLimit(rawFindings, MAX_FINDINGS, 'findings');

  return reviewCheckpointBatchPayloadSchema.parse({
    filePaths: normalizeFilePaths(record),
    findings: rawFindings
      .map(normalizeFinding)
      .map((finding) => requireNormalized(finding, 'finding')),
    providerResults,
  });
}

export function parseReviewCheckpointFinalizationMarker(
  input: string | unknown
): ReviewCheckpointFinalizationMarker {
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  return reviewCheckpointFinalizationMarkerSchema.parse(value);
}

export function checkpointPlansMatch(
  left: ReviewCheckpointPlanIdentity,
  right: ReviewCheckpointPlanIdentity
): boolean {
  return (
    left.pullRequestNumber === right.pullRequestNumber &&
    left.baseSha === right.baseSha &&
    left.headSha === right.headSha &&
    left.compatibilityKey === right.compatibilityKey &&
    left.planHash === right.planHash &&
    left.workKeys.length === right.workKeys.length &&
    left.workKeys.every((workKey, index) => workKey === right.workKeys[index])
  );
}

export function checkpointPayloadsMatch(
  left: ReviewCheckpointBatchPayload,
  right: ReviewCheckpointBatchPayload
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeFilePaths(record: Record<string, unknown> | null): string[] {
  const explicitPaths = Array.isArray(record?.filePaths)
    ? record.filePaths
    : [];
  const fileObjects = Array.isArray(record?.files) ? record.files : [];
  const values = [
    ...explicitPaths,
    ...fileObjects.map((file) => asRecord(file)?.filename),
  ];
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const path = normalizeText(value, 4_096);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
    if (paths.length > MAX_FILE_PATHS) {
      throw new Error('review_checkpoint_filePaths_limit_exceeded');
    }
  }
  return paths;
}

function normalizeFinding(value: unknown): ReviewCheckpointFinding | null {
  const finding = asRecord(value);
  if (!finding) return null;
  const parsed = checkpointFindingSchema.safeParse({
    file: normalizeRequiredText(finding.file, 4_096),
    ...(finding.startLine !== undefined
      ? { startLine: finding.startLine }
      : {}),
    line: finding.line,
    ...(finding.endLine !== undefined ? { endLine: finding.endLine } : {}),
    severity: finding.severity,
    title: normalizeRequiredText(finding.title, 1_000),
    message: normalizeRequiredText(finding.message, 20_000),
    ...(typeof finding.provider === 'string'
      ? { provider: normalizeText(finding.provider, 500) }
      : {}),
    ...(Array.isArray(finding.providers)
      ? { providers: normalizeStringArray(finding.providers, 50, 500) }
      : {}),
    ...(typeof finding.actualModel === 'string'
      ? { actualModel: normalizeText(finding.actualModel, 500) }
      : {}),
    ...(Array.isArray(finding.providerVoteKeys)
      ? {
          providerVoteKeys: normalizeStringArray(
            finding.providerVoteKeys,
            50,
            500
          ),
        }
      : {}),
    ...(finding.providerPoolSize !== undefined
      ? { providerPoolSize: finding.providerPoolSize }
      : {}),
    ...(finding.confidence !== undefined
      ? { confidence: finding.confidence }
      : {}),
    ...(typeof finding.category === 'string'
      ? { category: normalizeText(finding.category, 500) }
      : {}),
    ...(finding.hasConsensus !== undefined
      ? { hasConsensus: finding.hasConsensus }
      : {}),
  });
  return parsed.success ? parsed.data : null;
}

function normalizeProviderResult(
  value: unknown
): ReviewCheckpointProviderResult | null {
  const provider = asRecord(value);
  if (!provider || typeof provider.name !== 'string') return null;
  const result = asRecord(provider.result);
  const errorMessage = messageFromUnknown(
    provider.errorMessage ?? provider.error
  );
  const parsed = checkpointProviderResultSchema.safeParse({
    name: normalizeText(provider.name, 500),
    status: normalizeProviderStatus(provider.status),
    durationMs: normalizeDurationMs(provider),
    ...(errorMessage
      ? { errorMessage: normalizeText(errorMessage, 1_000) }
      : {}),
    ...(typeof (provider.actualModel ?? result?.actualModel) === 'string'
      ? {
          actualModel: normalizeText(
            (provider.actualModel ?? result?.actualModel) as string,
            500
          ),
        }
      : {}),
    ...(isProbability(provider.aiLikelihood ?? result?.aiLikelihood)
      ? { aiLikelihood: provider.aiLikelihood ?? result?.aiLikelihood }
      : {}),
    ...normalizeProviderUsage(provider, result),
    ...(Array.isArray(provider.lifecycleAssignedTargetIds)
      ? {
          lifecycleAssignedTargetIds: normalizeStringArray(
            provider.lifecycleAssignedTargetIds,
            MAX_LIFECYCLE_TARGETS,
            500
          ),
        }
      : {}),
    ...normalizeProviderRevalidations(provider, result),
  });
  return parsed.success ? parsed.data : null;
}

function normalizeProviderUsage(
  provider: Record<string, unknown>,
  result: Record<string, unknown> | null
): {
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
} {
  const usage = asRecord(provider.usage) ?? asRecord(result?.usage);
  if (!usage) return {};
  const parsed = z
    .object({
      promptTokens: z.number().int().min(0).max(MAX_TOKEN_COUNT),
      completionTokens: z.number().int().min(0).max(MAX_TOKEN_COUNT),
      totalTokens: z.number().int().min(0).max(MAX_TOKEN_COUNT),
    })
    .strict()
    .safeParse(usage);
  return parsed.success ? { usage: parsed.data } : {};
}

function normalizeProviderRevalidations(
  provider: Record<string, unknown>,
  result: Record<string, unknown> | null
): { lifecycleRevalidations?: ReviewCheckpointLifecycleRevalidation[] } {
  const raw = Array.isArray(provider.lifecycleRevalidations)
    ? provider.lifecycleRevalidations
    : Array.isArray(result?.lifecycleRevalidations)
      ? result.lifecycleRevalidations
      : Array.isArray(result?.revalidations)
        ? result.revalidations
        : null;
  if (!raw) return {};
  assertCollectionWithinLimit(raw, MAX_REVALIDATIONS, 'lifecycleRevalidations');
  return {
    lifecycleRevalidations: raw
      .map(normalizeLifecycleRevalidation)
      .map((revalidation) =>
        requireNormalized(revalidation, 'lifecycleRevalidation')
      ),
  };
}

function normalizeLifecycleRevalidation(
  value: unknown
): ReviewCheckpointLifecycleRevalidation | null {
  const revalidation = asRecord(value);
  if (!revalidation) return null;
  const evidence = Array.isArray(revalidation.evidence)
    ? (assertCollectionWithinLimit(
        revalidation.evidence,
        MAX_REVALIDATION_EVIDENCE,
        'lifecycleEvidence'
      ),
      revalidation.evidence
        .map(normalizeLifecycleEvidence)
        .map((entry) => requireNormalized(entry, 'lifecycleEvidence')))
    : undefined;
  const parsed = lifecycleRevalidationSchema.safeParse({
    targetId: normalizeRequiredText(revalidation.targetId, 500),
    ...(typeof revalidation.fingerprint === 'string'
      ? { fingerprint: normalizeText(revalidation.fingerprint, 500) }
      : {}),
    verdict: revalidation.verdict,
    ...(isProbability(revalidation.confidence)
      ? { confidence: revalidation.confidence }
      : {}),
    ...(evidence ? { evidence } : {}),
    ...(typeof revalidation.rationale === 'string'
      ? { rationale: normalizeText(revalidation.rationale, 2_000) }
      : {}),
  });
  return parsed.success ? parsed.data : null;
}

function normalizeLifecycleEvidence(
  value: unknown
): z.infer<typeof lifecycleEvidenceSchema> | null {
  const evidence = asRecord(value);
  if (!evidence) return null;
  const parsed = lifecycleEvidenceSchema.safeParse({
    path: normalizeRequiredText(evidence.path, 4_096),
    ...(evidence.startLine !== undefined
      ? { startLine: evidence.startLine }
      : {}),
    ...(evidence.endLine !== undefined ? { endLine: evidence.endLine } : {}),
    reason: normalizeRequiredText(evidence.reason, 2_000),
  });
  return parsed.success ? parsed.data : null;
}

function normalizeProviderStatus(
  value: unknown
): ReviewCheckpointProviderStatus {
  switch (value) {
    case 'success':
      return ReviewCheckpointProviderStatus.Success;
    case 'timeout':
      return ReviewCheckpointProviderStatus.Timeout;
    case 'rate-limited':
    case 'rate_limited':
      return ReviewCheckpointProviderStatus.RateLimited;
    case 'error':
    default:
      return ReviewCheckpointProviderStatus.Error;
  }
}

function normalizeDurationMs(provider: Record<string, unknown>): number {
  const raw =
    typeof provider.durationMs === 'number'
      ? provider.durationMs
      : typeof provider.durationSeconds === 'number'
        ? provider.durationSeconds * 1_000
        : 0;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(MAX_DURATION_MS, Math.max(0, Math.round(raw)));
}

function normalizeStringArray(
  values: readonly unknown[],
  maxItems: number,
  maxLength: number
): string[] {
  assertCollectionWithinLimit(values, maxItems, 'stringArray');
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => normalizeText(value, maxLength))
        .filter((value) => value.length > 0)
    ),
  ];
}

function normalizeRequiredText(value: unknown, maxLength: number): unknown {
  return typeof value === 'string' ? normalizeText(value, maxLength) : value;
}

function normalizeText(value: string, maxLength: number): string {
  const normalized = redactSensitiveText(value);
  if (normalized.length > maxLength) {
    throw new Error('review_checkpoint_text_limit_exceeded');
  }
  return normalized;
}

function assertCollectionWithinLimit(
  values: readonly unknown[],
  maxItems: number,
  field: string
): void {
  if (values.length > maxItems) {
    throw new Error(`review_checkpoint_${field}_limit_exceeded`);
  }
}

function requireNormalized<T>(value: T | null, field: string): T {
  if (value === null) {
    throw new Error(`review_checkpoint_${field}_invalid`);
  }
  return value;
}

function messageFromUnknown(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  const record = asRecord(value);
  return typeof record?.message === 'string' ? record.message : undefined;
}

function isProbability(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
