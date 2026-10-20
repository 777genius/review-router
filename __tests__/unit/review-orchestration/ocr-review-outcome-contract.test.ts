/**
 * Plan 56, §7.4 boundary parser fixtures: malformed values, unknown enums,
 * missing required fields, contradictory fields and documented stop aliases
 * all reject instead of defaulting to success.
 */

import {
  OcrManagedContractViolation,
  OcrNativeResultContractViolation,
  classifyOcrReviewOutcome,
  parseOcrNativeReviewResult,
  parseOcrReviewOutcome,
  OCR_OUTCOME_SCHEMA_VERSION,
} from '../../../src/review-orchestration/infrastructure/ocr-review-outcome-contract';

const validPhase = { state: 'not_applicable', reason: 'no_candidates' };

function validGroup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paths: ['calc.ts'],
    main_completed: true,
    stop_cause: null,
    rounds: { configured: 2, started: 1, completed: 1 },
    phases: {
      plan: { state: 'not_applicable', reason: 'threshold' },
      compression: { state: 'not_applicable', reason: 'no_zone' },
      relocation: { ...validPhase },
      filter: { ...validPhase },
    },
    filter_decision_valid: null,
    ...overrides,
  };
}

function validOutcome(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: OCR_OUTCOME_SCHEMA_VERSION,
    run_stop_cause: null,
    grouping: { state: 'completed', reason: null },
    groups: [validGroup()],
    ...overrides,
  };
}

function violationOf(build: () => unknown): OcrManagedContractViolation {
  try {
    parseOcrReviewOutcome(build());
  } catch (error) {
    if (error instanceof OcrManagedContractViolation) return error;
    throw error;
  }
  throw new Error('expected contract violation');
}

describe('parseOcrReviewOutcome (§7.4 reviewrouter_outcome)', () => {
  it('accepts the normative zero-findings single-group shape', () => {
    const outcome = parseOcrReviewOutcome(validOutcome());
    expect(outcome.schemaVersion).toBe(OCR_OUTCOME_SCHEMA_VERSION);
    expect(outcome.groups).toHaveLength(1);
    expect(outcome.groups[0].filterDecisionValid).toBeNull();
    expect(outcome.groups[0].phases.filter.state).toBe('not_applicable');
  });

  it('maps the native review_limit_reached stop alias to max_rounds', () => {
    const outcome = parseOcrReviewOutcome(
      validOutcome({
        run_stop_cause: 'review_limit_reached',
        groups: [
          validGroup({
            main_completed: false,
            stop_cause: 'review_limit_reached',
            rounds: { configured: 2, started: 1, completed: 0 },
          }),
        ],
      })
    );
    expect(outcome.runStopCause).toBe('max_rounds');
    expect(outcome.groups[0].stopCause).toBe('max_rounds');
  });

  it('rejects an unknown stop-cause wire value', () => {
    const error = violationOf(() =>
      validOutcome({ run_stop_cause: 'model_mood' })
    );
    expect(error.issues.map((issue) => issue.code)).toContain(
      'outcome_stop_cause_unknown'
    );
  });

  it('rejects a missing run_stop_cause instead of reading a silent null', () => {
    const { run_stop_cause: _dropped, ...withoutRunStop } = validOutcome();
    const error = violationOf(() => withoutRunStop);
    expect(error.issues.map((issue) => issue.code)).toContain(
      'outcome_stop_cause_missing'
    );
  });

  it('rejects a missing group stop_cause instead of reading a silent null', () => {
    const group = validGroup();
    delete group.stop_cause;
    const error = violationOf(() => validOutcome({ groups: [group] }));
    expect(error.issues.map((issue) => issue.code)).toContain(
      'outcome_stop_cause_missing'
    );
  });

  it('rejects an unknown phase state enum value', () => {
    const group = validGroup();
    (group.phases as Record<string, unknown>).plan = {
      state: 'done',
      reason: null,
    };
    const error = violationOf(() => validOutcome({ groups: [group] }));
    expect(error.issues.map((issue) => issue.code)).toContain(
      'outcome_phase_state_unknown'
    );
  });

  it.each([
    ['not an object', 'reviewrouter_outcome'],
    ['wrong schema version', { ...validOutcome(), schema_version: 'v2' }],
    ['missing grouping', { ...validOutcome(), grouping: undefined }],
    ['missing groups', { ...validOutcome(), groups: undefined }],
    [
      'missing main_completed',
      {
        ...validOutcome({
          groups: [{ ...validGroup(), main_completed: undefined }],
        }),
      },
    ],
    [
      'missing rounds',
      { ...validOutcome({ groups: [{ ...validGroup(), rounds: undefined }] }) },
    ],
    [
      'missing filter_decision_valid never defaults to success',
      {
        ...validOutcome({
          groups: [{ ...validGroup(), filter_decision_valid: undefined }],
        }),
      },
    ],
    [
      'non-boolean main_completed',
      {
        ...validOutcome({ groups: [{ ...validGroup(), main_completed: 'yes' }] }),
      },
    ],
    [
      'non-boolean filter_decision_valid',
      {
        ...validOutcome({
          groups: [{ ...validGroup(), filter_decision_valid: 'true' }],
        }),
      },
    ],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseOcrReviewOutcome(raw)).toThrow(
      OcrManagedContractViolation
    );
  });

  it.each([
    [
      'main_completed with stop_cause',
      validGroup({ stop_cause: 'max_rounds' }),
    ],
    [
      'main_completed with zero completed rounds',
      validGroup({ rounds: { configured: 2, started: 1, completed: 0 } }),
    ],
    [
      'incomplete main without stop cause',
      validGroup({ main_completed: false, stop_cause: null }),
    ],
    [
      'round counters inconsistent',
      validGroup({ rounds: { configured: 1, started: 2, completed: 1 } }),
    ],
    [
      'completed filter without parsed decision',
      validGroup({
        phases: {
          plan: validPhase,
          compression: validPhase,
          relocation: validPhase,
          filter: { state: 'completed', reason: null },
        },
        filter_decision_valid: null,
      }),
    ],
    [
      'filter_decision_valid=false outside failed/cancelled filter',
      validGroup({ filter_decision_valid: false }),
    ],
    [
      'not_applicable filter with a parsed decision',
      validGroup({ filter_decision_valid: true }),
    ],
  ])('rejects contradictory group: %s', (_label, group) => {
    const error = violationOf(() => validOutcome({ groups: [group] }));
    expect(error.issues.length).toBeGreaterThan(0);
  });

  it('rejects duplicated paths across groups', () => {
    const error = violationOf(() =>
      validOutcome({
        groups: [validGroup(), validGroup({ paths: ['calc.ts'] })],
      })
    );
    expect(error.issues.map((issue) => issue.code)).toContain(
      'outcome_group_paths_duplicate'
    );
  });

  it('rejects an empty group path list', () => {
    const error = violationOf(() =>
      validOutcome({ groups: [validGroup({ paths: [] })] })
    );
    expect(error.issues.map((issue) => issue.code)).toContain(
      'outcome_group_paths_invalid'
    );
  });

  it('accepts a valid approve-all filter decision record', () => {
    const outcome = parseOcrReviewOutcome(
      validOutcome({
        groups: [
          validGroup({
            phases: {
              plan: validPhase,
              compression: validPhase,
              relocation: validPhase,
              filter: { state: 'completed', reason: null },
            },
            filter_decision_valid: true,
          }),
        ],
      })
    );
    expect(outcome.groups[0].filterDecisionValid).toBe(true);
  });
});

describe('classifyOcrReviewOutcome (§8.2 mapping invariant)', () => {
  it('does not flag a natural completed run', () => {
    const classification = classifyOcrReviewOutcome(
      parseOcrReviewOutcome(validOutcome())
    );
    expect(classification.partial).toBe(false);
    expect(classification.reasons).toEqual([]);
  });

  it('flags review-limit stops and incomplete main as partial with reasons', () => {
    const classification = classifyOcrReviewOutcome(
      parseOcrReviewOutcome(
        validOutcome({
          groups: [
            validGroup({
              main_completed: false,
              stop_cause: 'review_limit_reached',
              rounds: { configured: 2, started: 1, completed: 0 },
            }),
          ],
        })
      )
    );
    expect(classification.partial).toBe(true);
    expect(classification.reasons).toContain('review_limit');
  });

  it('flags an invalid filter decision as partial', () => {
    const classification = classifyOcrReviewOutcome(
      parseOcrReviewOutcome(
        validOutcome({
          groups: [
            validGroup({
              phases: {
                plan: validPhase,
                compression: validPhase,
                relocation: validPhase,
                filter: { state: 'failed', reason: 'invalid_arguments' },
              },
              filter_decision_valid: false,
            }),
          ],
        })
      )
    );
    expect(classification.partial).toBe(true);
    expect(classification.reasons).toContain('invalid_filter_decision');
    expect(classification.reasons).toContain('phase_failed');
  });

  it('keeps natural not_applicable phase skips unflagged', () => {
    const classification = classifyOcrReviewOutcome(
      parseOcrReviewOutcome(validOutcome())
    );
    expect(classification.reasons).not.toContain('phase_failed');
  });
});

describe('parseOcrNativeReviewResult (native jsonOutput + managed extension)', () => {
  const admission = {
    baseSha: 'a'.repeat(40),
    mergeBaseSha: 'b'.repeat(40),
    headSha: 'c'.repeat(40),
  };

  function validNative(): Record<string, unknown> {
    return {
      status: 'complete',
      llm: { provider: 'reviewrouter', model: 'admitted-model' },
      summary: {
        files_reviewed: 1,
        comments: 0,
        total_tokens: 15,
        input_tokens: 10,
        output_tokens: 5,
      },
      comments: [
        {
          path: 'calc.ts',
          content: 'Subtraction looks unintended in add().',
          suggestion_code: 'return a + b;',
          existing_code: 'function add(a, b) { return a - b }',
          start_line: 1,
          end_line: 1,
          category: 'correctness',
          severity: 'high',
        },
      ],
      warnings: [{ file: 'calc.ts', message: 'grace round', type: 'review_limit_reached' }],
      manifest: {
        schema_version: 'ocr.run-manifest/v1',
        operation: 'review',
        terminal_state: 'complete',
        input: {
          mode: 'range',
          resolved_base: 'b'.repeat(40),
          resolved_head: 'c'.repeat(40),
        },
      },
      reviewrouter_outcome: validOutcome(),
      extra_native_field: { ignored: true },
    };
  }

  it('accepts the real native shape and carries observed fields', () => {
    const result = parseOcrNativeReviewResult(validNative(), admission);
    expect(result.requestedModel).toBe('admitted-model');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].severity).toBe('high');
    expect(result.warnings).toEqual(['grace round']);
    expect(result.outcome.groups[0].paths).toEqual(['calc.ts']);
  });

  it('rejects a missing managed extension instead of defaulting to success', () => {
    const raw = validNative();
    delete raw.reviewrouter_outcome;
    expect(() => parseOcrNativeReviewResult(raw, admission)).toThrow(
      OcrNativeResultContractViolation
    );
  });

  it.each([
    ['schema version mismatch', (raw: Record<string, unknown>) => {
      (raw.manifest as Record<string, unknown>).schema_version = 'other/v9';
    }],
    ['wrong operation', (raw: Record<string, unknown>) => {
      (raw.manifest as Record<string, unknown>).operation = 'scan';
    }],
    ['wrong input mode', (raw: Record<string, unknown>) => {
      ((raw.manifest as Record<string, unknown>).input as Record<string, unknown>).mode = 'staged';
    }],
    ['resolved base mismatch', (raw: Record<string, unknown>) => {
      ((raw.manifest as Record<string, unknown>).input as Record<string, unknown>).resolved_base = 'd'.repeat(40);
    }],
    ['resolved head mismatch', (raw: Record<string, unknown>) => {
      ((raw.manifest as Record<string, unknown>).input as Record<string, unknown>).resolved_head = 'd'.repeat(40);
    }],
  ])('rejects manifest %s', (_label, mutate) => {
    const raw = validNative();
    mutate(raw);
    const error = (() => {
      try {
        parseOcrNativeReviewResult(raw, admission);
      } catch (caught) {
        return caught as OcrNativeResultContractViolation;
      }
      throw new Error('expected violation');
    })();
    expect(error).toBeInstanceOf(OcrNativeResultContractViolation);
  });

  it('rejects a structurally corrupted result object', () => {
    expect(() => parseOcrNativeReviewResult([], admission)).toThrow(
      OcrNativeResultContractViolation
    );
    expect(() =>
      parseOcrNativeReviewResult({ ...validNative(), manifest: null }, admission)
    ).toThrow(OcrNativeResultContractViolation);
  });
});
