import {
  ReviewOrchestrator,
  ReviewComponents,
} from '../../../src/core/orchestrator';
import {
  ReviewConfig,
  PRContext,
  Finding,
  FileChange,
  ProviderResult,
  PullRequestLoadOmissionReason,
  PullRequestLoadStatus,
} from '../../../src/types';
import { Provider } from '../../../src/providers/base';
import { DEFAULT_CONFIG } from '../../../src/config/defaults';

// Minimal helpers
const emptyReview: any = {
  summary: '',
  findings: [],
  inlineComments: [],
  actionItems: [],
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
    durationSeconds: 0,
  },
  runDetails: {
    providers: [],
    totalCost: 0,
    totalTokens: 0,
    durationSeconds: 0,
    cacheHit: false,
    synthesisModel: '',
    providerPoolSize: 0,
  },
};

function makeOrchestrator(
  overrides: Partial<ReviewComponents & { config: ReviewConfig }>
) {
  const providers: Provider[] = [
    {
      name: 'p1',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider,
  ];

  const config: ReviewConfig = {
    ...DEFAULT_CONFIG,
    dryRun: true,
    enableCaching: false,
    analyticsEnabled: false,
    graphEnabled: false,
    providers: [],
    fallbackProviders: [],
    providerLimit: 4,
  };

  const components: ReviewComponents = {
    config,
    providerRegistry: {
      createProviders: jest.fn().mockResolvedValue(providers),
      discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
    } as any,
    promptBuilder: { build: jest.fn().mockReturnValue('prompt') } as any,
    llmExecutor: {
      filterHealthyProviders: jest.fn(),
      execute: jest.fn(() => {
        throw new Error(
          'execute should not be called when no healthy providers'
        );
      }),
    } as any,
    deduplicator: { dedupe: (f: Finding[]) => f } as any,
    consensus: { filter: (f: Finding[]) => f } as any,
    synthesis: { synthesize: jest.fn().mockReturnValue(emptyReview) } as any,
    testCoverage: { analyze: jest.fn().mockReturnValue(undefined) } as any,
    astAnalyzer: { analyze: jest.fn().mockReturnValue([]) } as any,
    cache: { load: jest.fn().mockResolvedValue(null), save: jest.fn() } as any,
    incrementalReviewer: {
      shouldUseIncremental: jest.fn().mockResolvedValue(false),
      getLastReview: jest.fn(),
      mergeFindings: jest.fn(),
      generateIncrementalSummary: jest.fn(),
      saveReview: jest.fn(),
      getChangedFilesSince: jest.fn(),
      getIncrementalChangeSet: jest.fn(),
    } as any,
    costTracker: {
      record: jest.fn(),
      summary: jest
        .fn()
        .mockReturnValue({ totalCost: 0, totalTokens: 0, breakdown: {} }),
      reset: jest.fn(),
    } as any,
    security: { scan: jest.fn().mockReturnValue([]) } as any,
    rules: { run: jest.fn().mockReturnValue([]) } as any,
    prLoader: { load: jest.fn() } as any,
    commentPoster: {
      postSummary: jest.fn(),
      postInline: jest.fn(),
      deleteSummaryComments: jest.fn(),
    } as any,
    formatter: { format: jest.fn().mockReturnValue('') } as any,
    contextRetriever: {
      findRelatedContext: jest.fn().mockReturnValue([]),
    } as any,
    impactAnalyzer: { analyze: jest.fn().mockReturnValue([]) } as any,
    evidenceScorer: {
      score: jest.fn().mockReturnValue({ confidence: 1 }),
    } as any,
    mermaidGenerator: {
      generateImpactDiagram: jest.fn().mockReturnValue(''),
    } as any,
    feedbackFilter: {
      loadSuppressed: jest.fn().mockResolvedValue([]),
      loadReviewCommentState: jest.fn().mockResolvedValue({
        suppressed: new Set(),
        alreadyPosted: new Set(),
      }),
      shouldPost: jest.fn().mockReturnValue(true),
    } as any,
    reliabilityTracker: {
      isCircuitOpen: jest.fn().mockResolvedValue(false),
      rankProviders: jest.fn().mockResolvedValue([]),
      recordResult: jest.fn(),
    } as any,
    promptGenerator: {
      generateFixPrompts: jest.fn().mockReturnValue([]),
      saveToFile: jest.fn(),
    } as any,
    quietModeFilter: undefined,
    graphBuilder: undefined,
    feedbackTracker: undefined,
    metricsCollector: undefined,
    batchOrchestrator: undefined,
    githubClient: undefined,
  } as any;

  Object.assign(components, overrides);
  return new ReviewOrchestrator(components);
}

function makePR(files: FileChange[]): PRContext {
  return {
    number: 1,
    title: 't',
    author: 'a',
    draft: false,
    labels: [],
    additions: 0,
    deletions: 0,
    files,
    diff: '',
    baseSha: 'b',
    headSha: 'h',
    body: '',
  };
}

describe('ReviewOrchestrator health check guard rails', () => {
  const originalProgressComments = process.env.REVIEW_ROUTER_PROGRESS_COMMENTS;

  afterEach(() => {
    if (originalProgressComments === undefined) {
      delete process.env.REVIEW_ROUTER_PROGRESS_COMMENTS;
    } else {
      process.env.REVIEW_ROUTER_PROGRESS_COMMENTS = originalProgressComments;
    }
  });

  it('short-circuits LLM execution when no healthy providers and records reliability', async () => {
    const healthResults: ProviderResult[] = [
      { name: 'p1', status: 'timeout', durationSeconds: 0 } as any,
    ];

    const orchestrator = makeOrchestrator({
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [],
          healthCheckResults: healthResults,
        }),
        execute: jest.fn(),
      } as any,
    });

    const pr = makePR([
      {
        filename: 'a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
      },
    ]);

    const review = await orchestrator.executeReview(pr);

    expect(review).toBeTruthy();
    expect(
      (orchestrator as any).components.llmExecutor.execute
    ).not.toHaveBeenCalled();
    expect(
      (orchestrator as any).components.reliabilityTracker.recordResult
    ).toHaveBeenCalledWith('p1', false, 0, undefined);
  });

  it('executes LLM review with one explicit healthy provider', async () => {
    const provider = {
      name: 'p1',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const execute = jest.fn().mockResolvedValue([
      {
        name: 'p1',
        status: 'success',
        result: {
          content: '{"findings":[]}',
          findings: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
        durationSeconds: 0,
      } as ProviderResult,
    ]);

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: ['p1'],
        fallbackProviders: [],
        providerLimit: 1,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute,
      } as any,
    });

    const pr = makePR([
      {
        filename: 'a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
      },
    ]);

    const review = await orchestrator.executeReview(pr);

    expect(review).toBeTruthy();
    expect(execute).toHaveBeenCalledWith(
      [provider],
      expect.any(String),
      expect.any(Number)
    );
  });

  it('does not post GitHub comments for a clean review', async () => {
    const provider = {
      name: 'p1',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const postSummary = jest.fn();
    const postInline = jest.fn();
    const deleteSummaryComments = jest.fn();

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: false,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: ['p1'],
        fallbackProviders: [],
        providerLimit: 1,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute: jest.fn().mockResolvedValue([
          {
            name: 'p1',
            status: 'success',
            result: {
              content: '{"findings":[]}',
              findings: [],
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            },
            durationSeconds: 0,
          } as ProviderResult,
        ]),
      } as any,
      commentPoster: {
        postSummary,
        postInline,
        deleteSummaryComments,
      } as any,
      formatter: { format: jest.fn().mockReturnValue('## All Clear!') } as any,
    });

    const pr = makePR([
      {
        filename: 'a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
      },
    ]);

    const review = await orchestrator.executeReview(pr);

    expect(review.findings).toHaveLength(0);
    expect(postSummary).not.toHaveBeenCalled();
    expect(deleteSummaryComments).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ reviewedHeadSha: 'h' }),
      'no reportable findings were found'
    );
    expect(postInline).toHaveBeenCalledWith(1, [], pr.files, 'h');
  });

  it('creates a progress comment by default for the first GitHub review', async () => {
    delete process.env.REVIEW_ROUTER_PROGRESS_COMMENTS;
    const provider = {
      name: 'p1',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const createComment = jest.fn().mockResolvedValue({ data: { id: 456 } });
    const updateComment = jest.fn().mockResolvedValue({});
    const listIssueComments = jest.fn().mockResolvedValue({ data: [] });
    const listReviewComments = jest.fn().mockResolvedValue({ data: [] });

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: false,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: ['p1'],
        fallbackProviders: [],
        providerLimit: 1,
      },
      githubClient: {
        owner: 'owner',
        repo: 'repo',
        octokit: {
          rest: {
            issues: {
              listComments: listIssueComments,
              createComment,
              updateComment,
            },
            pulls: {
              listReviewComments,
            },
          },
        },
      } as any,
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute: jest.fn().mockResolvedValue([
          {
            name: 'p1',
            status: 'success',
            result: {
              content: '{"findings":[]}',
              findings: [],
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            },
            durationSeconds: 0,
          } as ProviderResult,
        ]),
      } as any,
      formatter: { format: jest.fn().mockReturnValue('## All Clear!') } as any,
    });

    await orchestrator.executeReview(
      makePR([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(listIssueComments).toHaveBeenCalled();
    expect(listReviewComments).toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 1,
        body: expect.stringContaining('## 🤖 ReviewRouter Progress'),
      })
    );
    expect(updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 456,
        body: expect.stringContaining('Build code graph'),
      })
    );
    expect(updateComment).toHaveBeenLastCalledWith(
      expect.objectContaining({
        comment_id: 456,
        body: expect.stringContaining('## All Clear!'),
      })
    );
    expect(updateComment.mock.calls.at(-1)?.[0].body).not.toContain(
      '<!-- review-router-progress-tracker -->'
    );
  });

  it('skips default progress when the PR already has ReviewRouter activity', async () => {
    delete process.env.REVIEW_ROUTER_PROGRESS_COMMENTS;
    const provider = {
      name: 'p1',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const createComment = jest.fn();
    const listIssueComments = jest.fn().mockResolvedValue({
      data: [
        {
          id: 99,
          body: '<!-- review-router-bot -->\n\n# ReviewRouter\nold summary',
        },
      ],
    });
    const listReviewComments = jest.fn().mockResolvedValue({ data: [] });

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: false,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: ['p1'],
        fallbackProviders: [],
        providerLimit: 1,
      },
      githubClient: {
        owner: 'owner',
        repo: 'repo',
        octokit: {
          rest: {
            issues: {
              listComments: listIssueComments,
              createComment,
              updateComment: jest.fn(),
            },
            pulls: {
              listReviewComments,
            },
          },
        },
      } as any,
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute: jest.fn().mockResolvedValue([
          {
            name: 'p1',
            status: 'success',
            result: {
              content: '{"findings":[]}',
              findings: [],
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            },
            durationSeconds: 0,
          } as ProviderResult,
        ]),
      } as any,
      formatter: { format: jest.fn().mockReturnValue('## All Clear!') } as any,
    });

    await orchestrator.executeReview(
      makePR([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(listIssueComments).toHaveBeenCalled();
    expect(listReviewComments).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it('reuses progress-only comments instead of treating them as completed activity', async () => {
    delete process.env.REVIEW_ROUTER_PROGRESS_COMMENTS;
    const provider = {
      name: 'p1',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const createComment = jest.fn();
    const updateComment = jest.fn().mockResolvedValue({});
    const listIssueComments = jest.fn().mockResolvedValue({
      data: [
        {
          id: 99,
          body: '## 🤖 ReviewRouter Progress\n\n<!-- review-router-progress-tracker -->',
        },
      ],
    });
    const listReviewComments = jest.fn().mockResolvedValue({ data: [] });

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: false,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: ['p1'],
        fallbackProviders: [],
        providerLimit: 1,
      },
      githubClient: {
        owner: 'owner',
        repo: 'repo',
        octokit: {
          rest: {
            issues: {
              listComments: listIssueComments,
              createComment,
              updateComment,
            },
            pulls: {
              listReviewComments,
            },
          },
        },
      } as any,
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute: jest.fn().mockResolvedValue([
          {
            name: 'p1',
            status: 'success',
            result: {
              content: '{"findings":[]}',
              findings: [],
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            },
            durationSeconds: 0,
          } as ProviderResult,
        ]),
      } as any,
      formatter: { format: jest.fn().mockReturnValue('## All Clear!') } as any,
    });

    await orchestrator.executeReview(
      makePR([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(listIssueComments).toHaveBeenCalled();
    expect(listReviewComments).toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenLastCalledWith(
      expect.objectContaining({
        comment_id: 99,
        body: expect.stringContaining('## All Clear!'),
      })
    );
    expect(updateComment.mock.calls.at(-1)?.[0].body).not.toContain(
      '<!-- review-router-progress-tracker -->'
    );
  });

  it('does not create progress comments when explicitly disabled', async () => {
    process.env.REVIEW_ROUTER_PROGRESS_COMMENTS = 'false';
    const provider = {
      name: 'p1',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const createComment = jest.fn();
    const listIssueComments = jest.fn().mockResolvedValue({ data: [] });

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: false,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: ['p1'],
        fallbackProviders: [],
        providerLimit: 1,
      },
      githubClient: {
        owner: 'owner',
        repo: 'repo',
        octokit: {
          rest: {
            issues: {
              listComments: listIssueComments,
              createComment,
              updateComment: jest.fn(),
            },
            pulls: {
              listReviewComments: jest.fn(),
            },
          },
        },
      } as any,
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute: jest.fn().mockResolvedValue([
          {
            name: 'p1',
            status: 'success',
            result: {
              content: '{"findings":[]}',
              findings: [],
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            },
            durationSeconds: 0,
          } as ProviderResult,
        ]),
      } as any,
      formatter: { format: jest.fn().mockReturnValue('## All Clear!') } as any,
    });

    await orchestrator.executeReview(
      makePR([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(listIssueComments).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it('continues when one provider succeeds and other providers degrade', async () => {
    const previousFailOnNoHealthy = process.env.FAIL_ON_NO_HEALTHY_PROVIDERS;
    process.env.FAIL_ON_NO_HEALTHY_PROVIDERS = 'true';

    const providers = ['p1', 'p2', 'p3', 'p4'].map(
      (name) =>
        ({
          name,
          review: jest.fn(),
          healthCheck: jest.fn(),
        }) as unknown as Provider
    );
    const finding: Finding = {
      file: 'a.ts',
      line: 1,
      severity: 'major',
      title: 'Runtime exception',
      message:
        'The changed line dereferences config.value after config is assigned null, so this path will throw at runtime.',
    };
    const synthesize = jest.fn(
      (
        findings: Finding[],
        _reviewPR: PRContext,
        _testHints: unknown,
        _aiAnalysis: unknown,
        _providerResults: ProviderResult[],
        runDetails: unknown
      ) => ({
        ...emptyReview,
        summary: 'summary',
        findings,
        metrics: {
          ...emptyReview.metrics,
          totalFindings: findings.length,
          major: findings.length,
        },
        runDetails,
      })
    );

    try {
      const orchestrator = makeOrchestrator({
        config: {
          ...DEFAULT_CONFIG,
          dryRun: true,
          enableCaching: false,
          analyticsEnabled: false,
          graphEnabled: false,
          providers: providers.map((provider) => provider.name),
          fallbackProviders: [],
          providerLimit: 4,
          inlineMinSeverity: 'minor',
        },
        providerRegistry: {
          createProviders: jest.fn().mockResolvedValue(providers),
          discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
        } as any,
        llmExecutor: {
          filterHealthyProviders: jest.fn().mockResolvedValue({
            healthy: providers,
            healthCheckResults: [],
          }),
          execute: jest.fn().mockResolvedValue([
            {
              name: 'p1',
              status: 'success',
              result: {
                content:
                  '{"findings":[{"file":"a.ts","line":1,"severity":"major","title":"Runtime exception","message":"runtime crash"}]}',
                findings: [finding],
              },
              durationSeconds: 1,
            } as ProviderResult,
            {
              name: 'p2',
              status: 'error',
              error: new Error(
                'OpenRouter returned invalid review JSON: response was not valid JSON'
              ),
              durationSeconds: 1,
            } as ProviderResult,
            {
              name: 'p3',
              status: 'timeout',
              error: new Error('Provider timed out after 600000ms'),
              durationSeconds: 600,
            } as ProviderResult,
            {
              name: 'p4',
              status: 'error',
              error: new Error(
                'OpenRouter returned invalid review JSON: expected an object with a findings array'
              ),
              durationSeconds: 1,
            } as ProviderResult,
          ]),
        } as any,
        synthesis: { synthesize } as any,
      });

      const diff = 'diff --git a/a.ts b/a.ts\n@@ -0,0 +1 @@\n+config.value\n';
      const pr = makePR([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '@@ -0,0 +1 @@\n+config.value\n',
        },
      ]);
      pr.diff = diff;

      const review = await orchestrator.executeReview(pr);

      expect(review.findings).toContainEqual(expect.objectContaining(finding));
      expect(review.metrics.providersSuccess).toBe(1);
      expect(review.metrics.providersFailed).toBe(3);
      expect(review.runDetails?.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'p1', status: 'success' }),
          expect.objectContaining({ name: 'p2', status: 'error' }),
          expect.objectContaining({ name: 'p3', status: 'timeout' }),
          expect.objectContaining({ name: 'p4', status: 'error' }),
        ])
      );
    } finally {
      if (previousFailOnNoHealthy === undefined) {
        delete process.env.FAIL_ON_NO_HEALTHY_PROVIDERS;
      } else {
        process.env.FAIL_ON_NO_HEALTHY_PROVIDERS = previousFailOnNoHealthy;
      }
    }
  });

  it('fails when a required healthy provider fails health checks', async () => {
    const providers = ['codex/gpt-5.5', 'openrouter/free'].map(
      (name) =>
        ({
          name,
          review: jest.fn(),
          healthCheck: jest.fn(),
        }) as unknown as Provider
    );

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: providers.map((provider) => provider.name),
        requiredHealthyProviders: ['codex/gpt-5.5'],
        fallbackProviders: [],
        providerLimit: 2,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue(providers),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [providers[1]],
          healthCheckResults: [
            {
              name: 'codex/gpt-5.5',
              status: 'timeout',
              error: new Error('health check timed out'),
              durationSeconds: 30,
            } as ProviderResult,
            {
              name: 'openrouter/free',
              status: 'success',
              durationSeconds: 0.1,
            } as ProviderResult,
          ],
        }),
        execute: jest.fn(),
      } as any,
    });

    await expect(
      orchestrator.executeReview(
        makePR([
          {
            filename: 'a.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
          },
        ])
      )
    ).rejects.toThrow(
      /Required healthy provider codex\/gpt-5\.5 failed health check/
    );
  });

  it('fails when a required healthy provider fails execution while another provider succeeds', async () => {
    const providers = ['codex/gpt-5.5', 'openrouter/free'].map(
      (name) =>
        ({
          name,
          review: jest.fn(),
          healthCheck: jest.fn(),
        }) as unknown as Provider
    );

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: providers.map((provider) => provider.name),
        requiredHealthyProviders: ['codex/gpt-5.5'],
        fallbackProviders: [],
        providerLimit: 2,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue(providers),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: providers,
          healthCheckResults: [],
        }),
        execute: jest.fn().mockResolvedValue([
          {
            name: 'codex/gpt-5.5',
            status: 'timeout',
            error: new Error('Codex CLI timed out after 600000ms'),
            durationSeconds: 600,
          } as ProviderResult,
          {
            name: 'openrouter/free',
            status: 'success',
            result: {
              content: '{"findings":[],"revalidations":[]}',
              findings: [],
              revalidations: [],
            },
            durationSeconds: 1,
          } as ProviderResult,
        ]),
      } as any,
    });

    await expect(
      orchestrator.executeReview(
        makePR([
          {
            filename: 'a.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
          },
        ])
      )
    ).rejects.toThrow(
      /Required healthy provider codex\/gpt-5\.5 failed during review/
    );
  });

  it('fails when a required healthy provider only returns a health-check-shaped success', async () => {
    const providers = ['codex/gpt-5.5'].map(
      (name) =>
        ({
          name,
          review: jest.fn(),
          healthCheck: jest.fn(),
        }) as unknown as Provider
    );

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: providers.map((provider) => provider.name),
        requiredHealthyProviders: ['codex/gpt-5.5'],
        fallbackProviders: [],
        providerLimit: 1,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue(providers),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: providers,
          healthCheckResults: [
            {
              name: 'codex/gpt-5.5',
              status: 'success',
              durationSeconds: 0.01,
            } as ProviderResult,
          ],
        }),
        execute: jest.fn().mockResolvedValue([
          {
            name: 'codex/gpt-5.5',
            status: 'success',
            durationSeconds: 0.01,
          } as ProviderResult,
        ]),
      } as any,
    });

    await expect(
      orchestrator.executeReview(
        makePR([
          {
            filename: 'a.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
          },
        ])
      )
    ).rejects.toThrow(
      /Required healthy provider codex\/gpt-5\.5 did not return a review result/
    );
  });

  it('fails when a required healthy provider succeeds in one batch but fails in another', async () => {
    const providers = ['codex/gpt-5.5', 'openrouter/free'].map(
      (name) =>
        ({
          name,
          review: jest.fn(),
          healthCheck: jest.fn(),
        }) as unknown as Provider
    );
    const execute = jest
      .fn()
      .mockResolvedValueOnce([
        {
          name: 'codex/gpt-5.5',
          status: 'success',
          result: {
            content: '{"findings":[],"revalidations":[]}',
            findings: [],
            revalidations: [],
          },
          durationSeconds: 1,
        } as ProviderResult,
        {
          name: 'openrouter/free',
          status: 'success',
          result: {
            content: '{"findings":[],"revalidations":[]}',
            findings: [],
            revalidations: [],
          },
          durationSeconds: 1,
        } as ProviderResult,
      ])
      .mockResolvedValueOnce([
        {
          name: 'codex/gpt-5.5',
          status: 'error',
          error: new Error('returned invalid review JSON after retries'),
          durationSeconds: 3,
        } as ProviderResult,
        {
          name: 'openrouter/free',
          status: 'success',
          result: {
            content: '{"findings":[],"revalidations":[]}',
            findings: [],
            revalidations: [],
          },
          durationSeconds: 1,
        } as ProviderResult,
      ]);

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: providers.map((provider) => provider.name),
        requiredHealthyProviders: ['codex/gpt-5.5'],
        fallbackProviders: [],
        providerLimit: 2,
        batchMaxFiles: 1,
        enableTokenAwareBatching: false,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue(providers),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: providers,
          healthCheckResults: [],
        }),
        execute,
      } as any,
    });

    await expect(
      orchestrator.executeReview(
        makePR([
          {
            filename: 'a.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
          },
          {
            filename: 'b.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
          },
        ])
      )
    ).rejects.toThrow(
      /Required healthy provider codex\/gpt-5\.5 failed during review/
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('publishes partial coverage without advancing the completed snapshot', async () => {
    const provider = {
      name: 'codex/gpt-5.5',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const execute = jest
      .fn()
      .mockResolvedValueOnce([
        {
          name: provider.name,
          status: 'success',
          result: {
            content: '{"findings":[],"revalidations":[]}',
            findings: [],
            revalidations: [],
          },
          durationSeconds: 1,
        } as ProviderResult,
      ])
      .mockResolvedValueOnce([
        {
          name: provider.name,
          status: 'error',
          error: new Error('capacity_unavailable'),
          durationSeconds: 1,
        } as ProviderResult,
      ]);
    const saveReview = jest.fn();
    const format = jest.fn().mockReturnValue('');
    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        incrementalEnabled: true,
        providers: [provider.name],
        requiredHealthyProviders: [],
        fallbackProviders: [],
        providerLimit: 1,
        batchMaxFiles: 1,
        enableTokenAwareBatching: false,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute,
      } as any,
      incrementalReviewer: {
        shouldUseIncremental: jest.fn().mockResolvedValue(false),
        getLastReview: jest.fn(),
        mergeFindings: jest.fn(),
        generateIncrementalSummary: jest.fn(),
        saveReview,
        getChangedFilesSince: jest.fn(),
        getIncrementalChangeSet: jest.fn(),
      } as any,
      formatter: { format } as any,
    });

    const review = await orchestrator.executeReview(
      makePR([
        {
          filename: 'src/first.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
        {
          filename: 'src/second.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(review.coverage).toMatchObject({
      complete: false,
      unreviewedFiles: 1,
    });
    expect(review.coverage?.files).toContainEqual(
      expect.objectContaining({
        path: 'src/second.ts',
        status: 'unreviewed',
      })
    );
    expect(saveReview).not.toHaveBeenCalled();
    expect(
      format.mock.calls.some(
        ([formattedReview]) => formattedReview.coverage?.complete === false
      )
    ).toBe(true);
  });

  it('does not advance a snapshot when GitHub omitted files but loaded work is empty', async () => {
    const saveReview = jest.fn();
    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        incrementalEnabled: true,
        providers: [],
        fallbackProviders: [],
      },
      incrementalReviewer: {
        shouldUseIncremental: jest.fn().mockResolvedValue(false),
        getLastReview: jest.fn(),
        mergeFindings: jest.fn(),
        generateIncrementalSummary: jest.fn(),
        saveReview,
        getChangedFilesSince: jest.fn(),
        getIncrementalChangeSet: jest.fn(),
      } as any,
    });
    const pr: PRContext = {
      ...makePR([]),
      loadCompleteness: {
        status: PullRequestLoadStatus.Truncated,
        omissions: [
          {
            reason: PullRequestLoadOmissionReason.GitHubFileLimit,
            omittedFileCount: 1,
          },
        ],
      },
    };

    const review = await orchestrator.executeReview(pr);

    expect(review.coverage).toMatchObject({
      complete: false,
      unreviewedFiles: 1,
    });
    expect(saveReview).not.toHaveBeenCalled();
  });

  it('pins required healthy providers during execution limiting', async () => {
    const providers = ['opencode/high', 'opencode/required-low'].map(
      (name) =>
        ({
          name,
          review: jest.fn(),
          healthCheck: jest.fn(),
        }) as unknown as Provider
    );
    const execute = jest.fn().mockResolvedValue([
      {
        name: 'opencode/required-low',
        status: 'success',
        result: {
          content: '{"findings":[],"revalidations":[]}',
          findings: [],
          revalidations: [],
        },
        durationSeconds: 1,
      } as ProviderResult,
    ]);

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: providers.map((provider) => provider.name),
        requiredHealthyProviders: ['opencode/required-low'],
        fallbackProviders: [],
        providerLimit: 1,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue(providers),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: providers,
          healthCheckResults: [],
        }),
        execute,
      } as any,
    });

    await orchestrator.executeReview(
      makePR([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(execute).toHaveBeenCalledWith(
      [expect.objectContaining({ name: 'opencode/required-low' })],
      expect.any(String),
      expect.any(Number)
    );
  });

  it('executes a required healthy provider even when optional provider discovery is below the multi-provider minimum', async () => {
    const providers = [
      'codex/gpt-5.5',
      'openrouter/free-a',
      'openrouter/free-b',
      'opencode/free',
    ].map(
      (name) =>
        ({
          name,
          review: jest.fn(),
          healthCheck: jest.fn(),
        }) as unknown as Provider
    );
    const codexProvider = providers[0];
    const execute = jest.fn().mockResolvedValue([
      {
        name: 'codex/gpt-5.5',
        status: 'success',
        result: {
          content: '{"findings":[],"revalidations":[]}',
          findings: [],
          revalidations: [],
        },
        durationSeconds: 1,
      } as ProviderResult,
    ]);

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: providers.map((provider) => provider.name),
        requiredHealthyProviders: ['codex/gpt-5.5'],
        fallbackProviders: [],
        providerLimit: 4,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue(providers),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [codexProvider],
          healthCheckResults: [
            {
              name: 'codex/gpt-5.5',
              status: 'success',
              durationSeconds: 0.01,
            } as ProviderResult,
            {
              name: 'openrouter/free-a',
              status: 'error',
              error: new Error('OPENROUTER_API_KEY not set'),
              durationSeconds: 0.01,
            } as ProviderResult,
          ],
        }),
        execute,
      } as any,
    });

    await orchestrator.executeReview(
      makePR([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(execute).toHaveBeenCalledWith(
      [codexProvider],
      expect.any(String),
      expect.any(Number)
    );
  });

  it('keeps non-required provider findings eligible for severity blocking', async () => {
    const providers = ['codex/gpt-5.5', 'openrouter/free'].map(
      (name) =>
        ({
          name,
          review: jest.fn(),
          healthCheck: jest.fn(),
        }) as unknown as Provider
    );
    const finding: Finding = {
      file: 'a.ts',
      line: 1,
      severity: 'major',
      title: 'OpenRouter finding',
      message: 'The changed line can throw at runtime.',
      provider: 'openrouter/free',
    };
    const synthesize = jest.fn((findings: Finding[], ...rest: any[]) => ({
      ...emptyReview,
      findings,
      metrics: {
        ...emptyReview.metrics,
        totalFindings: findings.length,
        major: findings.length,
      },
      runDetails: rest[4],
    }));

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: providers.map((provider) => provider.name),
        requiredHealthyProviders: ['codex/gpt-5.5'],
        fallbackProviders: [],
        providerLimit: 2,
        inlineMinSeverity: 'minor',
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue(providers),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: providers,
          healthCheckResults: [],
        }),
        execute: jest.fn().mockResolvedValue([
          {
            name: 'codex/gpt-5.5',
            status: 'success',
            result: {
              content: '{"findings":[],"revalidations":[]}',
              findings: [],
              revalidations: [],
            },
            durationSeconds: 1,
          } as ProviderResult,
          {
            name: 'openrouter/free',
            status: 'success',
            result: {
              content:
                '{"findings":[{"file":"a.ts","line":1,"severity":"major","title":"OpenRouter finding","message":"runtime crash"}],"revalidations":[]}',
              findings: [finding],
              revalidations: [],
            },
            durationSeconds: 1,
          } as ProviderResult,
        ]),
      } as any,
      synthesis: { synthesize } as any,
    });

    const pr = makePR([
      {
        filename: 'a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: '@@ -0,0 +1 @@\n+dangerousCall()\n',
      },
    ]);
    pr.diff = 'diff --git a/a.ts b/a.ts\n@@ -0,0 +1 @@\n+dangerousCall()\n';

    const review = await orchestrator.executeReview(pr);

    expect(review.findings).toContainEqual(expect.objectContaining(finding));
    expect(review.runDetails?.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'codex/gpt-5.5',
          requiredHealthy: true,
        }),
        expect.objectContaining({
          name: 'openrouter/free',
          requiredHealthy: false,
        }),
      ])
    );
  });

  it('fails when all selected providers fail and provider failure is blocking', async () => {
    const previousFailOnNoHealthy = process.env.FAIL_ON_NO_HEALTHY_PROVIDERS;
    process.env.FAIL_ON_NO_HEALTHY_PROVIDERS = 'true';

    const providers = ['p1', 'p2', 'p3', 'p4'].map(
      (name) =>
        ({
          name,
          review: jest.fn(),
          healthCheck: jest.fn(),
        }) as unknown as Provider
    );

    try {
      const orchestrator = makeOrchestrator({
        config: {
          ...DEFAULT_CONFIG,
          dryRun: true,
          enableCaching: false,
          analyticsEnabled: false,
          graphEnabled: false,
          providers: providers.map((provider) => provider.name),
          fallbackProviders: [],
          providerLimit: 4,
        },
        providerRegistry: {
          createProviders: jest.fn().mockResolvedValue(providers),
          discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
        } as any,
        llmExecutor: {
          filterHealthyProviders: jest.fn().mockResolvedValue({
            healthy: providers,
            healthCheckResults: [],
          }),
          execute: jest.fn().mockResolvedValue([
            {
              name: 'p1',
              status: 'error',
              error: new Error(
                'OpenRouter returned invalid review JSON: response was not valid JSON'
              ),
              durationSeconds: 1,
            },
            {
              name: 'p2',
              status: 'timeout',
              error: new Error('Provider timed out after 600000ms'),
              durationSeconds: 600,
            },
            {
              name: 'p3',
              status: 'error',
              error: new Error(
                'OpenRouter returned invalid review JSON: expected an object with a findings array'
              ),
              durationSeconds: 1,
            },
            {
              name: 'p4',
              status: 'error',
              error: new Error(
                'OpenRouter returned invalid review JSON: missing required file, line, severity, title, or message'
              ),
              durationSeconds: 1,
            },
          ] as ProviderResult[]),
        } as any,
      });

      await expect(
        orchestrator.executeReview(
          makePR([
            {
              filename: 'a.ts',
              status: 'modified',
              additions: 1,
              deletions: 0,
              changes: 1,
            },
          ])
        )
      ).rejects.toThrow(/All LLM providers failed during review/);
    } finally {
      if (previousFailOnNoHealthy === undefined) {
        delete process.env.FAIL_ON_NO_HEALTHY_PROVIDERS;
      } else {
        process.env.FAIL_ON_NO_HEALTHY_PROVIDERS = previousFailOnNoHealthy;
      }
    }
  });

  it('succeeds across multiple batches when each batch has one successful provider', async () => {
    const previousFailOnNoHealthy = process.env.FAIL_ON_NO_HEALTHY_PROVIDERS;
    process.env.FAIL_ON_NO_HEALTHY_PROVIDERS = 'true';

    const providers = ['p1', 'p2'].map(
      (name) =>
        ({
          name,
          review: jest.fn(),
          healthCheck: jest.fn(),
        }) as unknown as Provider
    );
    const execute = jest.fn().mockResolvedValue([
      {
        name: 'p1',
        status: 'success',
        result: {
          content: '{"findings":[],"revalidations":[]}',
          findings: [],
          revalidations: [],
        },
        durationSeconds: 1,
      } as ProviderResult,
      {
        name: 'p2',
        status: 'error',
        error: new Error(
          'OpenRouter returned invalid review JSON: response was not valid JSON'
        ),
        durationSeconds: 1,
      } as ProviderResult,
    ]);

    try {
      const orchestrator = makeOrchestrator({
        config: {
          ...DEFAULT_CONFIG,
          dryRun: true,
          enableCaching: false,
          analyticsEnabled: false,
          graphEnabled: false,
          providers: providers.map((provider) => provider.name),
          fallbackProviders: [],
          providerLimit: 2,
          batchMaxFiles: 1,
          enableTokenAwareBatching: false,
        },
        providerRegistry: {
          createProviders: jest.fn().mockResolvedValue(providers),
          discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
        } as any,
        llmExecutor: {
          filterHealthyProviders: jest.fn().mockResolvedValue({
            healthy: providers,
            healthCheckResults: [],
          }),
          execute,
        } as any,
      });

      const review = await orchestrator.executeReview(
        makePR([
          {
            filename: 'a.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
          },
          {
            filename: 'b.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
          },
        ])
      );

      expect(review).toBeTruthy();
      expect(execute).toHaveBeenCalledTimes(2);
      expect(review.metrics.providersSuccess).toBe(1);
      expect(review.metrics.providersFailed).toBe(1);
    } finally {
      if (previousFailOnNoHealthy === undefined) {
        delete process.env.FAIL_ON_NO_HEALTHY_PROVIDERS;
      } else {
        process.env.FAIL_ON_NO_HEALTHY_PROVIDERS = previousFailOnNoHealthy;
      }
    }
  });

  it('resumes accepted batches and invokes providers only for missing work', async () => {
    const restoredUsage = {
      promptTokens: 11,
      completionTokens: 3,
      totalTokens: 14,
    };
    const executedUsage = {
      promptTokens: 17,
      completionTokens: 5,
      totalTokens: 22,
    };
    const provider = {
      name: 'p1',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const execute = jest.fn().mockResolvedValue([
      {
        name: 'p1',
        status: 'success',
        result: {
          content: '{"findings":[]}',
          findings: [],
          revalidations: [],
          usage: executedUsage,
        },
        durationSeconds: 1,
      } as ProviderResult,
    ]);
    const commitSuccessfulBatch = jest.fn().mockResolvedValue({
      status: 'accepted',
      expectedVersion: 3,
      payload: { filePaths: [], findings: [], providerResults: [] },
    });
    const finalize = jest.fn().mockResolvedValue({
      status: 'finalized',
      expectedVersion: 4,
      markerWritten: true,
    });
    let plannedWorkKeys: string[] = [];
    const openReviewCheckpointSession = jest
      .fn()
      .mockImplementation(async (plan: { workKeys: string[] }) => {
        plannedWorkKeys = [...plan.workKeys];
        return {
          acceptedBatchResults: new Map([
            [
              plan.workKeys[0],
              {
                filePaths: ['a.ts'],
                findings: [],
                providerResults: [
                  {
                    name: 'p1',
                    status: 'success',
                    durationMs: 1000,
                    usage: restoredUsage,
                    lifecycleAssignedTargetIds: [],
                    lifecycleRevalidations: [],
                  },
                ],
              },
            ],
          ]),
          commitSuccessfulBatch,
          finalize,
        };
      });

    const orchestrator = makeOrchestrator({
      config: {
        ...DEFAULT_CONFIG,
        dryRun: true,
        enableCaching: false,
        analyticsEnabled: false,
        graphEnabled: false,
        providers: ['p1'],
        fallbackProviders: [],
        providerLimit: 1,
        batchMaxFiles: 1,
        enableTokenAwareBatching: false,
        budgetMaxUsd: 5,
      },
      providerRegistry: {
        createProviders: jest.fn().mockResolvedValue([provider]),
        discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
      } as any,
      llmExecutor: {
        filterHealthyProviders: jest.fn().mockResolvedValue({
          healthy: [provider],
          healthCheckResults: [],
        }),
        execute,
      } as any,
      reviewCompatibilityKey: '1'.repeat(64),
      incrementalSnapshotAdvancementEnabled: false,
      openReviewCheckpointSession,
    });

    const review = await orchestrator.executeReview(
      makePR([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
        {
          filename: 'b.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ])
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(commitSuccessfulBatch).toHaveBeenCalledTimes(1);
    expect(commitSuccessfulBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workKey: plannedWorkKeys[1],
        files: [expect.objectContaining({ filename: 'b.ts' })],
      })
    );
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith({
      snapshotAdvancementRequired: false,
    });
    const recordUsage = (orchestrator as any).components.costTracker
      .record as jest.Mock;
    expect(recordUsage).toHaveBeenNthCalledWith(1, 'p1', restoredUsage, 5);
    expect(recordUsage).toHaveBeenNthCalledWith(2, 'p1', executedUsage, 5);
    expect(review.coverage?.complete).toBe(true);
  });

  it('restores plural provider attribution without duplicating findings', () => {
    const orchestrator = makeOrchestrator({});
    const restored = (orchestrator as any).restoreCheckpointProviderResults({
      filePaths: ['src/a.ts'],
      findings: [
        {
          id: 'finding-1',
          file: 'src/a.ts',
          line: 1,
          severity: 'major',
          title: 'Finding',
          message: 'Message',
          confidence: 0.9,
          providers: ['p1'],
        },
      ],
      providerResults: [
        { name: 'p1', status: 'success', durationMs: 1 },
        { name: 'p2', status: 'success', durationMs: 1 },
      ],
    });

    expect(restored[0].result.findings).toHaveLength(1);
    expect(restored[1].result.findings).toHaveLength(0);
  });

  it('fails when every LLM provider fails and provider failure is configured as blocking', async () => {
    const previousFailOnNoHealthy = process.env.FAIL_ON_NO_HEALTHY_PROVIDERS;
    process.env.FAIL_ON_NO_HEALTHY_PROVIDERS = 'true';

    const provider = {
      name: 'codex/gpt-5.5',
      review: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as Provider;
    const execute = jest.fn().mockResolvedValue([
      {
        name: 'codex/gpt-5.5',
        status: 'error',
        error: new Error(
          'Codex CLI failed: OPENAI_API_KEY=sk-1234567890abcdef refresh_token=secret-value'
        ),
        durationSeconds: 0,
      } as ProviderResult,
    ]);

    try {
      const orchestrator = makeOrchestrator({
        config: {
          ...DEFAULT_CONFIG,
          dryRun: true,
          enableCaching: false,
          analyticsEnabled: false,
          graphEnabled: false,
          providers: ['codex/gpt-5.5'],
          fallbackProviders: [],
          providerLimit: 1,
        },
        providerRegistry: {
          createProviders: jest.fn().mockResolvedValue([provider]),
          discoverAdditionalFreeProviders: jest.fn().mockResolvedValue([]),
        } as any,
        llmExecutor: {
          filterHealthyProviders: jest.fn().mockResolvedValue({
            healthy: [provider],
            healthCheckResults: [],
          }),
          execute,
        } as any,
      });

      const pr = makePR([
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ]);

      let thrown: Error | undefined;
      try {
        await orchestrator.executeReview(pr);
      } catch (error) {
        thrown = error as Error;
      }

      expect(thrown?.message).toMatch(/All LLM providers failed during review/);
      expect(thrown?.message).not.toMatch(/sk-1234567890abcdef|secret-value/);
    } finally {
      if (previousFailOnNoHealthy === undefined) {
        delete process.env.FAIL_ON_NO_HEALTHY_PROVIDERS;
      } else {
        process.env.FAIL_ON_NO_HEALTHY_PROVIDERS = previousFailOnNoHealthy;
      }
    }
  });
});
