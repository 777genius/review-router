import { ocrReviewFailureDiagnostic } from '../../../src/review-orchestration/infrastructure/ocr-review-failure-diagnostic';
import { OcrReviewAcceptanceError } from '../../../src/review-orchestration/infrastructure/ocr-review-managed-run';

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
