import {
  resolveReviewActionV2Activation,
  ReviewActionV2RuntimeMode,
  type VerifiedReviewActionV2Handoff,
} from '../control-plane/review-action-v2-contract';

export const HOSTED_V4_MODE = 'hosted-pool-v4';
export const HOSTED_V4_FLAG = 'REVIEW_ROUTER_HOSTED_V4_ADAPTER_ENABLED';

export type HostedV4Activation = Readonly<{
  handoff: VerifiedReviewActionV2Handoff;
}>;

/** Selection is explicit. A selected but disabled adapter is a terminal error. */
export function resolveHostedV4Activation(input: {
  readonly requestedMode: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly generatedRoot?: string;
}): HostedV4Activation | null {
  if (input.requestedMode !== HOSTED_V4_MODE) return null;
  if (input.env[HOSTED_V4_FLAG] !== '1') {
    throw new Error('hosted_v4_adapter_disabled');
  }
  const v2 = resolveReviewActionV2Activation({
    env: input.env,
    generatedRoot: input.generatedRoot,
  });
  if (v2.mode !== ReviewActionV2RuntimeMode.T0) {
    throw new Error('hosted_v4_verified_t0_handoff_required');
  }
  return { handoff: v2.handoff };
}
