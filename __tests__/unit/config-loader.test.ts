import { ConfigLoader } from '../../src/config/loader';
import { DEFAULT_CONFIG } from '../../src/config/defaults';

describe('ConfigLoader', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('merges environment overrides into defaults', () => {
    process.env.REVIEW_PROVIDERS = 'openrouter/a,opencode/b';
    process.env.INLINE_MAX_COMMENTS = '7';
    process.env.BUDGET_MAX_USD = '1.5';
    process.env.ENABLE_AST_ANALYSIS = 'false';
    process.env.UPDATE_PR_DESCRIPTION = 'false';
    process.env.FAIL_ON_SEVERITY = 'critical';

    const config = ConfigLoader.load();

    expect(config.providers).toEqual(['openrouter/a', 'opencode/b']);
    expect(config.inlineMaxComments).toBe(7);
    expect(config.budgetMaxUsd).toBe(1.5);
    expect(config.enableAstAnalysis).toBe(false);
    expect(config.updatePrDescription).toBe(false);
    expect(config.failOnSeverity).toBe('critical');
    expect(config.inlineMinSeverity).toBe(DEFAULT_CONFIG.inlineMinSeverity);
  });

  it('maps CODEX_MODEL to a Codex provider when REVIEW_PROVIDERS is not set', () => {
    process.env.CODEX_MODEL = 'gpt-5.5';

    const config = ConfigLoader.load();

    expect(config.providers).toEqual(['codex/gpt-5.5']);
    expect(config.synthesisModel).toBe('codex/gpt-5.5');
  });

  it('defaults failure policy to critical-only', () => {
    const config = ConfigLoader.load();

    expect(config.failOnSeverity).toBe('critical');
  });

  it('derives failure policy from critical and major switches', () => {
    process.env.FAIL_ON_CRITICAL = 'true';
    process.env.FAIL_ON_MAJOR = 'false';

    expect(ConfigLoader.load().failOnSeverity).toBe('critical');

    process.env.FAIL_ON_MAJOR = 'true';
    expect(ConfigLoader.load().failOnSeverity).toBe('major');

    process.env.FAIL_ON_CRITICAL = 'false';
    process.env.FAIL_ON_MAJOR = 'false';
    expect(ConfigLoader.load().failOnSeverity).toBe('off');
  });

  it('keeps FAIL_ON_SEVERITY as an explicit override', () => {
    process.env.FAIL_ON_CRITICAL = 'true';
    process.env.FAIL_ON_MAJOR = 'false';
    process.env.FAIL_ON_SEVERITY = 'off';

    expect(ConfigLoader.load().failOnSeverity).toBe('off');
  });

  it('keeps explicit REVIEW_PROVIDERS ahead of CODEX_MODEL', () => {
    process.env.CODEX_MODEL = 'gpt-5.5';
    process.env.REVIEW_PROVIDERS = 'openrouter/a';

    const config = ConfigLoader.load();

    expect(config.providers).toEqual(['openrouter/a']);
    expect(config.synthesisModel).toBe(DEFAULT_CONFIG.synthesisModel);
  });

  it('parses provider batch overrides and clamps to schema range', () => {
    process.env.PROVIDER_BATCH_OVERRIDES = '{"openrouter":250,"opencode":"2"}';

    const config = ConfigLoader.load();

    expect(config.providerBatchOverrides?.openrouter).toBe(200); // clamped to max 200
    expect(config.providerBatchOverrides?.opencode).toBe(2); // string numeric accepted
  });

  it('parses suggestion quality overrides from environment', () => {
    process.env.MIN_CONFIDENCE = '0.6';
    process.env.CONSENSUS_REQUIRED_FOR_CRITICAL = 'false';
    process.env.CONSENSUS_MIN_AGREEMENT = '3';
    process.env.SUGGESTION_SYNTAX_VALIDATION = 'false';

    const config = ConfigLoader.load();

    expect(config.minConfidence).toBe(0.6);
    expect(config.consensusRequiredForCritical).toBe(false);
    expect(config.consensusMinAgreement).toBe(3);
    expect(config.suggestionSyntaxValidation).toBe(false);
  });

  it('ignores non-numeric or negative provider batch overrides', () => {
    process.env.PROVIDER_BATCH_OVERRIDES = '{"bad":"abc","neg":-1}';

    const config = ConfigLoader.load();

    expect(config.providerBatchOverrides).toEqual({});
  });
});
