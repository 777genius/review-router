import { constants } from 'node:os';
import {
  OcrReviewAcceptanceError,
  type OcrReviewProcessResult,
} from './ocr-review-managed-run';

// Fixed RR protocol codes only. Unknown values are not diagnostic text.
const GATEWAY_CODES = [
  'authorization_denied',
  'close_pending',
  'context_tools_unavailable',
  'envelope_not_normalized',
  'gateway_unavailable',
  'invalid_request',
  'lane_saturated',
  'model_dispatch_claim_required',
  'model_dispatch_headers_invalid',
  'model_dispatch_readback_required',
  'model_dispatch_reservation_required',
  'model_dispatch_unavailable',
  'pending',
  'preparation_denied',
  'relay_saturated',
  'relay_unknown',
  'request_reviewer_mismatch',
  'reviewer_selector_invalid',
  'transport',
  'codex_subscription_authentication_failed',
] as const;
const GATE_REASONS = [
  'not_dispatched',
  'gateway_effect_unknown',
  'replay_fenced',
] as const;
const EFFECTS = [
  'none',
  'not_dispatched',
  'effect_unknown',
  'dispatched',
] as const;

export type OcrReviewFailureDiagnostic = Readonly<{
  reason:
    | OcrReviewAcceptanceError['code']
    | (typeof GATE_REASONS)[number]
    | 'invocation_failed';
  process?: Readonly<{
    closed: boolean;
    exitCode: number | null;
    signal: string | null;
    spawnError: boolean;
  }>;
  gateway?: Readonly<{
    code: (typeof GATEWAY_CODES)[number] | 'unrecognized';
    effect: (typeof EFFECTS)[number] | 'unrecognized';
  }>;
}>;

/** No error messages, native tails, request references or provider bodies. */
export function ocrReviewFailureDiagnostic(
  error: unknown,
  process: OcrReviewProcessResult | undefined,
  gateway: Readonly<{ code?: string; effect: string }> | undefined
): OcrReviewFailureDiagnostic {
  const gate =
    error instanceof Error
      ? GATE_REASONS.find(
          (reason) => error.message === `review_action_v2_ocr_${reason}`
        )
      : undefined;
  return {
    reason:
      error instanceof OcrReviewAcceptanceError
        ? error.code
        : (gate ?? 'invocation_failed'),
    ...(process
      ? {
          process: {
            closed: process.closed,
            exitCode:
              Number.isInteger(process.exitCode) &&
              process.exitCode! >= 0 &&
              process.exitCode! <= 255
                ? process.exitCode
                : null,
            signal:
              process.signal !== null &&
              Object.hasOwn(constants.signals, process.signal)
                ? process.signal
                : null,
            spawnError: process.spawnError !== undefined,
          },
        }
      : {}),
    ...(gateway
      ? {
          gateway: {
            code:
              GATEWAY_CODES.find((code) => code === gateway.code) ??
              'unrecognized',
            effect:
              EFFECTS.find((effect) => effect === gateway.effect) ??
              'unrecognized',
          },
        }
      : {}),
  };
}
