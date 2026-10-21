import fs from 'fs';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { verify } from 'crypto';
import {
  ProducerCoverage,
  UsageDelivery,
  UsageGrantScope,
} from '../../../src/provider-usage/delivery';
import {
  UsageFact,
  canonicalJson,
} from '../../../src/provider-usage/usage-contract';
import { createResponsesUsageObserver } from '../../../src/provider-usage/responses-observer';

const scope: UsageGrantScope = {
  sourceInstance: 'runner/grant',
  callIdPrefix: 'grant-',
  provider: 'openrouter',
  requestedModel: 'requested/model',
  runtimeType: 'codex-responses-relay',
  route: 'direct',
  workspaceId: 'workspace',
  repositoryId: '123',
  actorId: null,
  invocationId: 'authorization-provider-api',
  authorizationId: 'authorization',
  runId: '456',
  runAttempt: 1,
  bindingId: null,
  producerDigest: 'digest',
  workflowIdentity: 'workflow',
  jobIdentity: 'job',
};
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'TEST-usage-delivery-'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
async function setup(
  report: (body: {
    facts: UsageFact[];
    producerCoverage?: ProducerCoverage;
  }) => unknown = () => ({ accepted: [] }),
  maxSpoolBytes?: number
) {
  let publicKey = '';
  const uploadArtifact = jest.fn(async () => {});
  const fetchImpl = jest.fn(async (url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.pathname.endsWith('/grants')) {
      publicKey = body.publicKey;
      return new Response(
        JSON.stringify({
          grantId: 'grant',
          grantToken: 'SECRET-GRANT',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          scope,
        })
      );
    }
    return new Response(JSON.stringify(report(body)));
  }) as unknown as typeof fetch;
  const delivery = await UsageDelivery.create({
    apiUrl: 'https://api.example',
    executionToken: 'SECRET-EXECUTION',
    invocationId: scope.invocationId,
    temporaryDirectory: directory,
    fetchImpl,
    uploadArtifact,
    maxSpoolBytes,
  });
  return { delivery, publicKey, uploadArtifact, fetchImpl };
}
function capture(delivery: UsageDelivery) {
  const observer = createResponsesUsageObserver(delivery, 'requested/model');
  observer.dispatched();
  observer.observe({
    type: 'response.completed',
    response: {
      model: 'actual/model',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        input_tokens_details: { cached_tokens: 60 },
        output_tokens_details: { reasoning_tokens: 10 },
      },
      output: [{ content: 'SECRET-RESPONSE' }],
    },
  });
  observer.finish(false, false);
}
it('writes signed bounded safe spool before delivery and uploads it on failed ACK', async () => {
  const { delivery, publicKey, uploadArtifact } = await setup();
  capture(delivery);
  const bytes = readFileSync(delivery.artifactPath, 'utf8');
  expect(bytes).not.toMatch(/SECRET|privateKey|grantToken|authorizationToken/);
  const { signature, ...envelope } = JSON.parse(bytes);
  expect(envelope.facts).toHaveLength(2);
  expect(envelope.facts[1].tokens).toEqual({
    inputTotal: 100,
    outputTotal: 20,
    cacheRead: 60,
    cacheWrite: null,
    reasoning: 10,
    total: 120,
  });
  expect(
    verify(
      null,
      Buffer.from(canonicalJson(envelope)),
      publicKey,
      Buffer.from(signature, 'base64')
    )
  ).toBe(true);
  await delivery.cleanup();
  expect(uploadArtifact).toHaveBeenCalledWith(
    'reviewrouter-usage-v1-authorization-provider-api-1',
    delivery.artifactPath
  );
  expect(delivery.coverage).toBe('partial');
});
it('keeps exact same events for retry and deletes only explicitly ACKed hashes', async () => {
  let n = 0;
  const { delivery } = await setup((body) => {
    n++;
    const disk = JSON.parse(readFileSync(delivery.artifactPath, 'utf8'));
    if (n === 1)
      return {
        accepted: [
          {
            eventId: body.facts[0].eventId,
            revision: 1,
            hash: 'wrong',
            status: 'accepted',
          },
        ],
      };
    return {
      accepted: disk.facts.map((fact: UsageFact, i: number) => ({
        eventId: fact.eventId,
        revision: fact.revision,
        hash: disk.eventHashes[i],
        status: 'duplicate',
      })),
    };
  });
  capture(delivery);
  const before = readFileSync(delivery.artifactPath, 'utf8');
  await delivery.flush();
  expect(
    JSON.parse(readFileSync(delivery.artifactPath, 'utf8')).eventHashes
  ).toEqual(JSON.parse(before).eventHashes);
  await delivery.flush();
  expect(delivery.coverage).toBe('partial');
  expect(JSON.parse(readFileSync(delivery.artifactPath, 'utf8')).facts).toEqual(
    []
  );
});
it('records failure with unknown usage and retains terminal revision on cancellation', async () => {
  const { delivery } = await setup();
  const observer = createResponsesUsageObserver(delivery, 'requested/model');
  observer.dispatched();
  observer.finish(true, true);
  observer.finish(true, true);
  const facts = JSON.parse(readFileSync(delivery.artifactPath, 'utf8')).facts;
  expect(facts).toHaveLength(2);
  expect(facts[1]).toMatchObject({
    state: 'cancelled',
    completeness: 'unknown',
    tokens: { total: null },
  });
});
it('reserves a signed coverage capsule when fact spool overflows', async () => {
  const { delivery, publicKey } = await setup(undefined, 700);
  expect(() => capture(delivery)).not.toThrow();
  expect(delivery.coverage).toBe('partial');
  const { signature, ...envelope } = JSON.parse(
    readFileSync(delivery.artifactPath, 'utf8')
  );
  expect(envelope.facts).toEqual([]);
  expect(envelope.producerCoverage).toMatchObject({
    schemaVersion: 1,
    state: 'partial',
    reason: 'spool_overflow',
    revision: 2,
    droppedEvents: 2,
  });
  expect(
    verify(
      null,
      Buffer.from(canonicalJson(envelope)),
      publicKey,
      Buffer.from(signature, 'base64')
    )
  ).toBe(true);
});

it('captures actual direct relay success and failed HTTP attempts without changing stream bytes', async () => {
  const nock = (await import('nock')).default;
  const { startDirectOpenRouterModelTransport, LOCAL_MODEL_CAPABILITY_ENV } =
    await import('../../../src/review-orchestration/infrastructure/account-gateway-model-transport');
  const { delivery } = await setup();
  const stream =
    'event: response.completed\ndata: {"type":"response.completed","response":{"model":"actual/model","status":"completed","usage":{"input_tokens":7,"output_tokens":3}}}\n\n';
  for (const [status, body] of [
    [200, stream],
    [429, '{"error":"rate limited"}'],
  ] as const) {
    const upstream = nock('https://openrouter.ai')
      .post('/api/v1/responses')
      .reply(status, body, {
        'content-type':
          status === 200 ? 'text/event-stream' : 'application/json',
      });
    const relay = await startDirectOpenRouterModelTransport(
      () => 'safe-test-key',
      {
        requestMs: 5000,
        streamFrameBytes: 100000,
        usage: { delivery, requestedModel: 'requested/model' },
      }
    );
    try {
      const response = await fetch(relay.baseUrl + '/responses', {
        method: 'POST',
        headers: {
          authorization: relay.environment[LOCAL_MODEL_CAPABILITY_ENV]!,
          'content-type': 'application/json',
        },
        body: '{"model":"requested/model","stream":true}',
      });
      expect(response.status).toBe(status);
      expect(await response.text()).toBe(body);
      expect(upstream.isDone()).toBe(true);
    } finally {
      await relay.dispose();
    }
  }
  const facts = JSON.parse(readFileSync(delivery.artifactPath, 'utf8')).facts;
  expect(facts).toHaveLength(4);
  expect(facts[1]).toMatchObject({
    state: 'completed',
    actualModel: 'actual/model',
    tokens: { total: 10 },
  });
  expect(facts[3]).toMatchObject({
    state: 'failed',
    completeness: 'unknown',
    tokens: { total: null },
  });
});

it('keeps initial usage partial on cancelled streams and captures JSON failed usage', async () => {
  const { delivery } = await setup();
  const first = createResponsesUsageObserver(delivery, 'requested/model');
  first.dispatched();
  first.observe({
    type: 'response.created',
    response: { usage: { input_tokens: 9, output_tokens: 1 } },
  });
  first.finish(true, true);
  const second = createResponsesUsageObserver(delivery, 'requested/model');
  second.dispatched();
  second.observe({
    status: 'failed',
    model: 'actual/model',
    usage: { input_tokens: 10, output_tokens: 2 },
  });
  second.finish(true, false);
  const facts = JSON.parse(readFileSync(delivery.artifactPath, 'utf8')).facts;
  expect(facts[1]).toMatchObject({
    state: 'cancelled',
    completeness: 'partial',
    tokens: { total: 10 },
  });
  expect(facts[3]).toMatchObject({
    state: 'failed',
    completeness: 'complete',
    tokens: { total: 12 },
  });
});

it('reports empty-fact overflow capsules and keeps replay bytes until exact coverage revision ACK', async () => {
  const reports: Array<{
    facts: UsageFact[];
    producerCoverage?: ProducerCoverage;
  }> = [];
  let ack = false;
  const { delivery, uploadArtifact } = await setup((body) => {
    reports.push(body);
    return {
      accepted: [],
      ...(ack
        ? { producerCoverageRevision: body.producerCoverage?.revision }
        : {}),
    };
  }, 700);
  capture(delivery);
  await delivery.cleanup();
  expect(reports[0]).toMatchObject({
    facts: [],
    producerCoverage: {
      reason: 'spool_overflow',
      droppedEvents: 2,
      revision: 2,
    },
  });
  expect(uploadArtifact).toHaveBeenCalledTimes(1);
  const pending = JSON.parse(
    readFileSync(delivery.artifactPath, 'utf8')
  ).producerCoverage;
  await delivery.flush();
  expect(reports[1].producerCoverage).toEqual(pending);
  expect(
    JSON.parse(readFileSync(delivery.artifactPath, 'utf8')).producerCoverage
  ).toEqual(pending);
  ack = true;
  await delivery.cleanup();
  expect(uploadArtifact).toHaveBeenCalledTimes(1);
  // ACK does not make historical coverage complete or erase its signed evidence.
  expect(delivery.coverage).toBe('partial');
  expect(
    JSON.parse(readFileSync(delivery.artifactPath, 'utf8')).producerCoverage
  ).toEqual(pending);
});

it('keeps cumulative dropped events and monotonic capsule revisions across further overflow', async () => {
  const { delivery } = await setup(undefined, 700);
  capture(delivery);
  const first = JSON.parse(
    readFileSync(delivery.artifactPath, 'utf8')
  ).producerCoverage;
  capture(delivery);
  const second = JSON.parse(
    readFileSync(delivery.artifactPath, 'utf8')
  ).producerCoverage;
  expect(first).toMatchObject({ revision: 2, droppedEvents: 2 });
  expect(second).toMatchObject({ revision: 4, droppedEvents: 4 });
  expect(Date.parse(second.occurredAt)).toBeGreaterThanOrEqual(
    Date.parse(first.occurredAt)
  );
});

it('preserves prior signed bytes on fsync failure and later delivers reserved loss metadata', async () => {
  const reports: Array<{
    facts: UsageFact[];
    producerCoverage?: ProducerCoverage;
  }> = [];
  const { delivery } = await setup((body) => {
    reports.push(body);
    return { accepted: [] };
  });
  const before = readFileSync(delivery.artifactPath, 'utf8');
  const fsync = jest.spyOn(fs, 'fsyncSync').mockImplementation(() => {
    throw new Error('PRIVATE-DISK-ERROR');
  });
  try {
    const observer = createResponsesUsageObserver(delivery, 'requested/model');
    expect(() => observer.dispatched()).not.toThrow();
    expect(readFileSync(delivery.artifactPath, 'utf8')).toBe(before);
  } finally {
    fsync.mockRestore();
  }
  await delivery.cleanup();
  expect(reports[0]).toMatchObject({
    facts: [],
    producerCoverage: {
      reason: 'spool_write_failed',
      droppedEvents: 1,
      revision: 1,
    },
  });
  const report = readFileSync(delivery.artifactPath, 'utf8');
  expect(report).not.toContain('PRIVATE');
  expect(JSON.parse(report).producerCoverage.droppedEvents).toBe(1);
});
