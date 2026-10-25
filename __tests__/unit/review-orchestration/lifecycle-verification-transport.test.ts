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
      seen.push({ body: Buffer.from(value), headers: options.headers, url });
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

test('parent transport forwards exact normalized hashed bytes and complete lease dispatch context once', async () => {
  const output = '{"version":1,"packetHash":"packet","results":[]}';
  const sse = `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', model: 'saved-model', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: output }] }] } })}\n\n`;
  const upstream = mockUpstream(200, sse, 'text/event-stream');
  try {
    const transport = new AccountGatewayModelTransport(
      'https://fixture.invalid',
      () => 'synthetic-authorization'
    );
    const result = await transport.generateLifecycleVerification({
      requestBody: bytes,
      dispatch,
      signal: new AbortController().signal,
      maxResponseBytes: 32768,
      deadlineMs: 60000,
    });
    expect(upstream.seen).toHaveLength(1);
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
});

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
        deadlineMs: 60000,
      })
    ).rejects.toThrow('dispatch_unavailable');
    expect(upstream.seen).toHaveLength(1);
  } finally {
    upstream.restore();
  }
});
