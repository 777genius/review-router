import * as core from '../actions/core';
import { parseTrustedGitHubActionsOidcUrl } from '../codex-oauth/github-actions-oidc';
import { ReviewActionV2Client } from '../control-plane/review-action-v2-client';
import {
  reviewActionV2PublishedSchemaDigest,
  reviewInvestigationExtensionV1,
} from '../control-plane/generated/review-action-v2/review-action-v2';
import { ReviewActionV2ControlPlaneAdapter } from '../review-orchestration/infrastructure/review-action-v2-control-plane-adapter';
import {
  ReviewInvestigationRolloutCapability,
  type ReviewRunAuthorization,
} from '../review-orchestration/application';
import {
  HostedV4ReadClient,
  validHostedV4Path,
  type HostedV4BindingHints,
  type HostedV4ReadAuthority,
  type HostedV4ReadPort,
} from './hosted-read-client';
import { HostedV4Deadline, hostedV4ApiOrigin } from './boundary';

// Canonical authorization facts carry the selected domain protocol identity.
// The generated envelope protocolVersion is the distinct wire version "2".
const hostedV4SelectedReviewProtocolVersion = 'review_action_v2' as const;

export type HostedReadCheckpoint = Readonly<{
  status: 'read_checkpoint';
  authorizationId: string;
  headSha: string;
  reviewRevisionHash: string;
  path: string;
  blobSha: string;
  contentHash: string;
  readExpiresAt: string;
}>;

export type HostedV4Expected = Readonly<{
  repositoryConnectionId: string;
  scmRepositoryIdentityId: string;
  pullRequestNumber: number;
  headSha: string;
  reviewRevisionHash: string;
  producerReleaseId: string;
  sourceRunId: string;
  sourceRunAttempt: string;
}>;

export type HostedV4ActionInput = Readonly<{
  apiUrl: string;
  oidcAudience: string;
  oidcProvider: {
    requestToken(audience: string, signal?: AbortSignal): Promise<string>;
  };
  expected: HostedV4Expected;
  binding: HostedV4BindingHints;
  knownFilePath: string;
  deadlineEpochMs: number;
  now: () => number;
  fetchImpl?: typeof fetch;
  authorize?: {
    authorize(
      input: { oidcToken: string },
      options?: { timeoutMs: number; signal: AbortSignal }
    ): Promise<ReviewRunAuthorization>;
  };
  read?: HostedV4ReadPort;
  maskSecret?: (secret: string) => void;
}>;

/** Admission only: there is deliberately no provider or publisher port. */
export async function runHostedV4ReadCheckpoint(
  input: HostedV4ActionInput
): Promise<HostedReadCheckpoint> {
  validateInput(input);
  const deadline = new HostedV4Deadline(input.deadlineEpochMs, input.now);
  const fetchImpl = input.fetchImpl ?? fetch;
  const authorize =
    input.authorize ??
    new ReviewActionV2ControlPlaneAdapter(
      new ReviewActionV2Client({
        apiUrl: input.apiUrl,
        fetchImpl,
        maxAttempts: 1,
      })
    );
  const oidcToken = await deadline.run((signal) =>
    input.oidcProvider.requestToken(input.oidcAudience, signal)
  );
  if (!oidcToken) throw new Error('hosted_v4_oidc_unavailable');
  input.maskSecret?.(oidcToken);
  const authorization = await deadline.run((signal, timeoutMs) =>
    authorize.authorize({ oidcToken }, { signal, timeoutMs })
  );
  if (authorization.authorizationToken)
    input.maskSecret?.(authorization.authorizationToken);
  validateAuthorization(authorization, input);
  const authority: HostedV4ReadAuthority = {
    authorizationId: authorization.authorizationId,
    authorizationToken: authorization.authorizationToken,
    expiresAt: authorization.expiresAt,
    headSha: authorization.facts.headSha,
    reviewRevisionHash: authorization.facts.reviewRevisionHash,
    producerReleaseId: authorization.producerReleaseId,
  };
  const read =
    input.read ??
    new HostedV4ReadClient({
      apiUrl: input.apiUrl,
      fetchImpl,
      now: input.now,
      deadlineEpochMs: input.deadlineEpochMs,
      maskSecret: input.maskSecret,
    });
  await deadline.run(
    (signal) => read.admit(authority, input.binding, signal),
    authorization.expiresAt
  );
  assertReadExpiry(read.expiresAt(), authorization.expiresAt, input.now());
  const first = await deadline.run(
    (signal) => read.readFile(authority, input.knownFilePath, signal),
    read.expiresAt()
  );
  if (
    first.headSha !== authority.headSha ||
    first.path !== input.knownFilePath
  ) {
    throw new Error('hosted_v4_read_head_or_path_drift');
  }
  // Refresh while the first scope is still live. A denied refresh is terminal.
  const renewedExpiry = await deadline.run(
    (signal) => read.refresh(authority, signal),
    read.expiresAt()
  );
  assertReadExpiry(renewedExpiry, authorization.expiresAt, input.now());
  assertReadExpiry(read.expiresAt(), authorization.expiresAt, input.now());
  const second = await deadline.run(
    (signal) => read.readFile(authority, input.knownFilePath, signal),
    read.expiresAt()
  );
  if (
    second.headSha !== first.headSha ||
    second.path !== first.path ||
    second.blobSha !== first.blobSha ||
    second.contentHash !== first.contentHash
  ) {
    throw new Error('hosted_v4_read_content_drift');
  }
  deadline.assertLive(authorization.expiresAt);
  assertReadExpiry(read.expiresAt(), authorization.expiresAt, input.now());
  return {
    status: 'read_checkpoint',
    authorizationId: authority.authorizationId,
    headSha: authority.headSha,
    reviewRevisionHash: authority.reviewRevisionHash,
    path: first.path,
    blobSha: first.blobSha,
    contentHash: first.contentHash,
    readExpiresAt: read.expiresAt(),
  };
}

export function advanceHostedV4PaidTurn(
  _checkpoint: HostedReadCheckpoint
): never {
  throw new Error('hosted_v4_paid_turn_unavailable');
}

/** The inner Action's environment contract; the outer private wrapper is a separate gate. */
export async function runHostedV4ActionFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<never> {
  const checkpoint = await runHostedV4CheckpointFromEnvironment(
    env,
    fetchImpl,
    core.setSecret
  );
  return advanceHostedV4PaidTurn(checkpoint);
}

/** Explicit environment mapping shared with the inert packaged entrypoint. */
export async function runHostedV4CheckpointFromEnvironment(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  maskSecret: (secret: string) => void,
  now: () => number = Date.now
): Promise<HostedReadCheckpoint> {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`hosted_v4_input_missing_${name}`);
    return value;
  };
  const number = (name: string): number => {
    const raw = required(name);
    if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw new Error(`hosted_v4_input_invalid_${name}`);
    }
    return Number(raw);
  };
  const deadlineEpochMs = number('REVIEW_ROUTER_HOSTED_V4_DEADLINE_EPOCH_MS');
  return runHostedV4ReadCheckpoint({
    apiUrl: required('REVIEWROUTER_API_URL'),
    oidcAudience: required('REVIEWROUTER_OIDC_AUDIENCE'),
    oidcProvider: {
      requestToken: (audience, signal) =>
        requestFreshHostOidcToken(
          env,
          fetchImpl,
          audience,
          maskSecret,
          deadlineEpochMs,
          now,
          signal
        ),
    },
    expected: {
      repositoryConnectionId: required(
        'REVIEW_ROUTER_HOSTED_V4_REPOSITORY_CONNECTION_ID'
      ),
      scmRepositoryIdentityId: required(
        'REVIEW_ROUTER_HOSTED_V4_SCM_REPOSITORY_IDENTITY_ID'
      ),
      pullRequestNumber: number('PR_NUMBER'),
      headSha: required('REVIEW_HEAD_SHA'),
      reviewRevisionHash: required(
        'REVIEW_ROUTER_HOSTED_V4_REVIEW_REVISION_HASH'
      ),
      producerReleaseId: required(
        'REVIEW_ROUTER_HOSTED_V4_PRODUCER_RELEASE_ID'
      ),
      sourceRunId: required('GITHUB_RUN_ID'),
      sourceRunAttempt: required('GITHUB_RUN_ATTEMPT'),
    },
    binding: {
      repositoryConnectionId: required(
        'REVIEW_ROUTER_HOSTED_V4_REPOSITORY_CONNECTION_ID'
      ),
      providerInstanceId: required(
        'REVIEW_ROUTER_HOSTED_V4_PROVIDER_INSTANCE_ID'
      ),
      bindingId: required('REVIEW_ROUTER_HOSTED_V4_BINDING_ID'),
      bindingVersion: number('REVIEW_ROUTER_HOSTED_V4_BINDING_VERSION'),
    },
    knownFilePath: required('REVIEW_ROUTER_HOSTED_V4_KNOWN_FILE_PATH'),
    deadlineEpochMs,
    now,
    fetchImpl,
    maskSecret,
  });
}

function validateInput(input: HostedV4ActionInput): void {
  const expected = input.expected;
  if (
    !input.oidcAudience ||
    input.oidcAudience.length > 256 ||
    !expected.repositoryConnectionId ||
    !expected.scmRepositoryIdentityId ||
    !Number.isSafeInteger(expected.pullRequestNumber) ||
    expected.pullRequestNumber < 1 ||
    !/^[a-f0-9]{40}$/.test(expected.headSha) ||
    !/^[a-f0-9]{64}$/.test(expected.reviewRevisionHash) ||
    !expected.producerReleaseId ||
    !expected.sourceRunId ||
    !expected.sourceRunAttempt ||
    !validHostedV4Path(input.knownFilePath) ||
    !Number.isFinite(input.deadlineEpochMs) ||
    input.deadlineEpochMs <= input.now()
  ) {
    throw new Error('hosted_v4_input_invalid');
  }
  hostedV4ApiOrigin(input.apiUrl);
  if (
    input.binding.repositoryConnectionId !== expected.repositoryConnectionId ||
    ![
      input.binding.repositoryConnectionId,
      input.binding.providerInstanceId,
      input.binding.bindingId,
    ].every(
      (value) =>
        typeof value === 'string' && value.length > 0 && value.length <= 256
    ) ||
    !Number.isSafeInteger(input.binding.bindingVersion) ||
    input.binding.bindingVersion < 1
  ) {
    throw new Error('hosted_v4_binding_hints_invalid');
  }
}

async function requestFreshHostOidcToken(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  audience: string,
  maskSecret: (secret: string) => void,
  deadlineEpochMs: number,
  now: () => number,
  signal?: AbortSignal
): Promise<string> {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken || !audience || audience.length > 256) {
    throw new Error('hosted_v4_oidc_unavailable');
  }
  maskSecret(requestToken);
  const url = parseTrustedGitHubActionsOidcUrl(
    requestUrl,
    'hosted_v4_oidc_url_untrusted'
  );
  url.searchParams.set('audience', audience);
  const remaining = deadlineEpochMs - now();
  if (remaining <= 0) throw new Error('hosted_v4_deadline_expired');
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        controller.abort();
        reject(new Error('hosted_v4_oidc_transport_ambiguous'));
      },
      Math.min(15_000, remaining)
    );
  });
  try {
    const response = await Promise.race([
      fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${requestToken}`,
        },
      }),
      timeout,
    ]);
    if (signal?.aborted) throw new Error('hosted_v4_deadline_expired');
    if (
      response.status !== 200 ||
      response.redirected ||
      new URL(response.url || url).origin !== url.origin ||
      !response.body
    ) {
      throw new Error('hosted_v4_oidc_denied');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    for (;;) {
      const part = await Promise.race([reader.read(), timeout]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8 * 1024) throw new Error('hosted_v4_oidc_response_too_large');
      chunks.push(part.value);
    }
    const payload = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks, size)
      )
    ) as unknown;
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      Object.keys(payload).join(',') !== 'value' ||
      typeof (payload as { value?: unknown }).value !== 'string' ||
      !(payload as { value: string }).value
    ) {
      throw new Error('hosted_v4_oidc_malformed');
    }
    const token = (payload as { value: string }).value;
    if (signal?.aborted) throw new Error('hosted_v4_deadline_expired');
    maskSecret(token);
    return token;
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (
      code === 'hosted_v4_oidc_denied' ||
      code === 'hosted_v4_oidc_malformed' ||
      code === 'hosted_v4_oidc_response_too_large' ||
      code === 'hosted_v4_oidc_transport_ambiguous'
    ) {
      throw new Error(code);
    }
    throw new Error('hosted_v4_oidc_transport_ambiguous');
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

function validateAuthorization(
  value: ReviewRunAuthorization,
  input: HostedV4ActionInput
): void {
  const facts = value.facts;
  const expected = input.expected;
  const recording = facts.reviewInvestigation?.providerCapabilities.some(
    (provider) =>
      provider.providerKind === 'codex' &&
      provider.capabilities.includes(
        ReviewInvestigationRolloutCapability.Recording
      )
  );
  if (
    !value.authorizationId ||
    !value.authorizationToken ||
    !/^(?:0|[1-9][0-9]*)$/.test(value.mutationEpoch) ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= input.now() ||
    facts.repositoryConnectionId !== expected.repositoryConnectionId ||
    facts.scmRepositoryIdentityId !== expected.scmRepositoryIdentityId ||
    facts.pullRequestNumber !== expected.pullRequestNumber ||
    facts.headSha !== expected.headSha ||
    facts.reviewRevisionHash !== expected.reviewRevisionHash ||
    facts.sourceRunId !== expected.sourceRunId ||
    facts.sourceRunAttempt !== expected.sourceRunAttempt ||
    facts.producerReleaseId !== expected.producerReleaseId ||
    value.producerReleaseId !== expected.producerReleaseId ||
    facts.selectedProtocolVersion !== hostedV4SelectedReviewProtocolVersion ||
    facts.schemaDigest !== reviewActionV2PublishedSchemaDigest ||
    facts.trustDomain !== 'trusted_managed' ||
    facts.reviewInvestigation?.extensionId !==
      reviewInvestigationExtensionV1.extensionId ||
    facts.reviewInvestigation.extensionSchemaDigest !==
      reviewInvestigationExtensionV1.schemaDigest ||
    facts.reviewInvestigation.extensionCanonicalizerDigest !==
      reviewInvestigationExtensionV1.canonicalizerDigest ||
    !recording
  ) {
    throw new Error('hosted_v4_authority_stale_or_unsupported');
  }
}

function assertReadExpiry(
  readExpiry: string,
  authorizationExpiry: string,
  now: number
): void {
  const expiry = Date.parse(readExpiry);
  if (
    !Number.isFinite(expiry) ||
    expiry <= now ||
    expiry > Date.parse(authorizationExpiry)
  ) {
    throw new Error('hosted_v4_read_expiry_invalid');
  }
}
