import {
  renderReviewBanner,
  reviewPresentationHeading,
} from '../../../src/output/review-banner';
import type { ReviewPresentation } from '../../../src/review-projection/domain/review-presentation';

const fixes: ReviewPresentation = {
  variant: 'update',
  state: 'complete',
  severity: { critical: 0, major: 0, minor: 0, info: 0 },
  changes: { new: 0, resolved: 0, open: 0, unverified: 0 },
  verification: { fixesVerified: 4, unverified: 0, confirmedOpen: 0 },
};
const urls = (html: string) =>
  [...html.matchAll(/(?:src|srcset)="([^"]+)"/g)].map(
    (match) => new URL(match[1]!.replaceAll('&amp;', '&'))
  );

describe('verification banner query', () => {
  it('adds only the finite verification count trio to both responsive URLs', () => {
    const images = urls(renderReviewBanner('https://reviewrouter.org', fixes));
    expect(images.map((url) => url.searchParams.get('layout'))).toEqual([
      'compact',
      'wide',
    ]);
    for (const image of images) {
      expect(Object.fromEntries(image.searchParams)).toMatchObject({
        verified: '4',
        not_verified: '0',
        confirmed_open: '0',
        resolved: '0',
      });
      expect(image.pathname).toBe('/review-banner/v1.svg');
    }
    expect(reviewPresentationHeading(fixes)).toContain('4 fixes verified');
    expect(reviewPresentationHeading(fixes)).toContain('0 resolved');
    expect(
      reviewPresentationHeading({
        variant: 'first',
        state: 'complete',
        severity: fixes.severity,
        verification: fixes.verification!,
      })
    ).toBe('## 4 fixes verified');
  });

  it('keeps no-baseline unknown targets visible without manufacturing occurrence counts', () => {
    const presentation: ReviewPresentation = {
      variant: 'first',
      state: 'incomplete',
      severity: fixes.severity,
      verification: { fixesVerified: 0, unverified: 4, confirmedOpen: 0 },
    };
    for (const image of urls(
      renderReviewBanner('https://reviewrouter.org', presentation)
    )) {
      expect(image.searchParams.get('not_verified')).toBe('4');
      expect(image.searchParams.has('open')).toBe(false);
      expect(image.searchParams.has('resolved')).toBe(false);
    }
    expect(reviewPresentationHeading(presentation)).toBe(
      '## Review incomplete\n\n4 previous issues not verified'
    );
    expect(
      reviewPresentationHeading({ ...presentation, state: 'complete' })
    ).toContain('Review incomplete');
    expect(
      renderReviewBanner('https://reviewrouter.org', {
        ...presentation,
        state: 'complete',
      })
    ).toContain('alt="Verification incomplete"');
  });

  it('keeps new, verified and unverified counters separate in the text fallback', () => {
    const presentation: ReviewPresentation = {
      ...fixes,
      changes: { new: 1, resolved: 0, open: 1, unverified: 0 },
      verification: { fixesVerified: 2, unverified: 1, confirmedOpen: 0 },
    };
    expect(reviewPresentationHeading(presentation)).toBe(
      '## Review updated\n\n1 new · 0 resolved · 2 fixes verified · 1 confirmed open · 1 previous issue not verified'
    );
  });

  it('leaves installed URLs and headings unchanged without the extension', () => {
    const { verification: _verification, ...installed } = fixes;
    const images = urls(
      renderReviewBanner('https://reviewrouter.org', installed)
    );
    expect(images[1]!.search).toBe(
      '?state=complete&variant=update&critical=0&major=0&minor=0&info=0&new=0&resolved=0&open=0&unverified=0&theme=auto&layout=wide'
    );
    expect(reviewPresentationHeading(installed)).toBe(
      '## Review updated\n\n0 new · 0 resolved · 0 confirmed open'
    );
    expect(renderReviewBanner('https://reviewrouter.org', installed)).toContain(
      'alt="Review updated"'
    );
    expect(
      renderReviewBanner('https://reviewrouter.org', {
        variant: 'first',
        state: 'complete',
        severity: fixes.severity,
      })
    ).toContain('alt="Review complete"');
  });

  it.each([-1, 10000, 1.5, NaN, Infinity])(
    'omits an image with an invalid verification count: %s',
    (count) => {
      expect(
        renderReviewBanner('https://reviewrouter.org', {
          ...fixes,
          verification: {
            fixesVerified: count,
            unverified: 0,
            confirmedOpen: 0,
          },
        })
      ).toBe('');
    }
  );
});
