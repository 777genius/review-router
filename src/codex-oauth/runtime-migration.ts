import { createHash } from 'node:crypto';
import * as core from '../actions/core';
import {
  clearCodexRotatingAuthInput,
  readCodexRotatingAuthInput,
} from './auth-input';
import {
  compactCodexAuthJsonBytes,
  computeCodexAccountIdentityHash,
  computeCodexAuthGenerationHash,
  encryptCodexAuthForGitHubSecret,
} from './crypto';
import {
  clearGitHubActionsOidcRequestEnv,
  GitHubActionsOidcTokenProvider,
} from './github-actions-oidc';

export const CODEX_RUNTIME_MIGRATION_AUDIENCE =
  'reviewrouter.codex-runtime-migration.v1';
const MAX_RESPONSE_BYTES = 128 * 1024;
const migrationIdPattern = /^codex_migration_[a-f0-9-]{36}$/;
const opaqueIdPattern = /^[A-Za-z0-9_.:-]{8,180}$/;
const claimIdPattern =
  /^codex_claim_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const saltedDigestPattern = /^[A-Za-z0-9_-]{32,128}$/;
const secretNamePattern =
  /^REVIEWROUTER_CODEX_AUTH_JSON_R[1-9][0-9]*_P[a-f0-9]{16}_E[1-9][0-9]*_[a-f0-9]{32}$/;

type MigrationContext = Readonly<{
  migrationId: string;
  setupOrigin: string;
  providerInstanceId: string;
  namespaceId: string;
  namespaceEpoch: string;
  repositoryId: string;
  repositoryFullName: string;
  sourceCommitSha: string;
  runtimeCommitSha: string;
  ref: string;
}>;

type MigrationManifest = Readonly<{
  raw: string;
  setupNonce: string;
  generationHashSalt: string;
  accountFingerprintSalt: string;
  installerVersion: string;
  installerDigest: string;
  source: Readonly<{
    namespaceId: string;
    namespaceEpoch: string;
    canonicalizationVersion: 1;
    generationHash: string;
    accountIdentityHash: string;
    secretName: string;
  }>;
}>;

type Exchange = Readonly<{
  manifest: MigrationManifest;
  recoveryEpoch: string;
  githubPublicKey: { keyId: string; key: string };
  urls: { prepare: string; dispatch: string; outcome: string; status: string };
}>;

type ClaimStatus = Readonly<{
  status: 'prepared' | 'confirmed_candidate' | 'active';
  attempt: null | Readonly<{ attemptId: string; status: string }>;
}>;

/** Copies the one active runner-held credential into the existing sealed setup
 * ledger. It never logs in, refreshes OAuth, selects an account or calls a model. */
export async function runCodexRuntimeMigration(
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    now?: () => number;
  } = {}
): Promise<{ status: 'confirmed_candidate' | 'active' }> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(5 * 60_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const fetchImpl = options.fetchImpl ?? fetch;
  const boundedFetch: typeof fetch = async (url, init) => {
    signal.throwIfAborted();
    const response = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(30_000),
        ...(init?.signal ? [init.signal] : []),
      ]),
    });
    const bytes = await readBoundedResponse(response);
    signal.throwIfAborted();
    return new Response(
      response.status === 204 ? null : Uint8Array.from(bytes),
      {
        status: response.status,
        headers: response.headers,
      }
    );
  };
  let authJsonBytes = '';
  let compactAuthJson = '';
  try {
    signal.throwIfAborted();
    const context = readContext(env);
    if (env['INPUT_AUTH-JSON'] !== undefined)
      fail('credential_source_ambiguous');
    authJsonBytes = readCodexRotatingAuthInput(env).authJsonBytes;
    const compact = compactCodexAuthJsonBytes({ authJsonBytes });
    compactAuthJson = compact.compactAuthJsonBytes;
    authJsonBytes = '';
    const oidc = new GitHubActionsOidcTokenProvider({
      env,
      fetchImpl: boundedFetch,
    });
    let token = await oidc.requestToken(CODEX_RUNTIME_MIGRATION_AUDIENCE);
    clearGitHubActionsOidcRequestEnv(env);
    let exchangePayload: unknown;
    try {
      exchangePayload = await postJson(
        boundedFetch,
        `${context.setupOrigin}/api/codex-rotating/runtime-migration/exchange`,
        { migrationId: context.migrationId },
        { authorization: `Bearer ${token}` }
      );
    } finally {
      token = '';
    }
    const exchange = readExchange(exchangePayload, context, now());
    const manifest = exchange.manifest;
    const generationHash = computeCodexAuthGenerationHash({
      authJsonBytes: compactAuthJson,
      generationHashSalt: manifest.generationHashSalt,
    });
    const accountIdentityHash = computeCodexAccountIdentityHash({
      authJsonBytes: compactAuthJson,
      accountFingerprintSalt: manifest.accountFingerprintSalt,
    });
    if (
      generationHash !== manifest.source.generationHash ||
      accountIdentityHash !== manifest.source.accountIdentityHash
    )
      fail('source_credential_changed');
    const prepared = mapping(
      await postJson(boundedFetch, exchange.urls.prepare, {
        payloadVersion: 2,
        canonicalizationVersion: 1,
        operationId: context.migrationId,
        repositoryId: context.repositoryId,
        providerInstanceId: context.providerInstanceId,
        setupNonce: manifest.setupNonce,
        manifestDigest: createHash('sha256')
          .update(manifest.raw, 'utf8')
          .digest('hex'),
        recoveryEpoch: exchange.recoveryEpoch,
        generationHash,
        accountIdentityHash,
        accountIdentityAlgorithm: 'provider_issuer_subject_account_v1',
        authByteSize: compact.byteLength,
        installerVersion: manifest.installerVersion,
        installerDigest: manifest.installerDigest,
        runtimeMigrationSource: {
          namespaceId: manifest.source.namespaceId,
          namespaceEpoch: manifest.source.namespaceEpoch,
          canonicalizationVersion: 1,
          generationHash,
          accountIdentityHash,
        },
      })
    );
    const claimId = string(prepared.claimId, claimIdPattern);
    core.setSecret(claimId);
    if (
      ![
        'prepared',
        'prepared_replay',
        'confirmed_candidate',
        'active',
      ].includes(String(prepared.status))
    )
      fail('claim_invalid');

    const readStatus = async () =>
      readClaimStatus(
        await postJson(boundedFetch, exchange.urls.status, { claimId }),
        claimId,
        manifest
      );
    const status = await readStatus();
    if (status.status !== 'prepared') return { status: status.status };
    // An existing authorization may already have reached GitHub. Only its
    // durable status can complete this run; never allocate a replacement PUT.
    if (status.attempt !== null) fail('dispatch_outcome_unknown');
    const encrypted = await encryptCodexAuthForGitHubSecret({
      authJsonBytes: compactAuthJson,
      githubPublicKeyBase64: exchange.githubPublicKey.key,
      githubKeyId: exchange.githubPublicKey.keyId,
      generationHashSalt: manifest.generationHashSalt,
    });
    compactAuthJson = '';
    signal.throwIfAborted();
    let dispatched: Record<string, unknown>;
    try {
      dispatched = mapping(
        await postJson(boundedFetch, exchange.urls.dispatch, {
          claimId,
          idempotencyKey: `runtime-migration:${context.migrationId}`,
          encryptedValue: encrypted.encryptedValue,
          keyId: encrypted.keyId,
        })
      );
      if (
        dispatched.status !== 'confirmed' ||
        (dispatched.responseCode !== 201 && dispatched.responseCode !== 204)
      )
        fail('dispatch_response_invalid');
      readTargetAttempt(dispatched, claimId, manifest);
    } catch {
      const restored = await readStatus().catch(() => undefined);
      if (restored && restored.status !== 'prepared')
        return { status: restored.status };
      fail('dispatch_outcome_unknown');
    }
    try {
      await postJson(boundedFetch, exchange.urls.outcome, {
        claimId,
        attemptId: dispatched.attemptId,
        outcome: 'definite_success',
        responseCode: dispatched.responseCode,
      });
    } catch {
      // The existing writer already persists the definite GitHub response.
      // A lost acknowledgment is recovered by readback, without another PUT.
    }
    const confirmed = await readStatus();
    if (confirmed.status === 'prepared') fail('confirmation_pending');
    return { status: confirmed.status };
  } finally {
    authJsonBytes = '';
    compactAuthJson = '';
    clearCodexRotatingAuthInput(env);
    clearGitHubActionsOidcRequestEnv(env);
    controller.abort();
  }
}

function readContext(env: NodeJS.ProcessEnv): MigrationContext {
  const migrationId = string(env.INPUT_MIGRATION_ID, migrationIdPattern);
  const providerInstanceId = string(
    env.INPUT_PROVIDER_INSTANCE_ID,
    opaqueIdPattern
  );
  const repositoryId = string(env.GITHUB_REPOSITORY_ID, /^[1-9][0-9]*$/);
  const setup = new URL(string(env.INPUT_SETUP_BASE_URL, /^.{1,2048}$/));
  if (
    setup.username ||
    setup.password ||
    setup.search ||
    setup.hash ||
    setup.pathname !== '/' ||
    (setup.protocol !== 'https:' &&
      !(
        setup.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(setup.hostname)
      ))
  )
    fail('setup_origin_invalid');
  if (
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.RR_WORKFLOW_REPOSITORY !== '777genius/review-router' ||
    providerInstanceId !== `codex-rotating:${repositoryId}`
  )
    fail('runner_identity_invalid');
  return {
    migrationId,
    providerInstanceId,
    repositoryId,
    setupOrigin: setup.origin,
    namespaceId: string(env.INPUT_SOURCE_NAMESPACE_ID, opaqueIdPattern),
    namespaceEpoch: string(
      env.INPUT_SOURCE_NAMESPACE_EPOCH,
      /^[1-9][0-9]{0,19}$/
    ),
    repositoryFullName: string(
      env.GITHUB_REPOSITORY,
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
    ),
    sourceCommitSha: string(env.GITHUB_SHA, shaPattern),
    runtimeCommitSha: string(env.RR_WORKFLOW_SHA, shaPattern),
    ref: string(env.GITHUB_REF, /^refs\/heads\/.{1,255}$/),
  };
}

function readExchange(
  value: unknown,
  context: MigrationContext,
  now: number
): Exchange {
  const exchange = mapping(value);
  if (
    exchange.version !== 1 ||
    exchange.migrationId !== context.migrationId ||
    typeof exchange.payloadClaimed !== 'boolean'
  )
    fail('exchange_invalid');
  const expiresAt = date(exchange.expiresAt);
  const recoveryExpiresAt = date(exchange.recoveryExpiresAt);
  if ((exchange.payloadClaimed ? recoveryExpiresAt : expiresAt) <= now)
    fail('exchange_expired');
  const encoded = string(exchange.manifestBase64, /^[A-Za-z0-9_-]{1,65536}$/);
  core.setSecret(encoded);
  const raw = Buffer.from(encoded, 'base64url').toString('utf8');
  const manifest = mapping(JSON.parse(raw));
  const binding = mapping(manifest.runtimeMigration);
  const source = mapping(binding.source);
  const bootstrap = mapping(binding.bootstrap);
  const installer = mapping(manifest.installer);
  if (
    manifest.protocolVersion !== 2 ||
    manifest.authMode !== 'codex_subscription_oauth_rotating' ||
    manifest.repositoryId !== context.repositoryId ||
    manifest.repositoryFullName !== context.repositoryFullName ||
    manifest.providerInstanceId !== context.providerInstanceId ||
    binding.version !== 1 ||
    binding.migrationId !== context.migrationId ||
    binding.targetActionRef !==
      `777genius/review-router@${context.runtimeCommitSha}` ||
    binding.targetActionRef === source.actionRef ||
    bootstrap.sourceCommitSha !== context.sourceCommitSha ||
    `refs/heads/${String(binding.defaultBranch)}` !== context.ref ||
    source.namespaceId !== context.namespaceId ||
    source.namespaceEpoch !== context.namespaceEpoch ||
    source.canonicalizationVersion !== 1 ||
    manifest.generationHashSalt !== source.generationHashSalt ||
    manifest.accountFingerprintSalt !== source.accountFingerprintSalt ||
    date(manifest.expiresAt) !== expiresAt ||
    date(manifest.generatedAt) > now + 60_000
  )
    fail('manifest_binding_mismatch');
  const setupNonce = string(manifest.setupNonce, opaqueIdPattern);
  core.setSecret(setupNonce);
  const key = mapping(exchange.githubPublicKey);
  const setup = mapping(exchange.setup);
  const url = (key: string, suffix: string) => {
    const expected = `${context.setupOrigin}/api/codex-rotating/${suffix}`;
    if (setup[key] !== expected) fail('setup_route_mismatch');
    return expected;
  };
  return {
    manifest: {
      raw,
      setupNonce,
      generationHashSalt: string(
        manifest.generationHashSalt,
        /^[A-Za-z0-9_-]{22,128}$/
      ),
      accountFingerprintSalt: string(
        manifest.accountFingerprintSalt,
        /^[A-Za-z0-9_-]{22,128}$/
      ),
      installerVersion: string(installer.version, /^[A-Za-z0-9_.@/-]{1,120}$/),
      installerDigest: string(installer.sha256, digestPattern),
      source: {
        namespaceId: context.namespaceId,
        namespaceEpoch: context.namespaceEpoch,
        canonicalizationVersion: 1,
        generationHash: string(source.generationHash, saltedDigestPattern),
        accountIdentityHash: string(
          source.accountIdentityHash,
          saltedDigestPattern
        ),
        secretName: string(source.secretName, secretNamePattern),
      },
    },
    recoveryEpoch: string(exchange.recoveryEpoch, /^[0-9]{1,20}$/),
    githubPublicKey: {
      keyId: string(key.keyId, /^[A-Za-z0-9_.:-]{1,512}$/),
      key: string(key.key, /^[A-Za-z0-9+/]{43}=$/),
    },
    urls: {
      prepare: url('prepareUrl', 'setup-prepare'),
      dispatch: url('dispatchUrl', 'setup-dispatch'),
      outcome: url('dispatchOutcomeUrl', 'setup-dispatch-outcome'),
      status: url('statusUrl', 'setup-status'),
    },
  };
}

function readClaimStatus(
  value: unknown,
  claimId: string,
  manifest: MigrationManifest
): ClaimStatus {
  const status = mapping(value);
  if (
    status.claimId !== claimId ||
    !['prepared', 'confirmed_candidate', 'active'].includes(
      String(status.status)
    )
  )
    fail('claim_status_invalid');
  const attempt =
    status.attempt === null
      ? null
      : readTargetAttempt(status.attempt, claimId, manifest);
  if (status.status !== 'prepared' && attempt?.status !== 'confirmed')
    fail('claim_status_invalid');
  return { status: status.status as ClaimStatus['status'], attempt };
}

function readTargetAttempt(
  value: unknown,
  claimId: string,
  manifest: MigrationManifest
) {
  const attempt = mapping(value);
  const namespaceEpoch = string(attempt.namespaceEpoch, /^[1-9][0-9]{0,19}$/);
  const namespaceId = string(attempt.namespaceId, opaqueIdPattern);
  const secretName = string(attempt.secretName, secretNamePattern);
  if (
    attempt.claimId !== claimId ||
    namespaceId === manifest.source.namespaceId ||
    BigInt(namespaceEpoch) <= BigInt(manifest.source.namespaceEpoch) ||
    secretName === manifest.source.secretName ||
    ![
      'dispatch_authorized',
      'confirmed',
      'retired_ambiguous',
      'retired_confirmed',
    ].includes(String(attempt.status))
  )
    fail('target_attempt_invalid');
  return {
    attemptId: string(attempt.attemptId, opaqueIdPattern),
    status: String(attempt.status),
  };
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  value: unknown,
  headers: Record<string, string> = {}
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'POST',
    redirect: 'error',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(value),
  });
  if (!response.ok) fail('control_request_failed');
  return response.json();
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) fail('control_response_too_large');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function mapping(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('response_invalid');
  return value as Record<string, unknown>;
}
function string(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value))
    fail('response_invalid');
  return value;
}
function date(value: unknown): number {
  const parsed = Date.parse(string(value, /^\d{4}-\d{2}-\d{2}T.*Z$/));
  if (!Number.isFinite(parsed)) fail('response_invalid');
  return parsed;
}
function fail(reason: string): never {
  throw new Error(`codex_runtime_migration_${reason}`);
}
