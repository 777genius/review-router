import {
  ReviewInvocationConfigurationMismatchError,
  ReviewInvocationConfigurationMismatchReason,
  ReviewInvocationFailureClass,
} from '../../../src/review-orchestration/application';
import { ProviderInvocationFailureClassifier } from '../../../src/review-orchestration/infrastructure/provider-invocation-failure-classifier';

describe('ProviderInvocationFailureClassifier', () => {
  const classifier = new ProviderInvocationFailureClassifier();

  it.each([
    'capacity_unavailable',
    'rate limit exceeded',
    'quota_exhausted',
    "You've hit your usage limit. Visit the billing page.",
  ])('classifies capacity failure %s', (message) => {
    expect(classifier.classify(new Error(message))).toBe(
      ReviewInvocationFailureClass.CapacityUnavailable
    );
  });

  it('classifies structured provider capacity codes', () => {
    expect(classifier.classify({ error: { code: 'resource_exhausted' } })).toBe(
      ReviewInvocationFailureClass.CapacityUnavailable
    );
  });

  it.each([
    'Your access token could not be refreshed because your refresh token was revoked',
    'Codex authentication failed. Reseed auth.json',
  ])('classifies authentication failure %s', (message) => {
    expect(classifier.classify(new Error(message))).toBe(
      ReviewInvocationFailureClass.AuthenticationUnavailable
    );
  });

  it.each([
    'provider_failed',
    'structured JSON schema validation failed',
    'request timed out',
  ])('keeps transient failure %s retryable', (message) => {
    expect(classifier.classify(new Error(message))).toBe(
      ReviewInvocationFailureClass.Retryable
    );
  });

  it('classifies deterministic context gateway policy drift as non-retryable configuration', () => {
    expect(
      classifier.classify(
        new ReviewInvocationConfigurationMismatchError(
          ReviewInvocationConfigurationMismatchReason.ContextGatewayPolicyMismatch
        )
      )
    ).toBe(ReviewInvocationFailureClass.ConfigurationMismatch);
  });

  it('classifies terminal gateway admission refusal from the failure fact', () => {
    const refused = new ProviderInvocationFailureClassifier(() => ({
      code: 'admission_limited',
      effect: 'not_dispatched',
    }));
    expect(
      refused.classify(new Error('account_gateway_inference_denied'))
    ).toBe('admission_limited');
    expect(refused.classify(new Error('rate limit exceeded'))).toBe(
      'admission_limited'
    );
    const rejected = new ProviderInvocationFailureClassifier(() => ({
      code: 'admission_limited',
      effect: 'rejected_before_dispatch',
    }));
    expect(rejected.classify(new Error('relay refused'))).toBe(
      'admission_limited'
    );
  });

  it('keeps non-terminal gateway facts on the error heuristics', () => {
    const unknownEffect = new ProviderInvocationFailureClassifier(() => ({
      code: 'admission_limited',
      effect: 'effect_unknown',
    }));
    expect(unknownEffect.classify(new Error('request timed out'))).toBe(
      ReviewInvocationFailureClass.Retryable
    );
    const transportFact = new ProviderInvocationFailureClassifier(() => ({
      code: 'transport',
      effect: 'effect_unknown',
    }));
    expect(transportFact.classify(new Error('quota_exceeded'))).toBe(
      ReviewInvocationFailureClass.CapacityUnavailable
    );
  });
});
