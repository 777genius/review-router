import { Finding, InlineComment } from '../types';
import { GitHubClient } from './client';
import { logger } from '../utils/logger';
import { ProviderWeightTracker } from '../learning/provider-weights';
import { severityHeading, severityLine } from '../utils/severity';
import {
  extractInlineFingerprint,
  findingFingerprintFromFinding,
  findingFingerprintFromInlineComment,
  fingerprintFromInlineComment,
  InlineCommentReference,
  isReviewRouterInlineComment,
  isLikelySameInlineFinding,
  signatureFromInlineComment,
} from './comment-fingerprint';
import { ReviewLedger } from './ledger';

export interface ReviewCommentState {
  suppressed: Set<string>;
  alreadyPosted: Set<string>;
  commandDismissed?: Set<string>;
  commandDismissedLocations?: Set<string>;
  suppressedComments: InlineCommentReference[];
  alreadyPostedComments: InlineCommentReference[];
  commandDismissedComments?: InlineCommentReference[];
}

interface ReviewCommentApiItem {
  id?: number;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  body?: string | null;
  in_reply_to_id?: number | null;
  user?: {
    login?: string | null;
  } | null;
}

export class FeedbackFilter {
  constructor(
    private readonly client: GitHubClient,
    _providerWeightTracker?: ProviderWeightTracker,
    private readonly ledger?: ReviewLedger
  ) {}

  async loadSuppressed(prNumber: number): Promise<Set<string>> {
    return (await this.loadReviewCommentState(prNumber)).suppressed;
  }

  async loadReviewCommentState(
    prNumber: number,
    headSha?: string
  ): Promise<ReviewCommentState> {
    const { octokit, owner, repo } = this.client;
    const suppressed = new Set<string>();
    const alreadyPosted = new Set<string>();
    const commandDismissed = new Set<string>();
    const commandDismissedLocations = new Set<string>();
    const suppressedComments: InlineCommentReference[] = [];
    const alreadyPostedComments: InlineCommentReference[] = [];
    const commandDismissedComments: InlineCommentReference[] = [];

    try {
      const comments = (await octokit.paginate(
        octokit.rest.pulls.listReviewComments,
        {
          owner,
          repo,
          pull_number: prNumber,
          per_page: 100,
        }
      )) as ReviewCommentApiItem[];
      for (const comment of comments) {
        const activeLine = comment.line;
        const line = activeLine ?? comment.original_line;
        const body = comment.body || '';
        const signature = this.signatureFromComment(comment.path, line, body);
        const marker = extractInlineFingerprint(body);

        // Only active review comments should suppress reposting. Outdated
        // comments have line=null and should not hide a fresh current-diff
        // comment if the finding still exists after a new push.
        if (isReviewRouterInlineComment(body) && activeLine != null) {
          alreadyPosted.add(signature);
          if (marker) alreadyPosted.add(marker);
          alreadyPostedComments.push({
            path: comment.path,
            line: activeLine,
            body,
          });
        }

        if (typeof comment.id !== 'number') continue;
      }
    } catch (error) {
      logger.warn(
        'Failed to load review comments for feedback filter',
        error as Error
      );
    }

    if (this.ledger) {
      try {
        const loaded = await this.ledger.load(prNumber);
        if (!loaded.valid) {
          logger.warn(
            `ReviewRouter override ledger ignored: ${loaded.invalidReason || 'invalid ledger'}`
          );
        } else {
          for (const skip of this.ledger.activeSkips(loaded.payload, headSha)) {
            commandDismissed.add(skip.fingerprint);
            if (skip.legacyFingerprint)
              commandDismissed.add(skip.legacyFingerprint);
            const location = locationKey(skip.path, skip.line);
            if (location) commandDismissedLocations.add(location);
            if (skip.path) {
              commandDismissedComments.push({
                path: skip.path,
                line: skip.line,
                body: [
                  `**${skip.severity} - ${skip.title || 'Skipped finding'}**`,
                  '',
                  skip.reason || 'Skipped by maintainer command.',
                ].join('\n'),
              });
            }
          }
        }
      } catch (error) {
        logger.warn(
          'Failed to load ReviewRouter override ledger',
          error as Error
        );
      }
    }

    return {
      suppressed,
      alreadyPosted,
      commandDismissed,
      commandDismissedLocations,
      suppressedComments,
      alreadyPostedComments,
      commandDismissedComments,
    };
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
    const location = locationKey(comment.path, comment.line);

    if (state instanceof Set) {
      return !state.has(signature) && !state.has(fingerprint);
    }

    return (
      !state.suppressed.has(signature) &&
      !state.suppressed.has(fingerprint) &&
      !(state.commandDismissed?.has(signature) ?? false) &&
      !(state.commandDismissed?.has(fingerprint) ?? false) &&
      !(location ? state.commandDismissedLocations?.has(location) : false) &&
      !state.alreadyPosted.has(signature) &&
      !state.alreadyPosted.has(fingerprint) &&
      !state.suppressedComments.some((existing) =>
        isLikelySameInlineFinding(existing, comment)
      ) &&
      !(
        state.commandDismissedComments?.some((existing) =>
          isLikelySameInlineFinding(existing, comment)
        ) ?? false
      ) &&
      !state.alreadyPostedComments.some((existing) =>
        isLikelySameInlineFinding(existing, comment)
      )
    );
  }

  isFindingCommandDismissed(
    finding: Finding,
    state: ReviewCommentState
  ): boolean {
    const body = [
      `**${severityHeading(finding.severity, finding.title)}**`,
      '',
      severityLine(finding.severity),
      '',
      finding.message,
    ].join('\n');
    const findingFingerprint = findingFingerprintFromFinding(finding);
    if (state.commandDismissed?.has(findingFingerprint) ?? false) {
      return true;
    }
    return this.isCommandDismissed(
      { path: finding.file, line: finding.line, body },
      state
    );
  }

  isInlineCommandDismissed(
    comment: InlineComment,
    state: ReviewCommentState
  ): boolean {
    return this.isCommandDismissed(comment, state);
  }

  private isCommandDismissed(
    comment: InlineCommentReference,
    state: ReviewCommentState
  ): boolean {
    const commandDismissed = state.commandDismissed ?? new Set<string>();
    const commandDismissedComments = state.commandDismissedComments ?? [];
    const commandDismissedLocations =
      state.commandDismissedLocations ?? new Set<string>();
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
    const findingFingerprint = findingFingerprintFromInlineComment(
      comment.path,
      comment.line,
      comment.body
    );
    const location = locationKey(comment.path, comment.line);

    return (
      commandDismissed.has(signature) ||
      commandDismissed.has(fingerprint) ||
      commandDismissed.has(findingFingerprint) ||
      (location ? commandDismissedLocations.has(location) : false) ||
      commandDismissedComments.some((existing) =>
        isLikelySameInlineFinding(existing, comment)
      )
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

function locationKey(
  path: string | undefined,
  line: number | null | undefined
): string | null {
  if (!path || line == null) return null;
  return `${path.toLowerCase()}:${line}`;
}
