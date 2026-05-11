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
});
