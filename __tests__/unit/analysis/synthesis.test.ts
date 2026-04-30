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

  it('formats inline suggestions as GitHub suggestion blocks', () => {
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
    expect(review.inlineComments[0].body).toContain('```suggestion');
    expect(review.inlineComments[0].body).toContain(finding.suggestion);
    expect(review.inlineComments[0].body).not.toContain('Suggestion:');
  });
});
