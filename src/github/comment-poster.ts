import { InlineComment, FileChange, Severity, ReviewConfig } from '../types';
import { GitHubClient } from './client';
import { logger } from '../utils/logger';
import {
  chooseBestAddedLineForComment,
  mapLinesToPositions,
} from '../utils/diff';
import { withRetry } from '../utils/retry';
import {
  isSuggestionLineValid,
  validateSuggestionRange,
  isDeletionOnlyFile,
} from '../utils/suggestion-validator';
import {
  validateSyntax,
  shouldPostSuggestion,
  calculateConfidence,
  ConfidenceSignals,
} from '../validation';
import { SuppressionTracker } from '../learning/suppression-tracker';
import { ProviderWeightTracker } from '../learning/provider-weights';
import { detectLanguage } from '../analysis/ast/parsers';
import {
  appendInlineFingerprintMarker,
  extractInlineFingerprint,
  fingerprintFromInlineComment,
  InlineCommentReference,
  isReviewRouterInlineComment,
  isLikelySameInlineFinding,
  signatureFromInlineComment,
} from './comment-fingerprint';
import {
  ReviewSummaryMetadata,
  appendReviewSummaryMetadata,
  shouldSkipSummaryWriteForExisting,
} from './summary-metadata';

interface ActiveInlineComments {
  keys: Set<string>;
  comments: InlineCommentReference[];
}

interface GitHubInlineCommentPayload {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
}

export interface SummaryPostResult {
  posted: boolean;
  skippedStale: boolean;
  reason?: 'head_sha_changed' | 'newer_summary_exists';
}

type InlineCommentWithLegacyRange = InlineComment & {
  start_line?: unknown;
  end_line?: unknown;
};

interface IssueCommentSummaryCandidate {
  id: number;
  body?: string | null;
}

export class CommentPoster {
  private static readonly MAX_COMMENT_SIZE = 60_000;
  private static readonly BOT_COMMENT_MARKER = '<!-- review-router-bot -->';
  private static readonly INLINE_FALLBACK_MARKER =
    '<!-- review-router-inline-fallback -->';
  private static readonly INLINE_SKIP_HELP_MARKER =
    '<!-- review-router-skip-help -->';

  constructor(
    private readonly client: GitHubClient,
    private readonly dryRun: boolean = false,
    private readonly config?: Partial<ReviewConfig>,
    private readonly suppressionTracker?: SuppressionTracker,
    private readonly providerWeightTracker?: ProviderWeightTracker
  ) {}

  async postSummary(
    prNumber: number,
    body: string,
    updateExisting = true,
    summaryMetadata?: ReviewSummaryMetadata
  ): Promise<SummaryPostResult> {
    const guardedBody = appendReviewSummaryMetadata(body, summaryMetadata);
    const staleHead = await this.shouldSkipForStaleHead(
      prNumber,
      summaryMetadata
    );
    if (staleHead.skippedStale) {
      logger.warn('Skipping summary write because the PR head changed');
      return { posted: false, skippedStale: true, reason: staleHead.reason };
    }

    const chunks = this.chunk(guardedBody);

    if (this.dryRun) {
      logger.info(
        `[DRY RUN] Would post ${chunks.length} summary comment(s) to PR #${prNumber}`
      );
      for (let i = 0; i < chunks.length; i++) {
        const header =
          chunks.length > 1
            ? `## Review Summary (Part ${i + 1}/${chunks.length})\n\n`
            : '';
        const content = header + chunks[i];
        logger.info(
          `[DRY RUN] Summary comment ${i + 1}:\n${content.substring(0, 500)}...`
        );
      }
      return { posted: false, skippedStale: false };
    }

    const { octokit, owner, repo } = this.client;

    const newerSummary = await this.findNewerSummaryComment(
      prNumber,
      summaryMetadata
    );
    if (newerSummary) {
      logger.warn(
        'Skipping summary write because a newer ReviewRouter summary already exists'
      );
      return {
        posted: false,
        skippedStale: true,
        reason: 'newer_summary_exists',
      };
    }

    const markedBodies = chunks.map((chunk, index) => {
      const header =
        chunks.length > 1
          ? `## Review Summary (Part ${index + 1}/${chunks.length})\n\n`
          : '';
      return CommentPoster.BOT_COMMENT_MARKER + '\n\n' + header + chunk;
    });

    if (updateExisting) {
      const updated = await this.updateExistingSummaryComment(
        prNumber,
        markedBodies,
        summaryMetadata
      );
      if (updated) return { posted: true, skippedStale: false };
    }

    for (let i = 0; i < chunks.length; i++) {
      await withRetry(
        () =>
          octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: prNumber,
            body: markedBodies[i],
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );
      if (i < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    return { posted: true, skippedStale: false };
  }

  async deleteSummaryComments(
    prNumber: number,
    summaryMetadata?: ReviewSummaryMetadata,
    reason = 'no current summary findings remain'
  ): Promise<void> {
    if (this.dryRun) return;

    const staleHead = await this.shouldSkipForStaleHead(
      prNumber,
      summaryMetadata
    );
    if (staleHead.skippedStale) {
      logger.warn('Skipping summary cleanup because the PR head changed');
      return;
    }

    const { octokit, owner, repo } = this.client;
    const comments = await this.listIssueComments(prNumber);
    const staleSummaries = comments.filter((comment) => {
      const body = comment.body ?? '';
      return (
        CommentPoster.isSummaryComment(body) &&
        !shouldSkipSummaryWriteForExisting(body, summaryMetadata).shouldSkip
      );
    });

    for (const stale of staleSummaries) {
      await withRetry(
        () =>
          octokit.rest.issues.deleteComment({
            owner,
            repo,
            comment_id: stale.id,
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );
    }

    if (staleSummaries.length > 0) {
      logger.info(
        `Deleted ${staleSummaries.length} stale ReviewRouter summary comment(s): ${reason}`
      );
    }
  }

  private async findNewerSummaryComment(
    prNumber: number,
    summaryMetadata?: ReviewSummaryMetadata
  ): Promise<{ id: number; body: string } | null> {
    if (!summaryMetadata) return null;
    try {
      const comments = await this.listIssueComments(prNumber);
      const newer = comments.find(
        (comment) =>
          shouldSkipSummaryWriteForExisting(comment.body ?? '', summaryMetadata)
            .shouldSkip
      );
      return newer ? { id: newer.id, body: newer.body ?? '' } : null;
    } catch (error) {
      logger.warn('Failed to find newer ReviewRouter summary', error as Error);
      return null;
    }
  }

  private async updateExistingSummaryComment(
    prNumber: number,
    markedBodies: readonly string[],
    summaryMetadata?: ReviewSummaryMetadata
  ): Promise<boolean> {
    const { octokit, owner, repo } = this.client;
    const comments = await this.listIssueComments(prNumber);
    const summaries = comments.filter((comment) => {
      const body = comment.body ?? '';
      return (
        CommentPoster.isSummaryComment(body) &&
        !shouldSkipSummaryWriteForExisting(body, summaryMetadata).shouldSkip
      );
    });
    logger.info(
      `ReviewRouter summary lookup found ${summaries.length} existing summary comment(s) on PR #${prNumber}`
    );
    const target = summaries.at(-1);
    if (!target) {
      logger.info(
        'Creating a new ReviewRouter summary comment because no existing summary was found'
      );
      return false;
    }
    logger.info(`Updating ReviewRouter summary comment ${target.id}`);

    await withRetry(
      () =>
        octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: target.id,
          body: markedBodies[0] ?? CommentPoster.BOT_COMMENT_MARKER,
        }),
      { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
    );

    for (let index = 1; index < markedBodies.length; index += 1) {
      await withRetry(
        () =>
          octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: prNumber,
            body: markedBodies[index],
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );
    }

    const staleSummaries = summaries.filter(
      (summary) => summary.id !== target.id
    );
    for (const stale of staleSummaries) {
      await withRetry(
        () =>
          octokit.rest.issues.deleteComment({
            owner,
            repo,
            comment_id: stale.id,
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );
    }
    if (staleSummaries.length > 0) {
      logger.info(
        `Deleted ${staleSummaries.length} duplicate ReviewRouter summary comment(s)`
      );
    }

    return true;
  }

  private async listIssueComments(
    prNumber: number
  ): Promise<IssueCommentSummaryCandidate[]> {
    const comments = await this.listIssueCommentsViaCommentsApi(prNumber);
    if (
      comments.some((comment) => CommentPoster.isSummaryComment(comment.body))
    ) {
      return comments;
    }

    const timelineComments =
      await this.listIssueCommentsViaTimelineApi(prNumber);
    if (timelineComments.length === 0) {
      return comments;
    }

    const merged = [...comments];
    const knownIds = new Set(comments.map((comment) => comment.id));
    for (const comment of timelineComments) {
      if (!knownIds.has(comment.id)) {
        merged.push(comment);
        knownIds.add(comment.id);
      }
    }
    logger.info(
      `Loaded ${timelineComments.length} issue comment(s) from timeline fallback on PR #${prNumber}`
    );
    return merged;
  }

  private async listIssueCommentsViaCommentsApi(
    prNumber: number
  ): Promise<IssueCommentSummaryCandidate[]> {
    const { octokit, owner, repo } = this.client;
    const comments: IssueCommentSummaryCandidate[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await withRetry(
        () =>
          octokit.rest.issues.listComments({
            owner,
            repo,
            issue_number: prNumber,
            per_page: 100,
            page,
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );
      comments.push(...response.data);
      hasMore = response.data.length === 100;
      page += 1;
    }

    return comments;
  }

  private async listIssueCommentsViaTimelineApi(
    prNumber: number
  ): Promise<IssueCommentSummaryCandidate[]> {
    const { octokit, owner, repo } = this.client;
    if (!octokit.rest.issues.listEventsForTimeline) {
      return [];
    }

    const comments: IssueCommentSummaryCandidate[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await withRetry(
        () =>
          octokit.rest.issues.listEventsForTimeline({
            owner,
            repo,
            issue_number: prNumber,
            per_page: 100,
            page,
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );
      for (const event of response.data) {
        const candidate = event as {
          id?: unknown;
          event?: unknown;
          body?: unknown;
        };
        if (
          candidate.event === 'commented' &&
          typeof candidate.id === 'number'
        ) {
          comments.push({
            id: candidate.id,
            body:
              typeof candidate.body === 'string' ? candidate.body : undefined,
          });
        }
      }
      hasMore = response.data.length === 100;
      page += 1;
    }

    return comments;
  }

  private async shouldSkipForStaleHead(
    prNumber: number,
    summaryMetadata?: ReviewSummaryMetadata
  ): Promise<SummaryPostResult> {
    if (!summaryMetadata?.reviewedHeadSha || this.dryRun) {
      return { posted: false, skippedStale: false };
    }
    try {
      const response = await this.client.octokit.rest.pulls.get({
        owner: this.client.owner,
        repo: this.client.repo,
        pull_number: prNumber,
      });
      const freshHead = response.data.head?.sha;
      if (freshHead && freshHead !== summaryMetadata.reviewedHeadSha) {
        return {
          posted: false,
          skippedStale: true,
          reason: 'head_sha_changed',
        };
      }
    } catch (error) {
      logger.warn(
        'Failed to refresh PR head before summary write; continuing with existing summary behavior',
        error as Error
      );
    }
    return { posted: false, skippedStale: false };
  }

  private static isSummaryComment(body?: string | null): boolean {
    if (!body) return false;
    return (
      body.includes(CommentPoster.BOT_COMMENT_MARKER) &&
      body.includes('# ReviewRouter') &&
      !body.includes(CommentPoster.INLINE_FALLBACK_MARKER) &&
      !body.includes(CommentPoster.INLINE_SKIP_HELP_MARKER)
    );
  }

  private async loadActiveInlineComments(
    prNumber: number
  ): Promise<ActiveInlineComments> {
    const keys = new Set<string>();
    const activeComments: InlineCommentReference[] = [];
    const { octokit, owner, repo } = this.client;

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
        const activeLine = comment.line;
        const body = comment.body || '';
        if (activeLine == null || !isReviewRouterInlineComment(body)) continue;

        activeComments.push({
          path: comment.path,
          line: activeLine,
          body,
        });
        keys.add(signatureFromInlineComment(comment.path, activeLine, body));
        keys.add(fingerprintFromInlineComment(comment.path, activeLine, body));

        const marker = extractInlineFingerprint(body);
        if (marker) keys.add(marker);
      }
    } catch (error) {
      logger.warn(
        'Failed to load existing inline comments for deduplication',
        error as Error
      );
    }

    return { keys, comments: activeComments };
  }

  private hasInlineDuplicate(
    activeComments: ActiveInlineComments,
    path: string,
    line: number,
    body: string
  ): boolean {
    const marker = extractInlineFingerprint(body);
    return (
      activeComments.keys.has(signatureFromInlineComment(path, line, body)) ||
      activeComments.keys.has(fingerprintFromInlineComment(path, line, body)) ||
      (marker ? activeComments.keys.has(marker) : false) ||
      activeComments.comments.some((comment) =>
        isLikelySameInlineFinding(comment, { path, line, body })
      )
    );
  }

  /**
   * Validate and filter suggestions through quality pipeline.
   * Reads pre-computed hasConsensus from Finding (set during aggregation).
   */
  private async validateAndFilterSuggestion(
    comment: InlineComment & {
      suggestion?: string;
      category?: string;
      severity?: Severity;
      provider?: string;
      hasConsensus?: boolean; // Pre-computed during aggregation
      confidence?: number;
    },
    prNumber: number
  ): Promise<{ valid: boolean; reason?: string; hasConsensus?: boolean }> {
    if (!comment.suggestion) {
      return { valid: true }; // No suggestion to validate
    }

    // Check suppression first (fast path)
    if (this.suppressionTracker) {
      const suppressed = await this.suppressionTracker.shouldSuppress(
        {
          category: comment.category || 'unknown',
          file: comment.path,
          line: comment.line,
        },
        prNumber
      );
      if (suppressed) {
        logger.debug(
          `Suggestion suppressed for ${comment.path}:${comment.line} (similar suggestion dismissed)`
        );
        return { valid: false, reason: 'Similar suggestion was dismissed' };
      }
    }

    // Syntax validation (if enabled)
    let syntaxValid = true;
    if (this.config?.suggestionSyntaxValidation !== false) {
      const language = detectLanguage(comment.path);
      if (language !== 'unknown') {
        const syntaxResult = validateSyntax(comment.suggestion, language);
        if (!syntaxResult.isValid && !syntaxResult.skipped) {
          logger.debug(
            `Suggestion syntax invalid for ${comment.path}:${comment.line}: ${syntaxResult.errors.length} error(s)`
          );
          syntaxValid = false;
          // Don't return early - check consensus which might override
        }
      }
    }

    // Read consensus from Finding (set during aggregation, NOT computed here)
    // Consensus checking requires per-provider suggestions which aren't available at comment-posting time
    const hasConsensus = comment.hasConsensus ?? false;
    if (hasConsensus) {
      logger.debug(
        `Consensus detected for ${comment.path}:${comment.line} (providers agreed during aggregation)`
      );
    }

    // If syntax invalid and no consensus to override, reject
    if (!syntaxValid && !hasConsensus) {
      return {
        valid: false,
        reason: 'Syntax validation failed',
        hasConsensus: false,
      };
    }

    // Confidence threshold check
    if (comment.severity && this.config) {
      // Get provider weight for reliability signal
      let providerReliability = 1.0;
      if (this.providerWeightTracker && comment.provider) {
        providerReliability = await this.providerWeightTracker.getWeight(
          comment.provider
        );
      }

      const signals: ConfidenceSignals = {
        llmConfidence: comment.confidence,
        syntaxValid,
        hasConsensus,
        providerReliability,
      };
      const confidence = calculateConfidence(signals);

      // Create minimal Finding object for shouldPostSuggestion
      const minimalFinding = {
        file: comment.path,
        line: comment.line,
        severity: comment.severity,
        title: '',
        message: '',
        providers: comment.provider ? [comment.provider] : [],
        hasConsensus,
      };

      if (
        !shouldPostSuggestion(minimalFinding, confidence, {
          min_confidence: this.config.minConfidence,
          confidence_threshold: this.config.confidenceThreshold,
          consensus: {
            required_for_critical:
              this.config.consensusRequiredForCritical ?? true,
            min_agreement: this.config.consensusMinAgreement ?? 2,
          },
        })
      ) {
        logger.debug(
          `Suggestion below confidence threshold for ${comment.path}:${comment.line} (confidence: ${confidence.toFixed(2)})`
        );
        return {
          valid: false,
          reason: 'Below confidence threshold',
          hasConsensus,
        };
      }
    }

    return { valid: true, hasConsensus };
  }

  async postInline(
    prNumber: number,
    comments: InlineComment[],
    files: FileChange[],
    headSha?: string,
    dedupeComments?: InlineCommentReference[]
  ): Promise<void> {
    if (comments.length === 0) {
      if (!this.dryRun) {
        await this.deleteInlineFallbackComments(
          prNumber,
          'no current inline findings remain'
        );
      }
      return;
    }
    const activeInlineComments = this.dryRun
      ? { keys: new Set<string>(), comments: [] }
      : dedupeComments
        ? CommentPoster.activeInlineCommentsFromReferences(dedupeComments)
        : await this.loadActiveInlineComments(prNumber);

    // Filter out deletion-only files (no suggestions possible)
    const filesWithAdditions = files.filter((f) => !isDeletionOnlyFile(f));
    const filesWithAdditionsSet = new Set(
      filesWithAdditions.map((f) => f.filename)
    );

    // Build a map from file path to line->position mapping
    const positionMaps = new Map<string, Map<number, number>>();
    for (const file of files) {
      positionMaps.set(file.filename, mapLinesToPositions(file.patch));
    }

    // Sort comments for optimal batch commit UX (top-to-bottom per file)
    const sortedComments = [...comments].sort((a, b) => {
      const pathCompare = a.path.localeCompare(b.path);
      if (pathCompare !== 0) return pathCompare;
      return a.line - b.line;
    });

    // Convert comments to GitHub API format, filtering out those without valid positions
    const apiComments = (
      await Promise.all(
        sortedComments.map(async (c) => {
          const file = files.find((f) => f.filename === c.path);
          const rangedComment = c as InlineCommentWithLegacyRange;
          const requestedEndLine = CommentPoster.integerOrUndefined(
            c.endLine ?? rangedComment.end_line
          );
          if (requestedEndLine !== undefined && requestedEndLine !== c.line) {
            logger.debug(
              `Using inline comment end line for ${c.path}: ${c.line} -> ${requestedEndLine}`
            );
            c.line = requestedEndLine;
          }
          const correctedLine =
            c.side !== 'LEFT'
              ? chooseBestAddedLineForComment(file?.patch, c.line, c.body)
              : c.line;
          if (correctedLine !== c.line) {
            logger.debug(
              `Adjusted inline comment line for ${c.path}: ${c.line} -> ${correctedLine}`
            );
            c.line = correctedLine;
          }

          const posMap = positionMaps.get(c.path);
          const position = posMap?.get(c.line);
          if (!position) {
            logger.warn(
              `Cannot find diff position for ${c.path}:${c.line}, skipping inline comment`
            );
            return null;
          }

          let startLine = CommentPoster.integerOrUndefined(
            c.startLine ?? rangedComment.start_line
          );
          if (startLine !== undefined) {
            if (startLine === c.line) {
              startLine = undefined;
            } else {
              const validation = validateSuggestionRange(
                startLine,
                c.line,
                file?.patch
              );
              if (!validation.isValid) {
                logger.debug(
                  `Inline comment range invalid at ${c.path}:${startLine}-${c.line}: ${validation.reason}`
                );
                startLine = undefined;
              }
            }
          }

          // Validate suggestions can be applied at this line/range
          if (c.body.includes('```suggestion')) {
            // Skip suggestions for deletion-only files
            if (!filesWithAdditionsSet.has(c.path)) {
              logger.debug(
                `Skipping suggestion for deletion-only file: ${c.path}`
              );
              c.body = c.body.replace(
                /```suggestion[\s\S]*?```/g,
                '_Suggestion not available (file has no additions)_'
              );
            } else if (file?.patch) {
              // Check if this is a multi-line suggestion (has start_line)
              if (startLine !== undefined && startLine !== c.line) {
                // Multi-line suggestion - validate range
                const validation = validateSuggestionRange(
                  startLine,
                  c.line,
                  file.patch
                );
                if (!validation.isValid) {
                  logger.debug(
                    `Multi-line suggestion invalid at ${c.path}:${startLine}-${c.line}: ${validation.reason}`
                  );
                  c.body = c.body.replace(
                    /```suggestion[\s\S]*?```/g,
                    `_Suggestion not available: ${validation.reason}_`
                  );
                }
              } else {
                // Single-line suggestion - use existing validation
                if (!isSuggestionLineValid(c.line, file.patch)) {
                  logger.debug(
                    `Suggestion line ${c.path}:${c.line} not valid in diff, posting without suggestion block`
                  );
                  c.body = c.body.replace(
                    /```suggestion[\s\S]*?```/g,
                    '_Suggestion not available for this line_'
                  );
                }
              }
            }

            // Quality gate validation (syntax, suppression, confidence)
            // Extract suggestion content for validation
            const suggestionMatch = c.body.match(
              /```suggestion\n([\s\S]*?)```/
            );
            if (
              suggestionMatch &&
              !c.body.includes('_Suggestion not available')
            ) {
              const suggestionContent = suggestionMatch[1];
              const qualityValidation = await this.validateAndFilterSuggestion(
                {
                  ...c,
                  suggestion: suggestionContent,
                  category: c.category,
                  severity: c.severity,
                  provider: c.provider,
                  hasConsensus: c.hasConsensus,
                  confidence: c.confidence,
                },
                prNumber
              );
              if (!qualityValidation.valid) {
                c.body = c.body.replace(
                  /```suggestion[\s\S]*?```/g,
                  `_Suggestion not available: ${qualityValidation.reason}_`
                );
              }
            }
          }

          const apiComment: GitHubInlineCommentPayload = {
            path: c.path,
            line: c.line,
            side: c.side || 'RIGHT',
            body: CommentPoster.withSkipHelpFooter(
              appendInlineFingerprintMarker(c.body, c.path, c.line),
              c.severity
            ),
          };

          if (
            this.hasInlineDuplicate(
              activeInlineComments,
              c.path,
              c.line,
              apiComment.body
            )
          ) {
            logger.info(
              `Skipping duplicate active inline comment at ${c.path}:${c.line}`
            );
            return null;
          }

          activeInlineComments.keys.add(
            signatureFromInlineComment(c.path, c.line, apiComment.body)
          );
          activeInlineComments.keys.add(
            fingerprintFromInlineComment(c.path, c.line, apiComment.body)
          );
          const marker = extractInlineFingerprint(apiComment.body);
          if (marker) activeInlineComments.keys.add(marker);
          activeInlineComments.comments.push({
            path: c.path,
            line: c.line,
            body: apiComment.body,
          });

          if (startLine !== undefined && startLine !== c.line) {
            // Multi-line: use line-based parameters.
            apiComment.start_line = startLine;
            apiComment.start_side = 'RIGHT';
          }
          return apiComment;
        })
      )
    ).filter((c): c is GitHubInlineCommentPayload => c !== null);

    if (apiComments.length === 0) {
      logger.info('No inline comments with valid diff positions to post');
      return;
    }

    if (this.dryRun) {
      logger.info(
        `[DRY RUN] Would post ${apiComments.length} inline comment(s) to PR #${prNumber}`
      );
      for (const comment of apiComments) {
        logger.info(
          `[DRY RUN] Inline comment at ${comment.path}:${comment.line}:\n${comment.body.substring(0, 200)}...`
        );
      }
      return;
    }

    const { octokit, owner, repo } = this.client;
    try {
      await withRetry(
        () =>
          octokit.rest.pulls.createReview({
            owner,
            repo,
            pull_number: prNumber,
            event: 'COMMENT',
            comments: apiComments,
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );
      await this.deleteInlineFallbackComments(
        prNumber,
        'inline comments posted successfully'
      );
    } catch (error) {
      if (!CommentPoster.shouldFallbackInlineReviewError(error)) {
        throw error;
      }

      logger.warn(
        'GitHub inline review API failed; posting inline findings as a PR comment fallback',
        error as Error
      );
      const remainingComments = headSha
        ? await this.postIndividualInlineComments(
            prNumber,
            apiComments,
            headSha,
            error as Error
          )
        : apiComments;
      if (remainingComments.length > 0) {
        await this.postInlineFallback(
          prNumber,
          remainingComments,
          error as Error
        );
      } else {
        await this.deleteInlineFallbackComments(
          prNumber,
          'inline comments posted successfully'
        );
      }
    }
  }

  private static activeInlineCommentsFromReferences(
    references: InlineCommentReference[]
  ): ActiveInlineComments {
    const keys = new Set<string>();
    const comments: InlineCommentReference[] = [];

    for (const comment of references) {
      const body = comment.body || '';
      comments.push(comment);
      keys.add(signatureFromInlineComment(comment.path, comment.line, body));
      keys.add(fingerprintFromInlineComment(comment.path, comment.line, body));
      const marker = extractInlineFingerprint(body);
      if (marker) keys.add(marker);
    }

    return { keys, comments };
  }

  private async postIndividualInlineComments(
    prNumber: number,
    comments: GitHubInlineCommentPayload[],
    headSha: string,
    originalError: Error
  ): Promise<GitHubInlineCommentPayload[]> {
    const { octokit, owner, repo } = this.client;
    const failedComments: GitHubInlineCommentPayload[] = [];
    let postedCount = 0;

    for (const comment of comments) {
      try {
        await withRetry(
          () =>
            octokit.rest.pulls.createReviewComment({
              owner,
              repo,
              pull_number: prNumber,
              commit_id: headSha,
              path: comment.path,
              line: comment.line,
              side: comment.side,
              ...(comment.start_line !== undefined
                ? { start_line: comment.start_line }
                : {}),
              ...(comment.start_side !== undefined
                ? { start_side: comment.start_side }
                : {}),
              body: comment.body,
            }),
          { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
        );
        postedCount++;
      } catch (error) {
        if (!CommentPoster.shouldFallbackInlineReviewError(error)) {
          throw error;
        }
        const retryComment =
          CommentPoster.withoutCommittableSuggestionForInlineRetry(comment);
        if (retryComment.body !== comment.body) {
          try {
            await withRetry(
              () =>
                octokit.rest.pulls.createReviewComment({
                  owner,
                  repo,
                  pull_number: prNumber,
                  commit_id: headSha,
                  path: retryComment.path,
                  line: retryComment.line,
                  side: retryComment.side,
                  ...(retryComment.start_line !== undefined
                    ? { start_line: retryComment.start_line }
                    : {}),
                  ...(retryComment.start_side !== undefined
                    ? { start_side: retryComment.start_side }
                    : {}),
                  body: retryComment.body,
                }),
              { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
            );
            logger.info(
              `Posted inline comment at ${comment.path}:${comment.line} after removing committable suggestion block rejected by GitHub`
            );
            postedCount++;
            continue;
          } catch (retryError) {
            if (!CommentPoster.shouldFallbackInlineReviewError(retryError)) {
              throw retryError;
            }
          }
        }

        failedComments.push(comment);
      }
    }

    if (postedCount > 0) {
      logger.info(
        `Posted ${postedCount}/${comments.length} inline comment(s) through individual GitHub review-comment API after batch review failed`
      );
    }
    if (failedComments.length > 0) {
      logger.warn(
        `Falling back to PR comment for ${failedComments.length}/${comments.length} inline finding(s) after GitHub rejected batch and individual inline comment APIs`,
        originalError
      );
    }

    return failedComments;
  }

  private static shouldFallbackInlineReviewError(error: unknown): boolean {
    const maybeError = error as { status?: number; message?: string };
    const message = maybeError?.message || String(error);
    return (
      maybeError?.status === 422 ||
      /unprocessable entity/i.test(message) ||
      /internal error occurred/i.test(message) ||
      /validation failed/i.test(message)
    );
  }

  private static withoutCommittableSuggestionForInlineRetry(
    comment: GitHubInlineCommentPayload
  ): GitHubInlineCommentPayload {
    if (!comment.body.includes('```suggestion')) {
      return comment;
    }

    return {
      ...comment,
      body: comment.body
        .replace(
          /```suggestion[\s\S]*?```/g,
          '_Committable suggestion omitted because GitHub rejected this inline suggestion block._'
        )
        .trim(),
    };
  }

  private static integerOrUndefined(value: unknown): number | undefined {
    return Number.isInteger(value) ? (value as number) : undefined;
  }

  private async postInlineFallback(
    prNumber: number,
    comments: GitHubInlineCommentPayload[],
    error: Error
  ): Promise<void> {
    const { octokit, owner, repo } = this.client;
    const body = CommentPoster.formatInlineFallbackBody(comments, error);
    const chunks = this.chunk(body);
    const existingComments = await this.findInlineFallbackComments(prNumber);

    const updates = Math.min(existingComments.length, chunks.length);
    for (let i = 0; i < updates; i++) {
      await withRetry(
        () =>
          octokit.rest.issues.updateComment({
            owner,
            repo,
            comment_id: existingComments[i].id,
            body: chunks[i],
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );
    }

    for (let i = existingComments.length; i < chunks.length; i++) {
      await withRetry(
        () =>
          octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: prNumber,
            body: chunks[i],
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );
    }

    for (const stale of existingComments.slice(chunks.length)) {
      await withRetry(
        () =>
          octokit.rest.issues.deleteComment({
            owner,
            repo,
            comment_id: stale.id,
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );
    }
  }

  private async findInlineFallbackComments(
    prNumber: number
  ): Promise<Array<{ id: number; body: string }>> {
    const { octokit, owner, repo } = this.client;

    try {
      const comments = await withRetry(
        () =>
          octokit.rest.issues.listComments({
            owner,
            repo,
            issue_number: prNumber,
            per_page: 100,
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );

      return comments.data
        .filter((comment) =>
          (comment.body || '').includes(CommentPoster.INLINE_FALLBACK_MARKER)
        )
        .map((comment) => ({ id: comment.id, body: comment.body ?? '' }));
    } catch (error) {
      logger.warn(
        'Failed to find existing inline fallback comment',
        error as Error
      );
      return [];
    }
  }

  private async deleteInlineFallbackComments(
    prNumber: number,
    reason: string
  ): Promise<void> {
    const { octokit, owner, repo } = this.client;
    const existingComments = await this.findInlineFallbackComments(prNumber);

    for (const comment of existingComments) {
      await withRetry(
        () =>
          octokit.rest.issues.deleteComment({
            owner,
            repo,
            comment_id: comment.id,
          }),
        { retries: 2, minTimeout: 1000, maxTimeout: 5000 }
      );
    }

    if (existingComments.length > 0) {
      logger.info(
        `Deleted ${existingComments.length} stale inline fallback comment(s): ${reason}`
      );
    }
  }

  private static formatInlineFallbackBody(
    comments: GitHubInlineCommentPayload[],
    error: Error
  ): string {
    const errorMessage = (error.message || String(error)).slice(0, 2000);
    const items = comments
      .map((comment, index) =>
        [
          `### ${index + 1}. ${CommentPoster.formatApiCommentLocation(comment)}`,
          '',
          CommentPoster.stripUnsupportedFallbackText(comment.body),
        ].join('\n')
      )
      .join('\n\n---\n\n');

    return [
      CommentPoster.INLINE_FALLBACK_MARKER,
      '',
      '# ReviewRouter inline fallback',
      '',
      'GitHub could not create inline review comments for this run, so ReviewRouter is posting the findings as a normal PR comment. Severity gating still uses these findings.',
      '',
      '<details>',
      '<summary>GitHub API error</summary>',
      '',
      '```text',
      errorMessage,
      '```',
      '',
      '</details>',
      '',
      '## Findings',
      '',
      items,
    ].join('\n');
  }

  private static formatApiCommentLocation(
    comment: GitHubInlineCommentPayload
  ): string {
    return comment.start_line !== undefined && comment.start_line < comment.line
      ? `${comment.path}:${comment.start_line}-${comment.line}`
      : `${comment.path}:${comment.line}`;
  }

  private static stripUnsupportedFallbackText(body: string): string {
    return body
      .replace(/<sub><!-- review-router-skip-help -->[\s\S]*?<\/sub>/g, '')
      .replace(
        /```suggestion[\s\S]*?```/g,
        '_Committable suggestion is only available on inline review comments._'
      )
      .trim();
  }

  private chunk(content: string): string[] {
    const paragraphs = content.split('\n\n');
    const chunks: string[] = [];
    let current = '';

    for (const para of paragraphs) {
      if (
        Buffer.byteLength(current + para, 'utf8') >
        CommentPoster.MAX_COMMENT_SIZE
      ) {
        if (current) {
          chunks.push(current.trim());
          current = '';
        }
        if (Buffer.byteLength(para, 'utf8') > CommentPoster.MAX_COMMENT_SIZE) {
          const lines = para.split('\n');
          let lineChunk = '';
          for (const line of lines) {
            if (
              Buffer.byteLength(lineChunk + line + '\n', 'utf8') >
              CommentPoster.MAX_COMMENT_SIZE
            ) {
              chunks.push(lineChunk.trim());
              lineChunk = '';
            }
            lineChunk += line + '\n';
          }
          current = lineChunk + '\n\n';
        } else {
          current = para + '\n\n';
        }
      } else {
        current += para + '\n\n';
      }
    }

    if (current.trim()) chunks.push(current.trim());
    logger.info(`Prepared ${chunks.length} comment chunk(s)`);
    return chunks;
  }

  private static withSkipHelpFooter(body: string, severity?: Severity): string {
    if (body.includes(CommentPoster.INLINE_SKIP_HELP_MARKER)) {
      return body;
    }

    const actor =
      severity === 'minor' ? 'Someone with write access' : 'A maintainer/admin';
    const footer = `<sub>${CommentPoster.INLINE_SKIP_HELP_MARKER}${actor} can reply \`/rr skip\` if this finding is a false positive. ReviewRouter records a signed override and reruns the check.</sub>`;
    const { visibleBody, markers } = CommentPoster.splitTrailingInlineMarkers(
      body.trimEnd()
    );
    return [visibleBody, footer, ...markers].join('\n');
  }

  private static splitTrailingInlineMarkers(body: string): {
    visibleBody: string;
    markers: string[];
  } {
    const markers: string[] = [];
    let visibleBody = body;
    const markerPattern =
      /\n\n(<!--\s*(?:(?:review-router|ai-robot-review)-inline:[a-f0-9]{16}|review-router-finding:[a-f0-9]{24,64})\s*-->)$/i;

    let match = visibleBody.match(markerPattern);
    while (match?.[1]) {
      markers.unshift(match[1]);
      visibleBody = visibleBody.slice(0, match.index).trimEnd();
      match = visibleBody.match(markerPattern);
    }

    return { visibleBody, markers };
  }
}
