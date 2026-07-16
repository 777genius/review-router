import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  ReviewCheckpointSession,
  ReviewCheckpointSessionLogger,
} from '../application/review-checkpoint-session';
import {
  REVIEW_CHECKPOINT_MAX_AGGREGATE_BYTES,
  REVIEW_CHECKPOINT_MAX_REQUEST_BYTES,
  REVIEW_CHECKPOINT_PROTOCOL_VERSION,
  ReviewCheckpointBatchResult,
  ReviewCheckpointBatchResultStatus,
  ReviewCheckpointClearResult,
  ReviewCheckpointClearStatus,
  ReviewCheckpointClientPort,
  ReviewCheckpointFinalizationMarker,
  ReviewCheckpointFinalizationMarkerWriter,
  ReviewCheckpointFinalizeResult,
  ReviewCheckpointFinalizeStatus,
  ReviewCheckpointPlanIdentity,
  ReviewCheckpointRestoreResult,
  ReviewCheckpointRestoreStatus,
  ReviewCheckpointStartResult,
  ReviewCheckpointStartStatus,
  parseReviewCheckpointFinalizationMarker,
  reviewCheckpointBatchPayloadSchema,
  reviewCheckpointFinalizationMarkerSchema,
} from '../domain/review-checkpoint';

export const REVIEW_CHECKPOINT_API_URL_ENV = 'REVIEWROUTER_API_URL';
export const REVIEW_CHECKPOINT_LEASE_ID_ENV =
  'REVIEWROUTER_COMMENT_TOKEN_LEASE_ID';
export const REVIEW_CHECKPOINT_PROVIDER_INSTANCE_ID_ENV =
  'REVIEWROUTER_COMMENT_TOKEN_PROVIDER_INSTANCE_ID';
export const REVIEW_CHECKPOINT_FINALIZATION_PATH_ENV =
  'REVIEWROUTER_REVIEW_CHECKPOINT_FINALIZATION_PATH';

const CHECKPOINT_PATH =
  '/api/action/v1/codex-oauth/review-execution-checkpoint';
const EXECUTION_DEADLINE_ENV = 'REVIEWROUTER_EXECUTION_DEADLINE_EPOCH_MS';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_ENVELOPE_MAX_BYTES = 256 * 1024;
const RESPONSE_MAX_BYTES =
  REVIEW_CHECKPOINT_MAX_AGGREGATE_BYTES + RESPONSE_ENVELOPE_MAX_BYTES;
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/i);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const versionSchema = z.number().int().nonnegative();
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

const acceptedResultSchema = z
  .object({
    workKey: hashSchema,
    payload: reviewCheckpointBatchPayloadSchema,
  })
  .strict();

const restoredCheckpointSchema = z
  .object({
    version: versionSchema,
    baseSha: gitShaSchema,
    headSha: gitShaSchema,
    compatibilityKey: hashSchema,
    planHash: hashSchema,
    plannedWorkKeys: z.array(hashSchema).max(200),
    acceptedResults: z.array(acceptedResultSchema).max(500),
    finalized: z.boolean(),
  })
  .strict();

const restoreResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      protocolVersion: z.literal(REVIEW_CHECKPOINT_PROTOCOL_VERSION),
      status: z.literal(ReviewCheckpointRestoreStatus.Missing),
      expectedVersion: versionSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(REVIEW_CHECKPOINT_PROTOCOL_VERSION),
      status: z.literal(ReviewCheckpointRestoreStatus.Found),
      expectedVersion: versionSchema,
      checkpoint: restoredCheckpointSchema,
    })
    .strict(),
]);

const startResponseSchema = z.union([
  z
    .object({
      protocolVersion: z.literal(REVIEW_CHECKPOINT_PROTOCOL_VERSION),
      status: z.union([
        z.literal(ReviewCheckpointStartStatus.Started),
        z.literal(ReviewCheckpointStartStatus.Replaced),
        z.literal(ReviewCheckpointStartStatus.Idempotent),
      ]),
      version: versionSchema,
      headSha: gitShaSchema,
      planHash: hashSchema,
    })
    .strict(),
  conflictResponseSchema(z.literal(ReviewCheckpointStartStatus.Conflict)),
]);

const batchResultResponseSchema = z.union([
  z
    .object({
      protocolVersion: z.literal(REVIEW_CHECKPOINT_PROTOCOL_VERSION),
      status: z.union([
        z.literal(ReviewCheckpointBatchResultStatus.Accepted),
        z.literal(ReviewCheckpointBatchResultStatus.Idempotent),
      ]),
      version: versionSchema,
      headSha: gitShaSchema,
      planHash: hashSchema,
      workKey: hashSchema,
    })
    .strict(),
  conflictResponseSchema(z.literal(ReviewCheckpointBatchResultStatus.Conflict)),
]);

const finalizeResponseSchema = z.union([
  z
    .object({
      protocolVersion: z.literal(REVIEW_CHECKPOINT_PROTOCOL_VERSION),
      status: z.union([
        z.literal(ReviewCheckpointFinalizeStatus.Finalized),
        z.literal(ReviewCheckpointFinalizeStatus.Idempotent),
      ]),
      version: versionSchema,
      headSha: gitShaSchema,
      planHash: hashSchema,
    })
    .strict(),
  conflictResponseSchema(z.literal(ReviewCheckpointFinalizeStatus.Conflict)),
]);

const clearResponseSchema = z.union([
  z
    .object({
      protocolVersion: z.literal(REVIEW_CHECKPOINT_PROTOCOL_VERSION),
      status: z.union([
        z.literal(ReviewCheckpointClearStatus.Cleared),
        z.literal(ReviewCheckpointClearStatus.Missing),
      ]),
    })
    .strict(),
  conflictResponseSchema(z.literal(ReviewCheckpointClearStatus.Conflict)),
]);

type CheckpointFetch = typeof fetch;

export type ReviewCheckpointLogger = {
  warn(message: string): void;
};

export enum ReviewCheckpointHttpFailureCode {
  UnsupportedEndpoint = 'unsupported_endpoint',
  RequestTooLarge = 'request_too_large',
  ResponseTooLarge = 'response_too_large',
  RequestFailed = 'request_failed',
  RequestTimedOut = 'request_timed_out',
  InvalidResponse = 'invalid_response',
}

export class ReviewCheckpointHttpError extends Error {
  constructor(readonly code: ReviewCheckpointHttpFailureCode) {
    super(`review_checkpoint_${code}`);
    this.name = 'ReviewCheckpointHttpError';
  }
}

export class HttpReviewCheckpointClient implements ReviewCheckpointClientPort {
  static fromEnvironment(input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly fetchImpl?: CheckpointFetch;
  }): HttpReviewCheckpointClient | null {
    const env = input.env ?? process.env;
    const apiUrl = env[REVIEW_CHECKPOINT_API_URL_ENV]?.trim();
    const leaseId = env[REVIEW_CHECKPOINT_LEASE_ID_ENV]?.trim();
    const providerInstanceId =
      env[REVIEW_CHECKPOINT_PROVIDER_INSTANCE_ID_ENV]?.trim();
    if (!apiUrl || !leaseId || !providerInstanceId) return null;

    if (!isAllowedCheckpointApiUrl(apiUrl)) return null;

    return new HttpReviewCheckpointClient({
      apiUrl,
      leaseId,
      providerInstanceId,
      fetchImpl: input.fetchImpl,
      deadlineEpochMs: parseOptionalEpochMs(env[EXECUTION_DEADLINE_ENV]),
    });
  }

  private readonly apiUrl: string;
  private readonly leaseId: string;
  private readonly providerInstanceId: string;
  private readonly fetchImpl: CheckpointFetch;
  private readonly deadlineEpochMs?: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;

  constructor(input: {
    readonly apiUrl: string;
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly fetchImpl?: CheckpointFetch;
    readonly deadlineEpochMs?: number;
    readonly requestTimeoutMs?: number;
    readonly now?: () => number;
  }) {
    const parsedApiUrl = isAllowedCheckpointApiUrl(input.apiUrl);
    if (!parsedApiUrl) {
      throw new ReviewCheckpointHttpError(
        ReviewCheckpointHttpFailureCode.UnsupportedEndpoint
      );
    }
    this.apiUrl = parsedApiUrl.toString().replace(/\/+$/, '');
    this.leaseId = input.leaseId;
    this.providerInstanceId = input.providerInstanceId;
    this.fetchImpl = input.fetchImpl ?? fetch;
    this.deadlineEpochMs = input.deadlineEpochMs;
    this.requestTimeoutMs =
      input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.now = input.now ?? Date.now;
  }

  async restore(input: {
    readonly pullRequestNumber: number;
    readonly baseSha: string;
    readonly headSha: string;
    readonly compatibilityKey: string;
    readonly planHash: string;
  }): Promise<ReviewCheckpointRestoreResult> {
    const response = await this.post(
      '/restore',
      this.withCredentials({
        pullRequestNumber: input.pullRequestNumber,
        baseSha: input.baseSha,
        headSha: input.headSha,
        compatibilityKey: input.compatibilityKey,
        planHash: input.planHash,
      }),
      restoreResponseSchema
    );
    if (response.status === ReviewCheckpointRestoreStatus.Missing) {
      return response;
    }
    return {
      status: response.status,
      expectedVersion: response.expectedVersion,
      checkpoint: {
        version: response.checkpoint.version,
        plan: {
          pullRequestNumber: input.pullRequestNumber,
          baseSha: response.checkpoint.baseSha.toLowerCase(),
          headSha: response.checkpoint.headSha.toLowerCase(),
          compatibilityKey: response.checkpoint.compatibilityKey.toLowerCase(),
          planHash: response.checkpoint.planHash.toLowerCase(),
          workKeys: response.checkpoint.plannedWorkKeys.map((key) =>
            key.toLowerCase()
          ),
        },
        acceptedResults: response.checkpoint.acceptedResults.map((result) => ({
          workKey: result.workKey.toLowerCase(),
          payload: result.payload,
        })),
        finalized: response.checkpoint.finalized,
      },
    };
  }

  start(input: {
    readonly expectedVersion: number;
    readonly plan: ReviewCheckpointPlanIdentity;
  }): Promise<ReviewCheckpointStartResult> {
    return this.post(
      '/start',
      this.withCredentials({
        expectedVersion: input.expectedVersion,
        pullRequestNumber: input.plan.pullRequestNumber,
        baseSha: input.plan.baseSha,
        headSha: input.plan.headSha,
        compatibilityKey: input.plan.compatibilityKey,
        planHash: input.plan.planHash,
        plannedWorkKeys: input.plan.workKeys,
      }),
      startResponseSchema
    );
  }

  commitBatchResult(input: {
    readonly expectedVersion: number;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly planHash: string;
    readonly workKey: string;
    readonly batchId: string;
    readonly batchIndex: number;
    readonly payload: z.infer<typeof reviewCheckpointBatchPayloadSchema>;
  }): Promise<ReviewCheckpointBatchResult> {
    return this.post(
      '/batch-result',
      this.withCredentials({
        expectedVersion: input.expectedVersion,
        pullRequestNumber: input.pullRequestNumber,
        headSha: input.headSha,
        planHash: input.planHash,
        workKey: input.workKey,
        batchId: input.batchId,
        batchIndex: input.batchIndex,
        payload: input.payload,
      }),
      batchResultResponseSchema
    );
  }

  finalize(input: {
    readonly expectedVersion: number;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly planHash: string;
  }): Promise<ReviewCheckpointFinalizeResult> {
    return this.post(
      '/finalize',
      this.withCredentials({ ...input }),
      finalizeResponseSchema
    );
  }

  clear(input: {
    readonly expectedVersion: number;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly planHash: string;
  }): Promise<ReviewCheckpointClearResult> {
    return this.post(
      '/clear',
      this.withCredentials({ ...input }),
      clearResponseSchema
    );
  }

  clearFinalized(
    marker: string | unknown
  ): Promise<ReviewCheckpointClearResult> {
    const parsed = parseReviewCheckpointFinalizationMarker(marker);
    return this.clear({
      expectedVersion: parsed.expectedVersion,
      pullRequestNumber: parsed.pullRequestNumber,
      headSha: parsed.headSha,
      planHash: parsed.planHash,
    });
  }

  private withCredentials<T extends Record<string, unknown>>(
    body: T
  ): {
    readonly protocolVersion: typeof REVIEW_CHECKPOINT_PROTOCOL_VERSION;
    readonly leaseId: string;
    readonly providerInstanceId: string;
  } & T {
    return {
      protocolVersion: REVIEW_CHECKPOINT_PROTOCOL_VERSION,
      leaseId: this.leaseId,
      providerInstanceId: this.providerInstanceId,
      ...body,
    };
  }

  private async post<T>(
    path: string,
    body: Record<string, unknown>,
    schema: z.ZodType<T>
  ): Promise<T> {
    const serialized = JSON.stringify(body);
    if (
      Buffer.byteLength(serialized, 'utf8') >
      REVIEW_CHECKPOINT_MAX_REQUEST_BYTES
    ) {
      throw new ReviewCheckpointHttpError(
        ReviewCheckpointHttpFailureCode.RequestTooLarge
      );
    }

    const timeoutMs = this.availableRequestTimeMs();
    const abortController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutFailure = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        abortController.abort();
        reject(
          new ReviewCheckpointHttpError(
            ReviewCheckpointHttpFailureCode.RequestTimedOut
          )
        );
      }, timeoutMs);
    });

    try {
      let response: Response;
      try {
        response = await Promise.race([
          this.fetchImpl(`${this.apiUrl}${CHECKPOINT_PATH}${path}`, {
            method: 'POST',
            redirect: 'error',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
            },
            body: serialized,
            signal: abortController.signal,
          }),
          timeoutFailure,
        ]);
      } catch (error) {
        if (error instanceof ReviewCheckpointHttpError) throw error;
        throw new ReviewCheckpointHttpError(
          ReviewCheckpointHttpFailureCode.RequestFailed
        );
      }
      if ([404, 405, 410, 501].includes(response.status)) {
        throw new ReviewCheckpointHttpError(
          ReviewCheckpointHttpFailureCode.UnsupportedEndpoint
        );
      }

      let text: string;
      try {
        text = await this.readBoundedResponseText(
          response,
          timeoutFailure,
          abortController
        );
      } catch (error) {
        if (error instanceof ReviewCheckpointHttpError) throw error;
        throw new ReviewCheckpointHttpError(
          ReviewCheckpointHttpFailureCode.RequestFailed
        );
      }
      if (!response.ok && response.status !== 409) {
        throw new ReviewCheckpointHttpError(
          ReviewCheckpointHttpFailureCode.RequestFailed
        );
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(text);
      } catch {
        throw new ReviewCheckpointHttpError(
          ReviewCheckpointHttpFailureCode.InvalidResponse
        );
      }
      const parsed = schema.safeParse(decoded);
      if (!parsed.success) {
        throw new ReviewCheckpointHttpError(
          ReviewCheckpointHttpFailureCode.InvalidResponse
        );
      }
      return parsed.data;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private availableRequestTimeMs(): number {
    const remainingMs =
      this.deadlineEpochMs === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, this.deadlineEpochMs - this.now());
    return Math.max(0, Math.min(this.requestTimeoutMs, remainingMs));
  }

  private async readBoundedResponseText(
    response: Response,
    timeoutFailure: Promise<never>,
    abortController: AbortController
  ): Promise<string> {
    if (!response.body) {
      const text = await Promise.race([response.text(), timeoutFailure]);
      this.assertResponseSize(text);
      return text;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let byteCount = 0;
    let text = '';
    let completed = false;
    let endOfBody = false;
    try {
      while (!endOfBody) {
        const chunk = await Promise.race([reader.read(), timeoutFailure]);
        endOfBody = chunk.done;
        if (chunk.done) continue;
        byteCount += chunk.value.byteLength;
        if (byteCount > RESPONSE_MAX_BYTES) {
          abortController.abort();
          void reader.cancel().catch(() => undefined);
          throw new ReviewCheckpointHttpError(
            ReviewCheckpointHttpFailureCode.ResponseTooLarge
          );
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      completed = true;
      return text;
    } finally {
      if (completed) reader.releaseLock();
    }
  }

  private assertResponseSize(text: string): void {
    if (Buffer.byteLength(text, 'utf8') > RESPONSE_MAX_BYTES) {
      throw new ReviewCheckpointHttpError(
        ReviewCheckpointHttpFailureCode.ResponseTooLarge
      );
    }
  }
}

function isAllowedCheckpointApiUrl(input: string): URL | null {
  try {
    const parsed = new URL(input);
    if (parsed.protocol === 'https:') return parsed;
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return parsed.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(hostname)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export class FileReviewCheckpointFinalizationMarkerWriter implements ReviewCheckpointFinalizationMarkerWriter {
  static fromEnvironment(
    env: NodeJS.ProcessEnv = process.env
  ): FileReviewCheckpointFinalizationMarkerWriter | null {
    const path = env[REVIEW_CHECKPOINT_FINALIZATION_PATH_ENV]?.trim();
    return path ? new FileReviewCheckpointFinalizationMarkerWriter(path) : null;
  }

  static parse(input: string | unknown): ReviewCheckpointFinalizationMarker {
    return parseReviewCheckpointFinalizationMarker(input);
  }

  constructor(private readonly path: string) {}

  async write(marker: ReviewCheckpointFinalizationMarker): Promise<void> {
    const validated = reviewCheckpointFinalizationMarkerSchema.parse(marker);
    const temporaryPath = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(validated), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await fs.rename(temporaryPath, this.path);
      await fs.chmod(this.path, 0o600);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

export async function createReviewCheckpointSessionFromEnvironment(input: {
  readonly plan: ReviewCheckpointPlanIdentity;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: CheckpointFetch;
  readonly logger?: ReviewCheckpointSessionLogger;
}): Promise<ReviewCheckpointSession | null> {
  const env = input.env ?? process.env;
  const client = HttpReviewCheckpointClient.fromEnvironment({
    env,
    fetchImpl: input.fetchImpl,
  });
  if (!client) return null;

  return ReviewCheckpointSession.open({
    client,
    plan: input.plan,
    markerWriter:
      FileReviewCheckpointFinalizationMarkerWriter.fromEnvironment(env),
    logger: input.logger,
  });
}

function conflictResponseSchema<T extends string>(status: z.ZodLiteral<T>) {
  const base = {
    protocolVersion: z.literal(REVIEW_CHECKPOINT_PROTOCOL_VERSION),
    status,
    currentVersion: versionSchema,
  };
  return z.union([
    z.object(base).strict(),
    z.object({ ...base, currentHeadSha: gitShaSchema }).strict(),
    z
      .object({
        ...base,
        currentHeadSha: gitShaSchema,
        currentPlanHash: hashSchema,
      })
      .strict(),
  ]);
}

function parseOptionalEpochMs(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
