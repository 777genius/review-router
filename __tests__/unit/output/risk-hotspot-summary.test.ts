import { renderReviewerSummaryMarkdown } from '../../../src/output/reviewer-summary';
import { MarkdownFormatter } from '../../../src/output/formatter';
import { getBlockingFindingBreakdown } from '../../../src/output/severity-gate';
import type { Review } from '../../../src/types';

const headSha = '1111111111111111111111111111111111111111';
const metrics = {
  totalFindings: 0,
  critical: 0,
  major: 0,
  minor: 0,
  providersUsed: 1,
  providersSuccess: 1,
};

describe('Risk-aware summary user experience', () => {
  it('does not duplicate a single major finding in the real GitHub formatter', () => {
    const finding = {
      file: 'src/auth.ts',
      line: 8,
      severity: 'major' as const,
      title: 'Check permission handling',
      message: 'Permissions are not validated before access.',
    };
    const review: Review = {
      summary: '',
      sourceRevision: {
        repositoryHtmlUrl: 'https://github.com/example/demo',
        headSha,
        availablePaths: ['src/auth.ts'],
      },
      findings: [finding],
      inlineComments: [],
      actionItems: [],
      metrics: {
        ...metrics,
        totalFindings: 1,
        major: 1,
        providersFailed: 0,
        totalTokens: 0,
        totalCost: 0,
        durationSeconds: 0,
      },
      riskHotspots: [{
        path: 'src/auth.ts',
        line: 8,
        reason: 'major-finding',
        priority: 'attention',
      }],
    };
    const markdown = new MarkdownFormatter().format(review);
    expect(markdown).toContain('Check permission handling');
    expect(markdown).toContain(`/blob/${headSha}/src/auth.ts#L8`);
    expect(markdown).not.toContain('Where to look first');
    expect(getBlockingFindingBreakdown(review, 'major').total).toBe(1);
    expect(review.findings[0].severity).toBe('major');
  });

  it('shows at most three plain-language hotspots linking to exact reviewed SHA', () => {
    const markdown = renderReviewerSummaryMarkdown({
      language: 'en',
      metrics,
      findings: [],
      source: {
        repositoryHtmlUrl: 'https://github.com/example/demo',
        headSha,
        availablePaths: ['src/auth.ts'],
      },
      hotspots: [
        {
          path: 'src/auth.ts',
          reason: 'shared-code',
          priority: 'attention',
          relatedFiles: 2,
          line: 14,
        },
      ],
    });
    expect(markdown).toContain('Where to look first');
    expect(markdown).toContain('Possible dependency links to 2 changed files');
    expect(markdown).toContain(`/blob/${headSha}/src/auth.ts#L14`);
    expect(markdown).not.toContain('priority=attention');
    expect(markdown).not.toContain('risk probability');
  });

  it('translates section title, shows unknown review coverage and no false safe status', () => {
    const markdown = renderReviewerSummaryMarkdown({
      language: 'ru',
      metrics,
      findings: [],
      hotspots: [{ path: 'src/unreviewed.ts', reason: 'not-reviewed', priority: 'unknown' }],
    });
    expect(markdown).toContain('На что обратить внимание');
    expect(markdown).toContain('Проверка этого файла не завершена');
    expect(markdown).not.toContain('низкий риск');
  });

  it('does not insert a redundant section when there is no evidence', () => {
    const markdown = renderReviewerSummaryMarkdown({
      language: 'en',
      metrics,
      findings: [],
      hotspots: [],
    });
    expect(markdown).not.toContain('Where to look first');
  });

  it('never links a matching basename in another folder', () => {
    const markdown = renderReviewerSummaryMarkdown({
      language: 'en',
      metrics,
      findings: [],
      source: {
        repositoryHtmlUrl: 'https://github.com/example/demo',
        headSha,
        availablePaths: ['src/other/auth.ts'],
      },
      hotspots: [{
        path: 'src/auth.ts',
        reason: 'shared-code',
        priority: 'attention',
        relatedFiles: 2,
      }],
    });
    expect(markdown).toContain('src/auth.ts');
    expect(markdown).not.toContain(`/blob/${headSha}/src/auth.ts`);
    expect(markdown).not.toContain(`/blob/${headSha}/src/other/auth.ts`);
  });

  it('escapes malicious paths and does not link to unknown files', () => {
    const markdown = renderReviewerSummaryMarkdown({
      language: 'en',
      metrics,
      findings: [],
      source: {
        repositoryHtmlUrl: 'https://github.com/example/demo',
        headSha,
        availablePaths: ['safe.ts'],
      },
      hotspots: [
        { path: 'src/evil\n@team[link].ts', reason: 'shared-code', relatedFiles: 1, priority: 'attention' },
      ],
    });
    expect(markdown).not.toContain('\n@team');
    expect(markdown).not.toContain('](https://github.com/example/demo/blob/');
    expect(markdown).toContain('&#64;team');
  });
});
