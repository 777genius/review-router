import {
  ControlPlaneManualReviewRequestClient,
  ManualReviewRequestAvailability,
} from '../../../src/control-plane/review-request';

const applied = {
  status: 'applied' as const,
  apiUrl: 'https://api.reviewrouter.site',
  actionVersion: '1.0.0',
  configVersion: 1,
  sessionToken: 'session-token',
};

describe('ControlPlaneManualReviewRequestClient', () => {
  it('treats runtime-config fallback as unavailable rather than legacy-safe', () => {
    const client = new ControlPlaneManualReviewRequestClient({
      status: 'fallback',
      reason: 'network_error',
    });
    expect(client.availability()).toBe(
      ManualReviewRequestAvailability.Unavailable
    );
  });

  it('does not treat repository_not_registered as an unsupported endpoint', async () => {
    const client = new ControlPlaneManualReviewRequestClient(
      applied,
      jest.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 'repository_not_registered' } }),
            { status: 404, headers: { 'content-type': 'application/json' } }
          )
      ) as typeof fetch
    );

    await expect(client.request(command())).rejects.toThrow(
      'manual_review_request_failed:404:repository_not_registered'
    );
  });

  it.each([
    [{ error: { code: 'review_request_intent_disabled' } }],
    [
      {
        error: 'Not Found',
        message: 'Route POST:/api/action/v1/review-requests/manual not found',
      },
    ],
  ])(
    'allows legacy fallback only for an explicitly unsupported endpoint',
    async (body) => {
      const client = new ControlPlaneManualReviewRequestClient(
        applied,
        jest.fn(
          async () =>
            new Response(JSON.stringify(body), {
              status: 404,
              headers: { 'content-type': 'application/json' },
            })
        ) as typeof fetch
      );

      await expect(client.request(command())).resolves.toEqual({
        status: 'unsupported',
      });
    }
  );
});

function command() {
  return {
    pullRequestNumber: 252,
    expectedHeadSha: 'a'.repeat(40),
    sourceId: 'manual-comment:1',
    commandKind: 'review' as const,
  };
}
