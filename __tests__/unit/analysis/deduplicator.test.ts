import { Deduplicator } from '../../../src/analysis/deduplicator';
import { Finding } from '../../../src/types';

describe('Deduplicator', () => {
  it('preserves provider model attribution when merging duplicate findings', () => {
    const findings: Finding[] = [
      {
        file: 'auth.js',
        line: 5,
        severity: 'critical',
        title: 'Authentication bypass',
        message: 'Missing email filter.',
        provider: 'openrouter/poolside/laguna-m.1:free',
        providers: ['openrouter/poolside/laguna-m.1:free'],
        providerModels: [
          {
            provider: 'openrouter/poolside/laguna-m.1:free',
            actualModel: 'poolside/laguna-m.1-20260312:free',
          },
        ],
      },
      {
        file: 'auth.js',
        line: 5,
        severity: 'critical',
        title: 'Authentication bypass',
        message: 'Missing email filter.',
        provider: 'codex/gpt-5.5',
        providers: ['codex/gpt-5.5'],
        providerModels: [{ provider: 'codex/gpt-5.5' }],
      },
    ];

    expect(new Deduplicator().dedupe(findings)).toMatchObject([
      {
        providers: ['openrouter/poolside/laguna-m.1:free', 'codex/gpt-5.5'],
        providerModels: [
          {
            provider: 'openrouter/poolside/laguna-m.1:free',
            actualModel: 'poolside/laguna-m.1-20260312:free',
          },
          { provider: 'codex/gpt-5.5' },
        ],
      },
    ]);
  });

  it('merges same-location semantic duplicates and normalizes OpenRouter clone votes', () => {
    const findings: Finding[] = [
      {
        file: 'src/recentProjectOpenHistory.ts',
        line: 38,
        severity: 'critical',
        title: 'Null reference risk',
        message:
          'normalizeHistoryPath may return null before normalizePathForComparison is called.',
        provider: 'openrouter/openai/gpt-oss-120b:free',
        providers: ['openrouter/openai/gpt-oss-120b:free'],
        providerModels: [{ provider: 'openrouter/openai/gpt-oss-120b:free' }],
      },
      {
        file: 'src/recentProjectOpenHistory.ts',
        line: 38,
        severity: 'critical',
        title: 'Null reference',
        message:
          'normalizeHistoryPath may return null and that null value reaches normalizePathForComparison.',
        provider: 'openrouter/openai/gpt-oss-120b:free#5',
        providers: ['openrouter/openai/gpt-oss-120b:free#5'],
        providerModels: [{ provider: 'openrouter/openai/gpt-oss-120b:free#5' }],
      },
    ];

    const result = new Deduplicator().dedupe(findings);

    expect(result).toHaveLength(1);
    expect(result[0].providers).toEqual([
      'openrouter/openai/gpt-oss-120b:free',
      'openrouter/openai/gpt-oss-120b:free#5',
    ]);
    expect(result[0].providerVoteKeys).toEqual([
      'openrouter/openai/gpt-oss-120b:free',
    ]);
  });

  it('keeps different same-line issue classes separate', () => {
    const findings: Finding[] = [
      {
        file: 'src/auth.ts',
        line: 12,
        severity: 'critical',
        title: 'Null reference',
        message: 'user may be null before user.name is read.',
        provider: 'codex/gpt-5.5',
      },
      {
        file: 'src/auth.ts',
        line: 12,
        severity: 'critical',
        title: 'Authorization bypass',
        message: 'adminOnly is not checked before granting access.',
        provider: 'claude/sonnet',
      },
    ];

    expect(new Deduplicator().dedupe(findings)).toHaveLength(2);
  });
});
