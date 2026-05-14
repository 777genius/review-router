import { ReviewOrchestrator, ReviewComponents } from '../../../src/core/orchestrator';

describe('ReviewOrchestrator', () => {
  let orchestrator: ReviewOrchestrator;
  let mockComponents: Partial<ReviewComponents>;

  beforeEach(() => {
    // Minimal mock for instantiation testing only
    // Full component mocking is done in integration tests
    // See __tests__/integration/orchestrator.integration.test.ts for comprehensive tests
    mockComponents = {
      // Empty partial mock - only testing constructor doesn't throw
    };
    orchestrator = new ReviewOrchestrator(mockComponents as ReviewComponents);
  });

  it('should be instantiable', () => {
    expect(orchestrator).toBeInstanceOf(ReviewOrchestrator);
  });

  it('removes resolved lifecycle threads from fallback dedupe refs', () => {
    const filtered = (
      orchestrator as unknown as {
        removeResolvedLifecycleDedupeRefs: (
          dedupeComments: Array<{ path: string; line: number; body: string }>,
          resolvedRecords: Array<{
            target: { fingerprint: string };
            reasonCodes: string[];
          }>
        ) => Array<{ path: string; line: number; body: string }>;
      }
    ).removeResolvedLifecycleDedupeRefs(
      [
        {
          path: 'src/app.ts',
          line: 10,
          body: '<!-- review-router-finding:aaaaaaaaaaaaaaaaaaaaaaaa -->',
        },
        {
          path: 'src/app.ts',
          line: 12,
          body: '<!-- review-router-finding:bbbbbbbbbbbbbbbbbbbbbbbb -->',
        },
      ],
      [
        {
          target: { fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
          reasonCodes: [],
        },
      ]
    );

    expect(filtered).toHaveLength(1);
    expect(filtered[0].body).toContain('bbbbbbbbbbbbbbbbbbbbbbbb');
  });

  // Note: Comprehensive orchestration tests are in integration test suite
  // This unit test suite is minimal as ReviewOrchestrator is primarily
  // an integration/coordination layer tested better with real component interactions
});
