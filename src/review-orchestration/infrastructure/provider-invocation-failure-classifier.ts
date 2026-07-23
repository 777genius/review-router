import { normalizeReviewError } from '../../errors/review-router-error';
import {
  CapacitySignal,
  classifyProviderCapacitySignal,
} from '../../review-execution/domain';
import {
  ReviewInvocationFailureClass,
  type ReviewInvocationFailureClassifierPort,
} from '../application';

export class ProviderInvocationFailureClassifier implements ReviewInvocationFailureClassifierPort {
  classify(error: unknown): ReviewInvocationFailureClass {
    if (
      classifyProviderCapacitySignal({ error }) ===
      CapacitySignal.CapacityPressure
    ) {
      return ReviewInvocationFailureClass.CapacityUnavailable;
    }

    if (normalizeReviewError(error).category === 'provider_auth') {
      return ReviewInvocationFailureClass.AuthenticationUnavailable;
    }

    return ReviewInvocationFailureClass.Retryable;
  }
}
