import type { ReviewPresentation } from '../review-projection/domain/review-presentation';

/** Stateless, non-identifying image query; failure is always text-only. */
export function renderReviewBanner(
  baseUrl: string | undefined,
  presentation: ReviewPresentation
): string {
  if (!baseUrl) return '';
  const numeric = {
    ...presentation.severity,
    ...presentation.coverage,
    ...presentation.changes,
  };
  if (
    !Object.values(numeric).every(
      (value) => Number.isSafeInteger(value) && value >= 0 && value <= 9999
    )
  )
    return '';
  if (
    presentation.coverage &&
    presentation.coverage.reviewed > presentation.coverage.total
  )
    return '';
  if (
    presentation.variant === 'first'
      ? !!presentation.changes
      : !presentation.changes
  )
    return '';
  if (
    presentation.changes &&
    (presentation.changes.new > presentation.changes.open ||
      presentation.changes.unverified > presentation.changes.open)
  )
    return '';
  try {
    const base = new URL(baseUrl);
    if (
      base.protocol !== 'https:' ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== '/'
    )
      return '';
    const url = new URL('/review-banner/v1.svg', base);
    url.search = new URLSearchParams({
      state: presentation.state,
      variant: presentation.variant,
      ...Object.fromEntries(
        Object.entries(numeric).map(([key, value]) => [key, String(value)])
      ),
    }).toString();
    const source = (layout: 'compact' | 'wide') =>
      `${url}&theme=auto&layout=${layout}`.replaceAll('&', '&amp;');
    return `<picture>\n<source media="(max-width: 600px)" srcset="${source('compact')}">\n<img src="${source('wide')}" alt="${presentation.state === 'incomplete' ? 'Review incomplete' : presentation.variant === 'update' ? 'Review updated' : 'Review complete'}" width="100%">\n</picture>`;
  } catch {
    return '';
  }
}

export function reviewPresentationHeading(
  presentation: ReviewPresentation
): string {
  if (presentation.variant === 'update' && presentation.changes) {
    const changes = presentation.changes;
    return `## ${presentation.state === 'incomplete' ? 'Review incomplete' : 'Review updated'}\n\n${changes.new} new · ${changes.resolved} resolved · ${changes.open} open${changes.unverified ? ` · ${changes.unverified} unverified (included in open)` : ''}`;
  }
  return '';
}
