import { createHash } from 'crypto';
import { GitHubClient } from './client';
import {
  LifecycleReasonCode,
  LifecycleTarget,
  LifecycleThreadRecord,
} from '../types';
import {
  extractFindingFingerprint,
  extractInlineSeverity,
  extractInlineTitle,
  InlineCommentReference,
  stripInlineFingerprintMarkers,
} from './comment-fingerprint';
import { logger } from '../utils/logger';

export const DEFAULT_TRUSTED_REVIEW_THREAD_AUTHORS = [
  'review-router-ai[bot]',
];
const GITHUB_ACTIONS_BOT_AUTHOR = 'github-actions[bot]';

const TRUSTED_AUTHOR_ENV_KEYS = [
  'REVIEW_THREAD_LIFECYCLE_TRUSTED_AUTHORS',
  'REVIEW_ROUTER_TRUSTED_BOT_AUTHORS',
];

const APP_BOT_LOGIN_ENV_KEYS = [
  'REVIEW_APP_BOT_LOGIN',
  'REVIEW_ROUTER_APP_BOT_LOGIN',
  'REVIEWROUTER_APP_BOT_LOGIN',
];

const APP_SLUG_ENV_KEYS = [
  'REVIEW_APP_SLUG',
  'REVIEW_ROUTER_APP_SLUG',
  'REVIEWROUTER_APP_SLUG',
  'AI_ROBOT_REVIEW_APP_SLUG',
];

export interface ReviewThreadInventory {
  headRefOid?: string;
  candidates: LifecycleTarget[];
  manualAttention: LifecycleThreadRecord[];
  dedupeComments: InlineCommentReference[];
  warnings: string[];
  failed: boolean;
}

interface GraphQLPageInfo {
  hasNextPage: boolean;
  endCursor?: string | null;
}

interface GraphQLComment {
  id: string;
  author?: { login?: string | null } | null;
  body?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  path?: string | null;
  line?: number | null;
  originalLine?: number | null;
  diffHunk?: string | null;
  url?: string | null;
}

interface GraphQLThread {
  id: string;
  isResolved: boolean;
  isOutdated?: boolean;
  viewerCanResolve?: boolean;
  path?: string | null;
  line?: number | null;
  originalLine?: number | null;
  comments?: {
    pageInfo: GraphQLPageInfo;
    nodes: GraphQLComment[];
  };
}

interface GraphQLThreadCommentsResponse {
  node?: {
    comments?: {
      pageInfo: GraphQLPageInfo;
      nodes: GraphQLComment[];
    } | null;
  } | null;
}

const INVENTORY_QUERY = `
query ReviewRouterThreadInventory(
  $owner: String!
  $repo: String!
  $prNumber: Int!
  $threadsAfter: String
) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      headRefOid
      reviewThreads(first: 50, after: $threadsAfter) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          viewerCanResolve
          path
          line
          originalLine
          comments(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              author { login }
              body
              createdAt
              updatedAt
              path
              line
              originalLine
              diffHunk
              url
            }
          }
        }
      }
    }
	  }
	}`;

const THREAD_COMMENTS_QUERY = `
	query ReviewRouterThreadComments($threadId: ID!, $commentsAfter: String) {
	  node(id: $threadId) {
	    ... on PullRequestReviewThread {
	      comments(first: 100, after: $commentsAfter) {
	        pageInfo { hasNextPage endCursor }
	        nodes {
	          id
	          author { login }
	          body
	          createdAt
	          updatedAt
	          path
	          line
	          originalLine
	          diffHunk
	          url
	        }
	      }
	    }
	  }
	}`;

export class ReviewThreadInventoryLoader {
  constructor(
    private readonly client: GitHubClient,
    private readonly trustedAuthors = DEFAULT_TRUSTED_REVIEW_THREAD_AUTHORS
  ) {}

  async load(prNumber: number): Promise<ReviewThreadInventory> {
    const inventory: ReviewThreadInventory = {
      candidates: [],
      manualAttention: [],
      dedupeComments: [],
      warnings: [],
      failed: false,
    };

    try {
      let cursor: string | null | undefined;
      do {
        const response = await this.graphql<{
          repository?: {
            pullRequest?: {
              headRefOid?: string;
              reviewThreads?: {
                pageInfo: GraphQLPageInfo;
                nodes: GraphQLThread[];
              };
            } | null;
          } | null;
        }>(INVENTORY_QUERY, {
          owner: this.client.owner,
          repo: this.client.repo,
          prNumber,
          threadsAfter: cursor ?? null,
        });
        const pr = response.repository?.pullRequest;
        if (!pr?.headRefOid || !pr.reviewThreads) {
          throw new Error('pull request review thread connection was missing');
        }
        inventory.headRefOid = pr.headRefOid;
        const threads = pr.reviewThreads;
        if (!Array.isArray(threads.nodes)) {
          throw new Error('pull request review thread nodes were missing');
        }
        for (const thread of threads.nodes || []) {
          await this.classifyThread(thread, inventory);
        }
        if (threads.pageInfo.hasNextPage) {
          if (!threads.pageInfo.endCursor) {
            throw new Error('review thread pagination cursor was missing');
          }
          cursor = threads.pageInfo.endCursor;
        } else {
          cursor = null;
        }
      } while (cursor);
    } catch (error) {
      logger.warn(
        'Failed to load ReviewRouter review thread lifecycle inventory',
        error as Error
      );
      inventory.candidates = [];
      inventory.manualAttention = [];
      inventory.dedupeComments = [];
      inventory.failed = true;
      inventory.warnings.push('review thread lifecycle inventory failed');
    }

    return inventory;
  }

  private async classifyThread(
    thread: GraphQLThread,
    inventory: ReviewThreadInventory
  ): Promise<void> {
    if (thread.isResolved) {
      return;
    }

    if (!thread.comments || !Array.isArray(thread.comments.nodes)) {
      throw new Error(`thread ${thread.id} comments connection was missing`);
    }

    let comments = thread.comments.nodes;
    let commentsTruncated = Boolean(thread.comments?.pageInfo.hasNextPage);
    if (commentsTruncated) {
      try {
        comments = await this.loadRemainingThreadComments(
          thread.id,
          comments,
          thread.comments?.pageInfo.endCursor ?? null
        );
        commentsTruncated = false;
      } catch (error) {
        logger.warn(
          `Failed to load complete review thread comments for ${thread.id}`,
          error as Error
        );
        inventory.warnings.push(
          `thread ${thread.id} comments pagination could not be completed`
        );
      }
    }

    const parent = comments[0];
    const parentFingerprint = extractFindingFingerprint(parent?.body || '');
    if (!parent) {
      throw new Error(`thread ${thread.id} parent comment was missing`);
    }
    if (!parentFingerprint) {
      if (commentsTruncated) {
        inventory.warnings.push(
          `thread ${thread.id} has truncated comments before a ReviewRouter parent could be identified`
        );
      }
      return;
    }

    const body = parent.body || '';
    const fingerprint = parentFingerprint;

    const trustedAuthor = this.isTrustedAuthor(parent.author?.login);
    const humanReply = comments.some(
      (comment, index) =>
        index > 0 &&
        comment.id !== parent.id &&
        !this.isTrustedAuthor(comment.author?.login)
    );
    const cleanBody = stripLifecycleCommentBody(body);
    const parsedTitle = extractInlineTitle(cleanBody);
    const hasOldFindingDetails = Boolean(
      cleanBody.trim() || parsedTitle.trim()
    );
    const title = parsedTitle || 'Previous ReviewRouter finding';
    const severity = normalizeLifecycleSeverity(extractInlineSeverity(body));
    const message = cleanBody || parsedTitle || title;
    const reasonCodes: LifecycleReasonCode[] = [];

    if (!trustedAuthor) reasonCodes.push('untrusted_author');
    if (humanReply) reasonCodes.push('human_reply');
    if (!hasOldFindingDetails) reasonCodes.push('missing_old_finding_details');
    if (commentsTruncated) reasonCodes.push('pagination_incomplete');

    const target: LifecycleTarget = {
      targetId: targetIdFor(thread.id, parent.id, fingerprint),
      threadId: thread.id,
      threadUrl: parent.url ?? undefined,
      fingerprint,
      severity,
      title,
      message,
      originalPath: parent.path || thread.path || 'unknown',
      currentPath: thread.path || parent.path || undefined,
      originalLine: parent.originalLine ?? thread.originalLine ?? undefined,
      currentLine: parent.line ?? thread.line ?? undefined,
      diffHunk: parent.diffHunk ?? undefined,
      parentCommentId: parent.id,
      parentCommentUpdatedAt:
        parent.updatedAt || parent.createdAt || new Date(0).toISOString(),
      threadCommentCount: comments.length,
      viewerCanResolve: Boolean(thread.viewerCanResolve),
      hasHumanReply: humanReply,
      trustedAuthor,
      reasonCodes,
    };

    if (
      trustedAuthor &&
      !thread.isOutdated &&
      target.currentPath &&
      target.currentLine != null
    ) {
      inventory.dedupeComments.push({
        path: target.currentPath,
        line: target.currentLine,
        body,
      });
    }

    if (reasonCodes.length > 0) {
      inventory.manualAttention.push({
        target,
        reasonCodes,
      });
      return;
    }

    inventory.candidates.push(target);
  }

  private isTrustedAuthor(login?: string | null): boolean {
    return isTrustedReviewThreadAuthor(login, this.trustedAuthors);
  }

  private async loadRemainingThreadComments(
    threadId: string,
    initialComments: GraphQLComment[],
    initialCursor: string | null
  ): Promise<GraphQLComment[]> {
    if (!initialCursor) {
      throw new Error('thread comments pagination cursor was missing');
    }
    const comments = [...initialComments];
    let cursor: string | null = initialCursor;

    while (cursor) {
      const response: GraphQLThreadCommentsResponse =
        await this.graphql<GraphQLThreadCommentsResponse>(
          THREAD_COMMENTS_QUERY,
          {
            threadId,
            commentsAfter: cursor,
          }
        );
      const connection = response.node?.comments ?? null;
      if (!connection) {
        throw new Error('thread comments connection was missing');
      }
      comments.push(...(connection.nodes ?? []));
      if (!connection.pageInfo.hasNextPage) {
        cursor = null;
        break;
      }
      if (!connection.pageInfo.endCursor) {
        throw new Error('thread comments pagination cursor was missing');
      }
      cursor = connection.pageInfo.endCursor;
    }

    return comments;
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>
  ): Promise<T> {
    const graphql = (this.client.octokit as unknown as {
      graphql?: (query: string, variables: Record<string, unknown>) => Promise<T>;
    }).graphql;
    if (typeof graphql !== 'function') {
      throw new Error('GitHub GraphQL client is unavailable');
    }
    return graphql(query, variables);
  }
}

export function isTrustedReviewThreadAuthor(
  login?: string | null,
  trustedAuthors: readonly string[] = DEFAULT_TRUSTED_REVIEW_THREAD_AUTHORS
): boolean {
  const normalizedLogin = canonicalBotLogin(login);
  return Boolean(
    normalizedLogin &&
      trustedAuthors.some(
        (author) => canonicalBotLogin(author) === normalizedLogin
      )
  );
}

export function trustedReviewThreadAuthorsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const authors = new Set(
    DEFAULT_TRUSTED_REVIEW_THREAD_AUTHORS.map((author) => author.toLowerCase())
  );
  if (shouldTrustGitHubActionsBot(env)) {
    authors.add(GITHUB_ACTIONS_BOT_AUTHOR);
  }

  for (const key of TRUSTED_AUTHOR_ENV_KEYS) {
    for (const raw of splitList(env[key])) {
      const normalized = normalizeBotLogin(raw);
      if (normalized) authors.add(normalized);
    }
  }

  for (const key of APP_BOT_LOGIN_ENV_KEYS) {
    const normalized = normalizeBotLogin(env[key]);
    if (normalized) authors.add(normalized);
  }

  for (const key of APP_SLUG_ENV_KEYS) {
    const normalized = normalizeAppSlugBotLogin(env[key]);
    if (normalized) authors.add(normalized);
  }

  return Array.from(authors);
}

function shouldTrustGitHubActionsBot(env: NodeJS.ProcessEnv): boolean {
  if (env.REVIEWROUTER_COMMENT_TOKEN_MODE !== 'app-oidc') {
    return true;
  }
  return env.REVIEW_ROUTER_COMMENT_TOKEN_STATUS === 'fallback';
}

function targetIdFor(
  threadId: string,
  parentCommentId: string,
  fingerprint: string
): string {
  return `rrt_${createHash('sha256')
    .update(`${threadId}\n${parentCommentId}\n${fingerprint}`)
    .digest('hex')
    .slice(0, 16)}`;
}

function normalizeLifecycleSeverity(
  value: string | null
): LifecycleTarget['severity'] {
  if (value === 'critical' || value === 'major' || value === 'minor') {
    return value;
  }
  return 'unknown';
}

function stripLifecycleCommentBody(body: string): string {
  return stripInlineFingerprintMarkers(body)
    .replace(/<sub><!--\s*review-router-skip-help\s*-->[\s\S]*?<\/sub>/gi, '')
    .replace(/<sub>\s*Models?:[\s\S]*?<\/sub>/gi, '')
    .replace(/\*\*Provider:\*\*[\s\S]*?(?:\n\n|$)/gi, '')
    .trim();
}

function splitList(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeAppSlugBotLogin(value?: string | null): string | undefined {
  const slug = (value ?? '').trim();
  if (!slug) return undefined;
  return normalizeBotLogin(slug.endsWith('[bot]') ? slug : `${slug}[bot]`);
}

function normalizeBotLogin(value?: string | null): string | undefined {
  const login = (value ?? '').trim().toLowerCase();
  if (!login) return undefined;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?(?:\[bot\])?$/.test(login)) {
    return undefined;
  }
  return login;
}

function canonicalBotLogin(value?: string | null): string | undefined {
  const login = normalizeBotLogin(value);
  return login?.endsWith('[bot]') ? login.slice(0, -5) : login;
}
