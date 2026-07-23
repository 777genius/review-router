import { RuntimeConfigResult } from './runtime-config';

export type ManualReviewRequestCommandKind = 'skip' | 'unskip' | 'review';

export enum ManualReviewRequestAvailability {
  Available = 'available',
  ExplicitlyUnsupported = 'explicitly_unsupported',
  Unavailable = 'unavailable',
}

export interface ManualReviewRequestPort {
  availability(): ManualReviewRequestAvailability;
  request(input: {
    readonly pullRequestNumber: number;
    readonly expectedHeadSha: string;
    readonly sourceId: string;
    readonly commandKind: ManualReviewRequestCommandKind;
  }): Promise<{ readonly status: 'queued' | 'restored' | 'unsupported' }>;
}

export class ControlPlaneManualReviewRequestClient implements ManualReviewRequestPort {
  constructor(
    private readonly runtimeConfig: RuntimeConfigResult | undefined,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  availability(): ManualReviewRequestAvailability {
    if (this.runtimeConfig?.status === 'applied') {
      return ManualReviewRequestAvailability.Available;
    }
    if (!this.runtimeConfig || this.runtimeConfig.status === 'skipped') {
      return ManualReviewRequestAvailability.ExplicitlyUnsupported;
    }
    return ManualReviewRequestAvailability.Unavailable;
  }

  async request(
    input: Parameters<ManualReviewRequestPort['request']>[0]
  ): Promise<{ readonly status: 'queued' | 'restored' | 'unsupported' }> {
    const availability = this.availability();
    if (availability === ManualReviewRequestAvailability.Unavailable) {
      throw new Error('manual_review_request_control_plane_unavailable');
    }
    if (
      availability === ManualReviewRequestAvailability.ExplicitlyUnsupported
    ) {
      return { status: 'unsupported' };
    }
    const runtime = this.runtimeConfig as Extract<
      RuntimeConfigResult,
      { status: 'applied' }
    >;
    const response = await this.fetchImpl(
      new URL(
        '/api/action/v1/review-requests/manual',
        ensureTrailingSlash(runtime.apiUrl)
      ).toString(),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${runtime.sessionToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ protocolVersion: 1, ...input }),
      }
    );
    if (response.status === 426) {
      return { status: 'unsupported' };
    }
    if (response.status === 404) {
      const body = await readErrorBody(response);
      if (isExplicitlyUnsupported(body)) return { status: 'unsupported' };
      throw new Error(
        `manual_review_request_failed:404:${errorCode(body) || 'unknown'}`
      );
    }
    if (!response.ok) {
      throw new Error(`manual_review_request_failed:${response.status}`);
    }
    const body = (await response.json()) as { status?: unknown };
    if (body.status !== 'queued' && body.status !== 'restored') {
      throw new Error('manual_review_request_invalid_response');
    }
    return { status: body.status };
  }
}

async function readErrorBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isExplicitlyUnsupported(value: unknown): boolean {
  const code = errorCode(value);
  if (code === 'review_request_intent_disabled') return true;
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.error === 'Not Found' &&
    typeof record.message === 'string' &&
    record.message.includes('/api/action/v1/review-requests/manual') &&
    record.message.includes('not found')
  );
}

function errorCode(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const error = (value as Record<string, unknown>).error;
  if (!error || typeof error !== 'object') return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' ? code : null;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
