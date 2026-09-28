import { scrubAndAssertReviewActionV2ScmMutationEnv } from '../codex-oauth/auth-input';
import {
  runHostedV4CheckpointFromEnvironment,
  type HostedReadCheckpoint,
} from './action';
import { resolveHostedV4Activation, HOSTED_V4_MODE } from './activation';
import { hostedV4SafeErrorCode } from './boundary';
import { validHostedV4Path } from './hosted-read-client';

export const HOSTED_V4_ENTRY_ABI_VERSION = 1 as const;

const ENV_KEYS = [
  'REVIEW_ROUTER_HOSTED_V4_ADAPTER_ENABLED',
  'REVIEWROUTER_ACTION_V2_MODE',
  'REVIEWROUTER_API_URL',
  'REVIEWROUTER_OIDC_AUDIENCE',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'REVIEW_ROUTER_HOSTED_V4_REPOSITORY_CONNECTION_ID',
  'REVIEW_ROUTER_HOSTED_V4_SCM_REPOSITORY_IDENTITY_ID',
  'PR_NUMBER',
  'REVIEW_HEAD_SHA',
  'REVIEW_ROUTER_HOSTED_V4_REVIEW_REVISION_HASH',
  'REVIEW_ROUTER_HOSTED_V4_PRODUCER_RELEASE_ID',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
  'REVIEW_ROUTER_HOSTED_V4_PROVIDER_INSTANCE_ID',
  'REVIEW_ROUTER_HOSTED_V4_BINDING_ID',
  'REVIEW_ROUTER_HOSTED_V4_BINDING_VERSION',
  'REVIEW_ROUTER_HOSTED_V4_KNOWN_FILE_PATH',
  'REVIEW_ROUTER_HOSTED_V4_DEADLINE_EPOCH_MS',
] as const;

export type HostedV4EntryEnvironment = Partial<
  Record<(typeof ENV_KEYS)[number], string>
>;
export type HostedV4EntryCheckpoint = Readonly<
  HostedReadCheckpoint & {
    abiVersion: typeof HOSTED_V4_ENTRY_ABI_VERSION;
  }
>;
export type HostedV4EntryInput = Readonly<{
  abiVersion: typeof HOSTED_V4_ENTRY_ABI_VERSION;
  requestedMode: typeof HOSTED_V4_MODE;
  environment: HostedV4EntryEnvironment;
  fetchImpl: typeof fetch;
  maskSecret: (secret: string) => void;
  onCheckpoint: (checkpoint: HostedV4EntryCheckpoint) => void;
  now?: () => number;
}>;

/** Inert read evidence only. The Action's paid-turn denial remains in its own path. */
export async function runHostedV4Entry(
  input: HostedV4EntryInput
): Promise<HostedV4EntryCheckpoint> {
  let copied: NodeJS.ProcessEnv | undefined;
  try {
    if (
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).some(
        (key) =>
          ![
            'abiVersion',
            'requestedMode',
            'environment',
            'fetchImpl',
            'maskSecret',
            'onCheckpoint',
            'now',
          ].includes(key)
      ) ||
      input.abiVersion !== HOSTED_V4_ENTRY_ABI_VERSION ||
      input.requestedMode !== HOSTED_V4_MODE ||
      !input.environment ||
      typeof input.environment !== 'object' ||
      Array.isArray(input.environment) ||
      typeof input.fetchImpl !== 'function' ||
      typeof input.maskSecret !== 'function' ||
      typeof input.onCheckpoint !== 'function' ||
      (input.now !== undefined && typeof input.now !== 'function')
    ) {
      throw new Error('hosted_v4_input_invalid');
    }

    const environment = input.environment as NodeJS.ProcessEnv;
    resolveHostedV4Activation({
      requestedMode: input.requestedMode,
      env: environment,
    });
    scrubAndAssertReviewActionV2ScmMutationEnv(environment);
    copied = Object.create(null) as NodeJS.ProcessEnv;
    for (const key of ENV_KEYS) {
      const value = environment[key];
      if (value !== undefined) {
        if (typeof value !== 'string')
          throw new Error('hosted_v4_input_invalid');
        copied[key] = value;
      }
    }
    const checkpoint = await runHostedV4CheckpointFromEnvironment(
      copied,
      input.fetchImpl,
      (secret) => assertSynchronousCallback(input.maskSecret(secret)),
      input.now ?? Date.now
    );
    const result = validateCheckpoint(
      checkpoint,
      copied,
      input.now ?? Date.now
    );
    assertSynchronousCallback(input.onCheckpoint(result));
    return result;
  } catch (error) {
    throw new Error(hostedV4SafeErrorCode(error));
  } finally {
    if (copied) {
      delete copied.ACTIONS_ID_TOKEN_REQUEST_URL;
      delete copied.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    }
    if (input?.environment && typeof input.environment === 'object') {
      delete (input.environment as NodeJS.ProcessEnv)
        .ACTIONS_ID_TOKEN_REQUEST_URL;
      delete (input.environment as NodeJS.ProcessEnv)
        .ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    }
  }
}

function assertSynchronousCallback(value: unknown): void {
  if (value === undefined) return;
  if (value !== null && typeof value === 'object' && 'then' in value) {
    void Promise.resolve(value).catch(() => undefined);
  }
  throw new Error('hosted_v4_input_invalid');
}

function validateCheckpoint(
  checkpoint: HostedReadCheckpoint,
  env: NodeJS.ProcessEnv,
  now: () => number
): HostedV4EntryCheckpoint {
  if (
    !checkpoint ||
    Object.keys(checkpoint).sort().join(',') !==
      [
        'status',
        'authorizationId',
        'headSha',
        'reviewRevisionHash',
        'path',
        'blobSha',
        'contentHash',
        'readExpiresAt',
      ]
        .sort()
        .join(',') ||
    checkpoint.status !== 'read_checkpoint' ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(checkpoint.authorizationId) ||
    checkpoint.headSha !== env.REVIEW_HEAD_SHA ||
    !/^[a-f0-9]{40}$/.test(checkpoint.headSha) ||
    checkpoint.reviewRevisionHash !==
      env.REVIEW_ROUTER_HOSTED_V4_REVIEW_REVISION_HASH ||
    !/^[a-f0-9]{64}$/.test(checkpoint.reviewRevisionHash) ||
    checkpoint.path !== env.REVIEW_ROUTER_HOSTED_V4_KNOWN_FILE_PATH ||
    !validHostedV4Path(checkpoint.path) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(checkpoint.blobSha) ||
    !/^[a-f0-9]{64}$/.test(checkpoint.contentHash) ||
    !Number.isFinite(Date.parse(checkpoint.readExpiresAt)) ||
    Date.parse(checkpoint.readExpiresAt) <= now()
  ) {
    throw new Error('hosted_v4_input_invalid');
  }
  return Object.freeze({
    abiVersion: HOSTED_V4_ENTRY_ABI_VERSION,
    ...checkpoint,
  });
}
