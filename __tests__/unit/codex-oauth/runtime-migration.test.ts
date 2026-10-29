import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sodium from 'libsodium-wrappers';
import yaml from 'js-yaml';
import * as core from '../../../src/actions/core';
import {
  compactCodexAuthJsonBytes,
  computeCodexAccountIdentityHash,
  computeCodexAuthGenerationHash,
} from '../../../src/codex-oauth/crypto';
import {
  CODEX_RUNTIME_MIGRATION_AUDIENCE,
  runCodexRuntimeMigration,
} from '../../../src/codex-oauth/runtime-migration';

const now = Date.parse('2026-10-26T12:00:00.000Z');
const migrationId = 'codex_migration_11111111-1111-4111-8111-111111111111';
const claimId = 'codex_claim_22222222-2222-4222-8222-222222222222';
const runtimeSha = 'b'.repeat(40);
const bootstrapSha = 'c'.repeat(40);
const baseUrl = 'https://reviewrouter.example';
const generationHashSalt = Buffer.alloc(32, 5).toString('base64url');
const accountFingerprintSalt = Buffer.alloc(32, 8).toString('base64url');
const token = (claims: unknown) =>
  `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
const authJson = JSON.stringify(
  {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'access-fixture-must-stay-local',
      refresh_token: 'refresh-fixture-never-refreshed',
      id_token: token({
        iss: 'https://auth.openai.com',
        sub: 'subject-fixture',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'account-fixture',
        },
      }),
    },
    last_refresh: '2026-10-25T12:00:00.000Z',
  },
  null,
  2
);
const compact = compactCodexAuthJsonBytes({ authJsonBytes: authJson });
const sourceSecret =
  'REVIEWROUTER_CODEX_AUTH_JSON_R123_P0123456789abcdef_E3_0123456789abcdef0123456789abcdef';
const targetSecret =
  'REVIEWROUTER_CODEX_AUTH_JSON_R123_P0123456789abcdef_E4_abcdef0123456789abcdef0123456789';

beforeEach(() =>
  jest.spyOn(core, 'setSecret').mockImplementation(() => undefined)
);
afterEach(() => jest.restoreAllMocks());

async function fixture() {
  await sodium.ready;
  const keyPair = sodium.crypto_box_keypair();
  const env = (): NodeJS.ProcessEnv => ({
    INPUT_MIGRATION_ID: migrationId,
    INPUT_SETUP_BASE_URL: baseUrl,
    INPUT_PROVIDER_INSTANCE_ID: 'codex-rotating:123',
    INPUT_SOURCE_NAMESPACE_ID: 'namespace-original',
    INPUT_SOURCE_NAMESPACE_EPOCH: '3',
    INPUT_AUTH_JSON: authJson,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY_ID: '123',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_SHA: bootstrapSha,
    GITHUB_REF: 'refs/heads/main',
    RR_WORKFLOW_REPOSITORY: '777genius/review-router',
    RR_WORKFLOW_SHA: runtimeSha,
    ACTIONS_ID_TOKEN_REQUEST_URL:
      'https://pipelines.actions.githubusercontent.com/token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-request-fixture',
  });
  const source = {
    namespaceId: 'namespace-original',
    namespaceEpoch: '3',
    canonicalizationVersion: 1,
    secretName: sourceSecret,
    mutationEpoch: '2',
    generation: 7,
    generationHashSalt,
    accountFingerprintSalt,
    generationHash: computeCodexAuthGenerationHash({
      authJsonBytes: compact.compactAuthJsonBytes,
      generationHashSalt,
    }),
    accountIdentityHash: computeCodexAccountIdentityHash({
      authJsonBytes: compact.compactAuthJsonBytes,
      accountFingerprintSalt,
    }),
    actionRef: `777genius/review-router@${'a'.repeat(40)}`,
    workflowPath: '.github/workflows/reviewrouter-codex.yml',
    workflowSourceCommitSha: 'd'.repeat(40),
    workflowSourceBlobSha: 'e'.repeat(40),
    workflowSourceSha256: 'f'.repeat(64),
    workflowSemanticSha256: '1'.repeat(64),
    workflowSchemaVersion: 5,
  };
  const manifest = {
    protocolVersion: 2,
    repositoryFullName: 'owner/repo',
    repositoryId: '123',
    repositoryIdentityVersion: 1,
    providerInstanceId: 'codex-rotating:123',
    setupNonce: 'stp:33333333-3333-4333-8333-333333333333',
    authMode: 'codex_subscription_oauth_rotating',
    generatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 900_000).toISOString(),
    installer: {
      url: `https://raw.githubusercontent.com/777genius/review-router/${runtimeSha}/scripts/seed-codex-rotating-auth.sh`,
      version: runtimeSha,
      sha256: '2'.repeat(64),
    },
    generationHashSalt,
    accountFingerprintSalt,
    runtimeMigration: {
      version: 1,
      migrationId,
      source,
      targetActionRef: `777genius/review-router@${runtimeSha}`,
      defaultBranch: 'main',
      bootstrap: {
        workflowId: '100',
        sourceCommitSha: bootstrapSha,
        sourceBlobSha: '3'.repeat(40),
        sourceSha256: '4'.repeat(64),
      },
      ingress: [
        {
          workflowId: '101',
          workflowPath: source.workflowPath,
          sourceBlobSha: source.workflowSourceBlobSha,
          sourceSha256: source.workflowSourceSha256,
        },
      ],
    },
  };
  const exchange = {
    version: 1,
    migrationId,
    manifestBase64: '',
    recoveryEpoch: '4',
    expiresAt: manifest.expiresAt,
    recoveryExpiresAt: new Date(now + 3_600_000).toISOString(),
    payloadClaimed: false,
    githubPublicKey: {
      keyId: 'key-fixture',
      key: Buffer.from(keyPair.publicKey).toString('base64'),
    },
    setup: {
      prepareUrl: `${baseUrl}/api/codex-rotating/setup-prepare`,
      dispatchUrl: `${baseUrl}/api/codex-rotating/setup-dispatch`,
      dispatchOutcomeUrl: `${baseUrl}/api/codex-rotating/setup-dispatch-outcome`,
      statusUrl: `${baseUrl}/api/codex-rotating/setup-status`,
    },
  };
  const attempt = {
    claimId,
    attemptId: 'attempt-fixture',
    namespaceId: 'namespace-candidate',
    namespaceEpoch: '4',
    secretName: targetSecret,
    status: 'confirmed',
    dispatchExpiresAt: new Date(now + 600_000).toISOString(),
  };
  let claimStatus = 'prepared';
  let currentAttempt: typeof attempt | null = null;
  let dispatchFailure: 'none' | 'lost-confirmed' | 'unknown' = 'none';
  let outcomeFailure = false;
  let onStatus: (() => void) | undefined;
  const calls: Array<{
    url: string;
    body: Record<string, unknown> | null;
    authorization: string | null;
  }> = [];
  let dispatchCount = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : null;
    const authorization = new Headers(init?.headers).get('authorization');
    calls.push({ url, body, authorization });
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (
      url.startsWith('https://pipelines.actions.githubusercontent.com/token')
    ) {
      expect(new URL(url).searchParams.get('audience')).toBe(
        CODEX_RUNTIME_MIGRATION_AUDIENCE
      );
      return Response.json({ value: 'oidc-fixture' });
    }
    if (url.endsWith('/runtime-migration/exchange')) {
      exchange.manifestBase64 = Buffer.from(JSON.stringify(manifest)).toString(
        'base64url'
      );
      return Response.json(exchange);
    }
    if (url.endsWith('/setup-prepare')) {
      exchange.payloadClaimed = true;
      return Response.json({
        status: claimStatus === 'prepared' ? 'prepared_replay' : claimStatus,
        claimId,
        claimVersion: 1,
      });
    }
    if (url.endsWith('/setup-status')) {
      onStatus?.();
      return Response.json({
        status: claimStatus,
        claimId,
        databaseIncarnation: 'db-fixture',
        databaseRecoveryWitnessFingerprint: 'witness-fixture',
        attempt: currentAttempt,
      });
    }
    if (url.endsWith('/setup-dispatch')) {
      dispatchCount++;
      expect(body?.idempotencyKey).toBe(`runtime-migration:${migrationId}`);
      expect(body?.claimId).toBe(claimId);
      const decrypted = sodium.crypto_box_seal_open(
        Buffer.from(String(body?.encryptedValue), 'base64'),
        keyPair.publicKey,
        keyPair.privateKey
      );
      expect(Buffer.from(decrypted).toString('utf8')).toBe(
        compact.compactAuthJsonBytes
      );
      if (dispatchFailure === 'unknown') {
        currentAttempt = { ...attempt, status: 'dispatch_authorized' };
        throw new Error('fixture-response-lost');
      }
      claimStatus = 'confirmed_candidate';
      currentAttempt = attempt;
      if (dispatchFailure === 'lost-confirmed')
        throw new Error('fixture-response-lost');
      return Response.json({ ...attempt, responseCode: 204 });
    }
    if (url.endsWith('/setup-dispatch-outcome')) {
      if (outcomeFailure) throw new Error('fixture-confirmation-lost');
      return Response.json({ status: claimStatus });
    }
    throw new Error(`unexpected-fixture-url:${url}`);
  };
  return {
    env,
    source,
    manifest,
    exchange,
    calls,
    attempt,
    fetchImpl,
    get dispatchCount() {
      return dispatchCount;
    },
    setDispatchFailure(value: typeof dispatchFailure) {
      dispatchFailure = value;
    },
    failOutcome() {
      outcomeFailure = true;
    },
    confirm(status: string) {
      claimStatus = status;
      currentAttempt = attempt;
      exchange.payloadClaimed = true;
    },
    onStatus(callback: () => void) {
      onStatus = callback;
    },
  };
}

it('copies identical compact credentials through the existing sealed ledger with one provider PUT and no refresh', async () => {
  const h = await fixture();
  const env = h.env();
  await expect(
    runCodexRuntimeMigration({ env, fetchImpl: h.fetchImpl, now: () => now })
  ).resolves.toEqual({ status: 'confirmed_candidate' });
  expect(h.dispatchCount).toBe(1);
  const prepare = h.calls.find((call) =>
    call.url.endsWith('/setup-prepare')
  )!.body!;
  expect(prepare).toMatchObject({
    operationId: migrationId,
    canonicalizationVersion: 1,
    payloadVersion: 2,
    generationHash: h.source.generationHash,
    accountIdentityHash: h.source.accountIdentityHash,
    runtimeMigrationSource: {
      namespaceId: h.source.namespaceId,
      namespaceEpoch: h.source.namespaceEpoch,
      canonicalizationVersion: 1,
      generationHash: h.source.generationHash,
      accountIdentityHash: h.source.accountIdentityHash,
    },
    manifestDigest: createHash('sha256')
      .update(JSON.stringify(h.manifest))
      .digest('hex'),
  });
  const calls = JSON.stringify(h.calls);
  expect(calls).not.toContain('refresh-fixture-never-refreshed');
  expect(calls).not.toContain('access-fixture-must-stay-local');
  expect(calls).not.toContain('auth.openai.com');
  expect(
    h.calls
      .filter((call) => call.authorization === 'Bearer oidc-fixture')
      .map((call) => call.url)
  ).toEqual([`${baseUrl}/api/codex-rotating/runtime-migration/exchange`]);
  expect(env).not.toHaveProperty('INPUT_AUTH_JSON');
  expect(env).not.toHaveProperty('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
  expect(core.setSecret).toHaveBeenCalledWith(h.manifest.setupNonce);
  expect(core.setSecret).toHaveBeenCalledWith(claimId);
});

it.each(['lost-confirmed', 'outcome-ack'] as const)(
  'uses status only after a lost %s acknowledgment',
  async (fault) => {
    const h = await fixture();
    if (fault === 'lost-confirmed') h.setDispatchFailure(fault);
    else h.failOutcome();
    await expect(
      runCodexRuntimeMigration({
        env: h.env(),
        fetchImpl: h.fetchImpl,
        now: () => now,
      })
    ).resolves.toEqual({ status: 'confirmed_candidate' });
    expect(h.dispatchCount).toBe(1);
  }
);

it('keeps unknown dispatch fenced across a fresh runner process and never resends the PUT', async () => {
  const h = await fixture();
  h.setDispatchFailure('unknown');
  for (let run = 0; run < 2; run++)
    await expect(
      runCodexRuntimeMigration({
        env: h.env(),
        fetchImpl: h.fetchImpl,
        now: () => now,
      })
    ).rejects.toThrow('codex_runtime_migration_dispatch_outcome_unknown');
  expect(h.dispatchCount).toBe(1);
  expect(
    h.calls.filter((call) => call.url.endsWith('/setup-dispatch-outcome'))
  ).toHaveLength(0);
});

it.each(['confirmed_candidate', 'active'])(
  'restores an already %s migration without another encrypted dispatch',
  async (status) => {
    const h = await fixture();
    h.confirm(status);
    await expect(
      runCodexRuntimeMigration({
        env: h.env(),
        fetchImpl: h.fetchImpl,
        now: () => now,
      })
    ).resolves.toEqual({ status });
    expect(h.dispatchCount).toBe(0);
  }
);

it('uses the original recovery deadline for a claimed migration without renewing the manifest', async () => {
  const h = await fixture();
  h.confirm('confirmed_candidate');
  await expect(
    runCodexRuntimeMigration({
      env: h.env(),
      fetchImpl: h.fetchImpl,
      now: () => now + 900_001,
    })
  ).resolves.toEqual({ status: 'confirmed_candidate' });
  expect(h.dispatchCount).toBe(0);
  const prepare = h.calls.find((call) =>
    call.url.endsWith('/setup-prepare')
  )!.body!;
  expect(prepare.manifestDigest).toBe(
    createHash('sha256').update(JSON.stringify(h.manifest)).digest('hex')
  );

  h.calls.length = 0;
  const expiredEnv = h.env();
  await expect(
    runCodexRuntimeMigration({
      env: expiredEnv,
      fetchImpl: h.fetchImpl,
      now: () => now + 3_600_001,
    })
  ).rejects.toThrow('codex_runtime_migration_exchange_expired');
  expect(h.calls.some((call) => call.url.endsWith('/setup-prepare'))).toBe(
    false
  );
  expect(expiredEnv).not.toHaveProperty('INPUT_AUTH_JSON');
  expect(expiredEnv).not.toHaveProperty('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
});

it('rejects a second credential input before exchanging OIDC and clears both sources', async () => {
  const h = await fixture();
  const env = { ...h.env(), 'INPUT_AUTH-JSON': authJson };
  await expect(
    runCodexRuntimeMigration({ env, fetchImpl: h.fetchImpl, now: () => now })
  ).rejects.toThrow('codex_runtime_migration_credential_source_ambiguous');
  expect(h.calls).toHaveLength(0);
  expect(env).not.toHaveProperty('INPUT_AUTH_JSON');
  expect(env).not.toHaveProperty('INPUT_AUTH-JSON');
  expect(env).not.toHaveProperty('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
});

it('bounds an oversized control response before claim or encrypted dispatch', async () => {
  const h = await fixture();
  const env = h.env();
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/runtime-migration/exchange'))
      return new Response('x'.repeat(128 * 1024 + 1));
    return h.fetchImpl(input, init);
  };
  await expect(
    runCodexRuntimeMigration({ env, fetchImpl, now: () => now })
  ).rejects.toThrow('codex_runtime_migration_control_response_too_large');
  expect(h.dispatchCount).toBe(0);
  expect(h.calls.some((call) => call.url.endsWith('/setup-prepare'))).toBe(
    false
  );
  expect(env).not.toHaveProperty('INPUT_AUTH_JSON');
  expect(env).not.toHaveProperty('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
});

it.each([
  'generation',
  'account',
  'source-namespace',
  'target-sha',
  'bootstrap-sha',
  'repository',
  'salt-domain',
  'callback-origin',
  'expired',
])('rejects %s substitution before claim or write', async (fault) => {
  const h = await fixture();
  const env = h.env();
  if (fault === 'generation')
    env.INPUT_AUTH_JSON = authJson.replace(
      'refresh-fixture-never-refreshed',
      'different-refresh-fixture'
    );
  if (fault === 'account')
    h.source.accountIdentityHash = Buffer.alloc(32, 12).toString('base64url');
  if (fault === 'source-namespace')
    h.source.namespaceId = 'other-source-namespace';
  if (fault === 'target-sha')
    h.manifest.runtimeMigration.targetActionRef = `777genius/review-router@${'e'.repeat(40)}`;
  if (fault === 'bootstrap-sha')
    h.manifest.runtimeMigration.bootstrap.sourceCommitSha = 'f'.repeat(40);
  if (fault === 'repository') h.manifest.repositoryId = '999';
  if (fault === 'salt-domain')
    h.manifest.generationHashSalt = Buffer.alloc(32, 12).toString('base64url');
  if (fault === 'callback-origin')
    h.exchange.setup.dispatchUrl =
      'https://other.example/api/codex-rotating/setup-dispatch';
  if (fault === 'expired')
    h.exchange.expiresAt = new Date(now - 1).toISOString();
  await expect(
    runCodexRuntimeMigration({ env, fetchImpl: h.fetchImpl, now: () => now })
  ).rejects.toThrow();
  expect(
    h.calls.filter((call) => /setup-(prepare|dispatch)$/.test(call.url))
  ).toHaveLength(0);
  expect(env).not.toHaveProperty('INPUT_AUTH_JSON');
  expect(env).not.toHaveProperty('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
});

it('cancels before the first dispatch and clears private input without a fallback', async () => {
  const h = await fixture();
  const controller = new AbortController();
  h.onStatus(() => controller.abort());
  const env = h.env();
  await expect(
    runCodexRuntimeMigration({
      env,
      fetchImpl: h.fetchImpl,
      now: () => now,
      signal: controller.signal,
    })
  ).rejects.toThrow();
  expect(h.dispatchCount).toBe(0);
  expect(env).not.toHaveProperty('INPUT_AUTH_JSON');
});

it('keeps the migration reusable finite, immutable, read-only and isolated from PR code', () => {
  const source = fs.readFileSync(
    path.resolve(
      __dirname,
      '../../../.github/workflows/reviewrouter-runtime-migration.yml'
    ),
    'utf8'
  );
  const workflow = yaml.load(source, { schema: yaml.JSON_SCHEMA }) as {
    on: {
      workflow_call: {
        inputs: Record<string, unknown>;
        secrets: Record<string, unknown>;
      };
    };
    jobs: {
      migrate: {
        permissions: Record<string, string>;
        steps: Array<{
          uses?: string;
          with?: Record<string, unknown>;
          env?: Record<string, unknown>;
          run?: string;
        }>;
      };
    };
  };
  expect(source).toContain(
    '# ReviewRouter credential-preserving runtime migration v1'
  );
  expect(Object.keys(workflow.on.workflow_call.inputs).sort()).toEqual([
    'migration_id',
    'provider_instance_id',
    'setup_base_url',
    'source_namespace_epoch',
    'source_namespace_id',
  ]);
  expect(Object.keys(workflow.on.workflow_call.secrets)).toEqual([
    'codex_auth_json',
  ]);
  expect(workflow.jobs.migrate.permissions).toEqual({
    contents: 'read',
    'id-token': 'write',
  });
  const checkouts = workflow.jobs.migrate.steps.filter((step) =>
    step.uses?.startsWith('actions/checkout@')
  );
  expect(checkouts).toHaveLength(1);
  expect(checkouts[0]?.with).toEqual({
    repository: '777genius/review-router',
    ref: '${{ job.workflow_sha }}',
    path: '.reviewrouter-runtime',
    'persist-credentials': false,
  });
  const credentialSteps = workflow.jobs.migrate.steps.filter(
    (step) => step.env?.INPUT_AUTH_JSON
  );
  expect(credentialSteps).toHaveLength(1);
  expect(credentialSteps[0]?.run).toBe(
    'node .reviewrouter-runtime/dist/runtime-migration.js'
  );
  expect(source).not.toMatch(
    /codex login|codex app-server|setupNonce|manifestBase64|GITHUB_TOKEN|secrets: inherit/
  );
});
