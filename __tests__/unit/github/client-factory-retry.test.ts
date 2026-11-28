import { getEventListeners } from 'node:events';
import * as core from '../../../src/actions/core';
import { createPublicationGitHubClient } from '../../../src/codex-oauth/terminal-outcome-publication';
import { createScmReadGitHubClient } from '../../../src/review-orchestration/infrastructure/production-t0-review-runner';

describe('production GitHub retry wait cancellation', () => {
  it.each([
    ['publication', 'timeout'],
    ['publication', 'abort'],
    ['scm', 'timeout'],
    ['scm', 'abort'],
  ] as const)(
    '%s stops its Retry-After wait on the actual request %s',
    async (factory, ending) => {
      const outer = new AbortController();
      const outerReason = new Error('outer_cancelled_during_github_retry');
      let enteredWait!: () => void;
      const waiting = new Promise<void>((resolve) => {
        enteredWait = resolve;
      });
      const info = jest.spyOn(core, 'info').mockImplementation((message) => {
        if (message.startsWith('GitHub read retry 1/3')) enteredWait();
      });
      let requestSignal: AbortSignal | undefined;
      let initialListeners = 0;
      let reads = 0;
      const requestFetch = jest.fn(
        async (
          _input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1]
        ) => {
          requestSignal = init?.signal ?? undefined;
          if (requestSignal) {
            initialListeners = getEventListeners(requestSignal, 'abort').length;
          }
          reads += 1;
          return new Response(
            JSON.stringify(
              reads === 1 ? { message: 'Unavailable' } : { id: 1 }
            ),
            {
              status: reads === 1 ? 503 : 200,
              headers: {
                'content-type': 'application/json',
                'retry-after': '2',
              },
            }
          );
        }
      );
      const client =
        factory === 'publication'
          ? createPublicationGitHubClient('synthetic-token', {
              signal: outer.signal,
              timeoutMs: 200,
            })
          : createScmReadGitHubClient({
              token: 'synthetic-token',
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              refresh: async () => {
                throw new Error('unexpected_token_refresh');
              },
              signal: outer.signal,
              timeoutMs: 200,
            });
      const settled = jest.fn();
      let completion: Promise<void> | undefined;
      try {
        completion = client.octokit.rest.repos
          .get({
            owner: 'owner',
            repo: 'repo',
            request: { fetch: requestFetch },
          })
          .then(
            (value) => {
              settled({ value });
            },
            (error: unknown) => {
              settled({ error });
            }
          );
        await Promise.race([
          waiting,
          completion.then(() => {
            throw new Error('read_finished_before_retry_wait');
          }),
        ]);
        const signal = requestSignal;
        if (!signal) throw new Error('request_signal_missing');
        expect(signal).not.toBe(outer.signal);
        expect(signal.aborted).toBe(false);
        expect(requestFetch).toHaveBeenCalledTimes(1);
        if (ending === 'abort') {
          outer.abort(outerReason);
        } else {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          expect(outer.signal.aborted).toBe(false);
          expect(signal.reason).toHaveProperty('name', 'TimeoutError');
        }
        // Observe cancellation without waiting for the two-second Retry-After.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toHaveBeenCalledTimes(1);
        expect(settled.mock.calls[0][0].error).toBe(signal.reason);
        if (ending === 'abort') expect(signal.reason).toBe(outerReason);
        expect(requestFetch).toHaveBeenCalledTimes(1);
        expect(getEventListeners(signal, 'abort')).toHaveLength(
          initialListeners
        );
      } finally {
        outer.abort(outerReason);
        await completion;
        info.mockRestore();
      }
    }
  );
});
