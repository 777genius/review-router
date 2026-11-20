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

    it('does not retry non-idempotent GitHub writes', async () => {
      const request = nock('https://api.github.com', {
        reqheaders: { authorization: 'token TEST_TOKEN' },
      })
        .post('/repos/owner/repo/issues/1/comments', { body: 'hello' })
        .reply(503, { message: 'Service unavailable' });
      const sleep = jest.fn(async () => undefined);
      const client = new GitHubClient(mockToken, { sleep });

      await expect(
        client.octokit.rest.issues.createComment({
          owner: 'owner',
          repo: 'repo',
          issue_number: 1,
          body: 'hello',
        })
      ).rejects.toMatchObject({ status: 503 });
      expect(sleep).not.toHaveBeenCalled();
      expect(request.isDone()).toBe(true);
    });
  });
});
