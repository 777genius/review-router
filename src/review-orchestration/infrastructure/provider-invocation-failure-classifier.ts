import { normalizeReviewError } from '../../errors/review-router-error';
import {
  CapacitySignal,
  classifyProviderCapacitySignal,
} from '../../review-execution/domain';
import {
  ReviewInvocationConfigurationMismatchError,
  ReviewInvocationFailureClass,
  type ReviewInvocationFailureClassifierPort,
} from '../application';
import type { GatewayFailureFact } from './account-gateway-model-transport';

export class ProviderInvocationFailureClassifier implements ReviewInvocationFailureClassifierPort {
  constructor(
    private readonly gatewayFailureFact: () => GatewayFailureFact | undefined = () => undefined
  ) {}

  classify(error: unknown): ReviewInvocationFailureClass {
    // The gateway fact is authoritative: error text cannot tell a terminal
    // admission refusal apart from an ordinary retryable provider failure.
    const fact = this.gatewayFailureFact();
    if (
      fact?.code === 'admission_limited' &&
      (fact.effect === 'not_dispatched' ||
        fact.effect === 'rejected_before_dispatch')
    ) {
      return ReviewInvocationFailureClass.AdmissionLimited;
    }

    if (
      classifyProviderCapacitySignal({ error }) ===
      CapacitySignal.CapacityPressure
    ) {
      return ReviewInvocationFailureClass.CapacityUnavailable;
    }

    const normalized = normalizeReviewError(error);
    if (normalized.category === 'provider_auth') {
      return ReviewInvocationFailureClass.AuthenticationUnavailable;
    }

    if (error instanceof ReviewInvocationConfigurationMismatchError) {
      return ReviewInvocationFailureClass.ConfigurationMismatch;
    }

    return ReviewInvocationFailureClass.Retryable;
  }
}
