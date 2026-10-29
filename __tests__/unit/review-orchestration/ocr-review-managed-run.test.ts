/**
 * Plan 56, §5.1 builders and §8.4 acceptance order 1-8: gateway effects,
 * closed exit-0 process, bounded read-after-close, observed model attribution,
 * coverage vs prepare, then normalization. A readable JSON never rescues a
 * failed process or a missing attribution.
 */

import { OcrOutputTooLargeError } from '../../../src/review-orchestration/infrastructure/ocr-review-normalization';
import {
  OCR_RESULT_FILE_LIMIT_BYTES,
  acceptOcrManagedReviewResult,
  buildOcrChildEnvironment,
  buildOcrManagedConfigJson,
  buildOcrReviewArgv,
  extractRawLoopbackCapability,
  readOcrOutputFileAfterClose,
  truncateDiagnosticTail,
  type OcrReviewProcessResult,
} from '../../../src/review-orchestration/infrastructure/ocr-review-managed-run';
import type { OcrReviewArgvInput } from '../../../src/review-orchestration/infrastructure/ocr-review-managed-run';
import {
  OcrNativeResultContractViolation,
  OcrManagedContractViolation,
} from '../../../src/review-orchestration/infrastructure/ocr-review-outcome-contract';

const MERGE_BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);

function argvInput(
  overrides: Partial<OcrReviewArgvInput> = {}
): OcrReviewArgvInput {
  return {
    binaryPath: '/opt/ocr/opencodereview',
    repoPath: '/work/checkout',
    mergeBaseSha: MERGE_BASE,
    headSha: HEAD,
    model: 'admitted-model',
    rulePath: '/run/rule.json',
    backgroundPath: null,
    outputPath: '/run/result.json',
    effort: 'medium',
    limits: { requestTimeoutSec: 600 },
    preview: false,
    ...overrides,
  };
}

const closedProcess = (
  overrides: Partial<OcrReviewProcessResult> = {}
): OcrReviewProcessResult => ({
  closed: true,
  exitCode: 0,
  signal: null,
  stdoutTail: '',
  stderrTail: '',
  ...overrides,
});

function validNativeResultBytes(): Buffer {
  return Buffer.from(
    JSON.stringify({
      status: 'complete',
      llm: { provider: 'reviewrouter', model: 'requested-model' },
      summary: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      comments: [],
      manifest: {
        schema_version: 'ocr.run-manifest/v1',
        operation: 'review',
        terminal_state: 'complete',
        input: {
          mode: 'range',
          resolved_base: MERGE_BASE,
          resolved_head: HEAD,
        },
      },
      reviewrouter_outcome: {
        schema_version: 'reviewrouter.ocr-outcome/v1',
        run_stop_cause: null,
        grouping: { state: 'completed', reason: null },
        groups: [
          {
            paths: ['calc.ts'],
            main_completed: true,
            stop_cause: null,
            rounds: { configured: 2, started: 1, completed: 1 },
            phases: {
              plan: { state: 'not_applicable', reason: 'threshold' },
              compression: { state: 'not_applicable', reason: 'no_zone' },
              relocation: { state: 'not_applicable', reason: 'no_candidates' },
              filter: { state: 'not_applicable', reason: 'no_candidates' },
            },
            filter_decision_valid: null,
          },
        ],
      },
    }),
    'utf8'
  );
}

function acceptInput(overrides: Record<string, unknown> = {}) {
  return {
    admission: {
      baseSha: 'a'.repeat(40),
      mergeBaseSha: MERGE_BASE,
      headSha: HEAD,
    },
    process: closedProcess(),
    resultBytes: validNativeResultBytes(),
    observedActualModel: 'observed-model',
    observedRequestCount: 1,
    expectedPaths: ['calc.ts'],
    headFiles: { get: () => undefined },
    ...overrides,
  };
}

function acceptanceErrorOf(build: () => unknown): {
  code: string;
  message: string;
} {
  try {
    build();
  } catch (error) {
    const failure = error as { name?: string; code?: string; message?: string };
    if (failure.name === 'OcrReviewAcceptanceError') {
      return { code: failure.code!, message: failure.message! };
    }
    throw error;
  }
  throw new Error('expected acceptance error');
}

/** Acceptance result including the §8.4-6 coverage facts. */
function acceptedWithCoverage(input: Record<string, unknown>): {
  uncoveredPaths: readonly string[];
  partial: boolean;
  reasons: readonly string[];
} {
  return acceptOcrManagedReviewResult(
    input as Parameters<typeof acceptOcrManagedReviewResult>[0]
  ) as unknown as {
    uncoveredPaths: readonly string[];
    partial: boolean;
    reasons: readonly string[];
  };
}

describe('buildOcrReviewArgv (§5.1)', () => {
  it('builds the managed argv with the reviewrouter-managed mode flag', () => {
    const argv = buildOcrReviewArgv(
      argvInput({
        limits: {
          requestTimeoutSec: 600,
          timeoutMinutes: 15,
          maxTokens: 4000,
          maxTokensBudget: 90000,
        },
        preview: true,
      })
    );
    expect(argv[0]).toBe('review');
    expect(argv).toContain('--reviewrouter-managed');
    expect(argv).toContain('--provider');
    expect(argv[argv.indexOf('--provider') + 1]).toBe('reviewrouter');
    expect(argv).toContain('--concurrency');
    expect(argv[argv.indexOf('--concurrency') + 1]).toBe('1');
    expect(argv[argv.indexOf('--timeout') + 1]).toBe('15');
    expect(argv[argv.indexOf('--max-tokens') + 1]).toBe('4000');
    expect(argv[argv.indexOf('--max-tokens-budget') + 1]).toBe('90000');
    expect(argv).toContain('--preview');
    // Captured values, never shell substitutions.
    expect(
      argv.every((value) => !value.includes(';') && !value.includes('`'))
    ).toBe(true);
    // Native embedded tools; no resume/commit/tools overrides.
    expect(argv).not.toContain('--tools');
    expect(argv).not.toContain('--resume');
    expect(argv).not.toContain('--commit');
  });

  it('omits qualified limits entirely when unset', () => {
    const argv = buildOcrReviewArgv(argvInput());
    expect(argv).not.toContain('--timeout');
    expect(argv).not.toContain('--max-tokens');
    expect(argv).not.toContain('--max-tokens-budget');
  });

  it('rejects zero or negative limit settings instead of treating them as unlimited', () => {
    expect(() =>
      buildOcrReviewArgv(
        argvInput({ limits: { requestTimeoutSec: 600, timeoutMinutes: 0 } })
      )
    ).toThrow('review_action_v2_ocr_limit_invalid:timeout');
    expect(() =>
      buildOcrReviewArgv(
        argvInput({ limits: { requestTimeoutSec: 600, maxTokens: -1 } })
      )
    ).toThrow('review_action_v2_ocr_limit_invalid:max_tokens');
  });

  it('rejects malformed revision references', () => {
    expect(() =>
      buildOcrReviewArgv(argvInput({ headSha: 'not-a-sha' }))
    ).toThrow('review_action_v2_ocr_argv_refs_invalid');
  });
});

describe('managed config and child environment (§5.1)', () => {
  const capability = 'a'.repeat(64);

  it('writes a bare loopback base URL and a raw capability without Bearer', () => {
    const config = JSON.parse(
      buildOcrManagedConfigJson({
        baseUrl: 'http://127.0.0.1:34567',
        rawCapability: capability,
        model: 'admitted-model',
        limits: { requestTimeoutSec: 600 },
        modelReasoningEffort: 'medium',
        language: 'en',
      })
    );
    expect(config.provider).toBe('reviewrouter');
    const provider = config.custom_providers.reviewrouter;
    expect(provider.url).toBe('http://127.0.0.1:34567');
    expect(provider.url).not.toMatch(/\/v1|\/responses/);
    expect(provider.api_key).toBe(capability);
    expect(provider.api_key).not.toMatch(/^Bearer /);
    expect(provider.protocol).toBe('openai-responses');
    expect(config.telemetry).toEqual({ enabled: false });
  });

  it('rejects non-loopback and suffixed base URLs', () => {
    for (const baseUrl of [
      'https://api.openai.com/v1',
      'http://127.0.0.1:34567/v1',
      'http://127.0.0.1:34567/responses',
      'http://localhost:34567',
    ]) {
      expect(() =>
        buildOcrManagedConfigJson({
          baseUrl,
          rawCapability: capability,
          model: 'm',
          limits: { requestTimeoutSec: 60 },
          modelReasoningEffort: null,
          language: null,
        })
      ).toThrow('review_action_v2_ocr_config_base_url_invalid');
    }
  });

  it('extracts the raw capability from exactly one Bearer prefix', () => {
    expect(extractRawLoopbackCapability(`Bearer ${capability}`)).toBe(
      capability
    );
    expect(() =>
      extractRawLoopbackCapability(`Bearer Bearer ${capability}`)
    ).toThrow('review_action_v2_ocr_capability_format_invalid');
    expect(() => extractRawLoopbackCapability(capability)).toThrow(
      'review_action_v2_ocr_capability_format_invalid'
    );
  });

  it('builds a minimal child environment with one Bearer-prefixed token', () => {
    const env = buildOcrChildEnvironment({
      homeDirectory: '/run/home',
      capabilityAuthorization: `Bearer ${capability}`,
      path: '/usr/bin:/bin',
    });
    expect(Object.keys(env).sort()).toEqual([
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_NOSYSTEM',
      'GIT_TERMINAL_PROMPT',
      'HOME',
      'PATH',
      'REVIEWROUTER_LOCAL_MODEL_TOKEN',
    ]);
    expect(env.REVIEWROUTER_LOCAL_MODEL_TOKEN).toBe(`Bearer ${capability}`);
    expect(env.REVIEWROUTER_LOCAL_MODEL_TOKEN!.match(/Bearer /g)).toHaveLength(
      1
    );
    expect(env.HOME).toBe('/run/home');
    // No upstream/control credentials ever inherit into the OCR child.
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
  });
});

describe('readOcrOutputFileAfterClose (§8.4 step 4)', () => {
  it('refuses oversized result files instead of truncating', async () => {
    await expect(
      readOcrOutputFileAfterClose(
        async () => Buffer.alloc(0),
        async () => OCR_RESULT_FILE_LIMIT_BYTES + 1,
        '/run/result.json'
      )
    ).rejects.toThrow(new OcrOutputTooLargeError('result_file'));
  });

  it('reads the bounded file only through the injected post-close reader', async () => {
    const calls: string[] = [];
    const bytes = await readOcrOutputFileAfterClose(
      async (path) => {
        calls.push(`read:${path}`);
        return Buffer.from('{}');
      },
      async (path) => {
        calls.push(`stat:${path}`);
        return 2;
      },
      '/run/result.json'
    );
    expect(bytes.toString()).toBe('{}');
    expect(calls).toEqual(['stat:/run/result.json', 'read:/run/result.json']);
  });
});

describe('acceptOcrManagedReviewResult (§8.4 order 1-8)', () => {
  it('accepts a clean completed run and attributes the observed model', () => {
    const accepted = acceptOcrManagedReviewResult(acceptInput());
    expect(accepted.actualModel).toBe('observed-model');
    expect(accepted.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    expect(accepted.partial).toBe(false);
    expect(accepted.normalized.findings).toEqual([]);
    expect(accepted.native.requestedModel).toBe('requested-model');
  });

  it('rejects an unknown terminal gateway effect before output interpretation', () => {
    const error = acceptanceErrorOf(() =>
      acceptOcrManagedReviewResult(
        acceptInput({
          effectFacts: { effect: 'paid_dispatch_unknown' },
          // Even a perfect process and JSON must not pass step 2.
          process: closedProcess(),
        })
      )
    );
    expect(error.code).toBe('gateway_effect_unknown');
  });

  it('reports a positively proven not_dispatched effect as retry-safe, not gateway_effect_unknown', () => {
    // §8.4 step 2: proven not_dispatched is not an unknown paid effect; it
    // must never enter paid reconciliation as gateway_effect_unknown.
    const error = acceptanceErrorOf(() =>
      acceptOcrManagedReviewResult(
        acceptInput({ effectFacts: { effect: 'not_dispatched' } })
      )
    );
    expect(error.code).toBe('review_agent_not_dispatched');
    expect(error.code).not.toBe('gateway_effect_unknown');
  });

  it('rejects a nonzero exit even when a valid JSON is present (local diagnostics only)', () => {
    const error = acceptanceErrorOf(() =>
      acceptOcrManagedReviewResult(
        acceptInput({ process: closedProcess({ exitCode: 2 }) })
      )
    );
    expect(error.code).toBe('process_failed');
  });

  it('rejects a process that has not closed', () => {
    const error = acceptanceErrorOf(() =>
      acceptOcrManagedReviewResult(
        acceptInput({
          process: closedProcess({ closed: false as unknown as true }),
        })
      )
    );
    expect(error.code).toBe('process_failed');
  });

  it('rejects unparsable or contract-violating output', () => {
    expect(
      acceptanceErrorOf(() =>
        acceptOcrManagedReviewResult(
          acceptInput({ resultBytes: Buffer.from('{"truncated": ') })
        )
      ).code
    ).toBe('result_contract');
    expect(
      acceptanceErrorOf(() =>
        acceptOcrManagedReviewResult(
          acceptInput({ resultBytes: Buffer.from('{}') })
        )
      ).code
    ).toBe('result_contract');
  });

  it('rejects a manifest revision mismatch', () => {
    const raw = JSON.parse(validNativeResultBytes().toString('utf8'));
    raw.manifest.input.resolved_head = 'd'.repeat(40);
    const error = acceptanceErrorOf(() =>
      acceptOcrManagedReviewResult(
        acceptInput({ resultBytes: Buffer.from(JSON.stringify(raw)) })
      )
    );
    expect(error.code).toBe('result_contract');
    expect(error.message).toContain('native_manifest_refs_mismatch');
  });

  it('rejects a proven zero model requests run', () => {
    const error = acceptanceErrorOf(() =>
      acceptOcrManagedReviewResult(acceptInput({ observedRequestCount: 0 }))
    );
    expect(error.code).toBe('no_model_requests');
  });

  it('rejects success without observed model attribution', () => {
    const error = acceptanceErrorOf(() =>
      acceptOcrManagedReviewResult(
        acceptInput({ observedActualModel: undefined })
      )
    );
    expect(error.code).toBe('actual_model_missing');
  });

  it('rejects outcome paths outside the prepared inventory as a genuine contradiction', () => {
    const raw = JSON.parse(validNativeResultBytes().toString('utf8'));
    raw.reviewrouter_outcome.groups[0].paths = ['other.ts'];
    expect(
      acceptanceErrorOf(() =>
        acceptOcrManagedReviewResult(
          acceptInput({ resultBytes: Buffer.from(JSON.stringify(raw)) })
        )
      ).code
    ).toBe('coverage_mismatch');
  });

  it('classifies inventory gaps as partial missing_paths instead of a fatal coverage mismatch', () => {
    // Deleted/binary/gitignored/preview-excluded paths stay in the RR
    // inventory denominator but never appear in outcome groups (§8.1/§8.4-6):
    // that is a coverage limitation, not a contradiction.
    const accepted = acceptedWithCoverage(
      acceptInput({ expectedPaths: ['calc.ts', 'deleted.ts', 'binary.bin'] })
    );
    expect(accepted.uncoveredPaths).toEqual(['binary.bin', 'deleted.ts']);
    expect(accepted.partial).toBe(true);
    expect(accepted.reasons).toContain('missing_paths');
  });

  it('treats empty outcome coverage over a non-empty inventory as partial, not fatal', () => {
    const raw = JSON.parse(validNativeResultBytes().toString('utf8'));
    raw.reviewrouter_outcome.groups = [];
    const accepted = acceptedWithCoverage(
      acceptInput({ resultBytes: Buffer.from(JSON.stringify(raw)) })
    );
    expect(accepted.uncoveredPaths).toEqual(['calc.ts']);
    expect(accepted.partial).toBe(true);
    expect(accepted.reasons).toContain('missing_paths');
  });

  it('keeps full outcome coverage over the inventory clean without missing_paths', () => {
    const accepted = acceptedWithCoverage(acceptInput());
    expect(accepted.uncoveredPaths).toEqual([]);
    expect(accepted.reasons).not.toContain('missing_paths');
    expect(accepted.partial).toBe(false);
  });

  it('degrades a partial outcome with quality reasons instead of a clean result', () => {
    const raw = JSON.parse(validNativeResultBytes().toString('utf8'));
    raw.reviewrouter_outcome.groups[0].main_completed = false;
    raw.reviewrouter_outcome.groups[0].stop_cause = 'review_limit_reached';
    raw.reviewrouter_outcome.groups[0].rounds = {
      configured: 2,
      started: 1,
      completed: 0,
    };
    const accepted = acceptOcrManagedReviewResult(
      acceptInput({ resultBytes: Buffer.from(JSON.stringify(raw)) })
    );
    expect(accepted.partial).toBe(true);
    expect(accepted.reasons).toContain('review_limit');
  });
});

describe('truncateDiagnosticTail', () => {
  it('bounds diagnostic tails to 64 KiB', () => {
    expect(truncateDiagnosticTail('short')).toBe('short');
    expect(
      Buffer.byteLength(truncateDiagnosticTail('x'.repeat(200_000)), 'utf8')
    ).toBeLessThanOrEqual(64 * 1024);
  });
});

describe('contract violation types stay distinct', () => {
  it('keeps managed and native result violations distinguishable', () => {
    expect(new OcrManagedContractViolation([]).name).toBe(
      'OcrManagedContractViolation'
    );
    expect(new OcrNativeResultContractViolation([]).name).toBe(
      'OcrNativeResultContractViolation'
    );
  });
});
