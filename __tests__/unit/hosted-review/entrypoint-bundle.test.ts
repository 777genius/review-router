import { createHash } from 'crypto';
import { createRequire } from 'module';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'fs';
import path from 'path';
import { buildSync } from 'esbuild';
import {
  reviewActionV2PublishedProtocolVersion as protocolVersion,
  reviewActionV2PublishedSchemaDigest as schemaDigest,
  reviewInvestigationExtensionV1 as extension,
} from '../../../src/control-plane/generated/review-action-v2/review-action-v2';

type Entry = typeof import('../../../src/hosted-review/entrypoint');
const head = 'a'.repeat(40);
const revision = 'b'.repeat(64);
const blob = 'c'.repeat(40);
const knownPath = 'src/known.ts';
const content = 'export const synthetic = true;\n';
const firstCapability = `synthetic.${'x'.repeat(43)}`;
const secondCapability = `synthetic.${'y'.repeat(43)}`;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

function fixture() {
  const root = mkdtempSync(path.join(process.cwd(), '.rr-hosted-v4-fixture-'));
  const dist = path.join(root, 'dist');
  mkdirSync(dist);
  buildSync({
    entryPoints: ['src/hosted-review/entrypoint.ts'],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    minify: true,
    outfile: path.join(dist, 'hosted-v4-entry.cjs'),
  });
  const generated = path.join(
    root,
    'src/control-plane/generated/review-action-v2'
  );
  mkdirSync(path.dirname(generated), { recursive: true });
  cpSync(
    path.join(process.cwd(), 'src/control-plane/generated/review-action-v2'),
    generated,
    { recursive: true }
  );
  // The launch layout contains a bundle and verified data; no executable TS or node_modules.
  expect(readdirSync(root).sort()).toEqual(['dist', 'src']);
  expect(existsSync(path.join(root, 'src/hosted-review'))).toBe(false);
  const entry = createRequire(path.join(root, 'launch.cjs'))(
    path.join(dist, 'hosted-v4-entry.cjs')
  ) as Entry;
  expect(Object.keys(entry).sort()).toEqual([
    'HOSTED_V4_ENTRY_ABI_VERSION',
    'runHostedV4Entry',
  ]);
  return { root, generated, entry };
}

function env(now: number): Record<string, string> {
  return {
    REVIEW_ROUTER_HOSTED_V4_ADAPTER_ENABLED: '1',
    REVIEWROUTER_ACTION_V2_MODE: 't0',
    REVIEWROUTER_API_URL: 'https://synthetic.example/',
    REVIEWROUTER_OIDC_AUDIENCE: 'synthetic-audience',
    ACTIONS_ID_TOKEN_REQUEST_URL:
      'https://token.actions.githubusercontent.com/synthetic-oidc',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-request-token',
    REVIEW_ROUTER_HOSTED_V4_REPOSITORY_CONNECTION_ID: 'synthetic-connection',
    REVIEW_ROUTER_HOSTED_V4_SCM_REPOSITORY_IDENTITY_ID: 'synthetic-repository',
    PR_NUMBER: '12',
    REVIEW_HEAD_SHA: head,
    REVIEW_ROUTER_HOSTED_V4_REVIEW_REVISION_HASH: revision,
    REVIEW_ROUTER_HOSTED_V4_PRODUCER_RELEASE_ID: 'synthetic-release',
    GITHUB_RUN_ID: 'synthetic-run',
    GITHUB_RUN_ATTEMPT: '1',
    REVIEW_ROUTER_HOSTED_V4_PROVIDER_INSTANCE_ID: 'synthetic-provider',
    REVIEW_ROUTER_HOSTED_V4_BINDING_ID: 'synthetic-binding',
    REVIEW_ROUTER_HOSTED_V4_BINDING_VERSION: '1',
    REVIEW_ROUTER_HOSTED_V4_KNOWN_FILE_PATH: knownPath,
    REVIEW_ROUTER_HOSTED_V4_DEADLINE_EPOCH_MS: String(now + 180_000),
  };
}

function transport(now: number, blobSha = blob) {
  const calls: {
    route: string;
    body: Record<string, unknown>;
    headers?: HeadersInit;
  }[] = [];
  const limits = Object.fromEntries(
    [
      'maxAttemptsPerSlot',
      'maxLeaseDurationMs',
      'maxObservationBytes',
      'maxObservationFindings',
      'maxProjectionBytes',
      'maxProjectionFindings',
      'maxPublicationBodyBytes',
      'maxPublicationChunks',
      'maxPublicationOperations',
      'maxReconciliationDurationMs',
      'maxRequestBatchSize',
      'maxResultReportDurationMs',
      'maxWorkSlots',
    ].map((key) => [key, 10])
  );
  const facts = {
    workspaceId: 'synthetic-workspace',
    repositoryConnectionId: 'synthetic-connection',
    scmRepositoryIdentityId: 'synthetic-repository',
    pullRequestNumber: 12,
    sourceRunId: 'synthetic-run',
    sourceRunAttempt: '1',
    baseSha: 'd'.repeat(40),
    mergeBaseSha: 'e'.repeat(40),
    headSha: head,
    reviewRevisionHash: revision,
    producerReleaseId: 'synthetic-release',
    selectedProtocolVersion: 'review_action_v2',
    schemaDigest,
    trustDomain: 'trusted_managed',
    providerVoteLanes: [
      { providerKind: 'codex', providerVoteIdentityHash: 'f'.repeat(64) },
    ],
    reviewInvestigation: {
      authorizationDescriptorVersion: 3,
      capability: 'review_investigation_v1',
      coverageProfileHash: '1'.repeat(64),
      extensionCanonicalizerDigest: extension.canonicalizerDigest,
      extensionId: extension.extensionId,
      extensionSchemaDigest: extension.schemaDigest,
      policyHash: '2'.repeat(64),
      providerCapabilities: [
        { providerKind: 'codex', capabilities: ['recording'] },
      ],
    },
  };
  const json = (value: unknown, status: number): Response =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetchImpl = jest.fn(
    async (request: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(request));
      if (
        url.origin !== 'https://synthetic.example' &&
        url.origin !== 'https://token.actions.githubusercontent.com'
      )
        throw new Error('unexpected origin');
      const route = url.pathname;
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      calls.push({ route, body, headers: init?.headers });
      if (route === '/synthetic-oidc')
        return json({ value: 'synthetic-oidc-token' }, 200);
      if (route === '/api/action/v2/review-runs/authorize')
        return json(
          {
            protocolVersion,
            schemaDigest,
            requestId: body.requestId,
            serverTime: new Date(now).toISOString(),
            result: {
              status: 'authorized',
              authorizationId: 'synthetic-authorization',
              authorizationToken: 'synthetic-authorization-token',
              producerReleaseId: 'synthetic-release',
              protocolLimitsProfileId: 'synthetic-limits',
              operationalSloProfileId: 'synthetic-slo',
              mutationEpoch: '1',
              expiresAt: new Date(now + 240_000).toISOString(),
              authorizationFactsCanonicalJson: canonical(facts),
              protocolLimitsCanonicalJson: canonical(limits),
            },
          },
          201
        );
      if (route === '/api/hosted/v4/read-capabilities')
        return json(
          {
            capability: firstCapability,
            expiresAt: new Date(now + 120_000).toISOString(),
          },
          201
        );
      if (route === '/api/hosted/v4/read-capabilities/refresh')
        return json(
          {
            capability: secondCapability,
            expiresAt: new Date(now + 120_000).toISOString(),
          },
          200
        );
      if (route === '/api/hosted/v4/files/read')
        return json(
          {
            path: knownPath,
            headSha: head,
            blobSha,
            contentBase64: Buffer.from(content).toString('base64'),
          },
          200
        );
      throw new Error('unexpected route');
    }
  ) as typeof fetch;
  return { fetchImpl, calls };
}

describe('built hosted v4 CJS sidecar without executable source', () => {
  let launch: ReturnType<typeof fixture>;
  beforeAll(() => {
    launch = fixture();
  });
  afterAll(() => {
    rmSync(launch.root, { recursive: true, force: true });
  });

  // Regression: a source-relative import or a wider launch path would fail or reach an unlisted route.
  it('returns only a bounded checkpoint after OIDC, authorization, admit, read, refresh and same-file read', async () => {
    const now = Date.now();
    const environment: Parameters<Entry['runHostedV4Entry']>[0]['environment'] &
      Record<string, string> = {
      ...env(now),
      INPUT_AUTH_JSON: 'forbidden-synthetic-auth-json',
      OPENROUTER_API_KEY: 'forbidden-synthetic-provider-key',
      NODE_OPTIONS: '--inspect',
      GITHUB_OUTPUT: '/forbidden-output',
    };
    const { fetchImpl, calls } = transport(now);
    const masks: string[] = [];
    const receipts: unknown[] = [];
    const ambientFetch = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => {
        throw new Error('ambient transport forbidden');
      });
    let result: Awaited<ReturnType<Entry['runHostedV4Entry']>>;
    try {
      result = await launch.entry.runHostedV4Entry({
        abiVersion: 1,
        requestedMode: 'hosted-pool-v4',
        environment,
        fetchImpl,
        maskSecret: (value: string) => {
          masks.push(value);
        },
        onCheckpoint: (value) => {
          receipts.push(value);
        },
        now: () => now,
      });
      expect(ambientFetch).not.toHaveBeenCalled();
    } finally {
      ambientFetch.mockRestore();
    }
    expect(calls.map((call) => call.route)).toEqual([
      '/synthetic-oidc',
      '/api/action/v2/review-runs/authorize',
      '/api/hosted/v4/read-capabilities',
      '/api/hosted/v4/files/read',
      '/api/hosted/v4/read-capabilities/refresh',
      '/api/hosted/v4/files/read',
    ]);
    expect(calls[0].headers).toMatchObject({
      authorization: `Bearer ${'synthetic-request-token'}`,
    });
    expect(calls[1].body.oidcToken).toBe('synthetic-oidc-token');
    expect(calls[4].body.capability).toBe(firstCapability);
    expect(calls[5].body.capability).toBe(secondCapability);
    expect(masks).toEqual(
      expect.arrayContaining([
        'synthetic-request-token',
        'synthetic-oidc-token',
        'synthetic-authorization-token',
        firstCapability,
        secondCapability,
      ])
    );
    expect(result).toEqual({
      abiVersion: 1,
      status: 'read_checkpoint',
      authorizationId: 'synthetic-authorization',
      headSha: head,
      reviewRevisionHash: revision,
      path: knownPath,
      blobSha: blob,
      contentHash: createHash('sha256').update(content).digest('hex'),
      readExpiresAt: new Date(now + 120_000).toISOString(),
    });
    expect(receipts).toEqual([result]);
    expect(JSON.stringify(result)).not.toMatch(
      /token|capability|contentBase64|forbidden-synthetic/i
    );
    expect(environment.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
    expect(environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
  });

  // Regression: an unexpected SCM mutation key must be scrubbed and terminate before OIDC.
  it('scrubs unexpected SCM authority before filtering the environment', async () => {
    const now = Date.now();
    const environment: Record<string, string> = {
      ...env(now),
      INPUT_REVIEW_APP_TOKEN: 'synthetic-scm-token',
    };
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    await expect(
      launch.entry.runHostedV4Entry({
        abiVersion: 1,
        requestedMode: 'hosted-pool-v4',
        environment,
        fetchImpl,
        maskSecret: jest.fn(),
        onCheckpoint: jest.fn(),
        now: () => now,
      } as Parameters<Entry['runHostedV4Entry']>[0])
    ).rejects.toThrow('hosted_v4_failed_closed');
    expect(environment.INPUT_REVIEW_APP_TOKEN).toBeUndefined();
    expect(environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Regression: asynchronous masking could let a transport start before the secret is masked.
  it('requires synchronous masking before any transport call', async () => {
    const now = Date.now();
    const environment = env(now);
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    await expect(
      launch.entry.runHostedV4Entry({
        abiVersion: 1,
        requestedMode: 'hosted-pool-v4',
        environment,
        fetchImpl,
        maskSecret: async () => undefined,
        onCheckpoint: jest.fn(),
        now: () => now,
      })
    ).rejects.toThrow('hosted_v4_input_invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
  });

  // Regression: a callback exception must not carry arbitrary text across the port.
  it('redacts callback failures and clears OIDC inputs after a completed read', async () => {
    const now = Date.now();
    const environment = env(now);
    const { fetchImpl, calls } = transport(now);
    await expect(
      launch.entry.runHostedV4Entry({
        abiVersion: 1,
        requestedMode: 'hosted-pool-v4',
        environment,
        fetchImpl,
        maskSecret: jest.fn(),
        onCheckpoint: () => {
          throw new Error('synthetic-private-message');
        },
        now: () => now,
      } as Parameters<Entry['runHostedV4Entry']>[0])
    ).rejects.toThrow('hosted_v4_failed_closed');
    expect(calls).toHaveLength(6);
    expect(environment.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
    expect(environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
  });

  // Regression: the read client accepts a 64-hex blob ID; the entrypoint must deliver its checkpoint after both consistent reads.
  it('delivers a bounded checkpoint for a consistent 64-hex blob ID', async () => {
    const now = Date.now();
    const environment = env(now);
    const blobSha = 'c'.repeat(64);
    const { fetchImpl, calls } = transport(now, blobSha);
    const onCheckpoint = jest.fn();
    const result = await launch.entry.runHostedV4Entry({
      abiVersion: 1,
      requestedMode: 'hosted-pool-v4',
      environment,
      fetchImpl,
      maskSecret: jest.fn(),
      onCheckpoint,
      now: () => now,
    });
    expect(calls.map((call) => call.route)).toEqual([
      '/synthetic-oidc',
      '/api/action/v2/review-runs/authorize',
      '/api/hosted/v4/read-capabilities',
      '/api/hosted/v4/files/read',
      '/api/hosted/v4/read-capabilities/refresh',
      '/api/hosted/v4/files/read',
    ]);
    expect(result).toEqual({
      abiVersion: 1,
      status: 'read_checkpoint',
      authorizationId: 'synthetic-authorization',
      headSha: head,
      reviewRevisionHash: revision,
      path: knownPath,
      blobSha,
      contentHash: createHash('sha256').update(content).digest('hex'),
      readExpiresAt: new Date(now + 120_000).toISOString(),
    });
    expect(onCheckpoint).toHaveBeenCalledTimes(1);
    expect(onCheckpoint).toHaveBeenCalledWith(result);
    expect(environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
  });

  // Regression: disabled, malformed ABI/T0, or absent handoff must never start transport.
  it('fails closed before transport for disabled, malformed ABI/T0 and missing contract data', async () => {
    const now = Date.now();
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const call = (environment: Record<string, string>, abiVersion: number) =>
      launch.entry.runHostedV4Entry({
        abiVersion,
        requestedMode: 'hosted-pool-v4',
        environment,
        fetchImpl,
        maskSecret: jest.fn(),
        onCheckpoint: jest.fn(),
        now: () => now,
      } as Parameters<Entry['runHostedV4Entry']>[0]);
    await expect(
      call({ ...env(now), REVIEW_ROUTER_HOSTED_V4_ADAPTER_ENABLED: '0' }, 1)
    ).rejects.toThrow('hosted_v4_adapter_disabled');
    await expect(call(env(now), 2)).rejects.toThrow('hosted_v4_input_invalid');
    await expect(
      call({ ...env(now), REVIEWROUTER_ACTION_V2_MODE: 'disabled' }, 1)
    ).rejects.toThrow('hosted_v4_verified_t0_handoff_required');
    rmSync(launch.generated, { recursive: true, force: true });
    await expect(call(env(now), 1)).rejects.toThrow('hosted_v4_failed_closed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
