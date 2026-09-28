import {
  advanceHostedV4PaidTurn,
  runHostedV4ReadCheckpoint,
  type HostedV4ActionInput,
} from '../../../src/hosted-review/action';
import { HostedV4ReadClient } from '../../../src/hosted-review/hosted-read-client';
import {
  reviewActionV2PublishedProtocolVersion as protocolVersion,
  reviewActionV2PublishedSchemaDigest as schemaDigest,
  reviewInvestigationExtensionV1 as extension,
} from '../../../src/control-plane/generated/review-action-v2/review-action-v2';

const now = Date.parse('2026-09-28T12:00:00.000Z');
const authExpiry = new Date(now + 240_000).toISOString();
const readExpiry = new Date(now + 120_000).toISOString();
const head = 'a'.repeat(40);
const revision = 'b'.repeat(64);
const blob = 'c'.repeat(40);
const capability = `synthetic.${'x'.repeat(43)}`;
const nextCapability = `synthetic.${'y'.repeat(43)}`;
const path = 'src/known.ts';
const contentBase64 = Buffer.from('export const synthetic = true;\n').toString(
  'base64'
);

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

function facts(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

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

type Override = {
  readonly facts?: Record<string, unknown>;
  readonly authorizationExpiry?: string;
  readonly readExpiry?: string;
  readonly readStatus?: number;
  readonly refreshStatus?: number;
  readonly file?: Record<string, unknown>;
  readonly secondFile?: Record<string, unknown>;
  readonly lostFirstRead?: boolean;
};

function fixture(override: Override = {}) {
  const calls: { route: string; body: Record<string, unknown> }[] = [];
  let fileCalls = 0;
  const fetchImpl = jest.fn(
    async (request: string | URL | Request, init?: RequestInit) => {
      const route = new URL(String(request)).pathname;
      if (route === '/synthetic-oidc') {
        calls.push({ route, body: {} });
        return json({ value: 'synthetic-oidc-token' }, 200);
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ route, body });
      if (route === '/api/action/v2/review-runs/authorize') {
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
              expiresAt: override.authorizationExpiry ?? authExpiry,
              authorizationFactsCanonicalJson: canonical(facts(override.facts)),
              protocolLimitsCanonicalJson: canonical(limits),
            },
          },
          201
        );
      }
      if (route === '/api/hosted/v4/read-capabilities') {
        return body.bindingId !== 'synthetic-binding'
          ? json({ error: 'hosted_v4_authority_denied' }, 403)
          : json(
              { capability, expiresAt: override.readExpiry ?? readExpiry },
              201
            );
      }
      if (route === '/api/hosted/v4/read-capabilities/refresh') {
        return override.refreshStatus === 403
          ? json({ error: 'hosted_v4_authority_denied' }, 403)
          : json(
              {
                capability: nextCapability,
                expiresAt: override.readExpiry ?? readExpiry,
              },
              200
            );
      }
      if (route === '/api/hosted/v4/files/read') {
        fileCalls += 1;
        if (override.lostFirstRead && fileCalls === 1)
          throw new Error('synthetic lost read response');
        return override.readStatus === 403
          ? json({ error: 'hosted_v4_read_denied' }, 403)
          : json(
              fileCalls >= 2 && override.secondFile
                ? override.secondFile
                : (override.file ?? {
                    path,
                    headSha: head,
                    blobSha: blob,
                    contentBase64,
                  }),
              200
            );
      }
      throw new Error('unexpected synthetic route');
    }
  ) as typeof fetch;
  const input: HostedV4ActionInput = {
    apiUrl: 'https://synthetic.example/',
    oidcAudience: 'synthetic-audience',
    oidcProvider: { requestToken: jest.fn(async () => 'synthetic-oidc-token') },
    expected: {
      repositoryConnectionId: 'synthetic-connection',
      scmRepositoryIdentityId: 'synthetic-repository',
      pullRequestNumber: 12,
      headSha: head,
      reviewRevisionHash: revision,
      producerReleaseId: 'synthetic-release',
      sourceRunId: 'synthetic-run',
      sourceRunAttempt: '1',
    },
    binding: {
      repositoryConnectionId: 'synthetic-connection',
      providerInstanceId: 'synthetic-provider',
      bindingId: 'synthetic-binding',
      bindingVersion: 1,
    },
    knownFilePath: path,
    deadlineEpochMs: now + 200_000,
    now: () => now,
    fetchImpl,
  };
  return { input, calls, fetchImpl };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('hosted v4 generated authorization and scoped read checkpoint', () => {
  it('authorizes, admits, reads, refreshes and rereads exact head without credentials in receipt', async () => {
    const { input, calls } = fixture();
    const result = await runHostedV4ReadCheckpoint(input);
    expect(calls.map((call) => call.route)).toEqual([
      '/api/action/v2/review-runs/authorize',
      '/api/hosted/v4/read-capabilities',
      '/api/hosted/v4/files/read',
      '/api/hosted/v4/read-capabilities/refresh',
      '/api/hosted/v4/files/read',
    ]);
    expect(calls[0].body).toMatchObject({
      oidcToken: 'synthetic-oidc-token',
      supportedProtocols: [{ protocolVersion, schemaDigest }],
    });
    expect(calls[3].body).toEqual({
      authorizationToken: 'synthetic-authorization-token',
      capability,
    });
    expect(result).toMatchObject({
      status: 'read_checkpoint',
      authorizationId: 'synthetic-authorization',
      headSha: head,
      reviewRevisionHash: revision,
      path,
      blobSha: blob,
      readExpiresAt: readExpiry,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /synthetic-(?:oidc|authorization-token)|synthetic\./
    );
    expect(() => advanceHostedV4PaidTurn(result)).toThrow(
      'hosted_v4_paid_turn_unavailable'
    );
  });

  it.each([
    ['wire envelope version', { selectedProtocolVersion: protocolVersion }],
    [
      'unknown selected protocol',
      { selectedProtocolVersion: 'review_action_v3' },
    ],
    ['head', { headSha: '9'.repeat(40) }],
    ['repository identity', { scmRepositoryIdentityId: 'other-repository' }],
    ['run', { sourceRunId: 'other-run' }],
    ['release', { producerReleaseId: 'other-release' }],
    [
      'extension',
      {
        reviewInvestigation: {
          ...facts().reviewInvestigation,
          extensionId: 'other',
        },
      },
    ],
  ])(
    'rejects stale %s authority before read admission',
    async (_name, changed) => {
      const { input, calls } = fixture({
        facts: changed as Record<string, unknown>,
      });
      await expect(runHostedV4ReadCheckpoint(input)).rejects.toThrow(
        'hosted_v4_authority_stale_or_unsupported'
      );
      expect(calls.map((call) => call.route)).toEqual([
        '/api/action/v2/review-runs/authorize',
      ]);
    }
  );

  it('fails closed on denied refresh and never reads under a replacement scope', async () => {
    const { input, calls } = fixture({ refreshStatus: 403 });
    await expect(runHostedV4ReadCheckpoint(input)).rejects.toThrow(
      'hosted_v4_read_authority_denied'
    );
    expect(
      calls.filter((call) => call.route.endsWith('/files/read'))
    ).toHaveLength(1);
  });

  it('fails closed on denied read and a capability that outlives authorization', async () => {
    const deniedAdmission = fixture();
    await expect(
      runHostedV4ReadCheckpoint({
        ...deniedAdmission.input,
        binding: {
          ...deniedAdmission.input.binding,
          bindingId: 'drifted-binding',
        },
      })
    ).rejects.toThrow('hosted_v4_read_authority_denied');
    expect(deniedAdmission.calls).toHaveLength(2);
    const denied = fixture({ readStatus: 403 });
    await expect(runHostedV4ReadCheckpoint(denied.input)).rejects.toThrow(
      'hosted_v4_read_authority_denied'
    );
    expect(
      denied.calls.filter((call) => call.route.endsWith('/files/read'))
    ).toHaveLength(1);
    const overlong = fixture({
      readExpiry: new Date(now + 300_000).toISOString(),
    });
    await expect(runHostedV4ReadCheckpoint(overlong.input)).rejects.toThrow();
    expect(overlong.calls).toHaveLength(2);
  });

  it('rejects content drift after refresh even with the same blob claim', async () => {
    const different = Buffer.from('export const synthetic = false;\n').toString(
      'base64'
    );
    const { input, calls } = fixture({
      secondFile: {
        path,
        headSha: head,
        blobSha: blob,
        contentBase64: different,
      },
    });
    await expect(runHostedV4ReadCheckpoint(input)).rejects.toThrow(
      'hosted_v4_read_content_drift'
    );
    expect(
      calls.filter((call) => call.route.endsWith('/files/read'))
    ).toHaveLength(2);
  });

  it.each([
    [
      'head drift',
      { path, headSha: '9'.repeat(40), blobSha: blob, contentBase64 },
    ],
    [
      'invalid base64',
      { path, headSha: head, blobSha: blob, contentBase64: 'not base64!' },
    ],
    [
      'extra field',
      { path, headSha: head, blobSha: blob, contentBase64, token: 'synthetic' },
    ],
  ])('rejects malformed file response: %s', async (_name, file) => {
    await expect(
      runHostedV4ReadCheckpoint(fixture({ file }).input)
    ).rejects.toThrow();
  });

  it('bounds a lost file response to one scoped reread', async () => {
    const { input, calls } = fixture({ lostFirstRead: true });
    await runHostedV4ReadCheckpoint(input);
    expect(
      calls.filter((call) => call.route.endsWith('/files/read'))
    ).toHaveLength(3);
  });

  it('rejects expired authorization and read scope without another call', async () => {
    const expiredAuth = fixture({
      authorizationExpiry: new Date(now - 1).toISOString(),
    });
    await expect(
      runHostedV4ReadCheckpoint(expiredAuth.input)
    ).rejects.toThrow();
    expect(expiredAuth.calls).toHaveLength(1);
    const expiredRead = fixture({
      readExpiry: new Date(now - 1).toISOString(),
    });
    await expect(
      runHostedV4ReadCheckpoint(expiredRead.input)
    ).rejects.toThrow();
    expect(expiredRead.calls).toHaveLength(2);
  });

  it('coalesces concurrent refresh against the same authorization', async () => {
    const { input, calls } = fixture();
    const client = new HostedV4ReadClient({
      apiUrl: input.apiUrl,
      fetchImpl: input.fetchImpl!,
      now: input.now,
      deadlineEpochMs: input.deadlineEpochMs,
    });
    const authority = {
      authorizationId: 'synthetic-authorization',
      authorizationToken: 'synthetic-authorization-token',
      expiresAt: authExpiry,
      headSha: head,
      reviewRevisionHash: revision,
      producerReleaseId: 'synthetic-release',
    };
    await client.admit(authority, input.binding);
    const both = await Promise.all([
      client.refresh(authority),
      client.refresh(authority),
    ]);
    expect(both).toEqual([readExpiry, readExpiry]);
    expect(
      calls.filter((call) => call.route.endsWith('/refresh'))
    ).toHaveLength(1);
  });

  it.each([
    'https://localhost/',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
  ])(
    'refuses direct read transport loopback origin %s before I/O',
    (apiUrl) => {
      const fetchImpl = jest.fn() as unknown as typeof fetch;
      expect(
        () =>
          new HostedV4ReadClient({
            apiUrl,
            fetchImpl,
            now: () => now,
            deadlineEpochMs: now + 60_000,
          })
      ).toThrow('hosted_v4_api_url_invalid');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it.each(['headers', 'body'])(
    'bounds generated authorization when %s never completes, with no admission',
    async (stage) => {
      const { input, calls, fetchImpl } = fixture();
      const stalled = jest.fn(
        (request: string | URL | Request, init?: RequestInit) => {
          if (stage === 'headers')
            return new Promise<Response>(() => undefined);
          const stream = new ReadableStream<Uint8Array>({
            start: () => undefined,
          });
          return Promise.resolve(new Response(stream, { status: 201 }));
        }
      ) as unknown as typeof fetch;
      const deadline = Date.now() + 1_000;
      await expect(
        runHostedV4ReadCheckpoint({
          ...input,
          now: Date.now,
          deadlineEpochMs: deadline,
          fetchImpl: stalled,
        })
      ).rejects.toThrow();
      expect(stalled).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(0);
    }
  );

  it('stops at the shared deadline when an injected authorization ignores cancellation', async () => {
    const { input, calls } = fixture();
    let complete!: (value: never) => void;
    const authorize = jest.fn(
      () =>
        new Promise<never>((resolve) => {
          complete = resolve;
        })
    );
    const read = {
      admit: jest.fn(),
      refresh: jest.fn(),
      readFile: jest.fn(),
      expiresAt: jest.fn(() => readExpiry),
    };
    const signal = { current: undefined as AbortSignal | undefined };
    await expect(
      runHostedV4ReadCheckpoint({
        ...input,
        now: Date.now,
        deadlineEpochMs: Date.now() + 30,
        authorize: {
          authorize: (_input, options) => {
            signal.current = options?.signal;
            return authorize();
          },
        },
        read,
      })
    ).rejects.toThrow('hosted_v4_deadline_expired');
    expect(signal.current?.aborted).toBe(true);
    complete({} as never);
    await new Promise((resolve) => setImmediate(resolve));
    expect(read.admit).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('stops before authorization when an injected OIDC provider ignores cancellation', async () => {
    const { input } = fixture();
    let complete!: (value: string) => void;
    let requestSignal: AbortSignal | undefined;
    const authorize = jest.fn();
    await expect(
      runHostedV4ReadCheckpoint({
        ...input,
        now: Date.now,
        deadlineEpochMs: Date.now() + 30,
        oidcProvider: {
          requestToken: (_audience, signal) => {
            requestSignal = signal;
            return new Promise<string>((resolve) => {
              complete = resolve;
            });
          },
        },
        authorize: { authorize },
      })
    ).rejects.toThrow('hosted_v4_deadline_expired');
    expect(requestSignal?.aborted).toBe(true);
    complete('synthetic-late-oidc');
    await new Promise((resolve) => setImmediate(resolve));
    expect(authorize).not.toHaveBeenCalled();
  });

  it('checks the live read expiry before returning a receipt', async () => {
    const { input } = fixture();
    let clock = now;
    let reads = 0;
    const read = {
      admit: jest.fn(async () => undefined),
      refresh: jest.fn(async () => readExpiry),
      readFile: jest.fn(async () => {
        reads += 1;
        if (reads === 2) clock = Date.parse(readExpiry);
        return {
          path,
          headSha: head,
          blobSha: blob,
          contentHash: 'd'.repeat(64),
        };
      }),
      expiresAt: () => readExpiry,
    };
    await expect(
      runHostedV4ReadCheckpoint({ ...input, now: () => clock, read })
    ).rejects.toThrow('hosted_v4_deadline_expired');
    expect(read.readFile).toHaveBeenCalledTimes(2);
  });

  it('routes the actual public main through OIDC, generated authorize and private read only', async () => {
    const { calls, fetchImpl } = fixture();
    const oldFetch = global.fetch;
    const oldEnv = process.env;
    const oldExit = process.exitCode;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    const failurePublisher = jest.fn();
    try {
      global.fetch = fetchImpl;
      process.env = {
        REVIEW_ROUTER_MODE: 'hosted-pool-v4',
        REVIEW_ROUTER_HOSTED_V4_ADAPTER_ENABLED: '1',
        REVIEWROUTER_ACTION_V2_MODE: 't0',
        REVIEWROUTER_API_URL: 'https://synthetic.example/',
        REVIEWROUTER_OIDC_AUDIENCE: 'synthetic-audience',
        ACTIONS_ID_TOKEN_REQUEST_URL:
          'https://token.actions.githubusercontent.com/synthetic-oidc',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-oidc-request-token',
        REVIEW_ROUTER_HOSTED_V4_REPOSITORY_CONNECTION_ID:
          'synthetic-connection',
        REVIEW_ROUTER_HOSTED_V4_SCM_REPOSITORY_IDENTITY_ID:
          'synthetic-repository',
        PR_NUMBER: '12',
        REVIEW_HEAD_SHA: head,
        REVIEW_ROUTER_HOSTED_V4_REVIEW_REVISION_HASH: revision,
        REVIEW_ROUTER_HOSTED_V4_PRODUCER_RELEASE_ID: 'synthetic-release',
        GITHUB_RUN_ID: 'synthetic-run',
        GITHUB_RUN_ATTEMPT: '1',
        REVIEW_ROUTER_HOSTED_V4_PROVIDER_INSTANCE_ID: 'synthetic-provider',
        REVIEW_ROUTER_HOSTED_V4_BINDING_ID: 'synthetic-binding',
        REVIEW_ROUTER_HOSTED_V4_BINDING_VERSION: '1',
        REVIEW_ROUTER_HOSTED_V4_KNOWN_FILE_PATH: path,
        REVIEW_ROUTER_HOSTED_V4_DEADLINE_EPOCH_MS: String(now + 200_000),
      };
      process.exitCode = undefined;
      jest.resetModules();
      jest.doMock('../../../src/github/failure-summary', () => ({
        clearReviewFailureSummaries: jest.fn(),
        postReviewFailureSummary: failurePublisher,
      }));
      const core =
        require('../../../src/actions/core') as typeof import('../../../src/actions/core');
      const failed = jest
        .spyOn(core, 'setFailed')
        .mockImplementation(() => undefined);
      jest.spyOn(core, 'setSecret').mockImplementation(() => undefined);
      require('../../../src/main');
      await new Promise((resolve) => setImmediate(resolve));
      expect(calls.map((call) => call.route)).toEqual([
        '/synthetic-oidc',
        '/api/action/v2/review-runs/authorize',
        '/api/hosted/v4/read-capabilities',
        '/api/hosted/v4/files/read',
        '/api/hosted/v4/read-capabilities/refresh',
        '/api/hosted/v4/files/read',
      ]);
      expect(failed).toHaveBeenCalledWith('hosted_v4_paid_turn_unavailable');
      expect(failurePublisher).not.toHaveBeenCalled();
      for (const apiUrl of [
        'https://localhost/',
        'https://localhost./',
        'https://sub.localhost/',
        'https://127.0.0.1/',
        'https://127.1/',
        'https://[::1]/',
        'https://[::ffff:127.0.0.1]/',
        'https://synthetic-user:synthetic-pass@synthetic.example/',
      ]) {
        process.env.REVIEWROUTER_API_URL = apiUrl;
        const noNetwork = jest.fn() as unknown as typeof fetch;
        global.fetch = noNetwork;
        jest.resetModules();
        const invalidCore =
          require('../../../src/actions/core') as typeof import('../../../src/actions/core');
        const invalidFailure = jest
          .spyOn(invalidCore, 'setFailed')
          .mockImplementation(() => undefined);
        require('../../../src/main');
        await new Promise((resolve) => setImmediate(resolve));
        expect(invalidFailure).toHaveBeenCalledWith(
          'hosted_v4_api_url_invalid'
        );
        expect(noNetwork).not.toHaveBeenCalled();
        expect(failurePublisher).not.toHaveBeenCalled();
      }
      process.env.REVIEWROUTER_API_URL = 'https://synthetic.example/';
      expect(
        calls.some(
          (call) =>
            call.route.includes('relay') || call.route.includes('publication')
        )
      ).toBe(false);

      const denied = fixture({ facts: { headSha: '9'.repeat(40) } });
      global.fetch = denied.fetchImpl;
      jest.resetModules();
      const deniedCore =
        require('../../../src/actions/core') as typeof import('../../../src/actions/core');
      const deniedFailure = jest
        .spyOn(deniedCore, 'setFailed')
        .mockImplementation(() => undefined);
      jest.spyOn(deniedCore, 'setSecret').mockImplementation(() => undefined);
      require('../../../src/main');
      await new Promise((resolve) => setImmediate(resolve));
      expect(denied.calls.map((call) => call.route)).toEqual([
        '/synthetic-oidc',
        '/api/action/v2/review-runs/authorize',
      ]);
      expect(deniedFailure).toHaveBeenCalledWith(
        'hosted_v4_authority_stale_or_unsupported'
      );
      expect(failurePublisher).not.toHaveBeenCalled();

      const oidcFailure = jest.fn(async () => {
        throw new Error('hosted_v4_oidc_denied\nSYNTHETIC_PRIVATE_BODY');
      }) as unknown as typeof fetch;
      global.fetch = oidcFailure;
      jest.resetModules();
      const oidcCore =
        require('../../../src/actions/core') as typeof import('../../../src/actions/core');
      const oidcFailed = jest
        .spyOn(oidcCore, 'setFailed')
        .mockImplementation(() => undefined);
      jest.spyOn(oidcCore, 'setSecret').mockImplementation(() => undefined);
      require('../../../src/main');
      await new Promise((resolve) => setImmediate(resolve));
      expect(oidcFailure).toHaveBeenCalledTimes(1);
      expect(oidcFailed).toHaveBeenCalledWith(
        'hosted_v4_oidc_transport_ambiguous'
      );
      expect(failurePublisher).not.toHaveBeenCalled();
    } finally {
      global.fetch = oldFetch;
      process.env = oldEnv;
      process.exitCode = oldExit;
      clock.mockRestore();
    }
  });
});
