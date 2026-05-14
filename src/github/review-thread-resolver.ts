import { GitHubClient } from './client';
import {
  LifecycleMutationFailure,
  LifecycleReasonCode,
  LifecycleResolvedThread,
  LifecycleThreadRecord,
} from '../types';
import {
  extractFindingFingerprint,
} from './comment-fingerprint';
import {
  DEFAULT_TRUSTED_REVIEW_THREAD_AUTHORS,
  isTrustedReviewThreadAuthor,
} from './review-thread-inventory';
import { logger } from '../utils/logger';

export interface ReviewThreadResolveResult {
  resolved: LifecycleResolvedThread[];
  skipped: LifecycleThreadRecord[];
  manualAttention: LifecycleThreadRecord[];
  failed: LifecycleMutationFailure[];
  warnings: string[];
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
}

interface GraphQLThread {
  id: string;
  isResolved: boolean;
  viewerCanResolve?: boolean | null;
  comments?: {
    pageInfo: GraphQLPageInfo;
    nodes: GraphQLComment[];
  } | null;
}

const HEAD_QUERY = `
query ReviewRouterResolveHeadGuard($owner: String!, $repo: String!, $prNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      headRefOid
    }
  }
}`;

const THREAD_QUERY = `
query ReviewRouterResolveThreadGuard($threadId: ID!) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      id
      isResolved
      viewerCanResolve
      comments(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          author { login }
          body
          createdAt
          updatedAt
        }
      }
    }
  }
}`;

const RESOLVE_MUTATION = `
mutation ReviewRouterResolveReviewThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread {
      id
      isResolved
    }
  }
}`;

export class ReviewThreadResolver {
  constructor(
    private readonly client: GitHubClient,
    private readonly dryRun = false,
    private readonly trustedAuthors = DEFAULT_TRUSTED_REVIEW_THREAD_AUTHORS,
    private readonly mutationFallbackClient?: GitHubClient
  ) {}

  async resolveGuarded(
    prNumber: number,
    reviewedHeadSha: string,
    candidates: LifecycleThreadRecord[]
  ): Promise<ReviewThreadResolveResult> {
    const result: ReviewThreadResolveResult = {
      resolved: [],
      skipped: [],
      manualAttention: [],
      failed: [],
      warnings: [],
    };

    if (candidates.length === 0) {
      return result;
    }

    if (this.dryRun) {
      result.skipped.push(
        ...candidates.map((candidate) => this.withReason(candidate, ['dry_run']))
      );
      return result;
    }

    let freshHeadSha: string | undefined;
    try {
      freshHeadSha = await this.loadHeadSha(prNumber);
    } catch (error) {
      logger.warn(
        'Failed to refresh PR head before review thread lifecycle mutations',
        error as Error
      );
      if (isRateLimitedError(error)) {
        result.skipped.push(
          ...candidates.map((candidate) =>
            this.withReason(candidate, ['mutation_rate_limited'])
          )
        );
        result.warnings.push(
          'review thread lifecycle mutations stopped because GitHub rate limited the request'
        );
        return result;
      }
      result.skipped.push(
        ...candidates.map((candidate) =>
          this.withReason(candidate, ['thread_changed_before_mutation'])
        )
      );
      return result;
    }

    if (!freshHeadSha || freshHeadSha !== reviewedHeadSha) {
      result.skipped.push(
        ...candidates.map((candidate) =>
          this.withReason(candidate, ['head_sha_changed'])
        )
      );
      return result;
    }

    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      let thread: GraphQLThread | null;
      try {
        thread = await this.loadThread(candidate.target.threadId);
      } catch (error) {
        if (isRateLimitedError(error)) {
          result.skipped.push(
            ...candidates
              .slice(index)
              .map((remaining) =>
                this.withReason(remaining, ['mutation_rate_limited'])
              )
          );
          result.warnings.push(
            'review thread lifecycle mutations stopped because GitHub rate limited the request'
          );
          return result;
        }
        result.skipped.push(
          this.withReason(candidate, ['thread_changed_before_mutation'])
        );
        continue;
      }

      const guard = this.guardCandidate(candidate, thread);
      if (guard.kind === 'resolved') {
        result.resolved.push({
          ...this.withReason(candidate, guard.reasonCodes),
          resolvedBy: guard.resolvedBy,
        });
        continue;
      }
      if (guard.kind === 'manual') {
        result.manualAttention.push(
          this.withReason(candidate, guard.reasonCodes)
        );
        continue;
      }
      if (guard.kind === 'skipped') {
        result.skipped.push(this.withReason(candidate, guard.reasonCodes));
        continue;
      }

      try {
        await this.resolveThread(candidate.target.threadId);
        result.resolved.push({
          ...this.withReason(candidate, []),
          resolvedBy: 'review-router',
        });
      } catch (error) {
        if (isRateLimitedError(error)) {
          result.skipped.push(
            ...candidates
              .slice(index)
              .map((remaining) =>
                this.withReason(remaining, ['mutation_rate_limited'])
              )
          );
          result.warnings.push(
            'review thread lifecycle mutations stopped because GitHub rate limited the request'
          );
          return result;
        }
        result.failed.push({
          ...this.withReason(candidate, [
            permissionDenied(error)
              ? 'mutation_permission_denied'
              : 'mutation_failed',
          ]),
          errorMessage: errorMessage(error),
        });
      }
    }

    return result;
  }

  private guardCandidate(
    candidate: LifecycleThreadRecord,
    thread: GraphQLThread | null
  ):
    | {
        kind: 'ready';
      }
    | {
        kind: 'resolved';
        resolvedBy: 'external';
        reasonCodes: LifecycleReasonCode[];
      }
    | {
        kind: 'manual' | 'skipped';
        reasonCodes: LifecycleReasonCode[];
      } {
    if (!thread) {
      return { kind: 'skipped', reasonCodes: ['thread_not_found'] };
    }
    if (thread.isResolved) {
      return {
        kind: 'resolved',
        resolvedBy: 'external',
        reasonCodes: ['already_resolved'],
      };
    }
    const comments = thread.comments?.nodes ?? [];
    if (thread.comments?.pageInfo.hasNextPage) {
      return { kind: 'skipped', reasonCodes: ['pagination_incomplete'] };
    }

    const parent = comments.find(
      (comment) => comment.id === candidate.target.parentCommentId
    );
    const parentIndex = comments.findIndex(
      (comment) => comment.id === candidate.target.parentCommentId
    );
    if (!parent) {
      return {
        kind: 'skipped',
        reasonCodes: ['thread_changed_before_mutation'],
      };
    }
    if (!this.isTrustedAuthor(parent.author?.login)) {
      return {
        kind: 'manual',
        reasonCodes: ['untrusted_author'],
      };
    }
    if (
      extractFindingFingerprint(parent.body || '') !== candidate.target.fingerprint
    ) {
      return {
        kind: 'skipped',
        reasonCodes: ['thread_changed_before_mutation'],
      };
    }
    const parentUpdatedAt =
      parent.updatedAt || parent.createdAt || new Date(0).toISOString();
    if (parentUpdatedAt !== candidate.target.parentCommentUpdatedAt) {
      return {
        kind: 'skipped',
        reasonCodes: ['thread_changed_before_mutation'],
      };
    }
    if (comments.length !== candidate.target.threadCommentCount) {
      const hasHumanReply = comments.some(
        (comment, index) =>
          index > parentIndex &&
          comment.id !== candidate.target.parentCommentId &&
          !this.isTrustedAuthor(comment.author?.login)
      );
      return {
        kind: hasHumanReply ? 'manual' : 'skipped',
        reasonCodes: hasHumanReply
          ? ['human_reply']
          : ['thread_changed_before_mutation'],
      };
    }

    const hasHumanReply = comments.some(
      (comment, index) =>
        index > parentIndex &&
        comment.id !== candidate.target.parentCommentId &&
        !this.isTrustedAuthor(comment.author?.login)
    );
    if (hasHumanReply) {
      return { kind: 'manual', reasonCodes: ['human_reply'] };
    }

    return { kind: 'ready' };
  }

  private withReason(
    record: LifecycleThreadRecord,
    reasonCodes: LifecycleReasonCode[]
  ): LifecycleThreadRecord {
    return {
      ...record,
      reasonCodes: unique([
        ...record.reasonCodes,
        ...reasonCodes,
      ]) as LifecycleReasonCode[],
    };
  }

  private isTrustedAuthor(login?: string | null): boolean {
    return isTrustedReviewThreadAuthor(login, this.trustedAuthors);
  }

  private async loadHeadSha(prNumber: number): Promise<string | undefined> {
    const response = await this.graphql<{
      repository?: {
        pullRequest?: {
          headRefOid?: string | null;
        } | null;
      } | null;
    }>(HEAD_QUERY, {
      owner: this.client.owner,
      repo: this.client.repo,
      prNumber,
    });
    return response.repository?.pullRequest?.headRefOid ?? undefined;
  }

  private async loadThread(threadId: string): Promise<GraphQLThread | null> {
    const response = await this.graphql<{ node?: GraphQLThread | null }>(
      THREAD_QUERY,
      { threadId }
    );
    return response.node ?? null;
  }

  private async resolveThread(threadId: string): Promise<void> {
    try {
      await this.resolveThreadWithClient(this.client, threadId);
    } catch (error) {
      if (!permissionDenied(error) || !this.mutationFallbackClient) {
        throw error;
      }
      logger.warn(
        'Primary review thread lifecycle token cannot resolve thread; retrying with lifecycle fallback token',
        error as Error
      );
      await this.resolveThreadWithClient(this.mutationFallbackClient, threadId);
    }
  }

  private async resolveThreadWithClient(
    client: GitHubClient,
    threadId: string
  ): Promise<void> {
    const response = await this.graphql<{
      resolveReviewThread?: {
        thread?: {
          id: string;
          isResolved: boolean;
        } | null;
      } | null;
    }>(RESOLVE_MUTATION, { threadId }, client);
    if (!response.resolveReviewThread?.thread?.isResolved) {
      throw new Error('GitHub did not mark review thread resolved');
    }
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    client: GitHubClient = this.client
  ): Promise<T> {
    const graphql = (client.octokit as unknown as {
      graphql?: (query: string, variables: Record<string, unknown>) => Promise<T>;
    }).graphql;
    if (typeof graphql !== 'function') {
      throw new Error('GitHub GraphQL client is unavailable');
    }
    return graphql(query, variables);
  }
}

function isRateLimitedError(error: unknown): boolean {
  const maybe = error as { status?: number; message?: string };
  const message = maybe?.message || String(error);
  return (
    maybe?.status === 429 ||
    (maybe?.status === 403 &&
      /rate limit|secondary rate limit|abuse detection/i.test(message))
  );
}

function permissionDenied(error: unknown): boolean {
  const maybe = error as { status?: number; message?: string };
  const message = maybe?.message || String(error);
  return maybe?.status === 403 || /permission|forbidden|resource not accessible/i.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
