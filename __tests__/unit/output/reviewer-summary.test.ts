import {
  renderReviewerLifecycleMarkdown,
  renderReviewerSummaryMarkdown,
  resolveReviewerSummaryLocale,
} from '../../../src/output/reviewer-summary';

describe('reviewer summary markdown', () => {
  const metrics = {
    totalFindings: 1,
    critical: 0,
    major: 1,
    minor: 0,
    providersUsed: 1,
    providersSuccess: 1,
  };

  it('maps dashboard language names onto summary locales', () => {
    expect(resolveReviewerSummaryLocale(undefined)).toBe('en');
    expect(resolveReviewerSummaryLocale('English')).toBe('en');
    expect(resolveReviewerSummaryLocale('Russian')).toBe('ru');
    expect(resolveReviewerSummaryLocale('Русский')).toBe('ru');
    expect(resolveReviewerSummaryLocale('Ukrainian')).toBe('uk');
  });

  it('keeps the summary scannable while retaining full finding text for agents', () => {
    const markdown = renderReviewerSummaryMarkdown({
      language: 'English',
      metrics,
      findings: [
        {
          severity: 'major',
          title: 'Auth bypass',
          message: 'The query no longer filters by email.',
          file: 'src/auth.ts',
          line: 44,
          suggestion: 'return deny();',
        },
      ],
    });

    expect(markdown).toContain('<!-- reviewrouter:review-status:complete -->');
    expect(markdown).toContain('## 1 finding (1 major)');
    expect(markdown).toContain(
      '<summary>major · src/auth.ts:44 · Auth bypass</summary>'
    );
    expect(markdown).toContain('The query no longer filters by email.');
    expect(markdown).toContain('**Location:** `src/auth.ts:44`');
    expect(markdown).toContain('**Fix**');
    expect(markdown).toContain('return deny();');
    expect(markdown).not.toContain('Review complete');
  });

  it('renders historical lifecycle leftovers as expandable details', () => {
    const markdown = renderReviewerLifecycleMarkdown({
      language: 'Russian',
      lines: [
        {
          kind: 'resolved',
          title: 'Старый баг',
          message: 'Больше не воспроизводится.',
          locationLabel: 'src/old.ts:3',
        },
      ],
    });

    expect(markdown).toContain(
      '<summary>снято · src/old.ts:3 · Старый баг</summary>'
    );
    expect(markdown).toContain('Больше не воспроизводится.');
  });
});
