import {
  createNewtestJobTransport,
  type NewtestJobIdentity,
} from '../../../src/control-plane/newtest-one-shot-job-transport';

const identity: NewtestJobIdentity = {
  repository: '777genius/reviewrouter-e2e-prod-20260529-000305',
  repositoryId: '1252762369',
  headRepository: '777genius/reviewrouter-e2e-prod-20260529-000305',
  eventName: 'pull_request',
  runId: '123',
  runAttempt: '1',
  headSha: 'a'.repeat(40),
  pullRequestNumber: '4',
  workflowRepository: '777genius/review-router',
  workflowSha: 'b'.repeat(40),
};
const challenge = {
  schema: 'newtest-v4-root-challenge-v1',
  repositoryId: identity.repositoryId,
  runId: identity.runId,
  sourceSha: identity.workflowSha,
  headSha: identity.headSha,
  nonce: 'c'.repeat(64),
  expiresAt: 2000,
};
const receipt = {
  schema: 'newtest-v4-root-receipt-v1',
  status: 'completed',
  runId: identity.runId,
  sourceSha: identity.workflowSha,
  evidenceHash: 'd'.repeat(64),
};
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200 });

describe('finite TEST job transport', () => {
  it.each([
    { repositoryId: '999' },
    { headRepository: 'foreign/fork' },
    { eventName: 'workflow_dispatch' },
    { runAttempt: '2' },
    { workflowSha: 'main' },
    { workflowRepository: 'foreign/runtime' },
  ])('rejects wrong authority before any HTTP: %j', (change) => {
    const fetchImpl = jest.fn();
    expect(() =>
      createNewtestJobTransport({
        identity: { ...identity, ...change },
        fetch: fetchImpl,
        requestOidc: jest.fn(),
      })
    ).toThrow('identity_rejected');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not request OIDC or POST when fresh root/head binding fails', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(response({ ...challenge, headSha: 'e'.repeat(40) }));
    const requestOidc = jest.fn();
    const transport = createNewtestJobTransport({
      identity,
      fetch: fetchImpl,
      requestOidc,
      now: () => 1000,
    });
    await expect(transport.runOnce()).rejects.toThrow('challenge_rejected');
    expect(requestOidc).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(transport.runOnce()).rejects.toThrow('already_consumed');
  });

  it('transfers once with redirects forbidden and exposes only the evidence locator', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response(challenge))
      .mockResolvedValueOnce(response(receipt));
    const requestOidc = jest.fn().mockResolvedValue('synthetic-test-oidc');
    const transport = createNewtestJobTransport({
      identity,
      fetch: fetchImpl,
      requestOidc,
      now: () => 1000,
    });
    await expect(transport.runOnce()).resolves.toBe(receipt.evidenceHash);
    expect(requestOidc).toHaveBeenCalledWith('reviewrouter');
    expect(fetchImpl.mock.calls[1][0].toString()).toBe(
      'https://api.reviewrouter.site/__newtest_v4/dispatch'
    );
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
    });
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(body).toEqual({
      schema: 'newtest-v4-job-request-v1',
      identity,
      nonce: challenge.nonce,
      oidc: 'synthetic-test-oidc',
    });
    await expect(transport.runOnce()).rejects.toThrow('already_consumed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('burns transport after ambiguous dispatch without retry', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response(challenge))
      .mockRejectedValueOnce(new Error('connection lost'));
    const transport = createNewtestJobTransport({
      identity,
      fetch: fetchImpl,
      requestOidc: async () => 'synthetic',
      now: () => 1000,
    });
    await expect(transport.runOnce()).rejects.toThrow('connection lost');
    await expect(transport.runOnce()).rejects.toThrow('already_consumed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized root input before requesting OIDC', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response('x'.repeat(4097)));
    const requestOidc = jest.fn();
    await expect(
      createNewtestJobTransport({
        identity,
        fetch: fetchImpl,
        requestOidc,
        now: () => 1000,
      }).runOnce()
    ).rejects.toThrow('oversized');
    expect(requestOidc).not.toHaveBeenCalled();
  });
});
