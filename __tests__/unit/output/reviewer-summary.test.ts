import {
  limitReviewerPostedMarkdown,
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

  it('neutralizes nested details markup so later findings stay visible', () => {
    const markdown = renderReviewerSummaryMarkdown({
      language: 'English',
      metrics: {
        totalFindings: 2,
        critical: 0,
        major: 2,
        minor: 0,
        providersUsed: 1,
        providersSuccess: 1,
      },
      findings: [
        {
          severity: 'major',
          title: 'First',
          message:
            'hello <details><summary>trap</summary> hidden </details> more',
          file: 'a.ts',
          line: 1,
        },
        {
          severity: 'major',
          title: 'Second',
          message: 'still visible',
          file: 'b.ts',
          line: 2,
        },
      ],
    });

    expect(markdown).toContain(
      '&lt;details&gt;&lt;summary&gt;trap&lt;/summary&gt;'
    );
    expect(markdown).toContain('<summary>major · b.ts:2 · Second</summary>');
    expect(markdown).toContain('still visible');
    expect(markdown.match(/<details>/g)?.length).toBe(
      markdown.match(/<\/details>/g)?.length
    );
  });

  it('keeps details tags balanced when the posted body is truncated', () => {
    const markdown = limitReviewerPostedMarkdown(
      [
        '<details>',
        '<summary>first</summary>',
        '',
        'ok',
        '',
        '</details>',
        '',
        '<details>',
        '<summary>second starts',
      ].join('\n'),
      80
    );

    expect(markdown).toContain('[truncated]');
    expect(markdown).not.toContain('second starts');
    expect(markdown.match(/<details>/g)?.length ?? 0).toBe(
      markdown.match(/<\/details>/g)?.length ?? 0
    );
  });

  it('keeps details tags balanced when many large findings hit the size cap', () => {
    const findings = Array.from({ length: 40 }, (_, index) => ({
      severity: 'minor' as const,
      title: `Finding ${index + 1}`,
      message: 'x'.repeat(2_400),
      file: `src/f${index + 1}.ts`,
      line: index + 1,
    }));
    const markdown = renderReviewerSummaryMarkdown({
      language: 'English',
      metrics: {
        totalFindings: findings.length,
        critical: 0,
        major: 0,
        minor: findings.length,
        providersUsed: 1,
        providersSuccess: 1,
      },
      findings,
    });

    expect(Buffer.byteLength(markdown, 'utf8')).toBeLessThanOrEqual(60_000);
    expect(markdown).toContain('<!-- reviewrouter:review-status:complete -->');
    expect(markdown.match(/<details>/g)?.length ?? 0).toBe(
      markdown.match(/<\/details>/g)?.length ?? 0
    );
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
