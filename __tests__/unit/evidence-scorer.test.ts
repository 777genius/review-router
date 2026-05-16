import { EvidenceScorer } from '../../src/analysis/evidence';
import { Finding } from '../../src/types';

describe('EvidenceScorer', () => {
  const baseFinding: Finding = {
    file: 'src/index.ts',
    line: 10,
    severity: 'major',
    title: 'Test',
    message: 'Test message',
    providers: ['p1', 'p2'],
  };

  it('scores high confidence with multiple signals', () => {
    const scorer = new EvidenceScorer();

    const result = scorer.score(baseFinding, 3, true, true, true);

    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.badge).toContain('High Confidence');
    expect(result.reasoning).toContain('provider agreement');
  });

  it('degrades confidence when signals are missing', () => {
    const scorer = new EvidenceScorer();

    const result = scorer.score(baseFinding, 3, false, false, false);

    expect(result.confidence).toBeLessThan(0.7);
    expect(result.badge).toContain('Low');
  });

  it('does not inflate agreement for OpenRouter model clones', () => {
    const scorer = new EvidenceScorer();

    const result = scorer.score(
      {
        ...baseFinding,
        providers: [
          'openrouter/openai/gpt-oss-120b:free',
          'openrouter/openai/gpt-oss-120b:free#5',
        ],
        providerVoteKeys: ['openrouter/openai/gpt-oss-120b:free'],
      },
      2,
      false,
      false,
      false
    );

    expect(result.confidence).toBeCloseTo(0.15);
    expect(result.reasoning).toContain('50% provider agreement');
  });
});
