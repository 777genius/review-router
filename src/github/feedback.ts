import { InlineComment } from '../types';
import { GitHubClient } from './client';
import { logger } from '../utils/logger';
import { ProviderWeightTracker } from '../learning/provider-weights';
import {
  extractInlineFingerprint,
  fingerprintFromInlineComment,
  isAiRobotInlineComment,
  signatureFromInlineComment,
} from './comment-fingerprint';

export interface ReviewCommentState {
  suppressed: Set<string>;
  alreadyPosted: Set<string>;
}

export class FeedbackFilter {
  constructor(
    private readonly client: GitHubClient,
    private readonly providerWeightTracker?: ProviderWeightTracker
  ) {}

  async loadSuppressed(prNumber: number): Promise<Set<string>> {
    return (await this.loadReviewCommentState(prNumber)).suppressed;
  }

  async loadReviewCommentState(prNumber: number): Promise<ReviewCommentState> {
    const { octokit, owner, repo } = this.client;
    const suppressed = new Set<string>();
    const alreadyPosted = new Set<string>();

    try {
      const comments = await octokit.paginate(
        octokit.rest.pulls.listReviewComments,
        {
          owner,
          repo,
          pull_number: prNumber,
          per_page: 100,
        }
      );

      for (const comment of comments) {
        const line = comment.line ?? comment.original_line;
        const body = comment.body || '';
        const signature = this.signatureFromComment(comment.path, line, body);
        const marker = extractInlineFingerprint(body);

        if (isAiRobotInlineComment(body)) {
          alreadyPosted.add(signature);
          if (marker) alreadyPosted.add(marker);
        }

        try {
          const reactions =
            await octokit.rest.reactions.listForPullRequestReviewComment({
              owner,
              repo,
              comment_id: comment.id,
              per_page: 100,
            });
          const hasThumbsDown = reactions.data.some((r) => r.content === '-1');
          if (hasThumbsDown) {
            suppressed.add(signature);
            if (marker) suppressed.add(marker);

            // Record negative feedback if weight tracker available
            if (this.providerWeightTracker) {
              const providerMatch = comment.body?.match(
                /\*\*Provider:\*\* `([^`]+)`/
              );
              const provider = providerMatch?.[1];
              if (provider) {
                await this.providerWeightTracker.recordFeedback(provider, '👎');
              }
            }
          }
        } catch (error) {
          logger.warn(
            `Failed to load reactions for comment ${comment.id}`,
            error as Error
          );
        }
      }
    } catch (error) {
      logger.warn(
        'Failed to load review comments for feedback filter',
        error as Error
      );
    }

    return { suppressed, alreadyPosted };
  }

  shouldPost(
    comment: InlineComment,
    state: Set<string> | ReviewCommentState
  ): boolean {
    const signature = this.signatureFromComment(
      comment.path,
      comment.line,
      comment.body
    );
    const fingerprint = fingerprintFromInlineComment(
      comment.path,
      comment.line,
      comment.body
    );

    if (state instanceof Set) {
      return !state.has(signature) && !state.has(fingerprint);
    }

    return (
      !state.suppressed.has(signature) &&
      !state.suppressed.has(fingerprint) &&
      !state.alreadyPosted.has(signature) &&
      !state.alreadyPosted.has(fingerprint)
    );
  }

  private signatureFromComment(
    path: string | undefined,
    line: number | null | undefined,
    body: string
  ): string {
    return signatureFromInlineComment(path, line, body);
  }
}
