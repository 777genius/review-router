import { ocrReviewFailureDiagnostic } from '../../../src/review-orchestration/infrastructure/ocr-review-failure-diagnostic';
import { OcrReviewAcceptanceError } from '../../../src/review-orchestration/infrastructure/ocr-review-managed-run';

it('preserves the known RR same-operation recovery denial without changing its effect', () => {
  expect(
    ocrReviewFailureDiagnostic(new Error('not diagnostic text'), undefined, {
      code: 'same_operation_recovery_required',
      effect: 'effect_unknown',
    }).gateway
  ).toEqual({
    code: 'same_operation_recovery_required',
    effect: 'effect_unknown',
  });
});

it('retains the closed SDK denial codes, including admission limits and invalid input', () => {
  // SDK SafeError.errorCode and GatewayError.code, plus the SaaS safe_error fallback.
  const codes = [
    'admission_limited',
    'invalid_input',
    'invalid_request',
    'unauthenticated',
    'forbidden',
    'not_found',
    'conflict',
    'upstream_failure',
    'internal_error',
    'transport',
    'invalid_response',
    'cancelled',
    'safe_error',
    'gateway_error',
  ];
  for (const code of codes) {
    expect(
      ocrReviewFailureDiagnostic(new Error('not diagnostic text'), undefined, {
        code,
        effect: 'not_dispatched',
      }).gateway
    ).toEqual({ code, effect: 'not_dispatched' });
  }
});

it('retains the exact SDK effect states and rejects a non-contract dispatched alias', () => {
  const effects = [
    'not_dispatched',
    'dispatch_started',
    'response_started',
    'completed',
    'effect_unknown',
    'rejected_before_dispatch',
    'none',
  ];
  for (const effect of effects) {
    expect(
      ocrReviewFailureDiagnostic(new Error('not diagnostic text'), undefined, {
        code: 'invalid_request',
        effect,
      }).gateway
    ).toEqual({ code: 'invalid_request', effect });
  }
  expect(
    ocrReviewFailureDiagnostic(new Error('not diagnostic text'), undefined, {
      code: 'invalid_request',
      effect: 'dispatched',
    }).gateway?.effect
  ).toBe('unrecognized');
});

it('never projects arbitrary error details, gateway codes/effects or process tails', () => {
  const secret = 'PRIVATE_PROVIDER_NATIVE_PROMPT_TOKEN';
  const diagnostic = ocrReviewFailureDiagnostic(
    new OcrReviewAcceptanceError('coverage_mismatch', secret),
    {
      closed: true,
      exitCode: 256,
      signal: secret as NodeJS.Signals,
      spawnError: secret,
      stdoutTail: secret,
      stderrTail: secret,
    },
    { code: secret, effect: secret }
  );
  expect(diagnostic).toEqual({
    reason: 'coverage_mismatch',
    process: { closed: true, exitCode: null, signal: null, spawnError: true },
    gateway: { code: 'unrecognized', effect: 'unrecognized' },
  });
  expect(JSON.stringify(diagnostic)).not.toContain(secret);
  expect(
    ocrReviewFailureDiagnostic(new Error(secret), undefined, undefined)
  ).toEqual({
    reason: 'invocation_failed',
  });
});
