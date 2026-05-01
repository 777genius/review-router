import * as fs from 'fs';
import { GitHubClient } from './client';
import { ReviewLedger, LedgerEntry } from './ledger';
import {
  extractFindingFingerprint,
  extractInlineFingerprint,
  extractInlineSeverity,
  extractInlineTitle,
  findingFingerprintFromInlineComment,
  isReviewRouterInlineComment,
} from './comment-fingerprint';
import { Severity } from '../types';
import { logger } from '../utils/logger';
import {
  ReviewCommentEventPayload,
  ReviewDiscussionHandler,
} from './discussion';

type CommandKind = 'skip' | 'unskip' | 'status';

interface ParsedCommand {
  kind: CommandKind;
  reason: string;
}

interface ReviewCommentApiItem {
  id?: number;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  body?: string | null;
  user?: {
    login?: string | null;
  } | null;
}

type RepoRole = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

export class ReviewInteractionHandler {
  constructor(
    private readonly client: GitHubClient,
    private readonly ledger: ReviewLedger,
    private readonly discussionHandler?: ReviewDiscussionHandler
  ) {}

  async execute(): Promise<void> {
    const payload = readEventPayload();
    const command = parseCommand(payload.comment?.body || '');
    if (!command) {
      if (this.discussionHandler) {
        await this.discussionHandler.execute(payload);
        return;
      }
      logger.info('Ignoring review comment because it is not a /rr command.');
      return;
    }

    const prNumber = payload.pull_request?.number;
    if (!prNumber) {
      throw new Error(
        'pull_request_review_comment payload is missing pull_request.number'
      );
    }

    if (payload.pull_request?.head?.repo?.fork) {
      await this.postNotice(
        prNumber,
        'ReviewRouter ignored this command because fork pull requests do not receive secret-backed review automation by default.'
      );
      return;
    }

    if (command.kind === 'status') {
      await this.postStatus(prNumber, payload.pull_request?.head?.sha);
      return;
    }

    await this.handleSkipCommand(payload, command, prNumber);
  }

  private async handleSkipCommand(
    payload: ReviewCommentEventPayload,
    command: ParsedCommand,
    prNumber: number
  ): Promise<void> {
    const comment = payload.comment;
    const parentId = comment?.in_reply_to_id;
    if (!comment?.id || !parentId) {
      await this.postNotice(
        prNumber,
        '`/rr skip` and `/rr unskip` must be direct replies to a ReviewRouter inline finding.'
      );
      return;
    }

    const parent = await this.findReviewComment(prNumber, parentId);
    if (!parent?.body || !isReviewRouterInlineComment(parent.body)) {
      await this.postNotice(
        prNumber,
        '`/rr skip` was ignored because the parent comment is not a ReviewRouter inline finding.'
      );
      return;
    }

    const actor = comment.user?.login || 'unknown';
    const severity = normalizeSeverity(extractInlineSeverity(parent.body));
    const role = await this.getRole(actor);
    const prAuthor = payload.pull_request?.user?.login || '';
    const denialReason = getRoleDenialReason(role, severity, actor, prAuthor);
    if (denialReason) {
      await this.postNotice(prNumber, denialReason);
      return;
    }

    const fingerprint =
      extractFindingFingerprint(parent.body) ||
      findingFingerprintFromInlineComment(
        parent.path,
        parent.line ?? parent.original_line,
        parent.body
      );
    const legacyFingerprint =
      extractInlineFingerprint(parent.body) || undefined;
    const entry: LedgerEntry = {
      action: command.kind as 'skip' | 'unskip',
      fingerprint,
      legacyFingerprint,
      severity,
      path: parent.path,
      line: parent.line ?? parent.original_line ?? null,
      title: extractInlineTitle(parent.body),
      reason: command.reason,
      actor,
      actorRole: role,
      headSha: payload.pull_request?.head?.sha,
      parentCommentId: parentId,
      commandCommentId: comment.id,
      createdAt: new Date().toISOString(),
    };

    try {
      await this.ledger.append(prNumber, entry);
    } catch (error) {
      await this.postNotice(
        prNumber,
        `Could not record \`/rr ${command.kind}\`: ${sanitizeNoticeError(error)}. The ReviewRouter check was not rerun.`
      );
      return;
    }
    logger.info(
      `Accepted /rr ${command.kind} from ${actor} for ${entry.path}:${entry.line}`
    );

    const rerun = await this.rerunFailedReview(
      prNumber,
      payload.pull_request?.head?.sha
    );
    if (rerun.started) {
      logger.info(
        `Requested rerun of ReviewRouter workflow run ${rerun.runId}`
      );
      return;
    }

    await this.postNotice(
      prNumber,
      `Recorded \`/rr ${command.kind}\`, but could not automatically rerun the review check: ${rerun.reason}. Re-run the ReviewRouter check manually if the PR status did not update.`
    );
  }

  private async postStatus(prNumber: number, headSha?: string): Promise<void> {
    const loaded = await this.ledger.load(prNumber);
    const body = loaded.valid
      ? `ReviewRouter override status:\n\n${this.ledger.statusText(loaded.payload, headSha)}`
      : `ReviewRouter override ledger is unavailable: ${loaded.invalidReason || 'unknown reason'}.`;
    await this.postNotice(prNumber, body);
  }

  private async findReviewComment(
    prNumber: number,
    commentId: number
  ): Promise<ReviewCommentApiItem | undefined> {
    const { octokit, owner, repo } = this.client;
    const comments = (await octokit.paginate(
      octokit.rest.pulls.listReviewComments,
      {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      }
    )) as ReviewCommentApiItem[];
    return comments.find((comment) => comment.id === commentId);
  }

  private async getRole(username: string): Promise<RepoRole> {
    const { octokit, owner, repo } = this.client;
    try {
      const response = await octokit.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username,
      });
      const data = response.data as { permission?: string; role_name?: string };
      return normalizeRole(data.role_name || data.permission);
    } catch (error) {
      logger.warn(
        `Failed to verify repository permission for ${username}`,
        error as Error
      );
      return 'none';
    }
  }

  private async rerunFailedReview(
    prNumber: number,
    headSha?: string
  ): Promise<
    { started: true; runId: number } | { started: false; reason: string }
  > {
    if (!headSha) {
      return { started: false, reason: 'missing PR head SHA' };
    }

    const { octokit, owner, repo } = this.client;
    const workflowFile =
      process.env.REVIEW_ROUTER_REVIEW_WORKFLOW_FILE || 'review-router.yml';

    try {
      const response = await octokit.rest.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        event: 'pull_request',
        per_page: 50,
      });
      const run = response.data.workflow_runs.find((candidate) => {
        const path = String(candidate.path || '');
        const matchesWorkflow =
          path.endsWith(`/${workflowFile}`) || path === workflowFile;
        const matchesSha = candidate.head_sha === headSha;
        const failed =
          candidate.conclusion === 'failure' ||
          candidate.conclusion === 'cancelled' ||
          candidate.conclusion === 'timed_out';
        const matchesPr = (candidate.pull_requests || []).some(
          (pr) => pr.number === prNumber
        );
        return matchesWorkflow && matchesSha && failed && matchesPr;
      });

      if (!run?.id) {
        return {
          started: false,
          reason: `no failed ${workflowFile} run found for the current PR head SHA`,
        };
      }

      await octokit.rest.actions.reRunWorkflowFailedJobs({
        owner,
        repo,
        run_id: run.id,
      });
      return { started: true, runId: run.id };
    } catch (error) {
      const err = error as { status?: number; message?: string };
      if (err.status === 403) {
        return {
          started: false,
          reason: 'token is missing Actions: write permission',
        };
      }
      return { started: false, reason: err.message || 'GitHub API error' };
    }
  }

  private async postNotice(prNumber: number, body: string): Promise<void> {
    const { octokit, owner, repo } = this.client;
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
  }
}

function parseCommand(body: string): ParsedCommand | null {
  const trimmed = body.trim();
  const match = trimmed.match(/^\/rr\s+(skip|unskip|status)\b[\s:,-]*(.*)$/is);
  if (!match) return null;
  return {
    kind: match[1].toLowerCase() as CommandKind,
    reason: (match[2] || '').trim(),
  };
}

function normalizeSeverity(value: string | null): Severity {
  if (value === 'critical' || value === 'major' || value === 'minor') {
    return value;
  }
  return 'major';
}

function normalizeRole(value: string | undefined): RepoRole {
  if (
    value === 'admin' ||
    value === 'maintain' ||
    value === 'write' ||
    value === 'triage' ||
    value === 'read'
  ) {
    return value;
  }
  return 'none';
}

function isRoleAllowed(
  role: RepoRole,
  severity: Severity,
  actor: string,
  prAuthor: string
): boolean {
  if (severity === 'critical' || severity === 'major') {
    if (role === 'maintain' || role === 'admin') {
      return true;
    }
    return (
      actor.toLowerCase() === prAuthor.toLowerCase() &&
      process.env.REVIEW_ROUTER_ALLOW_AUTHOR_SKIP === 'true' &&
      role === 'write'
    );
  }
  return role === 'write' || role === 'maintain' || role === 'admin';
}

function getRoleDenialReason(
  role: RepoRole,
  severity: Severity,
  actor: string,
  prAuthor: string
): string | null {
  if (isRoleAllowed(role, severity, actor, prAuthor)) {
    return null;
  }

  const isBlocking = severity === 'critical' || severity === 'major';
  if (
    isBlocking &&
    actor.toLowerCase() === prAuthor.toLowerCase() &&
    role !== 'maintain' &&
    role !== 'admin' &&
    process.env.REVIEW_ROUTER_ALLOW_AUTHOR_SKIP !== 'true'
  ) {
    return `@${actor} cannot skip this ${severity} finding because PR authors without maintain/admin permission cannot override blocking ReviewRouter findings by default. A maintainer or admin can reply \`/rr skip\`, or the repository can explicitly set \`REVIEW_ROUTER_ALLOW_AUTHOR_SKIP=true\` for trusted same-repo authors.`;
  }

  return `@${actor} cannot skip this ${severity} finding. Required role: ${severity === 'minor' ? 'write, maintain, or admin' : 'maintain or admin'}.`;
}

function readEventPayload(): ReviewCommentEventPayload {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error(
      'GITHUB_EVENT_PATH is required for REVIEW_ROUTER_MODE=interaction'
    );
  }
  return JSON.parse(
    fs.readFileSync(eventPath, 'utf8')
  ) as ReviewCommentEventPayload;
}

function sanitizeNoticeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/gh[pousr]_[A-Za-z0-9_]{16,}/g, 'gh*-***')
    .replace(/github_pat_[A-Za-z0-9_]+/g, 'github_pat_***')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-***')
    .slice(0, 300);
}
