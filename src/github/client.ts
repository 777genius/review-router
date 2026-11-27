import * as core from '../actions/core';
import * as fs from 'fs';
import { Octokit } from '@octokit/rest';
import { GitHubRateLimitTracker } from './rate-limit';
import { GitHubTokenProvider } from './token-provider';

export class GitHubClient {
  public readonly octokit: Octokit;
  public readonly owner: string;
  public readonly repo: string;
  private readonly rateLimitTracker = new GitHubRateLimitTracker();

  constructor(
    token: string,
    options: {
      readonly repository?: string;
      readonly tokenProvider?: GitHubTokenProvider;
      readonly sleep?: (delayMs: number) => Promise<void>;
    } = {}
  ) {
    this.octokit = createResilientOctokit(
      token,
      options.tokenProvider,
      options.sleep
    );

    // Prefer the explicit Actions env var, then fall back to the event payload.
    const repoEnv =
      options.repository ||
      process.env.GITHUB_REPOSITORY ||
      getRepositoryFromEventPayload() ||
      '/';

    const [owner, repo] = repoEnv.split('/');
    this.owner = owner || '';
    this.repo = repo || '';

    core.debug(`GitHub client initialized for ${this.owner}/${this.repo}`);
  }

  /**
   * Get current GitHub API rate limit status
   */
  getRateLimitStatus() {
    return this.rateLimitTracker.getStatus();
  }

  /**
   * Check if we're approaching rate limit and log warning
   */
  checkRateLimitStatus(): void {
    if (this.rateLimitTracker.isApproachingLimit()) {
      const status = this.rateLimitTracker.getStatus();
      core.warning(
        `Approaching GitHub API rate limit: ${status?.remaining}/${status?.limit} remaining`
      );
    }
  }

  /**
   * Implement exponential backoff when approaching rate limit
   * Returns delay in milliseconds to wait before making next API call
   */
  private calculateBackoffDelay(): number {
    const status = this.rateLimitTracker.getStatus();
    if (!status) return 0;

    const percentRemaining = (status.remaining / status.limit) * 100;

    // No delay if plenty of requests remaining (>25%)
    if (percentRemaining > 25) {
      return 0;
    }

    // Progressive backoff as we approach limit:
    // 25% remaining: 100ms delay
    // 10% remaining: 500ms delay
    // 5% remaining: 1000ms delay
    // 1% remaining: 2000ms delay
    if (percentRemaining > 10) {
      return 100;
    } else if (percentRemaining > 5) {
      return 500;
    } else if (percentRemaining > 1) {
      return 1000;
    } else {
      return 2000;
    }
  }

  /**
   * Throttle requests when approaching rate limit
   */
  private async throttleIfNeeded(): Promise<void> {
    const delay = this.calculateBackoffDelay();
    if (delay > 0) {
      const status = this.rateLimitTracker.getStatus();
      core.debug(
        `Throttling GitHub API request (${delay}ms delay, ${status?.remaining} requests remaining)`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /**
   * Wait for rate limit to reset if exceeded
   */
  private async handleRateLimit(): Promise<void> {
    if (this.rateLimitTracker.isExceeded()) {
      await this.rateLimitTracker.waitForReset();
    }
  }

  /**
   * Fetch file content from a specific ref (commit SHA, branch, or tag)
   * @param filePath - Path to the file in the repository
   * @param ref - Git ref (commit SHA, branch name, or tag)
   * @returns File content as string, or null if file doesn't exist/inaccessible
   */
  async getFileContent(filePath: string, ref: string): Promise<string | null> {
    // Wait if rate limit is exceeded
    await this.handleRateLimit();

    // Throttle requests if approaching limit (exponential backoff)
    await this.throttleIfNeeded();

    try {
      const response = await this.octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: filePath,
        ref,
      });

      // Update rate limit tracker from response headers
      // Validate headers structure before passing to rate limit tracker
      if (
        response.headers &&
        typeof response.headers === 'object' &&
        !Array.isArray(response.headers)
      ) {
        // Convert headers to Record<string, string | undefined> for type safety
        // Octokit headers are typed as { [header: string]: string | number | undefined }
        const headers: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          headers[key] = value !== undefined ? String(value) : undefined;
        }
        this.rateLimitTracker.updateFromHeaders(headers);
      }

      // Check if the response is a file (not a directory)
      if ('content' in response.data && !Array.isArray(response.data)) {
        // Handle empty content or encoding "none" for large files
        if (
          !response.data.content ||
          response.data.content === '' ||
          response.data.encoding === 'none'
        ) {
          // File is empty or too large
          core.debug(`File content empty or encoding 'none': ${filePath}`);
          return '';
        }
        // Content is base64 encoded
        return Buffer.from(response.data.content, 'base64').toString('utf-8');
      }

      return null;
    } catch (error) {
      const err = error as { status?: number };
      if (err.status === 404) {
        // File not found - this is expected for new files in PRs
        core.debug(`File not found: ${filePath} at ref ${ref}`);
        return null;
      }
      // Log other errors but don't throw - gracefully degrade
      core.warning(
        `Failed to fetch file content for ${filePath}: ${(error as Error).message}`
      );
      return null;
    }
  }
}

function createResilientOctokit(
  initialToken: string,
  tokenProvider?: GitHubTokenProvider,
  sleep: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs))
): Octokit {
  const octokit = new Octokit();
  octokit.hook.wrap('request', async (request, options) => {
    const requestWithToken = (token: string) => {
      options.headers.authorization = tokenProvider
        ? `Bearer ${token}`
        : `token ${token}`;
      return request(options);
    };
    let token = tokenProvider ? await tokenProvider.getToken() : initialToken;
    let authRefreshAttempted = false;
    let retries = 0;
    const deadline = Date.now() + GITHUB_READ_RETRY_WINDOW_MS;

    for (;;) {
      try {
        return await requestWithToken(token);
      } catch (error) {
        const status = getHttpStatus(error);
        if (status === 401 && tokenProvider && !authRefreshAttempted) {
          token = await tokenProvider.refreshToken();
          authRefreshAttempted = true;
          continue;
        }
        if (!isSafeRetryMethod(options.method)) throw error;
        const failureClass = transientGitHubReadFailureClass(error);
        if (!failureClass) throw error;
        // A retry only reads again: the caller still judges the answer, and
        // an exhausted or refused retry surfaces the last attempt's error.
        const waitMs = transientGitHubReadWaitMs(
          error,
          failureClass,
          GITHUB_READ_RETRY_DELAYS_MS[retries],
          deadline - Date.now()
        );
        if (waitMs === undefined || options.request?.signal?.aborted) {
          core.info(
            `GitHub read gave up after ${retries} of ${GITHUB_READ_RETRY_DELAYS_MS.length} retries: ${describeFailure(failureClass, status)}`
          );
          // A cancelled or timed-out read keeps its abort reason, so callers
          // still tell cancellation apart from a GitHub failure.
          options.request?.signal?.throwIfAborted();
          throw error;
        }
        retries += 1;
        core.info(
          `GitHub read retry ${retries}/${GITHUB_READ_RETRY_DELAYS_MS.length} in ${waitMs} ms after ${describeFailure(failureClass, status)}`
        );
        await sleep(waitMs);
      }
    }
  });
  return octokit;
}

function getHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Waits before each retry of a transient GitHub read. The transient classes,
 * this schedule, the jitter and the 15 s window follow the SaaS revision read
 * (review-router-ai plan 86), so both sides of a run ride out the same short
 * GitHub outage and still refuse a longer one. Here the window bounds the
 * waits; each attempt is bounded by the caller's own request timeout.
 */
const GITHUB_READ_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
  1_000, 2_000, 4_000,
]);
// All attempts of one read share this window. A wait that does not end
// inside it is not taken, so the read fails with its last error instead.
const GITHUB_READ_RETRY_WINDOW_MS = 15_000;
// GitHub: a rate limit answer without an announced wait still needs at least
// a minute. That never fits the window, so such a read is refused at once.
const UNANNOUNCED_RATE_LIMIT_WAIT_MS = 60_000;
const TRANSIENT_GITHUB_NETWORK_ERROR_CODES = [
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
] as const;

function isSafeRetryMethod(method: unknown): boolean {
  return (
    typeof method === 'string' &&
    ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
  );
}

type TransientGitHubReadFailure = 'server_error' | 'network' | 'rate_limited';

/**
 * True when a failed GitHub read means "try later" rather than a refusal:
 * everything a read retries, plus a 408 and a 403 whose message names a rate
 * limit. Those two are not read again within one read (GitHub asks for a
 * minute or more), but they are still temporary.
 */
export function isTemporaryGitHubReadFailure(error: unknown): boolean {
  if (transientGitHubReadFailureClass(error)) return true;
  const status = getHttpStatus(error);
  if (status === 408) return true;
  const message = error instanceof Error ? error.message : undefined;
  return (
    status === 403 &&
    typeof message === 'string' &&
    /rate limit|abuse detection/i.test(message)
  );
}

// Only 5xx, network failures, 429 and a 403 that announces a rate limit are
// read again. 401 (the token refresh above), 404, every other 4xx and any
// other error reach the caller unchanged.
function transientGitHubReadFailureClass(
  error: unknown
): TransientGitHubReadFailure | undefined {
  const status = getHttpStatus(error);
  if (status !== undefined && status >= 500 && status <= 599) {
    // Octokit reports a failed fetch (reset, refused, DNS) as 500 without a
    // response.
    return responseHeaders(error) === undefined ? 'network' : 'server_error';
  }
  if (status === 429) return 'rate_limited';
  if (status === 403) {
    const headers = responseHeaders(error) ?? {};
    return readHeader(headers, 'retry-after') !== undefined ||
      readHeader(headers, 'x-ratelimit-remaining') === '0'
      ? 'rate_limited'
      : undefined;
  }
  return status === undefined && hasTransientNetworkErrorCode(error)
    ? 'network'
    : undefined;
}

function transientGitHubReadWaitMs(
  error: unknown,
  failureClass: TransientGitHubReadFailure,
  delayMs: number | undefined,
  remainingMs: number
): number | undefined {
  if (delayMs === undefined) return undefined;
  const headers = responseHeaders(error) ?? {};
  // Spread concurrent readers, never wait less than GitHub asks for, and give
  // up when that wait does not fit the window.
  const waitMs = Math.max(
    Math.round(delayMs * (0.5 + Math.random() / 2)),
    failureClass === 'rate_limited'
      ? rateLimitWaitMs(headers)
      : (retryAfterMs(headers) ?? 0)
  );
  return waitMs < remainingMs ? waitMs : undefined;
}

function rateLimitWaitMs(headers: object): number {
  const now = Date.now();
  const retryAfter = retryAfterMs(headers, now);
  if (readHeader(headers, 'x-ratelimit-remaining') === '0') {
    const reset = numericHeader(headers, 'x-ratelimit-reset');
    if (reset !== undefined) {
      // Exhausted primary quota must respect both announced boundaries.
      return Math.max(0, retryAfter ?? 0, Math.ceil(reset * 1_000 - now));
    }
  }
  return retryAfter ?? UNANNOUNCED_RATE_LIMIT_WAIT_MS;
}

// Retry-After is either integer delay seconds or an HTTP date.
function retryAfterMs(headers: object, now = Date.now()): number | undefined {
  const value = readHeader(headers, 'retry-after')?.trim();
  if (!value) return undefined;
  // An excessive but valid delay must exceed the window, not become absent.
  if (/^\d+$/u.test(value)) return Number(value) * 1_000;
  const retryAt = httpDateTimestamp(value, now);
  return retryAt === undefined ? undefined : Math.max(0, retryAt - now);
}

/** Accept all three HTTP-date forms (RFC 9110, section 5.6.7). */
function httpDateTimestamp(value: string, now: number): number | undefined {
  // JavaScript dates omit leap seconds: validate :59 before advancing to :60.
  const leapSecond = / 23:59:60(?: GMT| \d{4})$/u.test(value);
  let normalized = leapSecond ? value.replace('23:59:60', '23:59:59') : value;
  const obsolete =
    /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/u.exec(
      normalized
    );
  if (obsolete) {
    const futureLimit = new Date(now);
    futureLimit.setUTCFullYear(futureLimit.getUTCFullYear() + 50);
    const year =
      Math.floor(futureLimit.getUTCFullYear() / 100) * 100 +
      Number(obsolete[4]);
    normalized = `${obsolete[1].slice(0, 3)}, ${obsolete[2]} ${obsolete[3]} ${year} ${obsolete[5]} GMT`;
    if (
      Date.parse(normalized) + (leapSecond ? 1_000 : 0) > futureLimit.getTime()
    ) {
      normalized = normalized.replace(` ${year} `, ` ${year - 100} `);
    }
  } else {
    const asctime =
      /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ( \d|\d{2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/u.exec(
        normalized
      );
    if (asctime) {
      normalized = `${asctime[1]}, ${asctime[3].trim().padStart(2, '0')} ${asctime[2]} ${asctime[5]} ${asctime[4]} GMT`;
    }
  }
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toUTCString() === normalized
    ? timestamp + (leapSecond ? 1_000 : 0)
    : undefined;
}

// A blank, negative or otherwise malformed value announces nothing.
function numericHeader(headers: object, name: string): number | undefined {
  const value = readHeader(headers, name)?.trim();
  return value && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : undefined;
}

function responseHeaders(error: unknown): object | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const response = readOwnDataProperty(error, 'response');
  if (!response || typeof response !== 'object') return undefined;
  const headers = readOwnDataProperty(response, 'headers');
  return headers && typeof headers === 'object' ? headers : {};
}

// Logs carry only the failure class and status, never a URL, header or body.
function describeFailure(
  failureClass: TransientGitHubReadFailure,
  status: number | undefined
): string {
  return status === undefined ? failureClass : `${failureClass} ${status}`;
}

function readHeader(headers: object, expectedName: string): string | undefined {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== expectedName) continue;
    const value = readOwnDataProperty(headers, key);
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
  }
  return undefined;
}

function hasTransientNetworkErrorCode(
  error: unknown,
  visited = new Set<object>(),
  depth = 0
): boolean {
  if (!error || typeof error !== 'object' || depth > 4 || visited.has(error)) {
    return false;
  }
  visited.add(error);
  const code = readOwnDataProperty(error, 'code');
  if (
    typeof code === 'string' &&
    TRANSIENT_GITHUB_NETWORK_ERROR_CODES.some(
      (transientCode) => transientCode === code
    )
  ) {
    return true;
  }
  const cause = readOwnDataProperty(error, 'cause');
  if (hasTransientNetworkErrorCode(cause, visited, depth + 1)) return true;
  const errors = readOwnDataProperty(error, 'errors');
  return (
    Array.isArray(errors) &&
    errors.some((nested) =>
      hasTransientNetworkErrorCode(nested, visited, depth + 1)
    )
  );
}

function readOwnDataProperty(value: object, property: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function getRepositoryFromEventPayload(): string | undefined {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    return undefined;
  }

  try {
    const payload = JSON.parse(fs.readFileSync(eventPath, 'utf8')) as {
      repository?: {
        full_name?: string;
        name?: string;
        owner?: {
          login?: string;
          name?: string;
        };
      };
      organization?: {
        login?: string;
      };
    };

    if (payload.repository?.full_name) {
      return payload.repository.full_name;
    }

    const owner =
      payload.repository?.owner?.login ||
      payload.repository?.owner?.name ||
      payload.organization?.login;
    if (owner && payload.repository?.name) {
      return `${owner}/${payload.repository.name}`;
    }
  } catch {
    return undefined;
  }

  return undefined;
}
