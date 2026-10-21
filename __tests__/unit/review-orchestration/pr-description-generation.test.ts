import type { UsageDelivery } from '../../../src/provider-usage/delivery';
import type { UsageFact } from '../../../src/provider-usage/usage-contract';
import { createHash } from 'crypto';
import nock from 'nock';
import { DEFAULT_CONFIG } from '../../../src/config/defaults';
import type { PRContext } from '../../../src/types';
import { createPrDescriptionGeneration } from '../../../src/review-orchestration/infrastructure/pr-description-generation';
import {
  AccountGatewayModelTransport,
  LOCAL_MODEL_CAPABILITY_ENV,
  startLocalGatewayModelTransport,
  startDirectOpenRouterModelTransport,
  type LocalGatewayModelTransport,
} from '../../../src/review-orchestration/infrastructure/account-gateway-model-transport';
import {
  ReviewExecutionProviderKind,
  ReviewTaskKind,
} from '../../../src/review-orchestration/application';
import { prDescriptionExtensionV1 } from '../../../src/control-plane/generated/review-action-v2/pr-description-invocation-manifest-v1';
import { canonicalizeProviderInvocationManifestV1 } from '../../../src/control-plane/generated/review-action-v2/provider-invocation-manifest-v1';
import { GeneratedProviderInvocationManifestAssembler } from '../../../src/review-orchestration/infrastructure/codex-review-invocation-adapter';
import type { ReviewRunAuthorization } from '../../../src/review-orchestration/application';

const model = 'review/model';
const slot = {
  workSlotId: 'description-slot',
  taskKind: ReviewTaskKind.PrDescription,
  providerKind: ReviewExecutionProviderKind.Ocr,
  providerVoteIdentityHash: 'a'.repeat(64),
  shardKey: 'description',
  required: false,
  attemptBudget: 1,
  retryPolicyVersion: 'pr-description-no-replay.v1',
};
const lease = {
  leaseId: 'description-lease',
  attemptId: 'attempt',
  leaseCapability: 'capability',
  fencingToken: '1',
  expiresAt: '2099-01-01T00:00:00Z',
  resultReportUntil: '2099-01-01T00:01:00Z',
  renewalCeilingReached: false,
};
const manifest = {
  manifestCanonicalJson: '{}',
  manifestKey: 'a'.repeat(64),
  providerInvocationKey: 'b'.repeat(64),
  providerVoteIdentityHash: slot.providerVoteIdentityHash,
};
const pr: PRContext = {
  number: 1,
  title: 'Preserve invoice ownership',
  body: 'Author requirements.',
  author: 'owner',
  draft: false,
  labels: [],
  additions: 1,
  deletions: 0,
  baseSha: '1'.repeat(40),
  headSha: '2'.repeat(40),
  diff: '',
  files: [
    {
      filename: 'src/invoice.ts',
      status: 'modified',
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: '+return invoices.filter(invoice => invoice.owner === owner);',
    },
  ],
};
const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const completed = (
  actualModel?: string,
  text = '## Summary\nPreserve invoice ownership.',
  usage?: { input_tokens: number; output_tokens: number }
) =>
  `event: response.completed\ndata: ${JSON.stringify({
    type: 'response.completed',
    response: {
      status: 'completed',
      ...(usage ? { usage } : {}),
      ...(actualModel ? { model: actualModel } : {}),
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        },
      ],
    },
  })}\n\n`;
function generator(
  transport: LocalGatewayModelTransport,
  override: Partial<Parameters<typeof createPrDescriptionGeneration>[0]> = {}
) {
  return createPrDescriptionGeneration({
    enabled: true,
    capabilityJson: JSON.stringify(prDescriptionExtensionV1),
    pr,
    requestedModel: model,
    providerKind: ReviewExecutionProviderKind.Ocr,
    reviewRevisionHash: 'c'.repeat(64),
    language: 'English',
    config: DEFAULT_CONFIG,
    transport,
    warn: jest.fn(),
    ...override,
  });
}
async function execute(transport: LocalGatewayModelTransport) {
  const parent = generator(transport)!;
  const invocation = await parent.prepare({
    workSlot: slot,
    attemptOrdinal: 1,
  });
  return parent.execute({
    invocation,
    manifest,
    lease,
    signal: new AbortController().signal,
  });
}

describe('parent AI PR description', () => {
  beforeAll(() => {
    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
  });
  afterAll(() => {
    nock.enableNetConnect();
  });
  afterEach(() => {
    nock.abortPendingRequests();
    nock.cleanAll();
  });

  it('assembles auxiliary evidence in its separate domain without broadening review V1', async () => {
    const parent = generator({
      generatePrDescription: jest.fn(),
    } as unknown as LocalGatewayModelTransport)!;
    const invocation = await parent.prepare({
      workSlot: slot,
      attemptOrdinal: 1,
    });
    const authorization = {
      facts: {
        pullRequestNumber: 1,
        repositoryConnectionId: 'connection',
        scmRepositoryIdentityId: 'repository',
        workspaceId: 'workspace',
        producerReleaseId: 'release',
        selectedProtocolVersion: 'review-action-v2',
        providerVoteLanes: [
          {
            providerKind: slot.providerKind,
            providerVoteIdentityHash: slot.providerVoteIdentityHash,
          },
        ],
      },
    } as unknown as ReviewRunAuthorization;
    const assembled = await new GeneratedProviderInvocationManifestAssembler(
      authorization,
      DEFAULT_CONFIG,
      'd'.repeat(64)
    ).assemble(invocation);
    const wire = JSON.parse(assembled.manifestCanonicalJson);
    expect(wire).toMatchObject({
      taskKindSet: ['pr_description'],
      providerKind: 'ocr',
      executionProfile: 'prompt_only_envelope_v1',
      providerPolicyVersion: 'pr-description-provider-policy.v1',
    });
    expect(assembled.providerVoteIdentityHash).toBe(
      slot.providerVoteIdentityHash
    );
    expect(() => canonicalizeProviderInvocationManifestV1(wire)).toThrow();
  });

  it('uses only permitted redacted changes and original author context on the next run', async () => {
    const outside = '  Keep author requirements.\n\n';
    const body = `${outside}<!-- review-router-summary:start -->generated-untrusted-requirement<!-- review-router-summary:end -->\nAuthor footer. `;
    const secret = 'sk-synthetic-secret-value-123456789';
    const request = jest.fn(
      async ({ requestBody }: { requestBody: Uint8Array }) => ({
        generatedMarkdown: 'AI description',
        actualModel: model,
        providerRequestEnvelopeHash: hash(requestBody),
      })
    );
    const transport = {
      generatePrDescription: request,
    } as unknown as LocalGatewayModelTransport;
    const suppliedPr = {
      ...pr,
      body,
      files: [
        { ...pr.files[0], patch: `+const token = '${secret}';` },
        {
          ...pr.files[0],
          filename: '.env',
          patch: '+PRIVATE_ENV=env-secret-marker',
        },
        {
          ...pr.files[0],
          filename: 'private/policy.ts',
          patch: '+policy-secret-marker',
        },
        {
          ...pr.files[0],
          filename: 'src/renamed.ts',
          previousFilename: 'private/policy.ts',
          patch: '+renamed-policy-secret-marker',
        },
      ],
    };
    const parent = generator(transport, {
      pr: suppliedPr,
      config: { ...DEFAULT_CONFIG, trivialPatterns: ['^private/'] },
    })!;
    const invocation = await parent.prepare({
      workSlot: slot,
      attemptOrdinal: 1,
    });
    await parent.execute({
      invocation,
      manifest,
      lease,
      signal: new AbortController().signal,
    });
    const bytes = request.mock.calls[0][0].requestBody;
    const envelope = JSON.parse(Buffer.from(bytes).toString('utf8'));
    expect(envelope.input).toEqual([
      {
        role: 'user',
        content: [{ type: 'input_text', text: expect.any(String) }],
      },
    ]);
    const context = JSON.parse(envelope.input[0].content[0].text);
    expect(context.authorDescription).toBe(`${outside}\nAuthor footer. `);
    expect(
      context.files.map((file: { filename: string }) => file.filename)
    ).toEqual(['src/invoice.ts']);
    for (const forbidden of [
      secret,
      '.env',
      'env-secret-marker',
      'private/policy.ts',
      'policy-secret-marker',
      'src/renamed.ts',
      'renamed-policy-secret-marker',
      'generated-untrusted-requirement',
    ])
      expect(Buffer.from(bytes).toString('utf8')).not.toContain(forbidden);
    expect(envelope).toMatchObject({
      model,
      tools: [],
      tool_choice: 'none',
      store: false,
      stream: true,
      max_output_tokens: 1200,
    });
    expect(suppliedPr.body).toBe(body);
  });

  it('disabled generation performs no auxiliary model request', () => {
    const request = jest.fn();
    expect(
      generator(
        {
          generatePrDescription: request,
        } as unknown as LocalGatewayModelTransport,
        { enabled: false }
      )
    ).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    '{}',
    JSON.stringify({
      ...prDescriptionExtensionV1,
      canonicalizerDigest: 'f'.repeat(64),
    }),
    JSON.stringify({ ...prDescriptionExtensionV1, extra: true }),
  ])(
    'keeps old or unapproved producers unavailable without an auxiliary request: %s',
    (capabilityJson) => {
      const request = jest.fn();
      const warn = jest.fn();
      expect(
        generator(
          {
            generatePrDescription: request,
          } as unknown as LocalGatewayModelTransport,
          { capabilityJson, warn }
        )
      ).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
      expect(request).not.toHaveBeenCalled();
    }
  );

  it.each([
    'success',
    'missing-model',
    'different-model',
    'saturated',
    'unknown-effect',
    'reserved-marker',
    'output-bytes',
  ] as const)(
    'keeps review evidence isolated when auxiliary generation is %s',
    async (outcome) => {
      const transport = await startLocalGatewayModelTransport(
        new AccountGatewayModelTransport(
          'https://gateway.example',
          () => 'synthetic-parent-token'
        )
      );
      const seed = nock('https://gateway.example')
        .post('/api/action/v2/account-gateway/responses')
        .reply(200, completed(model), { 'content-type': 'text/event-stream' });
      try {
        const review = await fetch(`${transport.baseUrl}/responses`, {
          method: 'POST',
          headers: {
            authorization: transport.environment[LOCAL_MODEL_CAPABILITY_ENV]!,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model, stream: true }),
        });
        await review.text();
        expect(seed.isDone()).toBe(true);
        let attempted = 0;
        const noMatch = () => {
          attempted++;
        };
        nock.emitter.on('no match', noMatch);
        const scope = nock('https://gateway.example').post(
          '/api/action/v2/account-gateway/responses'
        );
        const expected =
          outcome === 'saturated'
            ? scope.reply(
                503,
                {
                  error: { code: 'relay_saturated', effect: 'not_dispatched' },
                },
                { 'content-type': 'application/json' }
              )
            : outcome === 'unknown-effect'
              ? scope.replyWithError(
                  Object.assign(new Error('synthetic accepted socket loss'), {
                    code: 'ECONNRESET',
                  })
                )
              : scope.reply(
                  200,
                  completed(
                    outcome === 'missing-model'
                      ? undefined
                      : outcome === 'different-model'
                        ? 'different/model'
                        : model,
                    outcome === 'reserved-marker'
                      ? '<!-- ai-robot-review-summary:end -->'
                      : outcome === 'output-bytes'
                        ? '😀'.repeat(2049)
                        : undefined
                  ),
                  { 'content-type': 'text/event-stream' }
                );
        try {
          if (outcome === 'success') {
            const result = await execute(transport);
            expect(result).toMatchObject({
              generatedMarkdown: expect.stringContaining(
                'Preserve invoice ownership'
              ),
              generationProvenance: {
                leaseId: lease.leaseId,
                providerIndex: 0,
                requestedModel: model,
                actualModel: model,
              },
            });
          } else await expect(execute(transport)).rejects.toThrow();
          expect(expected.isDone()).toBe(true);
          expect(attempted).toBe(0);
          expect(transport.actualModel()).toBe(model);
          expect(transport.requestCount!()).toBe(1);
          expect(transport.failureFact()).toBeUndefined();
        } finally {
          nock.emitter.removeListener('no match', noMatch);
        }
      } finally {
        await transport.dispose();
      }
    }
  );

  it('uses the direct OpenRouter parent connection without exposing its key in a prepared request', async () => {
    const key = 'synthetic-direct-parent-only-key';
    const facts: UsageFact[] = [];
    const delivery = {
      scope: {
        sourceInstance: 'action:review',
        callIdPrefix: 'review:',
        provider: 'openrouter',
        requestedModel: model,
        runtimeType: 'codex',
        route: 'direct',
        purpose: 'review',
      },
      scopeIdentity: () => ({
        workspaceId: 'workspace',
        repositoryId: '12',
        actorId: null,
        runId: '34',
        runAttempt: 1,
        invocationId: 'review',
        bindingId: null,
        authorizationId: 'authorization',
      }),
      record: (fact: UsageFact) => {
        facts.push(fact);
      },
    } as unknown as UsageDelivery;
    const transport = await startDirectOpenRouterModelTransport(() => key, {
      requestMs: 60_000,
      streamFrameBytes: 8 * 1024 * 1024,
      usage: { delivery, requestedModel: model },
    });
    const upstream = nock('https://openrouter.ai')
      .post('/api/v1/responses')
      .matchHeader('authorization', `Bearer ${key}`)
      .reply(
        200,
        completed(model, undefined, { input_tokens: 11, output_tokens: 3 }),
        { 'content-type': 'text/event-stream' }
      );
    try {
      const parent = generator(transport)!;
      const invocation = await parent.prepare({
        workSlot: slot,
        attemptOrdinal: 1,
      });
      expect(invocation.reviewPrompt).not.toContain(key);
      expect(JSON.stringify(invocation.manifestFacts)).not.toContain(key);
      await expect(
        parent.execute({
          invocation,
          manifest,
          lease,
          signal: new AbortController().signal,
        })
      ).resolves.toMatchObject({
        generationProvenance: { actualModel: model },
      });
      expect(upstream.isDone()).toBe(true);
      expect(transport.requestCount!()).toBe(0);
      expect(transport.actualModel()).toBeUndefined();
      expect(facts.map((fact) => fact.state)).toEqual([
        'dispatched',
        'completed',
      ]);
      expect(facts[1]?.identity.callId).toBe(facts[0]?.identity.callId);
      expect(facts[1]).toMatchObject({
        identity: { purpose: 'review' },
        actualModel: model,
        tokens: { inputTotal: 11, outputTotal: 3, total: 14 },
      });
    } finally {
      await transport.dispose();
    }
  });
});
