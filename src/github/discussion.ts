import { createHash } from 'crypto';
import {
  extractInlineSeverity,
  extractInlineTitle,
  isReviewRouterInlineComment,
} from './comment-fingerprint';
import { GitHubClient } from './client';
import {
  DiscussionComment,
  DiscussionMode,
  DiscussionResponder,
  ReviewDiscussionContext,
} from '../discussion/types';
import { logger } from '../utils/logger';

const DISCUSSION_MARKER = 'reviewrouter-discussion:v1';
const DISCUSSION_MARKER_RE =
  /<!--\s*reviewrouter-discussion:v1\s+user_comment_id=(\d+)\s+body_sha=([a-f0-9]{64})\s*-->/;

export interface ReviewCommentEventPayload {
  action?: string;
  comment?: {
    id?: number;
    body?: string | null;
    in_reply_to_id?: number | null;
    user?: {
      login?: string | null;
      type?: string | null;
    } | null;
  };
  pull_request?: {
    number?: number;
    head?: {
      sha?: string;
      ref?: string;
      repo?: {
        fork?: boolean;
        full_name?: string;
      } | null;
    };
    user?: {
      login?: string | null;
    } | null;
  };
  repository?: {
    full_name?: string;
  };
}

interface ReviewCommentApiItem {
  id?: number;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  body?: string | null;
  diff_hunk?: string | null;
  in_reply_to_id?: number | null;
  created_at?: string;
  updated_at?: string;
  user?: {
    login?: string | null;
    type?: string | null;
  } | null;
}

interface ReviewDiscussionOptions {
  mode: DiscussionMode;
  maxPerPr: number;
  maxPerThread: number;
}

export interface InteractionPreflightResult {
  shouldRun: boolean;
  needsDiscussion: boolean;
  reason: string;
}

export class ReviewDiscussionHandler {
  constructor(
    private readonly client: GitHubClient,
    private readonly responder: DiscussionResponder | undefined,
    private readonly options: ReviewDiscussionOptions
  ) {}

  async preflight(
    payload: ReviewCommentEventPayload
  ): Promise<InteractionPreflightResult> {
    const comment = payload.comment;
    const prNumber = payload.pull_request?.number;
    const parentId = comment?.in_reply_to_id;

    if (this.options.mode === 'off') {
      return ignore('discussion mode is off');
    }
    if (!prNumber) {
      return ignore('missing pull request number');
    }
    if (payload.pull_request?.head?.repo?.fork) {
      return ignore('fork pull request');
    }
    if (!comment?.id || !comment.body?.trim()) {
      return ignore('missing comment');
    }
    if (isBotUser(comment.user)) {
      return ignore('bot comment');
    }
    if (comment.body.trim().startsWith('/rr ')) {
      return {
        shouldRun: true,
        needsDiscussion: false,
        reason: 'ReviewRouter command',
      };
    }
    if (!parentId) {
      return ignore('not a review comment reply');
    }

    const comments = await this.listReviewComments(prNumber);
    const parent = comments.find((item) => item.id === parentId);
    if (!parent?.body || !isReviewRouterInlineComment(parent.body)) {
      return ignore('parent is not a ReviewRouter finding');
    }

    const userHash = bodyHash(comment.body);
    const existing = findExistingDiscussionReply(comments, comment.id);
    if (existing?.body && markerHash(existing.body) === userHash) {
      return ignore('discussion reply already exists for this body');
    }

    const threadCount = comments.filter((item) => {
      if (existing?.id && item.id === existing.id) return false;
      const parsed = item.body ? parseDiscussionMarker(item.body) : null;
      return parsed && item.in_reply_to_id === parentId;
    }).length;
    if (threadCount >= this.options.maxPerThread) {
      return ignore('thread discussion reply limit reached');
    }

    const prCount = comments.filter((item) => {
      if (existing?.id && item.id === existing.id) return false;
      return item.body?.includes(DISCUSSION_MARKER);
    }).length;
    if (prCount >= this.options.maxPerPr) {
      return ignore('PR discussion reply limit reached');
    }

    return {
      shouldRun: true,
      needsDiscussion: true,
      reason: 'needs AI discussion response',
    };
  }

  async execute(payload: ReviewCommentEventPayload): Promise<void> {
    const preflight = await this.preflight(payload);
    if (!preflight.shouldRun || !preflight.needsDiscussion) {
      logger.info(`Ignoring discussion reply: ${preflight.reason}`);
      return;
    }
    if (!this.responder) {
      logger.warn('Discussion responder is not configured');
      return;
    }

    const prNumber = payload.pull_request?.number;
    const comment = payload.comment;
    const parentId = comment?.in_reply_to_id;
    if (!prNumber || !comment?.id || !comment.body || !parentId) {
      return;
    }

    const comments = await this.listReviewComments(prNumber);
    const parent = comments.find((item) => item.id === parentId);
    if (!parent?.body) {
      return;
    }

    const context = this.buildContext(
      payload,
      prNumber,
      comment.id,
      parent,
      comments
    );
    let answer: string;
    let suggestSkip = false;
    try {
      const response = await this.responder.respond(context);
      answer = response.answer;
      suggestSkip = response.suggestedAction === 'suggest_rr_skip';
    } catch (error) {
      logger.warn('ReviewRouter discussion responder failed', error as Error);
      answer = `I could not evaluate this reply automatically: ${sanitizeError(error)}. A maintainer can still use \`/rr skip\` if they have verified this finding is not actionable.`;
    }
    const body = renderDiscussionReply(
      comment.id,
      comment.body,
      comment.user?.login || 'user',
      answer,
      suggestSkip
    );
    const existing = findExistingDiscussionReply(comments, comment.id);
    const { octokit, owner, repo } = this.client;

    if (existing?.id) {
      await octokit.rest.pulls.updateReviewComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      });
      logger.info(`Updated ReviewRouter discussion reply ${existing.id}`);
      return;
    }

    await octokit.rest.pulls.createReplyForReviewComment({
      owner,
      repo,
      pull_number: prNumber,
      comment_id: parentId,
      body,
    });
    logger.info(
      `Posted ReviewRouter discussion reply for comment ${comment.id}`
    );
  }

  private buildContext(
    payload: ReviewCommentEventPayload,
    prNumber: number,
    userCommentId: number,
    parent: ReviewCommentApiItem,
    comments: ReviewCommentApiItem[]
  ): ReviewDiscussionContext {
    const parentId = parent.id as number;
    const thread = comments
      .filter(
        (item) => item.id === parentId || item.in_reply_to_id === parentId
      )
      .sort((a, b) => (a.id || 0) - (b.id || 0))
      .map(toDiscussionComment);
    const userComment =
      thread.find((item) => item.id === userCommentId) ||
      toDiscussionComment({
        id: userCommentId,
        body: payload.comment?.body,
        user: payload.comment?.user,
        in_reply_to_id: parentId,
      });

    return {
      repository:
        payload.repository?.full_name ||
        payload.pull_request?.head?.repo?.full_name ||
        `${this.client.owner}/${this.client.repo}`,
      pullRequestNumber: prNumber,
      headSha: payload.pull_request?.head?.sha,
      parent: {
        id: parentId,
        path: parent.path,
        line: parent.line ?? parent.original_line ?? null,
        diffHunk: parent.diff_hunk,
        body: parent.body || '',
        severity: extractInlineSeverity(parent.body || '') || 'major',
        title: extractInlineTitle(parent.body || '') || undefined,
      },
      userComment,
      thread,
    };
  }

  private async listReviewComments(
    prNumber: number
  ): Promise<ReviewCommentApiItem[]> {
    const { octokit, owner, repo } = this.client;
    return (await octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    })) as ReviewCommentApiItem[];
  }
}

export function loadDiscussionOptionsFromEnv(): ReviewDiscussionOptions {
  return {
    mode: normalizeMode(process.env.REVIEW_ROUTER_DISCUSSION_MODE),
    maxPerPr: parsePositiveInt(
      process.env.REVIEW_ROUTER_DISCUSSION_MAX_PER_PR,
      20
    ),
    maxPerThread: parsePositiveInt(
      process.env.REVIEW_ROUTER_DISCUSSION_MAX_PER_THREAD,
      5
    ),
  };
}

function ignore(reason: string): InteractionPreflightResult {
  return { shouldRun: false, needsDiscussion: false, reason };
}

function normalizeMode(value: string | undefined): DiscussionMode {
  const normalized = (value || 'off').trim().toLowerCase();
  if (normalized === 'suggest') return normalized;
  return 'off';
}

function parsePositiveInt(
  value: string | undefined,
  defaultValue: number
): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

function findExistingDiscussionReply(
  comments: ReviewCommentApiItem[],
  userCommentId: number
): ReviewCommentApiItem | undefined {
  return comments.find((item) => {
    if (!item.body) return false;
    const parsed = parseDiscussionMarker(item.body);
    return parsed?.userCommentId === userCommentId;
  });
}

function parseDiscussionMarker(
  body: string
): { userCommentId: number; bodySha: string } | null {
  const match = body.match(DISCUSSION_MARKER_RE);
  if (!match) return null;
  return {
    userCommentId: Number.parseInt(match[1], 10),
    bodySha: match[2],
  };
}

function markerHash(body: string): string | null {
  return parseDiscussionMarker(body)?.bodySha || null;
}

function renderDiscussionReply(
  userCommentId: number,
  userCommentBody: string,
  userLogin: string,
  answer: string,
  suggestSkip: boolean
): string {
  const footer = suggestSkip
    ? [
        '',
        '_If a maintainer agrees this finding should not block the PR, reply `/rr skip` to the original ReviewRouter finding._',
      ].join('\n')
    : '';

  return [
    `<!-- ${DISCUSSION_MARKER} user_comment_id=${userCommentId} body_sha=${bodyHash(userCommentBody)} -->`,
    '',
    `@${userLogin} ${answer}`,
    footer,
  ].join('\n');
}

function toDiscussionComment(item: ReviewCommentApiItem): DiscussionComment {
  return {
    id: item.id || 0,
    body: item.body || '',
    author: item.user?.login || 'unknown',
    isBot: isBotUser(item.user),
    createdAt: item.created_at,
    inReplyToId: item.in_reply_to_id ?? null,
  };
}

function isBotUser(
  user: { login?: string | null; type?: string | null } | null | undefined
): boolean {
  const login = user?.login || '';
  return user?.type === 'Bot' || login.endsWith('[bot]');
}

function bodyHash(body: string): string {
  return createHash('sha256').update(body.trim()).digest('hex');
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/gh[pousr]_[A-Za-z0-9_]{16,}/g, 'gh*-***')
    .replace(/github_pat_[A-Za-z0-9_]+/g, 'github_pat_***')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-***')
    .slice(0, 240);
}
