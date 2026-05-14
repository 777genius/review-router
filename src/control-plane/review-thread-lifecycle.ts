import { RuntimeConfigResult } from './runtime-config';
import { LifecycleThreadRecord } from '../types';

type LifecycleResolverFetch = typeof fetch;

export type BackendReviewThreadLifecycleResolveStatus =
  | 'resolved'
  | 'already_resolved'
  | 'skipped'
  | 'manual_attention'
  | 'missing_user_authorization'
  | 'missing_resolver_permission'
  | 'failed';

export interface BackendReviewThreadLifecycleResolveResponse {
  protocolVersion: 1;
  status: BackendReviewThreadLifecycleResolveStatus;
  reasonCodes: string[];
  resolvedBy?: 'github_user' | 'external';
  errorCode?: string;
}

export interface ReviewThreadLifecycleBackendResolver {
  resolveReviewThread(input: {
    prNumber: number;
    reviewedHeadSha: string;
    candidate: LifecycleThreadRecord;
  }): Promise<BackendReviewThreadLifecycleResolveResponse>;
}

export class ControlPlaneReviewThreadLifecycleResolver implements ReviewThreadLifecycleBackendResolver {
  constructor(
    private readonly runtimeConfig: RuntimeConfigResult | undefined,
    private readonly fetchImpl: LifecycleResolverFetch = fetch
  ) {}

  async resolveReviewThread(input: {
    prNumber: number;
    reviewedHeadSha: string;
    candidate: LifecycleThreadRecord;
  }): Promise<BackendReviewThreadLifecycleResolveResponse> {
    if (!this.runtimeConfig || this.runtimeConfig.status !== 'applied') {
      throw new Error('runtime_oidc_session_unavailable');
    }

    const response = await this.fetchImpl(
      joinApiPath(
        this.runtimeConfig.apiUrl,
        '/api/action/v1/review-thread-lifecycle/resolve'
      ),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.runtimeConfig.sessionToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          protocolVersion: 1,
          pullRequestNumber: input.prNumber,
          reviewedHeadSha: input.reviewedHeadSha,
          target: {
            targetId: input.candidate.target.targetId,
            threadId: input.candidate.target.threadId,
            fingerprint: input.candidate.target.fingerprint,
            parentCommentId: input.candidate.target.parentCommentId,
            parentCommentUpdatedAt:
              input.candidate.target.parentCommentUpdatedAt,
            threadCommentCount: input.candidate.target.threadCommentCount,
          },
        }),
      }
    );
    if (!response.ok) {
      const code = await readSafeErrorCode(response);
      throw new Error(
        `review_thread_lifecycle_resolve_failed:${response.status}${code ? `:${code}` : ''}`
      );
    }

    return parseResolveResponse(await response.json());
  }
}

function parseResolveResponse(
  value: unknown
): BackendReviewThreadLifecycleResolveResponse {
  if (!value || typeof value !== 'object') {
    throw new Error('review_thread_lifecycle_invalid_response');
  }
  const input = value as {
    protocolVersion?: unknown;
    status?: unknown;
    reasonCodes?: unknown;
    resolvedBy?: unknown;
    errorCode?: unknown;
  };
  if (
    input.protocolVersion !== 1 ||
    !isResolveStatus(input.status) ||
    !Array.isArray(input.reasonCodes) ||
    !input.reasonCodes.every((reason) => typeof reason === 'string')
  ) {
    throw new Error('review_thread_lifecycle_invalid_response');
  }

  return {
    protocolVersion: 1,
    status: input.status,
    reasonCodes: input.reasonCodes,
    ...(input.resolvedBy === 'github_user' || input.resolvedBy === 'external'
      ? { resolvedBy: input.resolvedBy }
      : {}),
    ...(typeof input.errorCode === 'string' && input.errorCode
      ? { errorCode: input.errorCode }
      : {}),
  };
}

function isResolveStatus(
  value: unknown
): value is BackendReviewThreadLifecycleResolveStatus {
  return (
    value === 'resolved' ||
    value === 'already_resolved' ||
    value === 'skipped' ||
    value === 'manual_attention' ||
    value === 'missing_user_authorization' ||
    value === 'missing_resolver_permission' ||
    value === 'failed'
  );
}

async function readSafeErrorCode(
  response: Response
): Promise<string | undefined> {
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown } | string;
    };
    if (typeof body.error === 'string') return safeReason(body.error);
    if (typeof body.error?.code === 'string')
      return safeReason(body.error.code);
  } catch {
    return undefined;
  }
  return undefined;
}

function joinApiPath(apiUrl: string, path: string): string {
  return `${apiUrl.replace(/\/+$/, '')}${path}`;
}

function safeReason(message: string): string {
  return message
    .replace(/[^a-zA-Z0-9:_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}
