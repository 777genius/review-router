import { Review } from '../types';
import { renderReviewSummary } from './reviewer-summary';

/** Compatibility facade; all review paths share one presentation renderer. */
export class MarkdownFormatterV2 {
  format(review: Review): string {
    return renderReviewSummary(review);
  }
}
