import { ContextToolsError } from '../../context-tools/contract';
import { normalizeReviewError } from '../../errors/review-router-error';
import {
  CapacitySignal,
  classifyProviderCapacitySignal,
} from '../../review-execution/domain';
import {
  ReviewInvocationConfigurationMismatchError,
  ReviewInvocationFailureClass,
  type ReviewInvocationFailureClassifierPort,
  type ReviewInvocationFailureContext,
  type ReviewInvocationFailureScope,
} from '../application';
import type { GatewayFailureFact } from './account-gateway-model-transport';

export class ProviderInvocationFailureClassifier implements ReviewInvocationFailureClassifierPort {
  constructor(
    private readonly gatewayFailureFact: (
      context?: ReviewInvocationFailureContext
    ) => GatewayFailureFact | undefined = () => undefined
  ) {}

  scope(
    _error: unknown,
    context: ReviewInvocationFailureContext
  ): ReviewInvocationFailureScope | undefined {
    const fact = this.gatewayFailureFact(context);
    // A foreign allocation hint cannot cancel a sibling allocation.
    if (fact?.failureScope === 'allocation') {
      return fact.concurrencyGroupId === context.concurrencyGroupId
        ? 'allocation'
        : 'run';
    }
    return fact ? (fact.failureScope ?? 'reviewer') : undefined;
  }

  classify(
    error: unknown,
    context?: ReviewInvocationFailureContext
  ): ReviewInvocationFailureClass {
    // The gateway fact is authoritative: error text cannot tell a terminal
    // admission refusal apart from an ordinary retryable provider failure.
    const fact = this.gatewayFailureFact(context);
    if (
      error instanceof ContextToolsError ||
      fact?.code === 'context_tools_unavailable'
    )
      return ReviewInvocationFailureClass.ConfigurationMismatch;
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
