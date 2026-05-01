import { SynthesisEngine } from '../../../src/analysis/synthesis';
import { DEFAULT_CONFIG } from '../../../src/config/defaults';
import { Finding, PRContext } from '../../../src/types';

describe('SynthesisEngine', () => {
  const pr: PRContext = {
    number: 1,
    title: 'Test PR',
    body: '',
    author: 'tester',
    draft: false,
    labels: [],
    files: [],
    diff: '',
    additions: 1,
    deletions: 0,
    baseSha: 'base',
    headSha: 'head',
  };

  it('formats inline comments with committable suggestions when available', () => {
    const finding: Finding = {
      file: 'src/users.js',
      line: 10,
      severity: 'critical',
      title: 'SQL injection',
      message: 'Interpolated SQL is unsafe.',
      suggestion: "const rows = await db.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);",
    };

    const review = new SynthesisEngine({
      ...DEFAULT_CONFIG,
      inlineMinSeverity: 'minor',
      inlineMaxComments: 5,
    }).synthesize([finding], pr);

    expect(review.inlineComments).toHaveLength(1);
    expect(review.inlineComments[0].severity).toBe('critical');
    expect(review.inlineComments[0].suggestion).toBe(finding.suggestion);
    expect(review.inlineComments[0].body).toContain('_🔴 Critical_');
    expect(review.inlineComments[0].body).toContain('_⚡ Quick win_');
    expect(review.inlineComments[0].body).toContain('**SQL injection**');
    expect(review.inlineComments[0].body).toContain('<summary>Suggested fix</summary>');
    expect(review.inlineComments[0].body).toContain('<summary>📝 Committable suggestion</summary>');
    expect(review.inlineComments[0].body).toContain('```suggestion');
    expect(review.inlineComments[0].body).toContain(finding.suggestion);
    expect(review.inlineComments[0].body).toContain('<summary>🤖 Prompt for AI Agents</summary>');
  });

  it('sorts inline comments by severity before applying the inline limit', () => {
    const findings: Finding[] = [
      {
        file: 'src/minor.ts',
        line: 10,
        severity: 'minor',
        title: 'Minor issue',
        message: 'Small cleanup.',
      },
      {
        file: 'src/critical.ts',
        line: 20,
        severity: 'critical',
        title: 'Critical issue',
        message: 'Unsafe behavior.',
      },
      {
        file: 'src/major.ts',
        line: 30,
        severity: 'major',
        title: 'Major issue',
        message: 'Correctness issue.',
      },
    ];

    const review = new SynthesisEngine({
      ...DEFAULT_CONFIG,
      inlineMinSeverity: 'minor',
      inlineMaxComments: 2,
    }).synthesize(findings, pr);

    expect(review.inlineComments.map(comment => comment.severity)).toEqual(['critical', 'major']);
    expect(review.inlineComments[0].body).toContain('_🔴 Critical_');
    expect(review.inlineComments[0].body).toContain('**Critical issue**');
    expect(review.inlineComments[1].body).toContain('_🟡 Major_');
    expect(review.inlineComments[1].body).toContain('**Major issue**');
  });
});
