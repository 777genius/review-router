import { GitHubClient } from './client';
import { CommentPoster } from './comment-poster';
import { logger } from '../utils/logger';
import {
  normalizeReviewError,
  sanitizeErrorMessage,
} from '../errors/review-router-error';

const REVIEW_ROUTER_BOT_MARKER = '<!-- review-router-bot -->';
const LEGACY_BOT_MARKERS = [
  '<!-- ai-robot-review-bot -->',
  '<!-- multi-provider-code-review-bot -->',
];
const FAILURE_SUMMARY_TEXT = 'Review failed before comments could be completed';

export function formatReviewFailureSummary(error: Error, prNumber?: number): string {
  const normalized = normalizeReviewError(error);
  const safeDetails = sanitizeErrorMessage(
    normalized.stack || normalized.safeMessage || normalized.message
  );

  return [
    '# ReviewRouter',
    '',
    '🔴 **Review failed before comments could be completed.**',
    '',
    prNumber ? `PR: #${prNumber}` : undefined,
    '',
    '## What failed',
    '',
    normalized.summary,
    '',
    '## Why it matters',
    '',
    normalized.whyItMatters,
    '',
    '## How to fix',
    '',
    ...normalized.nextSteps.map(step => `- ${step}`),
    '',
    '<details>',
    '<summary>Technical details</summary>',
    '',
    '```text',
    `Code: ${normalized.code}`,
    `Category: ${normalized.category}`,
    `Retryable: ${normalized.isRetryable ? 'yes' : 'no'}`,
    `User action required: ${normalized.isUserActionable ? 'yes' : 'no'}`,
    '',
    safeDetails,
    '```',
    '',
    '</details>',
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
