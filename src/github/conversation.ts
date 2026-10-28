import { createHash } from 'crypto';
import type {
  ConversationPort,
  ConversationSource,
} from '../control-plane/conversations';
import type { GitHubClient } from './client';
import type { ReviewCommentEventPayload } from './discussion';
import { logger } from '../utils/logger';

/** The managed lane deliberately does not inspect reply gates or run a local model. */
export function conversationSource(
  payload: ReviewCommentEventPayload
): ConversationSource | null {
  const comment = payload.comment;
  const action = payload.action;
  const pullRequestNumber = payload.pull_request?.number;
  if (
    !['created', 'edited', 'deleted'].includes(action ?? '') ||
    !comment?.id ||
    !Number.isSafeInteger(comment.id) ||
    comment.id < 1 ||
    !pullRequestNumber ||
    !Number.isSafeInteger(pullRequestNumber) ||
    !comment.updated_at ||
    !Number.isFinite(Date.parse(comment.updated_at)) ||
    payload.pull_request?.head?.repo?.fork ||
    comment.user?.type === 'Bot' ||
    comment.user?.login?.endsWith('[bot]')
  )
    return null;
  return Object.freeze({
    protocolVersion: 2,
    pullRequestNumber,
    sourceCommentId: String(comment.id),
    sourceRevision: comment.updated_at,
    eventAction: action as ConversationSource['eventAction'],
  });
}

/** App-token-only publisher. Unknown publication is reconciled, never blindly retried. */
export class ManagedConversationHandler {
  constructor(
    private readonly client: GitHubClient,
    private readonly conversations: ConversationPort
  ) {}

  async execute(payload: ReviewCommentEventPayload): Promise<void> {
    const source = conversationSource(payload);
    if (!source) return;
    const result = await this.conversations.process(source);
    logger.info(
      `Conversation ${result.processingId}: ${result.status}; learning=${result.learning.status}.`
    );
    if (!result.reply || !['ready', 'unknown'].includes(result.status)) return;
    const { reply, processingId } = result;
    const { octokit, owner, repo } = this.client;
    const receipt = (status: 'published' | 'unknown', commentId?: string) =>
      this.conversations.publication({
        protocolVersion: 2,
        processingId,
        status,
        bodyDigest: reply.bodyDigest,
        ...(commentId ? { commentId } : {}),
      });
    // Read every page. A failed lookup must not authorize a fresh create.
    let comments;
    try {
      comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
        owner,
        repo,
        pull_number: source.pullRequestNumber,
        per_page: 100,
      });
    } catch {
      await receipt('unknown');
      return;
    }
    const matches = comments.filter((comment) =>
      comment.body?.includes(reply.marker)
    );
    if (matches.length) {
      const existing = matches[0];
      if (
        matches.length === 1 &&
        existing.user?.type === 'Bot' &&
        String(existing.in_reply_to_id) === reply.parentCommentId &&
        createHash('sha256')
          .update(existing.body ?? '', 'utf8')
          .digest('hex') === reply.bodyDigest
      )
        await receipt('published', String(existing.id));
      else await receipt('unknown');
      return;
    }
    // A prior ambiguous create remains uncertain even when a later read misses it.
    if (result.status === 'unknown') {
      await receipt('unknown');
      return;
    }
    try {
      const published = await octokit.rest.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: source.pullRequestNumber,
        comment_id: Number(reply.parentCommentId),
        body: reply.body,
      });
      await receipt('published', String(published.data.id));
    } catch {
      // This includes a lost publication receipt. Reconcile on redelivery;
      // never replace the frozen output or initiate a second model call.
      await receipt('unknown');
    }
  }
}
