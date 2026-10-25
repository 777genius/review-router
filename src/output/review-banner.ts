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
    ...(presentation.verification
      ? {
          verified: presentation.verification.fixesVerified,
          not_verified: presentation.verification.unverified,
          confirmed_open: presentation.verification.confirmedOpen,
        }
      : {}),
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
    const verification = presentation.verification;
    const verificationUnknownOnly =
      !!verification &&
      verification.unverified > 0 &&
      verification.fixesVerified === 0 &&
      verification.confirmedOpen === 0 &&
      Object.values(presentation.severity).every((count) => count === 0) &&
      (presentation.variant === 'first' ||
        (presentation.changes?.new === 0 &&
          presentation.changes.resolved === 0));
    const alt = verificationUnknownOnly
      ? 'Verification incomplete'
      : presentation.state === 'incomplete'
        ? 'Review incomplete'
        : presentation.variant === 'update'
          ? 'Review updated'
          : 'Review complete';
    return `<picture>\n<source media="(max-width: 600px)" srcset="${source('compact')}">\n<img src="${source('wide')}" alt="${alt}" width="100%">\n</picture>`;
  } catch {
    return '';
  }
}

export function reviewPresentationHeading(
  presentation: ReviewPresentation
): string {
  const verification = presentation.verification;
  const verifiedFixes = verification
    ? `${verification.fixesVerified} ${verification.fixesVerified === 1 ? 'fix' : 'fixes'} verified`
    : '';
  if (presentation.variant === 'update' && presentation.changes) {
    const changes = presentation.changes;
    const confirmedOpen = Math.max(0, changes.open - changes.unverified);
    const unverified = verification?.unverified ?? changes.unverified;
    return `## ${presentation.state === 'incomplete' ? 'Review incomplete' : 'Review updated'}\n\n${changes.new} new · ${changes.resolved} resolved${verification?.fixesVerified ? ` · ${verifiedFixes}` : ''} · ${confirmedOpen} confirmed open${unverified ? ` · ${unverified} previous ${unverified === 1 ? 'issue' : 'issues'} not verified` : ''}`;
  }
  if (
    verification &&
    Object.values(presentation.severity).every((count) => count === 0)
  ) {
    const detail =
      verification.fixesVerified > 0
        ? verifiedFixes
        : verification.unverified > 0
          ? `${verification.unverified} previous ${verification.unverified === 1 ? 'issue' : 'issues'} not verified`
          : '';
    if (detail)
      return presentation.state === 'incomplete' || verification.unverified > 0
        ? `## Review incomplete\n\n${detail}`
        : `## ${detail}`;
  }
  return '';
}
