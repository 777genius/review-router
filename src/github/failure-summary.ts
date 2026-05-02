import { GitHubClient } from './client';
import { CommentPoster } from './comment-poster';
import { logger } from '../utils/logger';

const REVIEW_ROUTER_BOT_MARKER = '<!-- review-router-bot -->';
const LEGACY_BOT_MARKERS = [
  '<!-- ai-robot-review-bot -->',
  '<!-- multi-provider-code-review-bot -->',
];
const FAILURE_SUMMARY_TEXT = 'Review failed before comments could be completed';

type FailureKind =
  | 'codex-oauth'
  | 'codex-api'
  | 'codex-cli'
  | 'no-providers'
  | 'timeout'
  | 'rate-limit'
  | 'configuration'
  | 'unknown';

export function formatReviewFailureSummary(error: Error, prNumber?: number): string {
  const kind = classifyFailure(error);
  const safeMessage = sanitizeFailureMessage(error.message || String(error));
  const details = failureDetails(kind);

  return [
    '# ReviewRouter',
    '',
    '🔴 **Review failed before comments could be completed.**',
    '',
    prNumber ? `PR: #${prNumber}` : undefined,
    '',
    '## What failed',
    '',
    details.summary,
    '',
    '## Error',
    '',
    '```text',
    safeMessage,
    '```',
    '',
    '## How to fix',
    '',
    ...details.steps.map(step => `- ${step}`),
  ].filter(line => line !== undefined).join('\n');
}

export async function postReviewFailureSummary(
  error: Error,
  token: string | undefined,
  prNumber: number | undefined
): Promise<void> {
  if (!token || !prNumber || prNumber <= 0) return;

  try {
    const client = new GitHubClient(token);
    const poster = new CommentPoster(client, false);
    await poster.postSummary(prNumber, formatReviewFailureSummary(error, prNumber), true);
  } catch (postError) {
    logger.warn('Failed to post review failure summary', postError as Error);
  }
}

export async function clearReviewFailureSummaries(
  token: string | undefined,
  prNumber: number | undefined
): Promise<void> {
  if (!token || !prNumber || prNumber <= 0) return;

  try {
    const client = new GitHubClient(token);
    await clearReviewFailureSummariesForClient(client, prNumber);
  } catch (clearError) {
    logger.warn('Failed to clear stale review failure summaries', clearError as Error);
  }
}

export async function clearReviewFailureSummariesForClient(
  client: GitHubClient,
  prNumber: number
): Promise<void> {
  const { octokit, owner, repo } = client;
  const comments = await listIssueComments(client, prNumber);
  const staleFailureComments = comments.filter(comment =>
    isReviewFailureSummary(comment.body)
  );

  for (const comment of staleFailureComments) {
    await octokit.rest.issues.deleteComment({
      owner,
      repo,
      comment_id: comment.id,
    });
  }

  if (staleFailureComments.length > 0) {
    logger.info(
      `Deleted ${staleFailureComments.length} stale ReviewRouter failure summary comment(s)`
    );
  }
}

function classifyFailure(error: Error): FailureKind {
  const message = `${error.name || ''} ${error.message || ''}`.toLowerCase();

  if (message.includes('configuration error') || message.includes('validation')) {
    return 'configuration';
  }
  if (
    message.includes('codex') &&
    (message.includes('401') ||
      message.includes('unauthorized') ||
      message.includes('access token') ||
      message.includes('refresh token') ||
      message.includes('reseed auth.json'))
  ) {
    return 'codex-oauth';
  }
  if (
    message.includes('codex_auth_json') ||
    message.includes('auth.json') ||
    message.includes('refresh_token') ||
    message.includes('auth_mode') ||
    message.includes('chatgpt')
  ) {
    return 'codex-oauth';
  }
  if (message.includes('openai_api_key') || message.includes('api key')) {
    return 'codex-api';
  }
  if (message.includes('no healthy providers')) {
    return 'no-providers';
  }
  if (message.includes('codex') || message.includes('enoent') || message.includes('command not found')) {
    return 'codex-cli';
  }
  if (message.includes('timeout') || message.includes('timed out')) {
    return 'timeout';
  }
  if (message.includes('rate limit') || message.includes('rate-limit')) {
    return 'rate-limit';
  }

  return 'unknown';
}

function failureDetails(kind: FailureKind): { summary: string; steps: string[] } {
  switch (kind) {
    case 'codex-oauth':
      return {
        summary: 'Codex OAuth authentication is missing, invalid, stale, or expired.',
        steps: [
          'Verify `CODEX_AUTH_JSON` exists in repository or selected organization Actions secrets.',
          'Verify the secret contains `auth_mode=chatgpt` and a refresh token from a trusted local Codex login.',
          'Reseed `auth.json`: run `codex login` on a trusted machine, then rerun the installer or update `CODEX_AUTH_JSON`.',
          'For automatic refresh without reseeding, use a trusted self-hosted runner with persistent `CODEX_HOME`; GitHub-hosted runners are ephemeral.',
        ],
      };
    case 'codex-api':
      return {
        summary: 'Codex API-key mode is configured, but the OpenAI API key is missing or invalid.',
        steps: [
          'Verify `OPENAI_API_KEY` exists in repository or selected organization Actions secrets.',
          'Verify the key has access to the configured `REVIEW_CODEX_MODEL`.',
          'If you intended to use ChatGPT subscription OAuth, reinstall with `REVIEW_ROUTER_AUTH=codex`.',
        ],
      };
    case 'codex-cli':
      return {
        summary: 'The Codex CLI could not run successfully in CI.',
        steps: [
          'Verify the workflow installs `@openai/codex` before running ReviewRouter.',
          'Check the ReviewRouter run logs for the Codex CLI error. Usage-limit errors usually need a later rerun or a lower-cost model.',
          'If this is a model issue, verify `REVIEW_CODEX_MODEL` is a current supported Codex model.',
        ],
      };
    case 'no-providers':
      return {
        summary: 'No configured review provider passed the health check.',
        steps: [
          'Check provider credentials and model variables.',
          'For Codex OAuth, verify `CODEX_AUTH_JSON` is present and the account has available Codex usage.',
          'For OpenRouter or OpenAI API mode, verify the API key secret is available to this repository.',
        ],
      };
    case 'timeout':
      return {
        summary: 'The review timed out before a complete result was produced.',
        steps: [
          'Reduce PR size or keep smart diff compaction enabled.',
          'Increase `RUN_TIMEOUT_SECONDS` only after confirming the provider is healthy.',
          'Check whether the provider stderr shows repeated retries or network failures.',
        ],
      };
    case 'rate-limit':
      return {
        summary: 'The review hit a provider or GitHub API rate limit.',
        steps: [
          'Re-run the workflow after the rate limit resets.',
          'Reduce provider count or run only one Codex model for this repository.',
          'For API-key mode, check provider quota and billing limits.',
        ],
      };
    case 'configuration':
      return {
        summary: 'ReviewRouter configuration is invalid.',
        steps: [
          'Check the workflow inputs in `.github/workflows/review-router.yml`.',
          'Verify required values such as `GITHUB_TOKEN`, `PR_NUMBER`, model variables, and provider credentials.',
          'Re-run the installer if the workflow was manually edited.',
        ],
      };
    default:
      return {
        summary: 'The review failed with an unexpected error.',
        steps: [
          'Open the failed workflow run and inspect the `Run ReviewRouter` step.',
          'Verify credentials, model variables, and repository permissions.',
          'If the error looks internal, file an issue with the sanitized workflow log.',
        ],
      };
  }
}

async function listIssueComments(
  client: GitHubClient,
  prNumber: number
): Promise<Array<{ id: number; body?: string | null }>> {
  const { octokit, owner, repo } = client;
  const params = {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  };

  if (typeof octokit.paginate === 'function') {
    return octokit.paginate(octokit.rest.issues.listComments, params);
  }

  const response = await octokit.rest.issues.listComments(params);
  return response.data;
}

function isReviewFailureSummary(body?: string | null): boolean {
  if (!body) return false;
  return hasReviewRouterBotMarker(body) && body.includes(FAILURE_SUMMARY_TEXT);
}

function hasReviewRouterBotMarker(body: string): boolean {
  return body.includes(REVIEW_ROUTER_BOT_MARKER)
    || LEGACY_BOT_MARKERS.some(marker => body.includes(marker));
}

function sanitizeFailureMessage(message: string): string {
  const redacted = message
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-***')
    .replace(/gh[pousr]_[A-Za-z0-9_]{16,}/g, 'gh*-***')
    .replace(/github_pat_[A-Za-z0-9_]+/g, 'github_pat_***')
    .replace(/(access_token["'\s:=]+)[^"',\s}]+/gi, '$1***')
    .replace(/(refresh_token["'\s:=]+)[^"',\s}]+/gi, '$1***')
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1***')
    .replace(/(OPENAI_API_KEY["'\s:=]+)[^"',\s}]+/gi, '$1***')
    .replace(/(OPENROUTER_API_KEY["'\s:=]+)[^"',\s}]+/gi, '$1***');

  return redacted.length > 1200 ? `${redacted.slice(0, 1200)}\n... truncated ...` : redacted;
}
