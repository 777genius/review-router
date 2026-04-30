import { Octokit } from '@octokit/rest';
import { logger } from '../utils/logger';

export type ProgressStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ProgressItem {
  id: string;
  label: string;
  status: ProgressStatus;
  details?: string;
  startTime?: number;
  endTime?: number;
}

export interface ProgressTrackerConfig {
  owner: string;
  repo: string;
  prNumber: number;
  updateStrategy: 'milestone' | 'debounced' | 'realtime';
}

/**
 * Tracks and displays review progress in a live-updating PR comment
 *
 * Inspired by Claude Code Action's progress tracking approach:
 * - Single comment that updates throughout review
 * - Checkboxes show completion status
 *
 * Update strategy: milestone-based (only major events to minimize API calls)
 */
export class ProgressTracker {
  private commentId: number | null = null;
  private items: Map<string, ProgressItem> = new Map();
  private startTime: number = Date.now();
  private totalCost: number = 0;
  private overrideBody?: string;
  private static readonly MARKER = '<!-- ai-robot-review-progress-tracker -->';
  private static readonly LEGACY_HEADERS = [
    '# AI Robot Review',
    '## 🤖 AI Robot Review Progress',
  ];

  constructor(
    private octokit: Octokit,
    private config: ProgressTrackerConfig
  ) {}

  /**
   * Initialize progress tracking by creating the initial comment
   */
  async initialize(): Promise<void> {
    if (!this.octokit?.rest?.issues?.createComment) {
      logger.warn('Progress tracker unavailable: octokit.rest.issues.createComment is missing');
      return;
    }
    try {
      const body = this.formatProgressComment();
      const existingCommentId = await this.findExistingCommentId();
      if (existingCommentId) {
        this.commentId = existingCommentId;
        await this.updateComment();
        logger.info('Progress tracker initialized from existing comment', { commentId: this.commentId });
        return;
      }

      const comment = await this.octokit.rest.issues.createComment({
        owner: this.config.owner,
        repo: this.config.repo,
        issue_number: this.config.prNumber,
        body,
      });

      this.commentId = comment.data.id;
      logger.info('Progress tracker initialized', { commentId: this.commentId });
    } catch (error) {
      logger.error('Failed to initialize progress tracker', error as Error);
      // Continue without progress tracking rather than failing the review
    }
  }

  /**
   * Add a new progress item to track
   */
  addItem(id: string, label: string): void {
    this.items.set(id, {
      id,
      label,
      status: 'pending',
      startTime: Date.now(),
    });

    logger.debug(`Progress item added: ${id}`, { label });
  }

  /**
   * Update progress for a specific item
   * Only updates comment on milestone events (completed/failed)
   */
  async updateProgress(
    itemId: string,
    status: ProgressStatus,
    details?: string
  ): Promise<void> {
    const item = this.items.get(itemId);
    if (!item) {
      logger.warn(`Progress item not found: ${itemId}`);
      return;
    }

    item.status = status;
    item.details = details;

    if (status === 'completed' || status === 'failed') {
      item.endTime = Date.now();

      // Milestone-based update: only update comment on completion/failure
      await this.updateComment();
    }

    logger.debug(`Progress updated: ${itemId}`, { status, details });
  }

  /**
   * Set total cost for metadata display
   */
  setTotalCost(cost: number): void {
    this.totalCost = cost;
  }

  /**
   * Finalize progress tracking with summary
   */
  async finalize(success: boolean): Promise<void> {
    const duration = Date.now() - this.startTime;

    // Update all pending items to final status
    this.items.forEach((item) => {
      if (item.status === 'pending' || item.status === 'in_progress') {
        item.status = success ? 'completed' : 'failed';
        item.endTime = Date.now();
      }
    });

    if (!this.overrideBody) {
      await this.updateComment();
    }

    logger.info('Progress tracker finalized', {
      success,
      duration,
      totalCost: this.totalCost,
    });
  }

  /**
   * Format progress comment with checkboxes and status emojis
   */
  private formatProgressComment(): string {
    const lines: string[] = [];

    // Header
    lines.push('## 🤖 AI Robot Review Progress\n');

    // Progress items with checkboxes
    const sortedItems = Array.from(this.items.values()).sort(
      (a, b) => (a.startTime || 0) - (b.startTime || 0)
    );

    for (const item of sortedItems) {
      const checkbox = item.status === 'completed' ? '[x]' : '[ ]';
      const emoji = this.getStatusEmoji(item.status);
      lines.push(`${checkbox} ${emoji} ${item.label}`);

      if (item.details) {
        lines.push(`   └─ ${item.details}`);
      }
    }

    lines.push(ProgressTracker.MARKER);

    return lines.join('\n');
  }

  /**
   * Update the progress comment (GitHub API call)
   */
  private async updateComment(): Promise<void> {
    if (!this.commentId) {
      logger.warn('Cannot update progress: comment not initialized');
      return;
    }
    if (!this.octokit?.rest?.issues?.updateComment) {
      logger.warn('Cannot update progress: octokit.rest.issues.updateComment is missing');
      return;
    }

    try {
      const body = this.overrideBody ?? this.formatProgressComment();

      await this.octokit.rest.issues.updateComment({
        owner: this.config.owner,
        repo: this.config.repo,
        comment_id: this.commentId,
        body,
      });

      logger.debug('Progress comment updated', { commentId: this.commentId });
    } catch (error) {
      logger.error('Failed to update progress comment', error as Error);
      // Don't throw - progress tracking failure shouldn't stop the review
    }
  }

  /**
   * Replace the progress comment with a final body (e.g., combined progress + review)
   */
  async replaceWith(body: string): Promise<void> {
    if (!this.commentId) {
      logger.warn('Cannot replace progress: comment not initialized');
      return;
    }
    if (!this.octokit?.rest?.issues?.updateComment) {
      logger.warn('Cannot replace progress: octokit.rest.issues.updateComment is missing');
      return;
    }
    this.overrideBody = this.withMarker(body);
    await this.octokit.rest.issues.updateComment({
      owner: this.config.owner,
      repo: this.config.repo,
      comment_id: this.commentId,
      body: this.overrideBody,
    });
  }

  private async findExistingCommentId(): Promise<number | null> {
    if (!this.octokit?.rest?.issues?.listComments) {
      return null;
    }

    try {
      const comments = await this.octokit.rest.issues.listComments({
        owner: this.config.owner,
        repo: this.config.repo,
        issue_number: this.config.prNumber,
        per_page: 100,
      });

      const matching = comments.data.filter(comment => this.isReviewComment(comment.body));
      return matching.length > 0 ? matching[matching.length - 1].id : null;
    } catch (error) {
      logger.warn('Failed to find existing progress comment', error as Error);
      return null;
    }
  }

  private isReviewComment(body?: string | null): boolean {
    if (!body) return false;
    return body.includes(ProgressTracker.MARKER)
      || ProgressTracker.LEGACY_HEADERS.some(header => body.startsWith(header));
  }

  private withMarker(body: string): string {
    return body.includes(ProgressTracker.MARKER)
      ? body
      : `${body.trimEnd()}\n\n${ProgressTracker.MARKER}`;
  }

  /**
   * Get status emoji for visual feedback
   */
  private getStatusEmoji(status: ProgressStatus): string {
    switch (status) {
      case 'completed':
        return '✅';
      case 'failed':
        return '❌';
      case 'in_progress':
        return '🔄';
      case 'pending':
        return '⏳';
      default:
        return '⬜';
    }
  }
}
