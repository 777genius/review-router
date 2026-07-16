import {
  REVIEW_CHECKPOINT_MAX_AGGREGATE_BYTES,
  REVIEW_CHECKPOINT_MAX_REQUEST_BYTES,
  ReviewCheckpointBatchPayload,
  ReviewCheckpointFindingSeverity,
  ReviewCheckpointProviderStatus,
  createReviewCheckpointPlanIdentity,
  normalizeReviewCheckpointBatchPayload,
} from '../../../src/review-execution/domain/review-checkpoint';
import {
  HttpReviewCheckpointClient,
  ReviewCheckpointHttpFailureCode,
  createReviewCheckpointSessionFromEnvironment,
} from '../../../src/review-execution/infrastructure/http-review-checkpoint-client';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const compatibilityKey = 'c'.repeat(64);
const planHash = 'd'.repeat(64);
const workKey = 'e'.repeat(64);
const secondWorkKey = 'f'.repeat(64);

const plan = createReviewCheckpointPlanIdentity({
  pullRequestNumber: 42,
  baseSha,
  headSha,
  compatibilityKey,
  planHash,
  workKeys: [workKey],
});

const hostedEnv = {
  REVIEWROUTER_API_URL: 'https://reviewrouter.example/',
  REVIEWROUTER_COMMENT_TOKEN_LEASE_ID: 'lease-secret-canary',
  REVIEWROUTER_COMMENT_TOKEN_PROVIDER_INSTANCE_ID:
    'provider-instance-secret-canary',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpReviewCheckpointClient', () => {
  it('returns null without the complete hosted environment', async () => {
    const fetchImpl = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >();

    const session = await createReviewCheckpointSessionFromEnvironment({
      plan,
      env: { REVIEWROUTER_API_URL: hostedEnv.REVIEWROUTER_API_URL },
      fetchImpl,
    });

    expect(session).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('restores then starts with exact credentialed request bodies', async () => {
    const fetchImpl = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(
        jsonResponse({
          protocolVersion: 1,
          status: 'missing',
          expectedVersion: 0,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          protocolVersion: 1,
          status: 'started',
          version: 1,
          headSha,
          planHash,
        })
      );

    const session = await createReviewCheckpointSessionFromEnvironment({
      plan,
      env: hostedEnv,
      fetchImpl,
    });

    expect(session).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://reviewrouter.example/api/action/v1/codex-oauth/review-execution-checkpoint/restore',
      'https://reviewrouter.example/api/action/v1/codex-oauth/review-execution-checkpoint/start',
    ]);
    expect(requestBody(fetchImpl, 0)).toEqual({
      protocolVersion: 1,
      leaseId: hostedEnv.REVIEWROUTER_COMMENT_TOKEN_LEASE_ID,
      providerInstanceId:
        hostedEnv.REVIEWROUTER_COMMENT_TOKEN_PROVIDER_INSTANCE_ID,
      pullRequestNumber: 42,
      baseSha,
      headSha,
      compatibilityKey,
      planHash,
    });
    expect(requestBody(fetchImpl, 1)).toEqual({
      protocolVersion: 1,
      leaseId: hostedEnv.REVIEWROUTER_COMMENT_TOKEN_LEASE_ID,
      providerInstanceId:
        hostedEnv.REVIEWROUTER_COMMENT_TOKEN_PROVIDER_INSTANCE_ID,
      expectedVersion: 0,
      pullRequestNumber: 42,
      baseSha,
      headSha,
      compatibilityKey,
      planHash,
      plannedWorkKeys: [workKey],
    });
  });

  it.each([404, 405, 501])(
    'fails open on an unsupported endpoint response (%s)',
    async (status) => {
      const warnings: string[] = [];
      const fetchImpl = jest
        .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
        .mockResolvedValue(
          jsonResponse({ error: 'secret-body-canary' }, status)
        );

      const session = await createReviewCheckpointSessionFromEnvironment({
        plan,
        env: hostedEnv,
        fetchImpl,
        logger: { warn: (message) => warnings.push(message) },
      });

      expect(session).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('continuing without durable batch');
      expect(warnings[0]).not.toContain('secret-body-canary');
      expect(warnings[0]).not.toContain('lease-secret-canary');
      expect(warnings[0]).not.toContain('provider-instance-secret-canary');
    }
  );

  it('fails open when checkpoint transport is unavailable', async () => {
    const warnings: string[] = [];
    const fetchImpl = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockRejectedValue(
        new Error(
          'network failure with provider-instance-secret-canary and raw-token-canary'
        )
      );

    const session = await createReviewCheckpointSessionFromEnvironment({
      plan,
      env: hostedEnv,
      fetchImpl,
      logger: { warn: (message) => warnings.push(message) },
    });

    expect(session).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('review_checkpoint_request_failed');
    expect(warnings[0]).not.toContain('provider-instance-secret-canary');
    expect(warnings[0]).not.toContain('raw-token-canary');
  });

  it('rejects responses with extra keys through the strict schema', async () => {
    const warnings: string[] = [];
    const fetchImpl = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        jsonResponse({
          protocolVersion: 1,
          status: 'missing',
          expectedVersion: 0,
          rawToken: 'response-token-canary',
        })
      );

    const session = await createReviewCheckpointSessionFromEnvironment({
      plan,
      env: hostedEnv,
      fetchImpl,
      logger: { warn: (message) => warnings.push(message) },
    });

    expect(session).toBeNull();
    expect(warnings.join('\n')).not.toContain('response-token-canary');
  });

  it('rejects a request larger than 128 KiB before transport', async () => {
    const fetchImpl = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >();
    const client = new HttpReviewCheckpointClient({
      apiUrl: hostedEnv.REVIEWROUTER_API_URL,
      leaseId: hostedEnv.REVIEWROUTER_COMMENT_TOKEN_LEASE_ID,
      providerInstanceId:
        hostedEnv.REVIEWROUTER_COMMENT_TOKEN_PROVIDER_INSTANCE_ID,
      fetchImpl,
    });
    const finding = {
      file: 'src/large.ts',
      line: 1,
      severity: ReviewCheckpointFindingSeverity.Major,
      title: 'Large finding',
      message: 'x'.repeat(20_000),
    };
    const payload: ReviewCheckpointBatchPayload = {
      filePaths: ['src/large.ts'],
      findings: Array.from({ length: 7 }, () => finding),
      providerResults: [],
    };

    await expect(
      client.commitBatchResult({
        expectedVersion: 1,
        pullRequestNumber: 42,
        headSha,
        planHash,
        workKey,
        batchId: workKey,
        batchIndex: 0,
        payload,
      })
    ).rejects.toMatchObject({
      code: ReviewCheckpointHttpFailureCode.RequestTooLarge,
    });
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(
      REVIEW_CHECKPOINT_MAX_REQUEST_BYTES
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('restores a valid multi-batch aggregate larger than 128 KiB', async () => {
    const finding = {
      file: 'src/large.ts',
      line: 1,
      severity: ReviewCheckpointFindingSeverity.Major,
      title: 'Large finding',
      message: 'x'.repeat(18_000),
    };
    const payload: ReviewCheckpointBatchPayload = {
      filePaths: ['src/large.ts'],
      findings: Array.from({ length: 4 }, () => finding),
      providerResults: [
        {
          name: 'codex/oauth',
          status: ReviewCheckpointProviderStatus.Success,
          durationMs: 25,
          usage: {
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120,
          },
        },
      ],
    };
    const body = {
      protocolVersion: 1,
      status: 'found',
      expectedVersion: 3,
      checkpoint: {
        version: 3,
        baseSha,
        headSha,
        compatibilityKey,
        planHash,
        plannedWorkKeys: [workKey, secondWorkKey],
        acceptedResults: [
          { workKey, payload },
          { workKey: secondWorkKey, payload },
        ],
        finalized: true,
      },
    };
    const responseBytes = Buffer.byteLength(JSON.stringify(body));
    const fetchImpl = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(jsonResponse(body));
    const client = checkpointClient({ fetchImpl });

    const restored = await client.restore({
      pullRequestNumber: 42,
      baseSha,
      headSha,
      compatibilityKey,
      planHash,
    });

    expect(responseBytes).toBeGreaterThan(REVIEW_CHECKPOINT_MAX_REQUEST_BYTES);
    expect(responseBytes).toBeLessThan(REVIEW_CHECKPOINT_MAX_AGGREGATE_BYTES);
    expect(restored).toMatchObject({
      status: 'found',
      checkpoint: {
        acceptedResults: [{ workKey }, { workKey: secondWorkKey }],
      },
    });
  });

  it('rejects an oversized streamed aggregate before decoding JSON', async () => {
    const fetchImpl = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        jsonResponse({
          padding: 'x'.repeat(
            REVIEW_CHECKPOINT_MAX_AGGREGATE_BYTES + 300 * 1024
          ),
        })
      );
    const client = checkpointClient({ fetchImpl });

    await expect(
      client.restore({
        pullRequestNumber: 42,
        baseSha,
        headSha,
        compatibilityKey,
        planHash,
      })
    ).rejects.toMatchObject({
      code: ReviewCheckpointHttpFailureCode.ResponseTooLarge,
    });
  });

  it('aborts a never-resolving fetch within the execution deadline', async () => {
    const fetchImpl = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >(() => new Promise<Response>(() => undefined));
    const client = checkpointClient({
      fetchImpl,
      deadlineEpochMs: 1_010,
      requestTimeoutMs: 10_000,
      now: () => 1_000,
    });

    await expect(
      client.restore({
        pullRequestNumber: 42,
        baseSha,
        headSha,
        compatibilityKey,
        planHash,
      })
    ).rejects.toMatchObject({
      code: ReviewCheckpointHttpFailureCode.RequestTimedOut,
    });
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('aborts a never-resolving response body within the request timeout', async () => {
    const response = {
      status: 200,
      ok: true,
      text: jest.fn(() => new Promise<string>(() => undefined)),
    } as unknown as Response;
    const fetchImpl = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >(() => Promise.resolve(response));
    const client = checkpointClient({ fetchImpl, requestTimeoutMs: 10 });

    await expect(
      client.restore({
        pullRequestNumber: 42,
        baseSha,
        headSha,
        compatibilityKey,
        planHash,
      })
    ).rejects.toMatchObject({
      code: ReviewCheckpointHttpFailureCode.RequestTimedOut,
    });
    expect(response.text).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('sends deterministic batch identity with the normalized payload', async () => {
    const fetchImpl = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        jsonResponse({
          protocolVersion: 1,
          status: 'accepted',
          version: 2,
          headSha,
          planHash,
          workKey,
        })
      );
    const client = new HttpReviewCheckpointClient({
      apiUrl: hostedEnv.REVIEWROUTER_API_URL,
      leaseId: hostedEnv.REVIEWROUTER_COMMENT_TOKEN_LEASE_ID,
      providerInstanceId:
        hostedEnv.REVIEWROUTER_COMMENT_TOKEN_PROVIDER_INSTANCE_ID,
      fetchImpl,
    });
    const payload = normalizeReviewCheckpointBatchPayload({
      filePaths: ['src/review.ts'],
      findings: [],
      providerResults: [
        { name: 'codex/oauth', status: 'success', durationMs: 25 },
      ],
    });

    await client.commitBatchResult({
      expectedVersion: 1,
      pullRequestNumber: 42,
      headSha,
      planHash,
      workKey,
      batchId: workKey,
      batchIndex: 7,
      payload,
    });

    expect(requestBody(fetchImpl, 0)).toEqual({
      protocolVersion: 1,
      leaseId: hostedEnv.REVIEWROUTER_COMMENT_TOKEN_LEASE_ID,
      providerInstanceId:
        hostedEnv.REVIEWROUTER_COMMENT_TOKEN_PROVIDER_INSTANCE_ID,
      expectedVersion: 1,
      pullRequestNumber: 42,
      headSha,
      planHash,
      workKey,
      batchId: workKey,
      batchIndex: 7,
      payload,
    });
  });

  it('clears only from an exact strict finalization marker', async () => {
    const fetchImpl = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        jsonResponse({
          protocolVersion: 1,
          status: 'cleared',
        })
      );
    const client = new HttpReviewCheckpointClient({
      apiUrl: hostedEnv.REVIEWROUTER_API_URL,
      leaseId: hostedEnv.REVIEWROUTER_COMMENT_TOKEN_LEASE_ID,
      providerInstanceId:
        hostedEnv.REVIEWROUTER_COMMENT_TOKEN_PROVIDER_INSTANCE_ID,
      fetchImpl,
    });

    await client.clearFinalized({
      protocolVersion: 1,
      pullRequestNumber: 42,
      headSha,
      planHash,
      expectedVersion: 3,
    });

    expect(requestBody(fetchImpl, 0)).toEqual({
      protocolVersion: 1,
      leaseId: hostedEnv.REVIEWROUTER_COMMENT_TOKEN_LEASE_ID,
      providerInstanceId:
        hostedEnv.REVIEWROUTER_COMMENT_TOKEN_PROVIDER_INSTANCE_ID,
      expectedVersion: 3,
      pullRequestNumber: 42,
      headSha,
      planHash,
    });
  });
});

describe('review checkpoint plan identity', () => {
  it('enforces the SaaS limit of 200 planned work keys', () => {
    const workKeys = Array.from({ length: 201 }, (_, index) =>
      index.toString(16).padStart(64, '0')
    );

    expect(() =>
      createReviewCheckpointPlanIdentity({ ...plan, workKeys })
    ).toThrow();
  });
});

describe('normalizeReviewCheckpointBatchPayload', () => {
  it('rejects oversized collections instead of silently truncating coverage', () => {
    expect(() =>
      normalizeReviewCheckpointBatchPayload({
        filePaths: Array.from(
          { length: 201 },
          (_, index) => `src/file-${index}.ts`
        ),
        findings: [],
        providerResults: [],
      })
    ).toThrow('review_checkpoint_filePaths_limit_exceeded');
  });

  it('allowlists local provider/finding shapes and redacts secret canaries', () => {
    const secret = 'sk-1234567890abcdefghijklmnop';
    const lifecycleTargetId = 't'.repeat(500);
    const payload = normalizeReviewCheckpointBatchPayload({
      filePaths: ['src/auth.ts'],
      files: [{ filename: 'src/ignored.ts', patch: 'PATCH-CANARY' }],
      prompt: 'PROMPT-CANARY',
      diff: 'DIFF-CANARY',
      patch: 'ROOT-PATCH-CANARY',
      findings: [
        {
          file: 'src/auth.ts',
          line: 7,
          severity: 'critical',
          title: 'Credential leak',
          message: `Do not expose ${secret}`,
          suggestion: 'SUGGESTION-CANARY',
          evidence: { content: 'EVIDENCE-CANARY' },
          source: 'SOURCE-CANARY',
          content: 'FINDING-CONTENT-CANARY',
        },
      ],
      providerResults: [
        {
          name: 'codex/oauth',
          status: 'rate-limited',
          durationSeconds: 1.25,
          error: new Error(`Authorization: Bearer ${secret}`),
          lifecycleAssignedTargetIds: [lifecycleTargetId, lifecycleTargetId],
          prompt: 'PROVIDER-PROMPT-CANARY',
          tokens: { prompt: 999 },
          result: {
            content: 'RAW-CONTENT-CANARY',
            usage: {
              promptTokens: 10,
              completionTokens: 5,
              totalTokens: 16,
            },
            actualModel: 'gpt-checkpoint',
            aiLikelihood: 0.75,
            revalidations: [
              {
                targetId: lifecycleTargetId,
                fingerprint: 'fingerprint-1',
                verdict: 'resolved',
                confidence: 0.9,
                rationale: `Safe after ${secret}`,
                evidence: [
                  {
                    path: 'src/auth.ts',
                    startLine: 4,
                    endLine: 7,
                    reason: 'Token removed',
                    content: 'REVALIDATION-CONTENT-CANARY',
                  },
                ],
              },
            ],
          },
        },
      ],
    });

    expect(payload.filePaths).toEqual(['src/auth.ts', 'src/ignored.ts']);
    expect(Object.keys(payload.findings[0])).toEqual([
      'file',
      'line',
      'severity',
      'title',
      'message',
    ]);
    expect(payload.providerResults[0]).toMatchObject({
      name: 'codex/oauth',
      status: ReviewCheckpointProviderStatus.RateLimited,
      durationMs: 1_250,
      actualModel: 'gpt-checkpoint',
      aiLikelihood: 0.75,
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 16,
      },
      lifecycleAssignedTargetIds: [lifecycleTargetId],
    });
    expect(Object.keys(payload.providerResults[0]).sort()).toEqual(
      [
        'actualModel',
        'aiLikelihood',
        'durationMs',
        'errorMessage',
        'lifecycleAssignedTargetIds',
        'lifecycleRevalidations',
        'name',
        'status',
        'usage',
      ].sort()
    );
    expect(JSON.stringify(payload)).not.toContain(secret);
    for (const canary of [
      'PROMPT-CANARY',
      'DIFF-CANARY',
      'PATCH-CANARY',
      'SUGGESTION-CANARY',
      'EVIDENCE-CANARY',
      'SOURCE-CANARY',
      'RAW-CONTENT-CANARY',
      'REVALIDATION-CONTENT-CANARY',
    ]) {
      expect(JSON.stringify(payload)).not.toContain(canary);
    }
  });
});

function checkpointClient(
  overrides: Partial<
    ConstructorParameters<typeof HttpReviewCheckpointClient>[0]
  > = {}
): HttpReviewCheckpointClient {
  return new HttpReviewCheckpointClient({
    apiUrl: hostedEnv.REVIEWROUTER_API_URL,
    leaseId: hostedEnv.REVIEWROUTER_COMMENT_TOKEN_LEASE_ID,
    providerInstanceId:
      hostedEnv.REVIEWROUTER_COMMENT_TOKEN_PROVIDER_INSTANCE_ID,
    ...overrides,
  });
}

function requestBody(
  fetchImpl: jest.Mock<ReturnType<typeof fetch>, Parameters<typeof fetch>>,
  callIndex: number
): unknown {
  const init = fetchImpl.mock.calls[callIndex][1];
  return JSON.parse(String(init?.body));
}
