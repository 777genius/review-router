import { extractFindings } from '../../../src/analysis/llm/parser';
import { ProviderResult } from '../../../src/types';

describe('extractFindings', () => {
  it('attaches provider and actual model attribution to parsed findings', () => {
    const results: ProviderResult[] = [
      {
        name: 'openrouter/poolside/laguna-m.1:free',
        status: 'success',
        durationSeconds: 1,
        result: {
          content: '',
          actualModel: 'poolside/laguna-m.1-20260312:free',
          findings: [
            {
              file: 'auth.js',
              line: 5,
              severity: 'critical',
              title: 'Authentication bypass',
              message: 'Missing email filter.',
            },
          ],
        },
      },
    ];

    expect(extractFindings(results)).toMatchObject([
      {
        provider: 'openrouter/poolside/laguna-m.1:free',
        providers: ['openrouter/poolside/laguna-m.1:free'],
        actualModel: 'poolside/laguna-m.1-20260312:free',
        providerModels: [
          {
            provider: 'openrouter/poolside/laguna-m.1:free',
            actualModel: 'poolside/laguna-m.1-20260312:free',
          },
        ],
      },
    ]);
  });
});
