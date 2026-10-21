export enum ReviewInvocationConfigurationMismatchReason {
  ActualModelEvidenceUnavailable = 'actual_model_evidence_unavailable',
  ContextGatewayPolicyMismatch = 'context_gateway_policy_mismatch',
  RequiredContextToolsUnavailable = 'required_context_tools_unavailable',
  InvestigationLegacyFallbackManifestMismatch = 'investigation_legacy_fallback_manifest_mismatch',
}

export class ReviewInvocationConfigurationMismatchError extends Error {
  constructor(
    readonly reason: ReviewInvocationConfigurationMismatchReason,
    options: ErrorOptions = {}
  ) {
    super(`review_invocation_configuration_mismatch:${reason}`, options);
    this.name = 'ReviewInvocationConfigurationMismatchError';
  }
}
