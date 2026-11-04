import {
  confirmedProviderFailure,
  providerFailureMessage,
} from '../../../src/review-execution/domain/provider-failure';
import https from 'https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  lifecycleVerificationContract as contract,
  type ReviewCompanionDispatchContextV1,
} from '../../../src/control-plane/generated/review-action-v2/companion-contracts';
import { AccountGatewayModelTransport } from '../../../src/review-orchestration/infrastructure/account-gateway-model-transport';

const dispatch: ReviewCompanionDispatchContextV1 = {
  dispatchId: 'dispatch',
  executionId: 'execution',
  workSlotId: 'slot',
  attemptOrdinal: 1,
  leaseId: 'lease',
  leaseCapability: 'parent-only-secret',
  fencingToken: '7',
  preparedManifestKey: 'a'.repeat(64),
};
const bytes = Buffer.from(
  JSON.stringify({
    model: 'saved-model',
    stream: true,
    store: false,
    service_tier: 'default',
    max_output_tokens: 4096,
    tools: [],
    tool_choice: 'none',
    instructions: 'verify',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'packet' }] },
    ],
  })
);
function mockUpstream(status: number, body: string, contentType: string) {
  const seen: {
    body: Uint8Array;
    headers: Record<string, string>;
    url: URL;
  }[] = [];
  const spy = jest.spyOn(https, 'request').mockImplementation(((
    url: URL,
    options: { headers: Record<string, string> },
    callback: (response: Readable) => void
  ) => {
    const request = new EventEmitter() as EventEmitter & {
      end(value: Uint8Array): void;
    };
    request.end = (value) => {
      seen.push({
        body: Buffer.from(value ?? []),
        headers: options.headers,
        url,
      });
      queueMicrotask(() =>
        callback(
          Object.assign(Readable.from([Buffer.from(body)]), {
            statusCode: status,
            headers: { 'content-type': contentType },
            complete: true,
            setTimeout: () => undefined,
          })
        )
      );
    };
    return request;
  }) as unknown as typeof https.request);
  return { seen, restore: () => spy.mockRestore() };
}

test.each([undefined, 'reviewer-primary'])(
  'parent transport forwards exact normalized hashed bytes and complete lease dispatch context once for reviewer=%s',
  async (reviewerId) => {
    const output = '{"version":1,"packetHash":"packet","results":[]}';
    const sse = `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', model: 'saved-model', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: output }] }] } })}\n\n`;
    const upstream = mockUpstream(200, sse, 'text/event-stream');
    try {
      const transport = new AccountGatewayModelTransport(
        'https://fixture.invalid',
        () => 'synthetic-authorization',
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        reviewerId
      );
      const result = await transport.generateLifecycleVerification({
        requestBody: bytes,
        dispatch,
        signal: new AbortController().signal,
        maxResponseBytes: 32768,
        maxOutputTokens: 4096,
        deadlineMs: 60000,
      });
      expect(upstream.seen).toHaveLength(1);
      expect(upstream.seen[0].headers['x-reviewrouter-reviewer-id']).toBe(
        reviewerId
      );
      expect(Buffer.from(upstream.seen[0].body).equals(bytes)).toBe(true);
      expect(upstream.seen[0].url.pathname).toBe(
        '/api/action/v2/account-gateway/responses'
      );
      expect(upstream.seen[0].headers).toMatchObject(
        Object.fromEntries(
          Object.entries(contract.dispatchHeaders).map(([key, header]) => [
            header,
            String(dispatch[key as keyof ReviewCompanionDispatchContextV1]),
          ])
        )
      );
      expect(result).toEqual({
        body: Buffer.from(output),
        actualModel: 'saved-model',
        providerRequestEnvelopeHash: createHash('sha256')
          .update(bytes)
          .digest('hex'),
      });
    } finally {
      upstream.restore();
    }
  }
);

test('positively unpaid companion denial still makes exactly one HTTP attempt', async () => {
  const upstream = mockUpstream(
    503,
    JSON.stringify({
      error: { code: 'relay_saturated', effect: 'not_dispatched' },
    }),
    'application/json'
  );
  try {
    const transport = new AccountGatewayModelTransport(
      'https://fixture.invalid',
      () => 'synthetic-authorization'
    );
    await expect(
      transport.generateLifecycleVerification({
        requestBody: bytes,
        dispatch,
        signal: new AbortController().signal,
        maxResponseBytes: 32768,
        maxOutputTokens: 4096,
        deadlineMs: 60000,
      })
    ).rejects.toThrow('dispatch_unavailable');
    expect(upstream.seen).toHaveLength(1);
  } finally {
    upstream.restore();
  }
});

test('child Responses and request readback carry their exact selector and scoped allocation failure facts', async () => {
  const upstream = mockUpstream(
    403,
    JSON.stringify({
      error: {
        code: 'admission_limited',
        effect: 'not_dispatched',
        failureScope: 'allocation',
        concurrencyGroupId: 'allocation-one',
        requestRef: 'request-one',
      },
    }),
    'application/json'
  );
  try {
    const transport = new AccountGatewayModelTransport(
      'https://fixture.invalid',
      () => 'synthetic-authorization',
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      'reviewer-one'
    );
    const response = await transport.responses(
      bytes,
      new AbortController().signal
    );
    for await (const _chunk of response.body) {
      /* Drain failure facts. */
    }
    expect(transport.lastFailure).toEqual({
      code: 'admission_limited',
      effect: 'not_dispatched',
      failureScope: 'allocation',
      concurrencyGroupId: 'allocation-one',
      requestRef: 'request-one',
    });
    await transport.readRequest('request-one');
    expect(upstream.seen).toHaveLength(2);
    expect(
      upstream.seen.every(
        (request) =>
          request.headers['x-reviewrouter-reviewer-id'] === 'reviewer-one'
      )
    ).toBe(true);
    expect(upstream.seen[1].url.pathname).toBe(
      '/api/action/v2/account-gateway/requests/request-one'
    );
  } finally {
    upstream.restore();
  }
});

test.each([
  ['legacy', 65_537, false],
  ['reviewer-plan', 65_537, true],
  ['reviewer-plan', 131_073, false],
] as const)(
  'keeps checkout-only response bound for %s at %s bytes',
  async (version, targetBytes, accepted) => {
    const value =
      version === 'legacy'
        ? { padding: '' }
        : {
            runtimeConfig: {
              runtimeEnv: { REVIEW_ROUTER_REVIEWER_PLAN_JSON: '{}' },
            },
            padding: '',
          };
    const encoded = JSON.stringify(value);
    value.padding = 'x'.repeat(targetBytes - Buffer.byteLength(encoded));
    const body = JSON.stringify(value);
    expect(Buffer.byteLength(body)).toBe(targetBytes);
    const upstream = mockUpstream(200, body, 'application/json');
    try {
      const transport = new AccountGatewayModelTransport(
        'https://fixture.invalid',
        () => 'synthetic-authorization'
      );
      const request = transport.checkoutCapability({
        providerInstanceId: 'provider',
        workflowSchemaVersion: 1,
      });
      if (accepted)
        await expect(request).resolves.toMatchObject({ httpStatus: 200 });
      else await expect(request).rejects.toThrow();
    } finally {
      upstream.restore();
    }
  }
);

test.each([
  [
    {
      provider: 'openrouter',
      limit: 1000,
      remaining: 0,
      resetAt: '2026-11-05T00:00:00.000Z',
      secret: 'must-not-survive',
    },
    true,
  ],
  [
    {
      provider: 'openrouter',
      limit: 1000,
      remaining: 1,
      resetAt: '2026-11-05T00:00:00.000Z',
    },
    false,
  ],
  [
    {
      provider: 'openrouter',
      limit: 1000,
      remaining: 0,
      resetAt: '2026-02-30T00:00:00.000Z',
    },
    false,
  ],
  [
    {
      provider: 'openrouter',
      limit: 0,
      remaining: 0,
      resetAt: '2026-11-05T00:00:00.000Z',
    },
    false,
  ],
  [
    {
      provider: 'other',
      limit: 1000,
      remaining: 0,
      resetAt: '2026-11-05T00:00:00.000Z',
    },
    false,
  ],
])(
  'retains only confirmed safe quota DTO from one failed HTTP attempt: %j',
  async (providerQuota, confirmed) => {
    const upstream = mockUpstream(
      502,
      JSON.stringify({
        error: {
          code: 'provider_quota_exhausted',
          effect: 'effect_unknown',
          providerQuota,
        },
      }),
      'application/json'
    );
    try {
      const transport = new AccountGatewayModelTransport(
        'https://fixture.invalid',
        () => 'synthetic'
      );
      const response = await transport.responses(
        bytes,
        new AbortController().signal
      );
      for await (const _chunk of response.body) {
        /* Drain failure facts. */
      }
      expect(upstream.seen).toHaveLength(1);
      expect(transport.lastFailure?.effect).toBe('effect_unknown');
      if (confirmed)
        expect(transport.lastFailure?.providerQuota).toEqual({
          provider: 'openrouter',
          limit: 1000,
          remaining: 0,
          resetAt: '2026-11-05T00:00:00.000Z',
        });
      else expect(transport.lastFailure?.providerQuota).toBeUndefined();
    } finally {
      upstream.restore();
    }
  }
);

test.each(['upstream_failure', 'relay_unknown', 'provider_quota_exhausted'])(
  'explains confirmed upstream HTTP502 without changing unknown effects or replaying: %s',
  async (code) => {
    const upstream = mockUpstream(
      502,
      JSON.stringify({ error: { code, effect: 'effect_unknown' } }),
      'application/json'
    );
    try {
      const transport = new AccountGatewayModelTransport(
        'https://fixture.invalid',
        () => 'synthetic'
      );
      const response = await transport.responses(
        bytes,
        new AbortController().signal
      );
      for await (const _chunk of response.body) {
        /* Drain the safe failure fact. */
      }
      expect(upstream.seen).toHaveLength(1);
      expect(transport.lastFailure?.effect).toBe('effect_unknown');
      const message = providerFailureMessage(
        confirmedProviderFailure(transport.lastFailure)
      );
      if (code === 'upstream_failure') {
        expect(message).toContain(
          'The outcome of the failed provider request is unknown.'
        );
        expect(message).toContain(
          'An incomplete review does not approve the changes.'
        );
        expect(message).toContain(
          'Wait for this run to finish, then start a new review.'
        );
      } else {
        expect(message).toContain('The request may have reached the provider.');
        expect(message).toContain('Automatic retry was withheld');
        expect(message).not.toContain('upstream failure');
      }
    } finally {
      upstream.restore();
    }
  }
);
