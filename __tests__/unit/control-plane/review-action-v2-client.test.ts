import {
  ReviewActionV2Client,
  ReviewActionV2ClientError,
  ReviewActionV2ClientFailureCode,
} from '../../../src/control-plane/review-action-v2-client';
import {
  ReviewActionV2OperationId,
  ReviewActionV2ProtocolErrorCode,
  ReviewExecutionStartResultStatus,
  ReviewRunAuthorizationResultStatus,
  reviewActionV2PublishedProtocolVersion,
  reviewActionV2PublishedSchemaDigest,
} from '../../../src/control-plane/generated/review-action-v2/review-action-v2';
import { ReviewActionV2RetryClass } from '../../../src/control-plane/generated/review-action-v2/review-action-v2-negotiation';

describe('ReviewActionV2Client', () => {
  it('frames and validates an authorize request with the generated contract', async () => {
    const fetchImpl = jest.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return jsonResponse({
        protocolVersion: reviewActionV2PublishedProtocolVersion,
        schemaDigest: reviewActionV2PublishedSchemaDigest,
        requestId: request.requestId,
        serverTime: '2026-07-22T12:00:00.000Z',
        result: { status: ReviewRunAuthorizationResultStatus.Authorized },
      });
    });
    const client = createClient(fetchImpl);

    await expect(
      client.execute(ReviewActionV2OperationId.ReviewRunAuthorize, {
        oidcToken: 'header.payload.signature',
        supportedProtocols: [
          {
            protocolVersion: reviewActionV2PublishedProtocolVersion,
            schemaDigest: reviewActionV2PublishedSchemaDigest,
          },
        ],
      })
    ).resolves.toEqual({
      status: ReviewRunAuthorizationResultStatus.Authorized,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
    });
  });

  it('retries a mutable command with byte-identical framing', async () => {
    const bodies: string[] = [];
    const fetchImpl = jest.fn(async (_url, init) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw new Error('connection_reset');
      const request = JSON.parse(bodies[0]);
      return jsonResponse(
        {
          protocolVersion: reviewActionV2PublishedProtocolVersion,
          schemaDigest: reviewActionV2PublishedSchemaDigest,
          requestId: request.requestId,
          serverTime: '2026-07-22T12:00:00.000Z',
          result: { status: ReviewExecutionStartResultStatus.Admitted },
        },
        201
      );
    });
    const client = createClient(fetchImpl);

    await client.execute(ReviewActionV2OperationId.ReviewExecutionStart, {
      authorizationToken: 'authorization.token',
      idempotencyKey: 'idem:start:1',
      authorizationId: 'authorization-1',
      executionId: 'execution-1',
      reviewRevisionHash: '1'.repeat(64),
      compatibilityKey: '2'.repeat(64),
      planHash: '3'.repeat(64),
      workSlotsCanonicalJson: '[]',
      sourceRunId: 'run-1',
      sourceRunAttempt: '1',
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[0]).requestBodyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('surfaces typed 426 without converting it to v1 behavior', async () => {
    const fetchImpl = jest.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return jsonResponse(
        {
          protocolVersion: reviewActionV2PublishedProtocolVersion,
          schemaDigest: reviewActionV2PublishedSchemaDigest,
          requestId: request.requestId,
          serverTime: '2026-07-22T12:00:00.000Z',
          error: {
            errorCode: ReviewActionV2ProtocolErrorCode.UnsupportedProtocol,
            retryClass: ReviewActionV2RetryClass.Never,
            details: { issues: ['v2_disabled'] },
          },
        },
        426
      );
    });

    await expect(
      createClient(fetchImpl).execute(
        ReviewActionV2OperationId.ReviewRunAuthorize,
        {
          oidcToken: 'header.payload.signature',
          supportedProtocols: [
            {
              protocolVersion: reviewActionV2PublishedProtocolVersion,
              schemaDigest: reviewActionV2PublishedSchemaDigest,
            },
          ],
        }
      )
    ).rejects.toMatchObject({
      code: ReviewActionV2ClientFailureCode.ProtocolError,
      httpStatus: 426,
      protocolErrorCode: ReviewActionV2ProtocolErrorCode.UnsupportedProtocol,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown response fields and request identity drift', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({
        protocolVersion: reviewActionV2PublishedProtocolVersion,
        schemaDigest: reviewActionV2PublishedSchemaDigest,
        requestId: 'different-request',
        serverTime: '2026-07-22T12:00:00.000Z',
        result: { status: ReviewRunAuthorizationResultStatus.Authorized },
        unexpected: true,
      })
    );

    await expect(
      createClient(fetchImpl, 1).execute(
        ReviewActionV2OperationId.ReviewRunAuthorize,
        {
          oidcToken: 'header.payload.signature',
          supportedProtocols: [
            {
              protocolVersion: reviewActionV2PublishedProtocolVersion,
              schemaDigest: reviewActionV2PublishedSchemaDigest,
            },
          ],
        }
      )
    ).rejects.toBeInstanceOf(ReviewActionV2ClientError);
  });

  it('cancels a streamed response as soon as its byte limit is exceeded', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700));
        controller.enqueue(new Uint8Array(700));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new ReviewActionV2Client({
      apiUrl: 'http://127.0.0.1:3000',
      allowInsecureLocalhost: true,
      fetchImpl: jest.fn(async () => new Response(stream)),
      maxAttempts: 1,
      maxResponseBytes: 1024,
      requestIdFactory: () => 'rr:test-request',
    });

    await expect(
      client.execute(ReviewActionV2OperationId.ReviewRunAuthorize, {
        oidcToken: 'header.payload.signature',
        supportedProtocols: [
          {
            protocolVersion: reviewActionV2PublishedProtocolVersion,
            schemaDigest: reviewActionV2PublishedSchemaDigest,
          },
        ],
      })
    ).rejects.toMatchObject({
      code: ReviewActionV2ClientFailureCode.ResponseTooLarge,
    });
    expect(cancelled).toBe(true);
  });
});

function createClient(fetchImpl: typeof fetch, maxAttempts = 2) {
  return new ReviewActionV2Client({
    apiUrl: 'http://127.0.0.1:3000',
    allowInsecureLocalhost: true,
    fetchImpl,
    maxAttempts,
    requestIdFactory: () => 'rr:test-request',
    sleep: async () => undefined,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
