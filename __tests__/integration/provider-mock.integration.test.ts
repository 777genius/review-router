import { OpenRouterProvider } from '../../src/providers/openrouter';
import { RateLimiter } from '../../src/providers/rate-limiter';

describe('OpenRouterProvider (mocked)', () => {
  const apiKey = 'test-key';
  let limiter: RateLimiter;
  const originalFetch = global.fetch;

  beforeEach(() => {
    limiter = new RateLimiter();
    return limiter.clear('openrouter/mistral:test');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it('parses findings and handles rate limits', async () => {
    const provider = new OpenRouterProvider('mistral:test', apiKey, limiter);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [
                  {
                    file: 'a.ts',
                    line: 1,
                    severity: 'major',
                    title: 'X',
                    message: 'Y',
                  },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      headers: new Map(),
    } as any);

    const result = await provider.review('prompt', 1000);
    expect(result.findings).toHaveLength(1);
    expect(result.usage?.totalTokens).toBe(15);
  });

  it('routes free aliases to the OpenRouter free meta-model id', async () => {
    const provider = new OpenRouterProvider('free#1', apiKey, limiter);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
      }),
      headers: new Map(),
    } as any);

    await provider.review('prompt', 1000);

    const request = (global.fetch as jest.Mock).mock.calls[0][1];
    const body = JSON.parse(request.body);
    expect(body.model).toBe('openrouter/free');
    expect(body.tool_choice).toEqual({
      type: 'function',
      function: { name: 'submit_review' },
    });
    expect(body.tools[0].function.name).toBe('submit_review');
    expect(body.tools[0].function.parameters.required).toEqual([
      'findings',
      'revalidations',
    ]);
  });

  it('strips alias suffixes from concrete OpenRouter model ids', async () => {
    const provider = new OpenRouterProvider(
      'qwen/qwen3-coder:free#2',
      apiKey,
      limiter
    );

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
      }),
      headers: new Map(),
    } as any);

    await provider.review('prompt', 1000);

    const request = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(JSON.parse(request.body).model).toBe('qwen/qwen3-coder:free');
  });

  it('parses review JSON from forced OpenRouter tool calls', async () => {
    const provider = new OpenRouterProvider('mistral:test', apiKey, limiter);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  function: {
                    name: 'submit_review',
                    arguments: JSON.stringify({
                      findings: [],
                      revalidations: [
                        {
                          targetId: 'rrt_123',
                          fingerprint: 'f'.repeat(24),
                          verdict: 'resolved',
                          confidence: 0.95,
                          evidence: [
                            {
                              path: 'src/app.ts',
                              startLine: 1,
                              endLine: 3,
                              reason: 'current code uses env secret',
                            },
                          ],
                          rationale: 'hardcoded secret removed',
                        },
                      ],
                    }),
                  },
                },
              ],
            },
          },
        ],
      }),
      headers: new Map(),
    } as any);

    const result = await provider.review('prompt', 1000);

    expect(result.findings).toEqual([]);
    expect(result.revalidations).toHaveLength(1);
    expect(result.revalidations?.[0].verdict).toBe('resolved');
  });

  it('marks rate limited providers', async () => {
    const provider = new OpenRouterProvider('mistral:test', apiKey, limiter);

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: { get: () => '60' },
      json: async () => ({}),
    } as any);

    await expect(provider.review('prompt', 100)).rejects.toThrow();

    // Second call should short-circuit due to rate limit file
    await expect(provider.review('prompt', 100)).rejects.toThrow();

    await limiter.clear('openrouter/mistral:test');
  });
});
