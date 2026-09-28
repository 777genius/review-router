import { createHash } from 'crypto';
import { hostedV4ApiOrigin } from './boundary';

const MAX_FILE_BYTES = 1_000_000;
const MAX_FILE_RESPONSE_BYTES = 1_500_000;
const MAX_CONTROL_RESPONSE_BYTES = 8 * 1024;
const CAPABILITY = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;
const SHA = /^[a-f0-9]{40}$/;
const BLOB = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export class HostedV4ReadError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'HostedV4ReadError';
  }
}

export type HostedV4ReadAuthority = Readonly<{
  authorizationId: string;
  authorizationToken: string;
  expiresAt: string;
  headSha: string;
  reviewRevisionHash: string;
  producerReleaseId: string;
}>;

export type HostedV4BindingHints = Readonly<{
  repositoryConnectionId: string;
  providerInstanceId: string;
  bindingId: string;
  bindingVersion: number;
}>;

export type HostedV4FileRead = Readonly<{
  path: string;
  headSha: string;
  blobSha: string;
  contentHash: string;
}>;

type ReadCapability = Readonly<{
  capability: string;
  expiresAt: string;
  authorizationId: string;
  headSha: string;
  reviewRevisionHash: string;
  producerReleaseId: string;
}>;

export interface HostedV4ReadPort {
  admit(
    authority: HostedV4ReadAuthority,
    hints: HostedV4BindingHints,
    signal?: AbortSignal
  ): Promise<void>;
  refresh(
    authority: HostedV4ReadAuthority,
    signal?: AbortSignal
  ): Promise<string>;
  readFile(
    authority: HostedV4ReadAuthority,
    path: string,
    signal?: AbortSignal
  ): Promise<HostedV4FileRead>;
  expiresAt(): string;
}

export function validHostedV4Path(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    !path.startsWith('/') &&
    path
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..') &&
    Array.from(path).every((character) => {
      const code = character.charCodeAt(0);
      return (
        character !== '\\' && character !== '%' && code >= 0x20 && code !== 0x7f
      );
    })
  );
}

/** Only these three private routes receive the scoped capability. */
export class HostedV4ReadClient implements HostedV4ReadPort {
  private readonly origin: URL;
  private current: ReadCapability | null = null;
  private pendingRefresh: Promise<string> | null = null;

  constructor(
    private readonly input: {
      readonly apiUrl: string;
      readonly fetchImpl: typeof fetch;
      readonly now: () => number;
      readonly deadlineEpochMs: number;
      readonly maskSecret?: (value: string) => void;
    }
  ) {
    let origin: URL;
    try {
      origin = hostedV4ApiOrigin(input.apiUrl);
    } catch {
      throw new HostedV4ReadError('hosted_v4_api_url_invalid');
    }
    this.origin = origin;
    if (
      !Number.isFinite(input.deadlineEpochMs) ||
      input.deadlineEpochMs <= input.now()
    ) {
      throw new HostedV4ReadError('hosted_v4_deadline_expired');
    }
  }

  async admit(
    authority: HostedV4ReadAuthority,
    hints: HostedV4BindingHints,
    signal?: AbortSignal
  ): Promise<void> {
    this.assertAuthority(authority);
    if (
      ![
        hints.repositoryConnectionId,
        hints.providerInstanceId,
        hints.bindingId,
      ].every(
        (value) =>
          typeof value === 'string' && value.length > 0 && value.length <= 256
      ) ||
      !Number.isSafeInteger(hints.bindingVersion) ||
      hints.bindingVersion < 1
    ) {
      throw new HostedV4ReadError('hosted_v4_binding_hints_invalid');
    }
    const raw = await this.post(
      '/api/hosted/v4/read-capabilities',
      {
        authorizationToken: authority.authorizationToken,
        ...hints,
      },
      201,
      MAX_CONTROL_RESPONSE_BYTES,
      authority.expiresAt,
      signal
    );
    this.current = this.parseCapability(raw, authority);
  }

  async refresh(
    authority: HostedV4ReadAuthority,
    signal?: AbortSignal
  ): Promise<string> {
    this.requireCurrent(authority);
    if (this.pendingRefresh) return this.pendingRefresh;
    const operation = this.refreshOnce(authority, signal);
    this.pendingRefresh = operation;
    try {
      return await operation;
    } finally {
      if (this.pendingRefresh === operation) this.pendingRefresh = null;
    }
  }

  private async refreshOnce(
    authority: HostedV4ReadAuthority,
    signal?: AbortSignal
  ): Promise<string> {
    const current = this.requireCurrent(authority);
    const raw = await this.post(
      '/api/hosted/v4/read-capabilities/refresh',
      {
        capability: current.capability,
        authorizationToken: authority.authorizationToken,
      },
      200,
      MAX_CONTROL_RESPONSE_BYTES,
      current.expiresAt,
      signal
    );
    const next = this.parseCapability(raw, authority);
    this.current = next;
    return next.expiresAt;
  }

  async readFile(
    authority: HostedV4ReadAuthority,
    path: string,
    signal?: AbortSignal
  ): Promise<HostedV4FileRead> {
    if (!validHostedV4Path(path))
      throw new HostedV4ReadError('hosted_v4_read_path_invalid');
    let raw: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const read = this.requireCurrent(authority);
        raw = await this.post(
          '/api/hosted/v4/files/read',
          {
            capability: read.capability,
            path,
          },
          200,
          MAX_FILE_RESPONSE_BYTES,
          read.expiresAt,
          signal
        );
        break;
      } catch (error) {
        if (signal?.aborted)
          throw new HostedV4ReadError('hosted_v4_read_scope_expired');
        if (
          attempt !== 0 ||
          !(error instanceof HostedV4ReadError) ||
          error.code !== 'hosted_v4_read_transport_ambiguous'
        )
          throw error;
      }
    }
    const file = strictRecord(raw, [
      'path',
      'headSha',
      'blobSha',
      'contentBase64',
    ]);
    if (
      file.path !== path ||
      file.headSha !== authority.headSha ||
      typeof file.headSha !== 'string' ||
      !SHA.test(file.headSha) ||
      typeof file.blobSha !== 'string' ||
      !BLOB.test(file.blobSha) ||
      typeof file.contentBase64 !== 'string' ||
      file.contentBase64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        file.contentBase64
      )
    ) {
      throw new HostedV4ReadError('hosted_v4_read_malformed_or_stale');
    }
    const bytes = Buffer.from(file.contentBase64, 'base64');
    if (
      bytes.length > MAX_FILE_BYTES ||
      bytes.toString('base64') !== file.contentBase64
    ) {
      throw new HostedV4ReadError('hosted_v4_read_malformed_or_stale');
    }
    return {
      path,
      headSha: authority.headSha,
      blobSha: file.blobSha,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  expiresAt(): string {
    if (!this.current)
      throw new HostedV4ReadError('hosted_v4_read_not_admitted');
    return this.current.expiresAt;
  }

  private assertAuthority(authority: HostedV4ReadAuthority): void {
    if (
      !authority.authorizationId ||
      !authority.authorizationToken ||
      authority.authorizationToken.length > 4096 ||
      !SHA.test(authority.headSha) ||
      !/^[a-f0-9]{64}$/.test(authority.reviewRevisionHash) ||
      !authority.producerReleaseId ||
      !Number.isFinite(Date.parse(authority.expiresAt)) ||
      Date.parse(authority.expiresAt) <= this.input.now()
    ) {
      throw new HostedV4ReadError('hosted_v4_authority_expired_or_malformed');
    }
  }

  private requireCurrent(authority: HostedV4ReadAuthority): ReadCapability {
    this.assertAuthority(authority);
    const current = this.current;
    if (
      !current ||
      current.authorizationId !== authority.authorizationId ||
      current.headSha !== authority.headSha ||
      current.reviewRevisionHash !== authority.reviewRevisionHash ||
      current.producerReleaseId !== authority.producerReleaseId ||
      Date.parse(current.expiresAt) <= this.input.now()
    ) {
      throw new HostedV4ReadError('hosted_v4_read_capability_expired_or_stale');
    }
    return current;
  }

  private parseCapability(
    raw: unknown,
    authority: HostedV4ReadAuthority
  ): ReadCapability {
    if (
      raw &&
      typeof raw === 'object' &&
      'capability' in raw &&
      typeof raw.capability === 'string'
    )
      this.input.maskSecret?.(raw.capability);
    const value = strictRecord(raw, ['capability', 'expiresAt']);
    if (
      typeof value.capability !== 'string' ||
      value.capability.length > 4096 ||
      !CAPABILITY.test(value.capability) ||
      typeof value.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= this.input.now() ||
      Date.parse(value.expiresAt) > Date.parse(authority.expiresAt)
    ) {
      throw new HostedV4ReadError('hosted_v4_read_capability_malformed');
    }
    return {
      capability: value.capability,
      expiresAt: value.expiresAt,
      authorizationId: authority.authorizationId,
      headSha: authority.headSha,
      reviewRevisionHash: authority.reviewRevisionHash,
      producerReleaseId: authority.producerReleaseId,
    };
  }

  private async post(
    path: string,
    body: object,
    expectedStatus: number,
    maxBytes: number,
    expiry: string,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (signal?.aborted)
      throw new HostedV4ReadError('hosted_v4_read_scope_expired');
    const deadline = Math.min(this.input.deadlineEpochMs, Date.parse(expiry));
    const remaining = deadline - this.input.now();
    if (remaining <= 0)
      throw new HostedV4ReadError('hosted_v4_read_scope_expired');
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized, 'utf8') > 8 * 1024) {
      throw new HostedV4ReadError('hosted_v4_read_request_too_large');
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          controller.abort();
          reject(new HostedV4ReadError('hosted_v4_read_transport_ambiguous'));
        },
        Math.min(15_000, remaining)
      );
    });
    let response: Response;
    try {
      response = await Promise.race([
        this.input.fetchImpl(new URL(path, this.origin), {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: serialized,
        }),
        timeout,
      ]);
      if (signal?.aborted)
        throw new HostedV4ReadError('hosted_v4_read_scope_expired');
      if (
        response.redirected ||
        new URL(response.url || this.origin).origin !== this.origin.origin
      ) {
        throw new HostedV4ReadError('hosted_v4_read_origin_drift');
      }
      if (response.status === 403)
        throw new HostedV4ReadError('hosted_v4_read_authority_denied');
      if (response.status === 429)
        throw new HostedV4ReadError('hosted_v4_read_capacity_limited');
      if (response.status === 503)
        throw new HostedV4ReadError('hosted_v4_read_transient_unavailable');
      if (response.status !== expectedStatus) {
        throw new HostedV4ReadError(
          response.status === 404
            ? 'hosted_v4_read_route_unavailable'
            : 'hosted_v4_read_http_failure'
        );
      }
      if (!response.body)
        throw new HostedV4ReadError('hosted_v4_read_response_malformed');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await Promise.race([reader.read(), timeout]);
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxBytes)
          throw new HostedV4ReadError('hosted_v4_read_response_too_large');
        chunks.push(part.value);
      }
      let json: string;
      try {
        json = new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.concat(chunks, size)
        );
      } catch {
        throw new HostedV4ReadError('hosted_v4_read_response_malformed');
      }
      if (this.input.now() >= deadline)
        throw new HostedV4ReadError('hosted_v4_read_scope_expired');
      if (signal?.aborted)
        throw new HostedV4ReadError('hosted_v4_read_scope_expired');
      try {
        return JSON.parse(json) as unknown;
      } catch {
        throw new HostedV4ReadError('hosted_v4_read_response_malformed');
      }
    } catch (error) {
      if (error instanceof HostedV4ReadError) throw error;
      throw new HostedV4ReadError('hosted_v4_read_transport_ambiguous');
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }
}

function strictRecord(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',')
  ) {
    throw new HostedV4ReadError('hosted_v4_read_response_malformed');
  }
  return value as Record<string, unknown>;
}
