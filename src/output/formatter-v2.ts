import { Review } from '../types';
import {
  renderReviewSummary,
  type ReviewerSummaryOptions,
} from './reviewer-summary';

/** Compatibility facade; all review paths share one presentation renderer. */
export class MarkdownFormatterV2 {
  constructor(private readonly options: ReviewerSummaryOptions = {}) {}

  format(
    review: Review,
    options: ReviewerSummaryOptions = this.options
  ): string {
    return renderReviewSummary(review, undefined, options);
  }
}
