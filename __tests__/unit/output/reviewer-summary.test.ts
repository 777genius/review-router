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

    expect(markdown).not.toContain('# ReviewRouter');
    expect(markdown).not.toContain('## Summary');
    expect(markdown).not.toContain('## Findings');
    expect(markdown).toContain('Performance Metrics');
    expect(markdown).toContain('<!-- reviewrouter:review-status:complete -->');
    expect(markdown).toContain('🟡 **1 major**');
    expect(markdown).not.toContain('0 critical');
    expect(markdown).not.toContain('0 minor');
    expect(markdown).toContain(
      '- **major · Auth bypass** · <code>src/auth.ts:44</code>'
    );
    expect(markdown).toContain('The query no longer filters by email.');
    expect(markdown).toContain('**Location:** <code>src/auth.ts:44</code>');
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
    expect(markdown).toContain('- **major · Second** · <code>b.ts:2</code>');
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

  it('explains the concrete cause of an incomplete review in plain language', () => {
    const markdown = renderReviewerSummaryMarkdown({
      language: 'English',
      metrics: {
        totalFindings: 0,
        critical: 0,
        major: 0,
        minor: 0,
        providersUsed: 1,
        providersSuccess: 0,
      },
      findings: [],
      incomplete: true,
      incompleteCauses: ['attempt_budget_exhausted', 'deadline_reached'],
    });

    expect(markdown).toContain('**Why the review is incomplete:**');
    expect(markdown).toContain(
      'The review provider exhausted its retry attempts without returning evidence'
    );
    expect(markdown).toContain(
      'The review ran out of its execution time budget'
    );
    expect(markdown).not.toContain('attempt_budget_exhausted');
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
    expect(markdown).not.toContain(
      '- <code>src/file-100.ts</code> - compacted'
    );
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
          path: longPath.replace(
            '.ts',
            `-${String(index).padStart(3, '0')}.ts`
          ),
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
  ])(
    'uses singular file wording when one manifest line is hidden: %s',
    (language, expected) => {
      expect(reviewerSummaryCopy(language).moreFiles(1)).toBe(expected);
    }
  );

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

describe('compact summary publication contract', () => {
  const metrics = {
    totalFindings: 1,
    critical: 1,
    major: 0,
    minor: 0,
    providersUsed: 1,
    providersSuccess: 1,
  };
  const finding = {
    severity: 'critical' as const,
    title: 'Guard the tenant boundary',
    message: 'The tenant filter is missing. Requests can read another tenant.',
    file: 'src/auth.ts',
    line: 44,
  };
  const outsideDetails = (markdown: string) =>
    markdown.replace(/<details>[\s\S]*?<\/details>/g, '');

  it('shows a bounded ordinary paragraph and retains the full original body and fix', () => {
    const paragraph =
      'A request can cross tenant boundaries without this filter. '
        .repeat(60)
        .trim();
    const original = {
      ...finding,
      message: `${paragraph}\n\nSecond paragraph with the full explanation.`,
      suggestion: 'return deny();',
    };
    const markdown = renderReviewerSummaryMarkdown({
      language: 'en',
      metrics,
      findings: [original],
    });
    const visible = outsideDetails(markdown);
    const excerpt = visible
      .split('\n\n')
      .find((block) => block.startsWith('A request'))!;

    expect(excerpt.length).toBeLessThanOrEqual(320);
    expect(excerpt).toMatch(/\S…$/);
    expect(paragraph.startsWith(excerpt.slice(0, -1))).toBe(true);
    expect(markdown).toContain(paragraph);
    expect(visible).not.toContain('Second paragraph');
    expect(visible).not.toContain('return deny();');
    expect(markdown).toContain('return deny();');
    expect(original.message).toBe(
      `${paragraph}\n\nSecond paragraph with the full explanation.`
    );
  });

  it.each([
    '    const indentedCode = true;',
    '<img\n src=x onerror=alert(1)>',
    '```ts\nconst x = 1;\n```',
    '| Name | Value |\n|---|---|\n| a | b |',
    '<div>Private HTML</div>',
  ])(
    'does not turn an initial non-prose block into a preview: %s',
    (message) => {
      const markdown = renderReviewerSummaryMarkdown({
        language: 'en',
        metrics,
        findings: [{ ...finding, message }],
      });
      const visible = outsideDetails(markdown);
      expect(visible).not.toContain('const x');
      expect(visible).not.toContain('| Name');
      expect(visible).not.toContain('Private HTML');
      expect(visible).not.toContain('indentedCode');
      expect(markdown).not.toContain('<img\n');
      expect(markdown).not.toContain('<div>');
      expect(markdown).toContain(finding.title);
    }
  );

  it('preserves indented first-block code in full finding and lifecycle details without a prose preview', () => {
    const code = '    const tenant = getTenant();\n    return tenant;';
    const markdown = renderReviewerSummaryMarkdown({
      language: 'en',
      metrics,
      findings: [{ ...finding, message: code, suggestion: code }],
    });
    expect(outsideDetails(markdown)).not.toContain('getTenant');
    expect(markdown).toContain(`\n\n${code}\n\n**Location:**`);
    expect(markdown).toContain(`\`\`\`\n${code}\n\`\`\``);
    const lifecycle = renderReviewerLifecycleMarkdown({
      language: 'en',
      lines: [
        {
          kind: 'active',
          title: 'Previous tenant issue',
          message: code,
          locationLabel: 'src/auth.ts:44',
        },
      ],
    });
    expect(lifecycle).toContain(`\n\n${code}\n\n<code>`);
  });

  it('uses word boundaries for a CJK paragraph without spaces', () => {
    const message = '安全检查'.repeat(100);
    const markdown = renderReviewerSummaryMarkdown({
      language: 'zh',
      metrics,
      findings: [{ ...finding, message }],
    });
    const excerpt = outsideDetails(markdown)
      .split('\n\n')
      .find((block) => block.startsWith('安全'));
    // 319 available code points end halfway through 检查; preserve the whole
    // preceding word 安全 and add the ellipsis within the 320-character cap.
    expect(excerpt).toBe(`${'安全检查'.repeat(79)}安全…`);
    expect(Array.from(excerpt!).length).toBeLessThanOrEqual(320);
    expect(markdown).toContain(message);
  });

  it.each([
    'LongEnglishIdentifier'.repeat(30),
    `https://example.com/${'segment/'.repeat(80)}`,
  ])(
    'keeps an oversized indivisible identifier or URL out of the preview',
    (message) => {
      const markdown = renderReviewerSummaryMarkdown({
        language: 'en',
        metrics,
        findings: [{ ...finding, message }],
      });
      expect(outsideDetails(markdown)).not.toContain(message.slice(0, 24));
      expect(markdown).toContain(message);
    }
  );

  it('keeps all same-location findings in severity/stable order and uses compact previews for four findings', () => {
    const findings = [
      { ...finding, title: 'Z last', severity: 'minor' as const },
      { ...finding, title: 'B second' },
      { ...finding, title: 'A first' },
      { ...finding, title: 'C third', severity: 'major' as const },
    ];
    const markdown = renderReviewerSummaryMarkdown({
      language: 'en',
      metrics: {
        ...metrics,
        totalFindings: 4,
        critical: 2,
        major: 1,
        minor: 1,
      },
      findings,
    });
    const visible = outsideDetails(markdown);
    expect(visible).not.toContain(finding.message);
    expect(visible.match(/<code>src\/auth.ts:44<\/code>/g)).toHaveLength(4);
    expect(visible.indexOf('A first')).toBeLessThan(
      visible.indexOf('B second')
    );
    expect(visible.indexOf('B second')).toBeLessThan(
      visible.indexOf('C third')
    );
    expect(visible.indexOf('C third')).toBeLessThan(visible.indexOf('Z last'));
    expect(markdown.match(/The tenant filter is missing/g)).toHaveLength(4);
  });

  it('reserves visible incomplete, provider, coverage and lifecycle warnings against oversized Unicode/code/evidence blocks', () => {
    const markdown = renderReviewerSummaryMarkdown({
      language: 'en',
      metrics: { ...metrics, providersUsed: 2 },
      findings: [
        {
          ...finding,
          message: `\`\`\`ts\n${'😀'.repeat(30_000)}\n\`\`\``,
          evidence: {
            confidence: 0.9,
            badge: 'High',
            reasoning: 'я'.repeat(70_000),
          },
        },
      ],
      coverage: {
        complete: false,
        totalFiles: 3,
        reviewedFiles: 1,
        unreviewedFiles: 2,
        mode: 'full',
        limitations: ['Required auth.ts was not reviewed.'],
      },
      lifecycleAttention: true,
      lifecycleWarnings: ['A human reply requires attention.'],
      lifecycle: [
        {
          kind: 'uncertain',
          title: 'Previous authentication issue',
          message: 'Still needs a decision.',
          locationLabel: 'src/old.ts:2',
        },
      ],
    });
    const visible = outsideDetails(markdown);
    expect(Buffer.byteLength(markdown)).toBeLessThanOrEqual(60_000);
    expect(visible).toContain('Review incomplete');
    expect(visible).toContain('1 of 2 review providers failed.');
    expect(visible).toContain('Required auth.ts was not reviewed.');
    expect(visible).toContain('A human reply requires attention.');
    expect(visible).toContain('needs attention');
    expect(visible).toContain('Previous authentication issue');
    expect(visible).toContain(
      'Full findings remain in the review JSON artifact.'
    );
    expect(markdown.match(/<details>/g)?.length ?? 0).toBe(
      markdown.match(/<\/details>/g)?.length ?? 0
    );
    expect(markdown.match(/^`{3,}/gm)?.length ?? 0).toBe(0);
  });

  it('keeps code fences balanced and all diagnostics under one unnested disclosure', () => {
    const markdown = renderReviewerSummaryMarkdown({
      language: 'en',
      metrics,
      findings: [
        {
          ...finding,
          message: 'Explanation\n\n```ts\nconst x = 1;',
          suggestion: '```\nconst y = 2;\n```',
        },
      ],
      analysis: {
        averageLikelihood: 0.5,
        consensus: 'Mixed',
        providerEstimates: { one: 0.5 },
      },
      diagram: 'graph TD\nA --> B',
      measurements: { durationSeconds: 2, tokens: 100, providers: [] },
      coverage: {
        complete: true,
        totalFiles: 1,
        reviewedFiles: 1,
        unreviewedFiles: 0,
        mode: 'full',
        limitations: [],
      },
    });
    expect(markdown.match(/<summary>Review details<\/summary>/g)).toHaveLength(
      1
    );
    expect(markdown).not.toMatch(
      /<details>(?:(?!<\/details>)[\s\S])*<details>/
    );
    expect(markdown).toContain('const x = 1;\n```');
    expect(markdown).toContain('````\n```\nconst y = 2;\n```\n````');
    expect(markdown).toContain('### Review Scope');
    expect(markdown).toContain('### Performance Metrics');
    expect(markdown).toContain('### AI-Generated Code Analysis');
    expect(markdown).toContain('### Impact Analysis Graph');
  });

  it('links only safe files at the reviewed head and keeps paths escaped in the fallback', () => {
    const file = "src/a #](x)' файл.ts";
    const markdown = renderReviewerSummaryMarkdown({
      language: 'en',
      metrics,
      findings: [{ ...finding, file, startLine: 40, endLine: 44 }],
      source: {
        repositoryHtmlUrl: 'https://github.com/owner/repo',
        headSha: 'a'.repeat(40),
      },
    });
    expect(markdown).toContain(
      `/blob/${'a'.repeat(40)}/src/a%20%23%5D%28x%29%27%20%D1%84%D0%B0%D0%B9%D0%BB.ts#L40-L44`
    );
    for (const source of [
      { repositoryHtmlUrl: 'javascript:alert(1)', headSha: 'a'.repeat(40) },
      { repositoryHtmlUrl: 'https://github.com/owner/repo', headSha: 'main' },
      {
        repositoryHtmlUrl: 'https://github.com/owner/repo?token=secret',
        headSha: 'a'.repeat(40),
      },
      {
        repositoryHtmlUrl: 'https://github.com/owner/repo',
        headSha: 'a'.repeat(40),
        availablePaths: [],
      },
    ]) {
      const fallback = renderReviewerSummaryMarkdown({
        language: 'en',
        metrics,
        findings: [finding],
        source,
      });
      expect(fallback).not.toContain('/blob/');
      expect(fallback).toContain('<code>src/auth.ts:44</code>');
    }
  });

  it.each([{ startLine: 8 }, { endLine: 12 }])(
    'uses the displayed line for a partial range: %j',
    (partial) => {
      const markdown = renderReviewerSummaryMarkdown({
        language: 'en',
        metrics,
        findings: [{ ...finding, line: 10, ...partial }],
        source: {
          repositoryHtmlUrl: 'https://github.com/owner/repo',
          headSha: 'a'.repeat(40),
        },
      });
      expect(markdown).toContain(
        `[<code>src/auth.ts:10</code>](https://github.com/owner/repo/blob/${'a'.repeat(40)}/src/auth.ts#L10)`
      );
    }
  );

  it('uses only public count/enumeration parameters in optional theme banners and rewrites their incomplete state', () => {
    const markdown = renderReviewerSummaryMarkdown({
      language: 'Russian',
      metrics,
      findings: [finding],
      bannerBaseUrl: 'https://reviewrouter.org',
      previousCounts: { critical: 2, major: 0, minor: 0 },
    });
    const urls = [...markdown.matchAll(/(?:src|srcset)="([^"]+)"/g)].map(
      (match) => new URL(match[1].replaceAll('&amp;', '&'))
    );
    expect(urls).toHaveLength(3);
    for (const url of urls) {
      expect(url.pathname).toBe('/review-banner/v1.svg');
      expect([...url.searchParams.keys()]).toEqual([
        'state',
        'critical',
        'major',
        'minor',
        'info',
        'lang',
        'theme',
      ]);
      expect(url.searchParams.get('critical')).toBe('3');
      expect(url.searchParams.get('lang')).toBe('ru');
      expect(url.searchParams.get('state')).toBe('complete');
      expect(url.href).not.toContain('auth');
    }
    expect(urls.map((url) => url.searchParams.get('theme'))).toEqual([
      'dark',
      'light',
      'light',
    ]);
    const revised = markReviewSummaryIncomplete({
      summary: markdown,
      language: 'ru',
      preliminaryFindingCount: 1,
    });
    expect(revised).not.toContain('state=complete');
    expect(revised.match(/state=incomplete/g)).toHaveLength(3);
    expect(outsideDetails(revised)).toContain('Guard the tenant boundary');
    expect(
      renderReviewerSummaryMarkdown({
        language: 'en',
        metrics,
        findings: [finding],
      })
    ).not.toContain('<picture>');
  });

  it.each([
    'http://reviewrouter.org',
    'https://secret@reviewrouter.org',
    'https://reviewrouter.org?token=secret',
    'https://reviewrouter.org/path',
  ])('omits an unsafe optional banner origin: %s', (bannerBaseUrl) => {
    expect(
      renderReviewerSummaryMarkdown({
        language: 'en',
        metrics,
        findings: [finding],
        bannerBaseUrl,
      })
    ).not.toContain('<picture>');
  });

  it.each([-1, 1.5, 10_000, NaN, Infinity])(
    'falls back to text for out-of-contract banner counts: %s',
    (critical) => {
      expect(
        renderReviewerSummaryMarkdown({
          language: 'en',
          metrics: { ...metrics, critical },
          findings: [finding],
          bannerBaseUrl: 'https://reviewrouter.org',
        })
      ).not.toContain('<picture>');
    }
  );
});
