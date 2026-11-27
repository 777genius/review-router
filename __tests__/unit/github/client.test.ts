import * as core from '../../../src/actions/core';
import { GitHubClient } from '../../../src/github/client';
import nock from 'nock';

function waits(sleep: jest.Mock): number[] {
  return sleep.mock.calls.map(([delayMs]) => delayMs as number);
}

// Each retry waits a jittered 50-100% of its scheduled delay.
function expectJitteredWaits(
  sleep: jest.Mock,
  scheduledMs: readonly number[]
): void {
  const observed = waits(sleep);
  expect(observed).toHaveLength(scheduledMs.length);
  observed.forEach((delayMs, index) => {
    expect(delayMs).toBeGreaterThanOrEqual(scheduledMs[index] / 2);
    expect(delayMs).toBeLessThanOrEqual(scheduledMs[index]);
  });
}

describe('GitHubClient', () => {
  const mockToken = 'TEST_TOKEN';
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      GITHUB_REPOSITORY: 'owner/repo',
    };
  });

  afterEach(() => {
    nock.cleanAll();
    process.env = originalEnv;
  });

  describe('Initialization', () => {
    it('uses an explicit repository without changing the shared Actions environment', () => {
      const client = new GitHubClient(mockToken, {
        repository: 'disposable-test/canary',
      });

      expect(client.owner).toBe('disposable-test');
      expect(client.repo).toBe('canary');
      expect(process.env.GITHUB_REPOSITORY).toBe('owner/repo');
    });

    it('creates client with token', () => {
      const client = new GitHubClient(mockToken);

      expect(client).toBeDefined();
      expect(client.owner).toBe('owner');
      expect(client.repo).toBe('repo');
    });

    it('parses owner and repo from environment', () => {
      process.env.GITHUB_REPOSITORY = 'test-owner/test-repo';

      const client = new GitHubClient(mockToken);

      expect(client.owner).toBe('test-owner');
      expect(client.repo).toBe('test-repo');
    });

    it('handles GITHUB_REPOSITORY without slash', () => {
      process.env.GITHUB_REPOSITORY = 'invalid-format';

      const client = new GitHubClient(mockToken);

      // When there's no '/', split returns the whole string as first element, repo is empty string
      expect(client.owner).toBe('invalid-format');
      expect(client.repo).toBe('');
    });

    it('handles GITHUB_REPOSITORY not set', () => {
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_EVENT_PATH;

      const client = new GitHubClient(mockToken);

      // When GITHUB_REPOSITORY is undefined, should handle gracefully
      expect(client.owner).toBe('');
      expect(client.repo).toBe('');
    });
  });

  describe('Octokit Integration', () => {
    it('provides access to octokit instance', () => {
      const client = new GitHubClient(mockToken);

      expect(client.octokit).toBeDefined();
      expect(client.octokit.rest).toBeDefined();
    });

    it('configures octokit with correct auth', () => {
      const client = new GitHubClient(mockToken);

      // Octokit should be configured with the token
      expect(client.octokit).toBeDefined();
    });

    it('refreshes once and retries a request rejected with 401', async () => {
      const tokenProvider = {
        getToken: jest.fn().mockResolvedValue('ghs_initial'),
        refreshToken: jest.fn().mockResolvedValue('ghs_refreshed'),
      };
      const initialRequest = nock('https://api.github.com', {
        reqheaders: { authorization: 'Bearer ghs_initial' },
      })
        .get('/repos/owner/repo')
        .reply(401, { message: 'Bad credentials' });
      const retriedRequest = nock('https://api.github.com', {
        reqheaders: { authorization: 'Bearer ghs_refreshed' },
      })
        .get('/repos/owner/repo')
        .reply(200, { id: 1, name: 'repo' });
      const client = new GitHubClient(mockToken, { tokenProvider });

      await expect(
        client.octokit.rest.repos.get({ owner: 'owner', repo: 'repo' })
      ).resolves.toMatchObject({ status: 200 });
      expect(tokenProvider.getToken).toHaveBeenCalledTimes(1);
      expect(tokenProvider.refreshToken).toHaveBeenCalledTimes(1);
      expect(initialRequest.isDone()).toBe(true);
      expect(retriedRequest.isDone()).toBe(true);
    });

    it('retries transient GitHub failures without refreshing the token', async () => {
      const tokenProvider = {
        getToken: jest.fn().mockResolvedValue('ghs_initial'),
        refreshToken: jest.fn(),
      };
      const requests = nock('https://api.github.com', {
        reqheaders: { authorization: 'Bearer ghs_initial' },
      })
        .get('/repos/owner/repo')
        .reply(503, { message: 'Service unavailable' })
        .get('/repos/owner/repo')
        .reply(502, { message: 'Bad gateway' })
        .get('/repos/owner/repo')
        .reply(200, { id: 1, name: 'repo' });
      const sleep = jest.fn(async () => undefined);
      const client = new GitHubClient(mockToken, { tokenProvider, sleep });

      await expect(
        client.octokit.rest.repos.get({ owner: 'owner', repo: 'repo' })
      ).resolves.toMatchObject({ status: 200 });
      expect(tokenProvider.getToken).toHaveBeenCalledTimes(1);
      expect(tokenProvider.refreshToken).not.toHaveBeenCalled();
      expectJitteredWaits(sleep, [1_000, 2_000]);
      expect(requests.isDone()).toBe(true);
    });

    it('retries transient GitHub failures for a static token', async () => {
      const requests = nock('https://api.github.com', {
        reqheaders: { authorization: 'token TEST_TOKEN' },
      })
        .get('/repos/owner/repo')
        .reply(503, { message: 'Service unavailable' })
        .get('/repos/owner/repo')
        .reply(200, { id: 1, name: 'repo' });
      const sleep = jest.fn(async () => undefined);
      const client = new GitHubClient(mockToken, { sleep });

      await expect(
        client.octokit.rest.repos.get({ owner: 'owner', repo: 'repo' })
      ).resolves.toMatchObject({ status: 200 });
      expectJitteredWaits(sleep, [1_000]);
      expect(requests.isDone()).toBe(true);
    });

    it('gives up after three retries with the last GitHub error', async () => {
      const requests = nock('https://api.github.com')
        .get('/repos/owner/repo')
        .times(4)
        .reply(502, { message: 'Bad gateway' });
      const sleep = jest.fn(async () => undefined);
      const client = new GitHubClient(mockToken, { sleep });

      await expect(
        client.octokit.rest.repos.get({ owner: 'owner', repo: 'repo' })
      ).rejects.toMatchObject({ status: 502 });
      expectJitteredWaits(sleep, [1_000, 2_000, 4_000]);
      expect(requests.isDone()).toBe(true);
    });

    it('retries a failed connection without logging credentials', async () => {
      const info = jest.spyOn(core, 'info').mockImplementation(() => undefined);
      const requests = nock('https://api.github.com', {
        reqheaders: { authorization: 'token TEST_TOKEN' },
      })
        .get('/repos/owner/repo')
        .replyWithError({ code: 'ECONNRESET', message: 'socket hang up' })
        .get('/repos/owner/repo')
        .reply(200, { id: 1, name: 'repo' });
      const sleep = jest.fn(async () => undefined);
      const client = new GitHubClient(mockToken, { sleep });

      await expect(
        client.octokit.rest.repos.get({ owner: 'owner', repo: 'repo' })
      ).resolves.toMatchObject({ status: 200 });
      expectJitteredWaits(sleep, [1_000]);
      expect(requests.isDone()).toBe(true);
      const logged = info.mock.calls.map(([message]) => message).join('\n');
      expect(logged).toMatch(/^GitHub read retry 1\/3 in \d+ ms after network/);
      expect(logged).not.toContain(mockToken);
      expect(logged).not.toContain('socket hang up');
      expect(logged).not.toContain('/repos/');
      info.mockRestore();
    });

    it.each([
      ['a rate limit without an announced wait', 429, {}],
      [
        'a secondary rate limit without an announced wait',
        403,
        { 'X-RateLimit-Remaining': '12' },
      ],
      ['a rate limit with a blank Retry-After', 429, { 'Retry-After': ' ' }],
      [
        'a rate limit with a negative Retry-After',
        429,
        { 'Retry-After': '-5' },
      ],
      [
        'an exhausted rate limit whose reset is past the read window',
        403,
        {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.ceil(Date.now() / 1_000) + 3_600),
        },
      ],
      [
        'an exhausted rate limit with a blank reset',
        403,
        { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '' },
      ],
      ['an authentication refusal', 401, {}],
      ['a permission refusal', 403, {}],
      ['a missing resource', 404, {}],
      ['a request timeout', 408, {}],
      ['a validation failure', 422, {}],
    ])(
      'refuses %s at once',
      async (_name, status, headers: Record<string, string>) => {
        const request = nock('https://api.github.com')
          .get('/repos/owner/repo')
          .reply(status, { message: 'secondary rate limit' }, headers);
        const sleep = jest.fn(async () => undefined);
        const client = new GitHubClient(mockToken, { sleep });

        await expect(
          client.octokit.rest.repos.get({ owner: 'owner', repo: 'repo' })
        ).rejects.toMatchObject({ status });
        expect(sleep).not.toHaveBeenCalled();
        expect(request.isDone()).toBe(true);
      }
    );

    it('waits for an exhausted primary rate limit only when its reset fits the read window', async () => {
      const resetAt = Math.ceil(Date.now() / 1_000) + 3;
      const requests = nock('https://api.github.com')
        .get('/repos/owner/repo')
        .reply(
          403,
          { message: 'API rate limit exceeded' },
          {
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(resetAt),
          }
        )
        .get('/repos/owner/repo')
        .reply(200, { id: 1, name: 'repo' });
      const sleep = jest.fn(async () => undefined);
      const client = new GitHubClient(mockToken, { sleep });

      await expect(
        client.octokit.rest.repos.get({ owner: 'owner', repo: 'repo' })
      ).resolves.toMatchObject({ status: 200 });
      const [wait] = waits(sleep);
      expect(wait).toBeGreaterThan(2_000);
      expect(wait).toBeLessThanOrEqual(4_000);
      expect(requests.isDone()).toBe(true);
    });

    it.each<[string, string, string, number, number]>([
      ['the longer primary reset', '2', '0', 6, 6_000],
      ['the longer Retry-After', '7', '0', 2, 7_000],
      ['a fractional reset rounded up', '0', '0', 3.0001, 3_001],
      ['unexhausted primary quota', '2', '12', 3_600, 2_000],
      ['a reset with malformed Retry-After', 'invalid', '0', 3, 3_000],
      ['expired announced boundaries', '0', '0', -1, 0],
    ])(
      'respects %s when both rate-limit headers are present',
      async (_name, retryAfter, remaining, resetSeconds, expectedWait) => {
        const now = Date.parse('2026-11-06T10:00:00Z');
        const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
        const requests = nock('https://api.github.com')
          .get('/repos/owner/repo')
          .reply(
            403,
            { message: 'API rate limit exceeded' },
            {
              'Retry-After': retryAfter,
              'X-RateLimit-Remaining': remaining,
              'X-RateLimit-Reset': String(now / 1_000 + resetSeconds),
            }
          )
          .get('/repos/owner/repo')
          .reply(200, { id: 1, name: 'repo' });
        const sleep = jest.fn(async () => undefined);
        const client = new GitHubClient(mockToken, { sleep });

        try {
          await expect(
            client.octokit.rest.repos.get({ owner: 'owner', repo: 'repo' })
          ).resolves.toMatchObject({ status: 200 });
          if (expectedWait === 0) {
            expectJitteredWaits(sleep, [1_000]);
          } else {
            expect(waits(sleep)).toEqual([expectedWait]);
          }
          expect(requests.isDone()).toBe(true);
        } finally {
          clock.mockRestore();
        }
      }
    );

    it.each<[string, string, string, number, number?]>([
      [
        'IMF-fixdate',
        '2026-11-06T10:00:00Z',
        'Fri, 06 Nov 2026 10:00:03 GMT',
        3_000,
        1,
      ],
      [
        'RFC 850',
        '2026-11-06T10:00:00Z',
        'Friday, 06-Nov-26 10:00:03 GMT',
        3_000,
        1,
      ],
      [
        'asctime in UTC',
        '2026-11-06T10:00:00Z',
        'Fri Nov  6 10:00:03 2026',
        3_000,
        1,
      ],
      [
        'RFC 850 in the current century',
        '2050-01-01T00:00:00Z',
        'Saturday, 01-Jan-50 00:00:03 GMT',
        3_000,
        1,
      ],
      [
        'RFC 850 more than 50 years ahead interpreted in the past',
        '2026-11-06T10:00:00Z',
        'Sunday, 06-Nov-94 08:49:37 GMT',
        0,
      ],
      [
        'an IMF-fixdate leap second',
        '2016-12-31T23:59:57Z',
        'Sat, 31 Dec 2016 23:59:60 GMT',
        3_000,
        1,
      ],
      [
        'an RFC 850 leap second',
        '2016-12-31T23:59:57Z',
        'Saturday, 31-Dec-16 23:59:60 GMT',
        3_000,
        1,
      ],
      [
        'an asctime leap second',
        '2016-12-31T23:59:57Z',
        'Sat Dec 31 23:59:60 2016',
        3_000,
        1,
      ],
      [
        'an RFC 850 leap second just beyond the 50-year cutoff',
        '2026-12-31T23:59:59.500Z',
        'Friday, 31-Dec-76 23:59:60 GMT',
        0,
      ],
    ])(
      'honors %s without shortening the announced wait',
      async (_name, currentTime, retryAfter, expectedWait, resetSeconds) => {
        const now = Date.parse(currentTime);
        const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
        const requests = nock('https://api.github.com')
          .get('/repos/owner/repo')
          .reply(
            429,
            { message: 'rate limit exceeded' },
            {
              'Retry-After': retryAfter,
              ...(resetSeconds === undefined
                ? {}
                : {
                    'X-RateLimit-Remaining': '0',
                    'X-RateLimit-Reset': String(now / 1_000 + resetSeconds),
                  }),
            }
          )
          .get('/repos/owner/repo')
          .reply(200, { id: 1, name: 'repo' });
        const sleep = jest.fn(async () => undefined);
        const client = new GitHubClient(mockToken, { sleep });

        try {
          await expect(
            client.octokit.rest.repos.get({ owner: 'owner', repo: 'repo' })
          ).resolves.toMatchObject({ status: 200 });
          if (expectedWait === 0) {
            expectJitteredWaits(sleep, [1_000]);
          } else {
            expect(waits(sleep)).toEqual([expectedWait]);
          }
          expect(requests.isDone()).toBe(true);
        } finally {
          clock.mockRestore();
        }
      }
    );

    it.each<[string, Record<string, string>]>([
      [
        'a reset outside the window despite a short Retry-After',
        { 'Retry-After': '2', 'X-RateLimit-Reset': '1793959260' },
      ],
      [
        'Retry-After exactly at the window boundary',
        { 'Retry-After': '15', 'X-RateLimit-Reset': '1793959202' },
      ],
      [
        'an overflowing valid Retry-After despite a short reset',
        { 'Retry-After': '9'.repeat(400), 'X-RateLimit-Reset': '1793959202' },
      ],
      [
        'an overflowing valid reset despite a short Retry-After',
        { 'Retry-After': '2', 'X-RateLimit-Reset': '9'.repeat(400) },
      ],
      ['fractional delay seconds', { 'Retry-After': '0.5' }],
      ['exponential delay seconds', { 'Retry-After': '1e0' }],
      ['a non-HTTP date', { 'Retry-After': '2026-11-06T10:00:03Z' }],
      [
        'an invalid calendar date',
        { 'Retry-After': 'Tue, 31 Feb 2026 10:00:03 GMT' },
      ],
      [
        'a mismatched weekday',
        { 'Retry-After': 'Sat, 06 Nov 2026 10:00:03 GMT' },
      ],
      [
        'a non-GMT zone',
        { 'Retry-After': 'Fri, 06 Nov 2026 10:00:03 UTC' },
      ],
      [
        'an invalid leap-second time',
        { 'Retry-After': 'Fri, 06 Nov 2026 10:00:60 GMT' },
      ],
      [
        'an RFC 850 date no more than 50 years ahead',
        {
          'Retry-After': 'Friday, 06-Nov-76 10:00:00 GMT',
          'X-RateLimit-Reset': '1793959202',
        },
      ],
    ])('refuses %s without a second read', async (_name, headers) => {
      const clock = jest
        .spyOn(Date, 'now')
        .mockReturnValue(Date.parse('2026-11-06T10:00:00Z'));
      const request = nock('https://api.github.com')
        .get('/repos/owner/repo')
        .reply(
          429,
          { message: 'rate limit exceeded' },
          {
            'X-RateLimit-Remaining': '0',
            ...headers,
          }
        );
      const sleep = jest.fn(async () => undefined);
      const client = new GitHubClient(mockToken, { sleep });

      try {
        await expect(
          client.octokit.rest.repos.get({ owner: 'owner', repo: 'repo' })
        ).rejects.toMatchObject({ status: 429 });
        expect(sleep).not.toHaveBeenCalled();
        expect(request.isDone()).toBe(true);
      } finally {
        clock.mockRestore();
      }
    });

    it('honors a Retry-After given as an HTTP date', async () => {
      const retryAt = new Date(Date.now() + 3_000).toUTCString();
      const requests = nock('https://api.github.com')
        .get('/repos/owner/repo')
        .reply(
          503,
          { message: 'Service unavailable' },
          { 'Retry-After': retryAt }
        )
        .get('/repos/owner/repo')
        .reply(200, { id: 1, name: 'repo' });
      const sleep = jest.fn(async () => undefined);
      const client = new GitHubClient(mockToken, { sleep });

      await expect(
        client.octokit.rest.repos.get({ owner: 'owner', repo: 'repo' })
      ).resolves.toMatchObject({ status: 200 });
      const [wait] = waits(sleep);
      // HTTP dates have whole-second precision.
      expect(wait).toBeGreaterThan(1_000);
      expect(wait).toBeLessThanOrEqual(3_000);
      expect(requests.isDone()).toBe(true);
    });

    it('keeps every retry of one read inside the shared read window', async () => {
      let now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
      const requests = nock('https://api.github.com')
        .get('/repos/owner/repo')
        .times(3)
        .reply(503, { message: 'Service unavailable' }, { 'Retry-After': '6' });
      const sleep = jest.fn(async (delayMs: number) => {
        now += delayMs;
      });
      const client = new GitHubClient(mockToken, { sleep });

      try {
        await expect(
          client.octokit.rest.repos.get({ owner: 'owner', repo: 'repo' })
        ).rejects.toMatchObject({ status: 503 });
      } finally {
        clock.mockRestore();
      }
      // Two 6 s waits fit the 15 s window, a third would end after it.
      expect(waits(sleep)).toEqual([6_000, 6_000]);
      expect(requests.isDone()).toBe(true);
    });

    it('ignores rate-limit window headers on ordinary server failures', async () => {
      const resetAt = Math.floor(Date.now() / 1_000) + 3_600;
      const requests = nock('https://api.github.com', {
        reqheaders: { authorization: 'token TEST_TOKEN' },
      })
        .get('/repos/owner/repo')
        .reply(
          503,
          { message: 'Service unavailable' },
          {
            'X-RateLimit-Remaining': '4000',
            'X-RateLimit-Reset': String(resetAt),
          }
        )
        .get('/repos/owner/repo')
        .reply(200, { id: 1, name: 'repo' });
      const sleep = jest.fn(async () => undefined);
      const client = new GitHubClient(mockToken, { sleep });

      await expect(
        client.octokit.rest.repos.get({ owner: 'owner', repo: 'repo' })
      ).resolves.toMatchObject({ status: 200 });
      expectJitteredWaits(sleep, [1_000]);
      expect(requests.isDone()).toBe(true);
    });

    it('honors a bounded Retry-After before retrying a rate limit', async () => {
      const requests = nock('https://api.github.com', {
        reqheaders: { authorization: 'token TEST_TOKEN' },
      })
        .get('/repos/owner/repo')
        .reply(429, { message: 'rate limit exceeded' }, { 'Retry-After': '2' })
        .get('/repos/owner/repo')
        .reply(200, { id: 1, name: 'repo' });
      const sleep = jest.fn(async () => undefined);
      const client = new GitHubClient(mockToken, { sleep });

      await expect(
        client.octokit.rest.repos.get({ owner: 'owner', repo: 'repo' })
      ).resolves.toMatchObject({ status: 200 });
      expect(sleep).toHaveBeenCalledWith(2_000);
      expect(requests.isDone()).toBe(true);
    });

    it('does not wait or retry beyond the bounded server delay', async () => {
      const request = nock('https://api.github.com', {
        reqheaders: { authorization: 'token TEST_TOKEN' },
      })
        .get('/repos/owner/repo')
        .reply(
          429,
          { message: 'rate limit exceeded' },
          { 'Retry-After': '60' }
        );
      const sleep = jest.fn(async () => undefined);
      const client = new GitHubClient(mockToken, { sleep });

      await expect(
        client.octokit.rest.repos.get({ owner: 'owner', repo: 'repo' })
      ).rejects.toMatchObject({ status: 429 });
      expect(sleep).not.toHaveBeenCalled();
      expect(request.isDone()).toBe(true);
    });

    it.each([403, 429, 503])(
      'does not retry GitHub writes after %d',
      async (status) => {
        const request = nock('https://api.github.com', {
          reqheaders: { authorization: 'token TEST_TOKEN' },
        })
          .post('/repos/owner/repo/issues/1/comments', { body: 'hello' })
          .reply(status, { message: 'Request failed' }, { 'Retry-After': '2' });
        const sleep = jest.fn(async () => undefined);
        const client = new GitHubClient(mockToken, { sleep });

        await expect(
          client.octokit.rest.issues.createComment({
            owner: 'owner',
            repo: 'repo',
            issue_number: 1,
            body: 'hello',
          })
        ).rejects.toMatchObject({ status });
        expect(sleep).not.toHaveBeenCalled();
        expect(request.isDone()).toBe(true);
      }
    );
  });
});
