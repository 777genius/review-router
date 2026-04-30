import { MarkdownFormatterV2 } from '../../../src/output/formatter-v2';
import { Review, Finding } from '../../../src/types';

describe('MarkdownFormatterV2', () => {
  let formatter: MarkdownFormatterV2;

  beforeEach(() => {
    formatter = new MarkdownFormatterV2();
  });

  const createMockReview = (overrides?: Partial<Review>): Review => ({
    summary: 'Test review summary',
    findings: [],
    inlineComments: [],
    actionItems: [],
    metrics: {
      totalFindings: 0,
      critical: 0,
      major: 0,
      minor: 0,
      providersUsed: 2,
      providersSuccess: 2,
      providersFailed: 0,
      totalTokens: 1000,
      totalCost: 0.005,
      durationSeconds: 5.5,
    },
    ...overrides,
  });

  const createMockFinding = (overrides?: Partial<Finding>): Finding => ({
    file: 'src/test.ts',
    line: 42,
    severity: 'major',
    title: 'Test Finding',
    message: 'This is a test finding message',
    provider: 'test-provider',
    providers: ['test-provider'],
    ...overrides,
  });

  describe('format', () => {
    it('should format review with no findings', () => {
      const review = createMockReview();
      const output = formatter.format(review);

      expect(output).toContain('# AI Robot Review');
      expect(output).toContain('## All Clear!');
      expect(output).toContain('No issues found. Great job!');
      expect(output).toContain('Performance Metrics');
    });

    it('should include quick stats summary', () => {
      const review = createMockReview({
        findings: [
          createMockFinding({ severity: 'critical' }),
          createMockFinding({ severity: 'major' }),
          createMockFinding({ severity: 'minor' }),
        ],
        metrics: {
          totalFindings: 3,
          critical: 1,
          major: 1,
          minor: 1,
          providersUsed: 2,
          providersSuccess: 2,
          providersFailed: 0,
          totalTokens: 1500,
          totalCost: 0.01,
          durationSeconds: 10.5,
        },
      });

      const output = formatter.format(review);

      expect(output).toContain('🔴 **1 Critical**');
      expect(output).toContain('🟡 **1 Major**');
      expect(output).toContain('🔵 1 Minor');
      expect(output).toContain(
        '<sub>10.5s • $0.0100 • Powered by AI Robot Review</sub>'
      );
    });

    it('should format critical findings with emoji', () => {
      const finding = createMockFinding({
        severity: 'critical',
        title: 'Security Vulnerability',
        message: 'SQL injection risk detected',
        file: 'src/auth.ts',
        line: 123,
      });

      const review = createMockReview({
        findings: [finding],
        metrics: {
          ...createMockReview().metrics,
          critical: 1,
          totalFindings: 1,
        },
      });

      const output = formatter.format(review);

      expect(output).toContain('### 🔴 Critical (1)');
      expect(output).toContain('#### 🔴 Security Vulnerability');
      expect(output).toContain('**Reported Location:** `src/auth.ts:123`');
      expect(output).toContain('**Severity:** 🔴 **Critical**');
      expect(output).toContain('SQL injection risk detected');
    });

    it('should format major findings with emoji', () => {
      const finding = createMockFinding({
        severity: 'major',
        title: 'Performance Issue',
      });

      const review = createMockReview({
        findings: [finding],
        metrics: {
          ...createMockReview().metrics,
          major: 1,
          totalFindings: 1,
        },
      });

      const output = formatter.format(review);

      expect(output).toContain('### 🟡 Major (1)');
      expect(output).toContain('#### 🟡 Performance Issue');
    });

    it('should format minor findings with emoji', () => {
      const finding = createMockFinding({
        severity: 'minor',
        title: 'Code Style',
      });

      const review = createMockReview({
        findings: [finding],
        metrics: {
          ...createMockReview().metrics,
          minor: 1,
          totalFindings: 1,
        },
      });

      const output = formatter.format(review);

      expect(output).toContain('### 🔵 Minor (1)');
      expect(output).toContain('#### 🔵 Code Style');
    });

    it('should include suggestions in formatted findings', () => {
      const finding = createMockFinding({
        suggestion: 'Use const instead of let',
      });

      const review = createMockReview({
        findings: [finding],
        metrics: {
          ...createMockReview().metrics,
          major: 1,
          totalFindings: 1,
        },
      });

      const output = formatter.format(review);

      expect(output).toContain('**Suggested Fix:**');
      expect(output).toContain('Use const instead of let');
    });

    it('should include evidence with confidence percentage', () => {
      const finding = createMockFinding({
        evidence: {
          confidence: 0.85,
          reasoning: 'Multiple providers agree',
          badge: '⭐ High Confidence',
        },
      });

      const review = createMockReview({
        findings: [finding],
        metrics: {
          ...createMockReview().metrics,
          major: 1,
          totalFindings: 1,
        },
      });

      const output = formatter.format(review);

      expect(output).toContain('**Evidence:**');
      expect(output).toContain('⭐ High Confidence');
      expect(output).toContain('(85% confidence)');
      expect(output).toContain('View reasoning');
      expect(output).toContain('Multiple providers agree');
    });

    it('should show provider consensus for multi-provider findings', () => {
      const finding = createMockFinding({
        providers: ['provider-1', 'provider-2', 'provider-3'],
      });

      const review = createMockReview({
        findings: [finding],
        metrics: {
          ...createMockReview().metrics,
          major: 1,
          totalFindings: 1,
        },
      });

      const output = formatter.format(review);

      expect(output).toContain(
        'Detected by: provider-1, provider-2, provider-3'
      );
    });

    it('should omit duplicated action items from summary output', () => {
      const review = createMockReview({
        actionItems: [
          'Update dependencies',
          'Add missing tests',
          'Fix security issues',
        ],
      });

      const output = formatter.format(review);

      expect(output).not.toContain('## Action Items');
      expect(output).not.toContain('- [ ] Update dependencies');
      expect(output).not.toContain('- [ ] Add missing tests');
      expect(output).not.toContain('- [ ] Fix security issues');
    });

    it('should format performance metrics table', () => {
      const review = createMockReview({
        metrics: {
          totalFindings: 5,
          critical: 1,
          major: 2,
          minor: 2,
          providersUsed: 3,
          providersSuccess: 2,
          providersFailed: 1,
          totalTokens: 5000,
          totalCost: 0.025,
          durationSeconds: 15.75,
        },
      });

      const output = formatter.format(review);

      expect(output).toContain('Performance Metrics');
      expect(output).toContain('| Metric | Value |');
      expect(output).toContain('| Duration | 15.75s |');
      expect(output).toContain('| Cost | $0.0250 |');
      expect(output).toContain('| Tokens | 5,000 |');
      expect(output).toContain('| Providers | 2/3 |');
    });

    it('should hide API cost for OAuth CLI subscription providers', () => {
      const review = createMockReview({
        runDetails: {
          providers: [
            {
              name: 'codex/gpt-5.4-mini',
              status: 'success',
              durationSeconds: 3.5,
              cost: 0,
            },
          ],
          totalCost: 0,
          totalTokens: 0,
          durationSeconds: 5.5,
          cacheHit: false,
          synthesisModel: 'codex/gpt-5.4-mini',
          providerPoolSize: 1,
        },
        metrics: {
          totalFindings: 0,
          critical: 0,
          major: 0,
          minor: 0,
          providersUsed: 1,
          providersSuccess: 1,
          providersFailed: 0,
          totalTokens: 0,
          totalCost: 0,
          durationSeconds: 5.5,
        },
      });

      const output = formatter.format(review);

      expect(output).toContain('OAuth subscription');
      expect(output).toContain(
        '<sub>5.5s • OAuth subscription • Powered by AI Robot Review</sub>'
      );
      expect(output).not.toContain('$0.0000');
      expect(output).not.toContain('| Cost |');
      expect(output).not.toContain('| Tokens | 0 |');
      expect(output).not.toContain('codex/gpt-5.4-mini** (3.50s, $0.0000)');
    });

    it('omits zero dollar footer when billing was not measured', () => {
      const review = createMockReview({
        runDetails: {
          providers: [],
          totalCost: 0,
          totalTokens: 0,
          durationSeconds: 0.2,
          cacheHit: false,
          synthesisModel: 'none',
          providerPoolSize: 0,
        },
        metrics: {
          totalFindings: 0,
          critical: 0,
          major: 0,
          minor: 0,
          providersUsed: 0,
          providersSuccess: 0,
          providersFailed: 0,
          totalTokens: 0,
          totalCost: 0,
          durationSeconds: 0.2,
        },
      });

      const output = formatter.format(review);

      expect(output).toContain('| Billing | Not reported |');
      expect(output).toContain('<sub>0.2s • Powered by AI Robot Review</sub>');
      expect(output).not.toContain('$0.0000');
      expect(output).not.toContain('| Tokens | 0 |');
    });

    it('should show cache hit indicator', () => {
      const review = createMockReview({
        runDetails: {
          providers: [],
          totalCost: 0.005,
          totalTokens: 1000,
          durationSeconds: 2.5,
          cacheHit: true,
          synthesisModel: 'test-model',
          providerPoolSize: 2,
        },
      });

      const output = formatter.format(review);

      expect(output).toContain('| Cache | Hit |');
    });

    it('shows incomplete review state when all providers fail', () => {
      const review = createMockReview({
        metrics: {
          totalFindings: 0,
          critical: 0,
          major: 0,
          minor: 0,
          providersUsed: 1,
          providersSuccess: 0,
          providersFailed: 1,
          totalTokens: 0,
          totalCost: 0,
          durationSeconds: 4.2,
        },
        runDetails: {
          providers: [
            {
              name: 'codex/gpt-5.5',
              status: 'error',
              durationSeconds: 4.2,
              errorMessage:
                'Codex CLI returned invalid review JSON: response was not valid JSON',
            },
          ],
          totalCost: 0,
          totalTokens: 0,
          durationSeconds: 4.2,
          cacheHit: false,
          synthesisModel: 'codex/gpt-5.5',
          providerPoolSize: 1,
        },
      });

      const output = formatter.format(review);

      expect(output).toContain('## Review Incomplete');
      expect(output).not.toContain('## All Clear!');
      expect(output).toContain('LLM review did not complete');
      expect(output).toContain(
        'Codex CLI returned invalid review JSON: response was not valid JSON'
      );
    });

    it('should format provider performance details', () => {
      const review = createMockReview({
        runDetails: {
          providers: [
            {
              name: 'provider-1',
              status: 'success',
              durationSeconds: 3.5,
              cost: 0.005,
              tokens: 500,
            },
            {
              name: 'provider-2',
              status: 'timeout',
              durationSeconds: 30.0,
              errorMessage: 'Request timed out after 30s',
            },
          ],
          totalCost: 0.005,
          totalTokens: 500,
          durationSeconds: 5.5,
          cacheHit: false,
          synthesisModel: 'test-model',
          providerPoolSize: 2,
        },
      });

      const output = formatter.format(review);

      expect(output).toContain('**Provider Performance:**');
      expect(output).toContain(
        '✅ **provider-1** (3.50s, $0.0050, 500 tokens)'
      );
      expect(output).toContain('⏱️ **provider-2** (30.00s)');
      expect(output).toContain('Request timed out after 30s');
    });

    it('should include AI analysis if present', () => {
      const review = createMockReview({
        aiAnalysis: {
          averageLikelihood: 0.75,
          providerEstimates: {
            'provider-1': 0.8,
            'provider-2': 0.7,
          },
          consensus: 'Likely AI-generated',
        },
      });

      const output = formatter.format(review);

      expect(output).toContain('AI-Generated Code Analysis');
      expect(output).toContain('**Overall Likelihood:** 75.0%');
      expect(output).toContain('**Consensus:** Likely AI-generated');
      expect(output).toContain('provider-1: 80.0%');
      expect(output).toContain('provider-2: 70.0%');
    });

    it('should include mermaid diagram if present', () => {
      const review = createMockReview({
        mermaidDiagram: 'graph TD\nA --> B\nB --> C',
      });

      const output = formatter.format(review);

      expect(output).toContain('Impact Analysis Graph');
      expect(output).toContain('```mermaid');
      expect(output).toContain('graph TD');
      expect(output).toContain('A --> B');
    });

    it('should omit impact graph when it only contains standalone nodes', () => {
      const review = createMockReview({
        mermaidDiagram: 'graph TD\nsrc_users_js["src/users.js"]',
      });

      const output = formatter.format(review);

      expect(output).not.toContain('Impact Analysis Graph');
      expect(output).not.toContain('```mermaid');
    });

    it('should include raw provider outputs', () => {
      const review = createMockReview({
        providerResults: [
          {
            name: 'provider-1',
            status: 'success',
            result: {
              content: 'This is the provider review content',
            },
            durationSeconds: 3.5,
          },
          {
            name: 'provider-2',
            status: 'error',
            error: new Error('API rate limited'),
            durationSeconds: 1.0,
          },
        ],
      });

      const output = formatter.format(review);

      expect(output).toContain('Raw Provider Outputs');
      expect(output).toContain('✅ provider-1 [success] (3.50s)');
      expect(output).toContain('This is the provider review content');
      expect(output).toContain('❌ provider-2 [error] (1.00s)');
      expect(output).toContain('Error: API rate limited');
    });

    it('should generate PR summary with findings count', () => {
      const review = createMockReview({
        findings: [
          createMockFinding({ severity: 'critical', file: 'auth.ts' }),
          createMockFinding({ severity: 'major', file: 'api.ts' }),
          createMockFinding({ severity: 'minor', file: 'utils.ts' }),
        ],
        metrics: {
          totalFindings: 3,
          critical: 1,
          major: 1,
          minor: 1,
          providersUsed: 2,
          providersSuccess: 2,
          providersFailed: 0,
          totalTokens: 1000,
          totalCost: 0.005,
          durationSeconds: 5.5,
        },
      });

      const output = formatter.format(review);

      expect(output).toContain('## Summary');
      expect(output).toContain(
        '**1 critical issue** requires immediate attention'
      );
      expect(output).toContain('1 major issue should be addressed');
      expect(output).toContain('1 minor improvement suggested');
      expect(output).toContain('Found across 3 files');
    });

    it('should generate release notes for significant changes', () => {
      const review = createMockReview({
        findings: [
          createMockFinding({
            severity: 'critical',
            title: 'Security fix required',
            category: 'Security',
          }),
          createMockFinding({
            severity: 'major',
            title: 'Breaking API change',
            category: 'API',
          }),
        ],
        metrics: {
          totalFindings: 2,
          critical: 1,
          major: 1,
          minor: 0,
          providersUsed: 2,
          providersSuccess: 2,
          providersFailed: 0,
          totalTokens: 1000,
          totalCost: 0.005,
          durationSeconds: 5.5,
        },
      });

      const output = formatter.format(review);

      expect(output).toContain('## Release Notes');
      expect(output).toContain('**Security:**');
      expect(output).toContain('🔴 Security fix required');
      expect(output).toContain('**API:**');
      expect(output).toContain('🟡 Breaking API change');
    });

    it('should omit empty release notes when significant findings have no categories', () => {
      const review = createMockReview({
        findings: [
          createMockFinding({
            severity: 'critical',
            title: 'Security fix required',
          }),
        ],
        metrics: {
          ...createMockReview().metrics,
          critical: 1,
          totalFindings: 1,
        },
      });

      const output = formatter.format(review);

      expect(output).not.toContain('## Release Notes');
    });

    it('should include footer with branding', () => {
      const review = createMockReview();
      const output = formatter.format(review);

      expect(output).toContain('Powered by AI Robot Review');
      expect(output).toContain(
        '<sub>5.5s • $0.0050 • Powered by AI Robot Review</sub>'
      );
      expect(output).not.toContain('react 👎');
    });

    it('should not mention thumbs-down suppression in the footer', () => {
      const review = createMockReview({
        inlineComments: [
          {
            path: 'src/test.ts',
            line: 42,
            side: 'RIGHT',
            body: 'Inline finding',
          },
        ],
      });
      const output = formatter.format(review);

      expect(output).toContain('Powered by AI Robot Review');
      expect(output).not.toContain('suppress an inline finding');
      expect(output).not.toContain('react 👎');
    });

    it('should use collapsible sections for long content', () => {
      const review = createMockReview({
        findings: [
          createMockFinding({
            evidence: {
              confidence: 0.9,
              reasoning: 'Detailed reasoning here',
              badge: 'High',
            },
          }),
        ],
        metrics: {
          ...createMockReview().metrics,
          major: 1,
          totalFindings: 1,
        },
      });

      const output = formatter.format(review);

      expect(output).toContain('<details>');
      expect(output).toContain('<summary>');
      expect(output).toContain('</details>');
    });
  });
});
