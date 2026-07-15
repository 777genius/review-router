import * as fs from 'fs/promises';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { redactSensitiveText } from '../utils/redaction';
import { IncrementalCacheData, IncrementalStoragePort } from './incremental';

export const REVIEW_SNAPSHOT_INPUT_PATH_ENV =
  'REVIEWROUTER_INCREMENTAL_SNAPSHOT_INPUT_PATH';
export const REVIEW_SNAPSHOT_OUTPUT_PATH_ENV =
  'REVIEWROUTER_INCREMENTAL_SNAPSHOT_OUTPUT_PATH';
export const REVIEW_SNAPSHOT_REQUIRED_ENV =
  'REVIEWROUTER_INCREMENTAL_SNAPSHOT_REQUIRED';

const REVIEW_SNAPSHOT_MAX_PAYLOAD_BYTES = 512 * 1024;
const REVIEW_SNAPSHOT_MAX_CANDIDATE_BYTES =
  REVIEW_SNAPSHOT_MAX_PAYLOAD_BYTES + 16 * 1024;

const findingSchema = z
  .object({
    file: z.string().min(1).max(4_096),
    startLine: z.number().int().positive().optional(),
    line: z.number().int().positive(),
    endLine: z.number().int().positive().optional(),
    severity: z.enum(['critical', 'major', 'minor']),
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

const snapshotSchema = z
  .object({
    version: z.number().int().positive(),
    schemaVersion: z.literal(1),
    reviewedHeadSha: z.string().regex(/^[a-f0-9]{40}$/i),
    baseSha: z.string().regex(/^[a-f0-9]{40}$/i),
    compatibilityKey: z.string().regex(/^[a-f0-9]{64}$/i),
    payload: z
      .object({
        reviewSummary: z.string().min(1).max(100_000),
        findings: z.array(findingSchema).max(500),
      })
      .strict(),
    reviewedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

const restoreEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(1),
    status: z.enum(['found', 'missing', 'expired', 'base_changed']),
    expectedVersion: z.number().int().nonnegative(),
    snapshot: snapshotSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'found') {
      if (!value.snapshot) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Found snapshot response must include a snapshot',
          path: ['snapshot'],
        });
      } else if (value.expectedVersion !== value.snapshot.version) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Snapshot version does not match expected version',
          path: ['expectedVersion'],
        });
      }
    } else if (value.snapshot) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Non-found snapshot response must not include a snapshot',
        path: ['snapshot'],
      });
    }
  });

const incrementalCacheDataSchema = z.object({
  prNumber: z.number().int().positive(),
  lastReviewedCommit: z.string().regex(/^[a-f0-9]{40}$/i),
  timestamp: z.number().int().nonnegative(),
  findings: z.array(z.unknown()),
  reviewSummary: z.string(),
  schemaVersion: z.literal(1),
  baseSha: z.string().regex(/^[a-f0-9]{40}$/i),
  compatibilityKey: z.string().regex(/^[a-f0-9]{64}$/i),
  expiresAt: z.number().int().positive(),
});

type RestoreEnvelope = z.infer<typeof restoreEnvelopeSchema>;

export class FileReviewSnapshotStorage implements IncrementalStoragePort {
  static fromEnvironment(
    env: NodeJS.ProcessEnv = process.env
  ): FileReviewSnapshotStorage | null {
    const inputPath = env[REVIEW_SNAPSHOT_INPUT_PATH_ENV]?.trim();
    const outputPath = env[REVIEW_SNAPSHOT_OUTPUT_PATH_ENV]?.trim();
    if (!inputPath && !outputPath) return null;
    if (!inputPath || !outputPath) {
      logger.warn('Hosted incremental snapshot bridge is incomplete');
      return null;
    }
    return new FileReviewSnapshotStorage(inputPath, outputPath);
  }

  constructor(
    private readonly inputPath: string,
    private readonly outputPath: string
  ) {}

  private envelope: RestoreEnvelope | null | undefined;

  async read(key: string): Promise<string | null> {
    const prNumber = parsePrNumber(key);
    const envelope = await this.readEnvelope();
    if (!prNumber || !envelope || envelope.status !== 'found') return null;
    if (!envelope.snapshot) {
      logger.warn(
        'Hosted incremental snapshot response is missing its payload'
      );
      return null;
    }

    const reviewedAt = Date.parse(envelope.snapshot.reviewedAt);
    const expiresAt = Date.parse(envelope.snapshot.expiresAt);
    if (!Number.isFinite(reviewedAt) || !Number.isFinite(expiresAt)) {
      logger.warn('Hosted incremental snapshot contains invalid timestamps');
      return null;
    }
    const data: IncrementalCacheData = {
      prNumber,
      lastReviewedCommit: envelope.snapshot.reviewedHeadSha,
      timestamp: reviewedAt,
      findings: envelope.snapshot.payload.findings,
      reviewSummary: envelope.snapshot.payload.reviewSummary,
      schemaVersion: envelope.snapshot.schemaVersion,
      baseSha: envelope.snapshot.baseSha,
      compatibilityKey: envelope.snapshot.compatibilityKey,
      expiresAt,
    };
    return JSON.stringify(data);
  }

  async write(_key: string, value: string): Promise<void> {
    const envelope = await this.readEnvelope();
    if (!envelope) return;

    const parsedData = incrementalCacheDataSchema.safeParse(
      safeJsonParse(value)
    );
    if (!parsedData.success) {
      logger.warn(
        'Hosted incremental snapshot candidate is invalid; persistence skipped'
      );
      return;
    }
    const data = parsedData.data;
    const normalizedFindings = data.findings
      .map(normalizeFinding)
      .filter((finding): finding is NonNullable<typeof finding> => !!finding)
      .slice(0, 500);
    const candidate = {
      protocolVersion: 1,
      expectedVersion: envelope.expectedVersion,
      pullRequestNumber: data.prNumber,
      schemaVersion: data.schemaVersion,
      reviewedHeadSha: data.lastReviewedCommit,
      baseSha: data.baseSha,
      compatibilityKey: data.compatibilityKey,
      payload: {
        reviewSummary: normalizeText(data.reviewSummary, 100_000),
        findings: [] as Array<(typeof normalizedFindings)[number]>,
      },
    };
    let payloadBytes = Buffer.byteLength(JSON.stringify(candidate.payload));
    let candidateBytes = Buffer.byteLength(JSON.stringify(candidate));
    for (const finding of normalizedFindings) {
      const additionalBytes =
        Buffer.byteLength(JSON.stringify(finding)) +
        (candidate.payload.findings.length > 0 ? 1 : 0);
      if (
        payloadBytes + additionalBytes > REVIEW_SNAPSHOT_MAX_PAYLOAD_BYTES ||
        candidateBytes + additionalBytes > REVIEW_SNAPSHOT_MAX_CANDIDATE_BYTES
      ) {
        continue;
      }
      candidate.payload.findings.push(finding);
      payloadBytes += additionalBytes;
      candidateBytes += additionalBytes;
    }
    if (candidate.payload.findings.length < normalizedFindings.length) {
      logger.warn('Hosted incremental snapshot findings were size-limited');
    }
    const serializedCandidate = JSON.stringify(candidate);
    if (
      Buffer.byteLength(serializedCandidate) >
      REVIEW_SNAPSHOT_MAX_CANDIDATE_BYTES
    ) {
      logger.warn('Hosted incremental snapshot candidate exceeds size limit');
      return;
    }

    const temporaryPath = `${this.outputPath}.tmp-${process.pid}`;
    try {
      await fs.writeFile(temporaryPath, serializedCandidate, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await fs.rename(temporaryPath, this.outputPath);
      logger.info('Prepared hosted incremental review snapshot candidate');
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async readEnvelope(): Promise<RestoreEnvelope | null> {
    if (this.envelope !== undefined) return this.envelope;
    try {
      const raw = await fs.readFile(this.inputPath, 'utf8');
      const parsed = restoreEnvelopeSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        logger.warn(
          'Hosted incremental snapshot response is invalid; running full review'
        );
        this.envelope = null;
        return this.envelope;
      }
      this.envelope = parsed.data;
      return this.envelope;
    } catch (error) {
      logger.warn(
        `Hosted incremental snapshot unavailable; running full review: ${safeError(error)}`
      );
      this.envelope = null;
      return this.envelope;
    }
  }
}

function parsePrNumber(key: string): number | null {
  const match = /^incremental-review-pr-(\d+)$/.exec(key);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeFinding(finding: unknown) {
  if (!finding || typeof finding !== 'object') return null;
  const candidate = finding as Record<string, unknown>;
  if (
    typeof candidate.file !== 'string' ||
    typeof candidate.title !== 'string' ||
    typeof candidate.message !== 'string'
  ) {
    return null;
  }
  const parsed = findingSchema.safeParse({
    file: normalizeText(candidate.file, 4_096),
    ...(candidate.startLine !== undefined
      ? { startLine: candidate.startLine }
      : {}),
    line: candidate.line,
    ...(candidate.endLine !== undefined ? { endLine: candidate.endLine } : {}),
    severity: candidate.severity,
    title: normalizeText(candidate.title, 1_000),
    message: normalizeText(candidate.message, 20_000),
    ...(typeof candidate.provider === 'string'
      ? { provider: normalizeText(candidate.provider, 500) }
      : {}),
    ...(Array.isArray(candidate.providers)
      ? {
          providers: candidate.providers
            .filter((value): value is string => typeof value === 'string')
            .slice(0, 50)
            .map((value) => normalizeText(value, 500)),
        }
      : {}),
    ...(typeof candidate.actualModel === 'string'
      ? { actualModel: normalizeText(candidate.actualModel, 500) }
      : {}),
    ...(Array.isArray(candidate.providerVoteKeys)
      ? {
          providerVoteKeys: candidate.providerVoteKeys
            .filter((value): value is string => typeof value === 'string')
            .slice(0, 50)
            .map((value) => normalizeText(value, 500)),
        }
      : {}),
    ...(candidate.providerPoolSize !== undefined
      ? { providerPoolSize: candidate.providerPoolSize }
      : {}),
    ...(candidate.confidence !== undefined
      ? { confidence: candidate.confidence }
      : {}),
    ...(typeof candidate.category === 'string'
      ? { category: normalizeText(candidate.category, 500) }
      : {}),
    ...(candidate.hasConsensus !== undefined
      ? { hasConsensus: candidate.hasConsensus }
      : {}),
  });
  return parsed.success ? parsed.data : null;
}

function normalizeText(value: string, maxLength: number): string {
  return redactSensitiveText(value).slice(0, maxLength) || 'Redacted.';
}

export function isHostedReviewSnapshotRequired(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const value = env[REVIEW_SNAPSHOT_REQUIRED_ENV]?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

export class DisabledIncrementalStorage implements IncrementalStoragePort {
  async read(): Promise<null> {
    return null;
  }

  async write(): Promise<void> {}
}

export function selectIncrementalSnapshotStorage(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly localStorage: IncrementalStoragePort;
  readonly incrementalEnabled: boolean;
}): {
  readonly storage: IncrementalStoragePort;
  readonly enabled: boolean;
  readonly requireCompatibleSnapshot: boolean;
  readonly hostedSnapshotUnavailable: boolean;
} {
  const env = input.env ?? process.env;
  const hostedStorage = FileReviewSnapshotStorage.fromEnvironment(env);
  const hostedRequired = isHostedReviewSnapshotRequired(env);
  const hostedSnapshotUnavailable = hostedRequired && hostedStorage === null;
  return {
    storage:
      hostedStorage ??
      (hostedSnapshotUnavailable
        ? new DisabledIncrementalStorage()
        : input.localStorage),
    enabled: input.incrementalEnabled && !hostedSnapshotUnavailable,
    requireCompatibleSnapshot: hostedRequired || hostedStorage !== null,
    hostedSnapshotUnavailable,
  };
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? redactSensitiveText(error.message).slice(0, 500)
    : 'unknown_error';
}
