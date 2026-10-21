import {
  limitReviewerPostedMarkdown,
  markReviewSummaryIncomplete,
  renderReviewerLifecycleMarkdown,
  renderReviewerSummaryMarkdown,
  resolveReviewerSummaryLocale,
  reviewerSummaryCopy,
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

    expect(markdown).toContain('# ReviewRouter');
    expect(markdown).toContain('## Summary');
    expect(markdown).toContain('## Findings');
    expect(markdown).toContain('Performance Metrics');
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

  it('keeps planned provider counts separate from unknown measurements', () => {
    const markdown = renderReviewerSummaryMarkdown({
      language: 'English',
      metrics,
      findings: [],
    });
    expect(markdown).toContain('| Providers | 1/1 |');
    expect(markdown).not.toContain('| Duration |');
    expect(markdown).not.toContain('| Tokens |');
    expect(markdown).not.toContain('| Cost |');
    expect(markdown).not.toContain('OAuth subscription');
  });

  it('marks the status block incomplete without rewriting localized section headings', () => {
    for (const language of [
      'en',
      'ru',
      'uk',
      'es',
      'pt',
      'fr',
      'de',
      'it',
      'zh',
      'ja',
      'ko',
    ]) {
      const original = renderReviewerSummaryMarkdown({
        language,
        metrics,
        findings: [],
      });
      const revised = markReviewSummaryIncomplete({
        summary: original,
        language,
        preliminaryFindingCount: 1,
      });
      expect(revised).toContain(
        '<!-- reviewrouter:review-status:incomplete -->'
      );
      expect(revised).not.toContain(
        '<!-- reviewrouter:review-status:complete -->'
      );
      expect(revised.split('<!-- reviewrouter:summary-status -->')[0]).toBe(
        original
          .replace('review-status:complete', 'review-status:incomplete')
          .split('<!-- reviewrouter:summary-status -->')[0]
      );
    }
  });

  it('finishes the scope table before incomplete coverage details', () => {
    const markdown = renderReviewerSummaryMarkdown({
      language: 'English',
      metrics,
      findings: [],
      coverage: {
        complete: false,
        totalFiles: 2,
        reviewedFiles: 1,
        unreviewedFiles: 1,
        mode: 'full',
        limitations: ['A required file was not reviewed.'],
        fullDiffFiles: 1,
        compactedFiles: 0,
        metadataOnlyFiles: 0,
        skippedFiles: 1,
        agenticContext: true,
      },
    });

    expect(markdown).toContain(
      [
        '| Review mode | full |',
        '| Full diff in prompt | 1 |',
        '| Compacted in prompt | 0 |',
        '| Metadata-only or trimmed | 0 |',
        '| Skipped before LLM review | 1 |',
        '| Agentic context | ✓ |',
        '',
        '### Coverage not completed',
        '',
        '- A required file was not reviewed.',
      ].join('\n')
    );
  });

  it('explains policy-excluded files without changing completed coverage', () => {
    const markdown = renderReviewerSummaryMarkdown({
      language: 'English',
      metrics,
      findings: [],
      coverage: {
        complete: true,
        totalFiles: 1,
        reviewedFiles: 0,
        unreviewedFiles: 0,
        mode: 'full',
        limitations: [],
      },
    });

    expect(markdown).toContain('| Files reviewed | 0/1 |');
    expect(markdown).toContain('| Not reviewed | 0 |');
    expect(markdown).toContain('| Excluded by review policy | 1 |');
    expect(markdown).toContain('<!-- reviewrouter:review-status:complete -->');
    expect(markdown).not.toContain('### Coverage not completed');
  });

  it('keeps missing coverage distinct from policy exclusions', () => {
    const markdown = renderReviewerSummaryMarkdown({
      language: 'English',
      metrics,
      findings: [],
      coverage: {
        complete: false,
        totalFiles: 5,
        reviewedFiles: 2,
        unreviewedFiles: 1,
        mode: 'full',
        limitations: ['A required file was not reviewed.'],
      },
    });

    expect(markdown).toContain('| Files reviewed | 2/5 |');
    expect(markdown).toContain('| Not reviewed | 1 |');
    expect(markdown).toContain('| Excluded by review policy | 2 |');
    expect(markdown).toContain(
      '<!-- reviewrouter:review-status:incomplete -->'
    );
    expect(markdown).toContain('A required file was not reviewed.');
  });

  it('does not label unchanged incremental files as excluded by policy', () => {
    const markdown = renderReviewerSummaryMarkdown({
      language: 'English',
      metrics,
      findings: [],
      coverage: {
        complete: true,
        totalFiles: 5,
        reviewedFiles: 2,
        unreviewedFiles: 0,
        mode: 'incremental',
        limitations: [],
      },
    });

    expect(markdown).toContain('| Files reviewed | 2/5 |');
    expect(markdown).toContain('| Review mode | incremental |');
    expect(markdown).not.toContain('| Excluded by review policy |');
    expect(markdown).toContain('<!-- reviewrouter:review-status:complete -->');
  });

  it('lists reviewed and not-reviewed files in the incomplete coverage manifest', () => {
    const markdown = renderReviewerSummaryMarkdown({
      language: 'English',
      metrics,
      findings: [],
      coverage: {
        complete: false,
        totalFiles: 4,
        reviewedFiles: 3,
        unreviewedFiles: 1,
        mode: 'full',
        limitations: ['A required file was not reviewed.'],
        files: [
          { path: 'src/full-1.ts', status: 'full' },
          { path: 'src/full-2.ts', status: 'full' },
          {
            path: 'src/compacted.ts',
            status: 'compacted',
            reason: 'summary-only content in prompt',
          },
          {
            path: 'src/missed.ts',
            status: 'unreviewed',
            reason: 'no review work slot covered this file',
          },
        ],
      },
    });

    expect(markdown).toContain('### File coverage');
    expect(markdown).toContain('- <code>src/full-1.ts</code> - full');
    expect(markdown).toContain('- <code>src/full-2.ts</code> - full');
    expect(markdown).toContain(
      '- <code>src/compacted.ts</code> - compacted — summary-only content in prompt'
    );
    expect(markdown).toContain(
      '- <code>src/missed.ts</code> - unreviewed — no review work slot covered this file'
    );
    // Gaps surface before fully reviewed files.
    expect(markdown.indexOf('- <code>src/missed.ts</code>')).toBeLessThan(
      markdown.indexOf('- <code>src/full-1.ts</code>')
    );
    expect(markdown.indexOf('- <code>src/compacted.ts</code>')).toBeLessThan(
      markdown.indexOf('- <code>src/full-1.ts</code>')
    );
  });

  it('reports manifest overflow instead of dropping coverage lines silently', () => {
    const markdown = renderReviewerSummaryMarkdown({
      language: 'English',
      metrics,
      findings: [],
      coverage: {
        complete: false,
        totalFiles: 120,
        reviewedFiles: 120,
        unreviewedFiles: 0,
        mode: 'full',
        limitations: ['A required file was not reviewed.'],
        files: Array.from({ length: 120 }, (_, index) => ({
          path: `src/file-${String(index).padStart(3, '0')}.ts`,
          status: 'full',
        })),
      },
    });

    expect(markdown).toContain('- <code>src/file-000.ts</code> - full');
    expect(markdown).toContain('- <code>src/file-099.ts</code> - full');
    expect(markdown).not.toContain('- <code>src/file-100.ts</code> - full');
    expect(markdown).toContain('20 more files not shown.');
  });

  it('flags truncated non-full coverage lines in complete reports', () => {
    const markdown = renderReviewerSummaryMarkdown({
      language: 'English',
      metrics,
      findings: [],
      coverage: {
        complete: true,
        totalFiles: 120,
        reviewedFiles: 120,
        unreviewedFiles: 0,
        mode: 'full',
        limitations: [],
        files: Array.from({ length: 120 }, (_, index) => ({
          path: `src/file-${String(index).padStart(3, '0')}.ts`,
          status: 'compacted',
          reason: 'summary-only content in prompt',
        })),
      },
    });

    expect(markdown).toContain('- <code>src/file-000.ts</code> - compacted');
    expect(markdown).not.toContain('- <code>src/file-100.ts</code> - compacted');
    expect(markdown).toContain('20 more files not shown.');
  });

  it('keeps the coverage block intact when manifest lines would exceed the summary byte budget', () => {
    const longPath = `src/${'a'.repeat(180)}.ts`;
    const markdown = renderReviewerSummaryMarkdown({
      language: 'English',
      metrics,
      findings: [],
      coverage: {
        complete: false,
        totalFiles: 300,
        reviewedFiles: 100,
        unreviewedFiles: 200,
        mode: 'full',
        limitations: Array.from(
          { length: 200 },
          (_, index) =>
            `path_coverage:src/${'b'.repeat(170)}-${String(index).padStart(3, '0')}.ts:metadata_only`
        ),
        files: Array.from({ length: 100 }, (_, index) => ({
          path: longPath.replace('.ts', `-${String(index).padStart(3, '0')}.ts`),
          status: 'metadata-only' as const,
          reason: 'metadata-only content in prompt',
        })),
      },
    });

    // The byte cap must fall between manifest lines, never inside the
    // coverage <details> block, or the whole block is dropped.
    expect(Buffer.byteLength(markdown, 'utf8')).toBeLessThanOrEqual(60_000);
    expect(markdown).toContain('| Files reviewed | 100/300 |');
    expect(markdown).toContain('### File coverage');
    expect(markdown).toContain('more files not shown.');
    expect(markdown).toContain('</details>');
  });

  it('neutralizes html and markdown breakout in manifest file paths', () => {
    const markdown = renderReviewerSummaryMarkdown({
      language: 'English',
      metrics,
      findings: [],
      coverage: {
        complete: false,
        totalFiles: 1,
        reviewedFiles: 0,
        unreviewedFiles: 1,
        mode: 'full',
        limitations: [],
        files: [
          {
            path: 'src/evil`<img src=x onerror=alert(1)>@mention\n- fake item.ts',
            status: 'unreviewed',
            reason: 'no review work slot covered this file',
          },
        ],
      },
    });

    expect(markdown).not.toContain('<img');
    expect(markdown).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markdown).not.toMatch(/(^|[\s>])@mention/m);
    expect(markdown).not.toMatch(/^- fake item/m);
    expect(markdown).not.toContain('`src/evil');
  });

  it.each([
    ['English', '**1 more file not shown.**'],
    ['Russian', '**Ещё 1 файл не показано.**'],
    ['Ukrainian', '**Ще 1 файл не показано.**'],
    ['Spanish', '**1 archivo más no se muestra.**'],
    ['Portuguese', '**Mais 1 arquivo não exibido.**'],
    ['French', '**1 fichier supplémentaire non affiché.**'],
    ['German', '**1 weitere Datei wird nicht angezeigt.**'],
    ['Italian', '**1 file aggiuntivo non mostrato.**'],
  ])('uses singular file wording when one manifest line is hidden: %s', (language, expected) => {
    expect(reviewerSummaryCopy(language).moreFiles(1)).toBe(expected);
  });

  it.each([
    { totalFiles: 1, reviewedFiles: 1, unreviewedFiles: 0 },
    { totalFiles: 2, reviewedFiles: 1, unreviewedFiles: 1 },
    { totalFiles: 0, reviewedFiles: 0, unreviewedFiles: 0 },
    { totalFiles: 1, reviewedFiles: 2, unreviewedFiles: 0 },
    { totalFiles: Infinity, reviewedFiles: 0, unreviewedFiles: 0 },
    { totalFiles: 1, reviewedFiles: NaN, unreviewedFiles: 0 },
    { totalFiles: 1, reviewedFiles: -1, unreviewedFiles: 0 },
    { totalFiles: 1, reviewedFiles: 0, unreviewedFiles: -1 },
    { totalFiles: 1.5, reviewedFiles: 0, unreviewedFiles: 0 },
    {
      totalFiles: Number.MAX_SAFE_INTEGER + 1,
      reviewedFiles: 0,
      unreviewedFiles: 0,
    },
  ])(
    'does not invent policy exclusions for zero or invalid residuals: %j',
    (counts) => {
      const markdown = renderReviewerSummaryMarkdown({
        language: 'English',
        metrics,
        findings: [],
        coverage: { ...counts, complete: true, mode: 'full', limitations: [] },
      });

      expect(markdown).not.toContain('| Excluded by review policy |');
    }
  );

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
