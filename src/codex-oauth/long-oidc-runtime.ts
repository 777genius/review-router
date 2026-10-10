// REVIEW DRAFT: normal RR bearer renewal is allowed; fixed execution authority
// and approved server deadline must stay unchanged. Not approved for execution.
// TEST-only adapter. Place beside account-gateway-runtime.ts in a NEW approved
// Action artifact. Never inject this into the already attested 49f artifact.
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { runAccountGatewayRuntime } from './account-gateway-runtime';
import { CodexOAuthV2ReviewOutcome, CodexOAuthV2TerminalReason, CodexOAuthV2CancellationReason } from './runtime';
import { ReviewActionV2OperationId, ReviewActionV2ProtocolErrorCode } from '../control-plane/generated/review-action-v2/review-action-v2';

type Inputs = Parameters<typeof runAccountGatewayRuntime>[0];
type Ports = Parameters<typeof runAccountGatewayRuntime>[1];
type Gateway = NonNullable<Parameters<Ports['review']['run']>[0]['accountGateway']>;
type Authorization = ReturnType<Gateway['controlPlane']['currentAuthorization']>;
type Observation = Readonly<{
  stage: 'mint' | 'after-expiry' | 'review-complete' | 'deadline-denied' | 'failed' | 'review-returned';
  outcome?: string;
  terminalReason?: string;
  blockingFailure?: string;
  reason?: string;
  observedAt: string;
  elapsedMs: number;
  mintExpiresAt: string;
  deadline?: string;
  executionDeadline?: string;
  outerBearerExpiresAt?: string;
  authorizationId?: string;
  httpStatus?: number;
}>;

function projectLongReviewResult(result: Awaited<ReturnType<Ports['review']['run']>>) {
  const outcome = Object.values(CodexOAuthV2ReviewOutcome).includes(result.outcome)
    ? result.outcome : 'unknown';
  const reason = 'reason' in result ? result.reason : undefined;
  const terminalReason = [...Object.values(CodexOAuthV2TerminalReason),
    ...Object.values(CodexOAuthV2CancellationReason)].some(value => value === reason)
    ? String(reason) : 'unknown';
  const code = 'blockingFailure' in result ? result.blockingFailure : undefined;
  const knownCodes = new Set([
    'review_orchestration_execution_authorization_window_insufficient',
    'review_action_v2_authorization_renew_denied', 'review_action_v2_authorization_renew_expired',
    'review_action_v2_authorization_renew_scope_mismatch', 'review_action_v2_authorization_renew_epoch_mismatch',
    'review_action_v2_authorization_renew_expiry_invalid', 'review_orchestration_execution_deadline_reached',
    'review_action_v2_revision_guard_unavailable', 'review_action_v2_revision_guard_failed',
    'codex_oauth_oidc_invalid_response', 'codex_oauth_missing_ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'codex_oauth_missing_ACTIONS_ID_TOKEN_REQUEST_URL', 'required_work_exhausted',
    'required_execution_deadline_reached', 'required_review_coverage_incomplete',
  ]);
  let blockingFailure = typeof code === 'string' && knownCodes.has(code) ? code : 'unknown';
  // Keep only generated operation/category enums; discard arbitrary issue suffixes.
  if (typeof code === 'string') {
    const [prefix, operation, category] = code.split(':');
    if (prefix === 'review_action_v2' &&
        Object.values(ReviewActionV2OperationId).some(value => value === operation) &&
        Object.values(ReviewActionV2ProtocolErrorCode).some(value => value === category))
      blockingFailure = `${prefix}:${operation}:${category}`;
  }
  return { outcome, terminalReason, blockingFailure };
}

// The caller supplies a public-only receipt writer, never arbitrary token logs.
export async function runLongOidcTestRuntime(
  inputs: Inputs,
  ports: Ports,
  record: (observation: Observation) => void,
  expected: Readonly<{ repository: string; model: string }>,
): Promise<void> {
  if (!process.env.GITHUB_ACTIONS || process.env.GITHUB_EVENT_NAME !== 'pull_request' ||
      !expected.repository || inputs.repository !== expected.repository || !expected.model)
    throw new Error('long_oidc_disposable_github_pr_required');
  const started = performance.now();
  const network = ports.fetchImpl ?? fetch;
  let mintExpiresAt = 0;
  let authorizationCount = 0;
  let authorityFingerprint: string | undefined;
  let authorizationId: string | undefined;
  let deadline = 0;
  let executionDeadline = 0;
  let outerBearerExpiresAt = 0;
  let currentAuthorization: (() => Authorization) | undefined;
  let caseCompleted = false;
  let failureReason: string | undefined;
  const knownReasons = new Set([
    'long_oidc_verified_admission_missing', 'long_oidc_approved_deadline_unsuitable',
    'long_oidc_execution_authority_changed', 'long_oidc_run_window_lost',
    'long_oidc_normal_execution_deadline_missing', 'long_oidc_execution_window_insufficient',
    'long_oidc_review_not_completed', 'long_oidc_review_missed_deadline',
    'long_oidc_deadline_did_not_deny', 'long_oidc_body_unobservable',
    'long_oidc_reauthorization_forbidden', 'long_oidc_jwt_invalid',
    'long_oidc_github_mint_required',
  ]);
  const emit = (stage: Observation['stage'], httpStatus?: number) => {
    record({
      stage,
      observedAt: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - started),
      mintExpiresAt: new Date(mintExpiresAt).toISOString(),
      ...(deadline ? { deadline: new Date(deadline).toISOString() } : {}),
      ...(executionDeadline ? { executionDeadline: new Date(executionDeadline).toISOString() } : {}),
      ...(outerBearerExpiresAt ? { outerBearerExpiresAt: new Date(outerBearerExpiresAt).toISOString() } : {}),
      ...(authorizationId ? { authorizationId } : {}),
      ...(httpStatus === undefined ? {} : { httpStatus }),
    });
  };
  const fingerprint = (a: Authorization) => JSON.stringify({
    id: a.authorizationId, epoch: a.mutationEpoch, release: a.producerReleaseId,
    facts: a.facts, limits: a.limits,
  });
  const assertOriginal = () => {
    const a = currentAuthorization?.();
    outerBearerExpiresAt = a ? Date.parse(a.expiresAt) : NaN;
    if (!a || !Number.isFinite(outerBearerExpiresAt) ||
        fingerprint(a) !== authorityFingerprint || outerBearerExpiresAt > deadline)
      throw new Error('long_oidc_execution_authority_changed');
    return a;
  };
  const waitUntil = async (instant: number, signal?: AbortSignal) => {
    // Real elapsed time; recheck against the observed absolute wall-clock bound.
    while (Date.now() < instant) {
      await delay(Math.min(60_000, instant - Date.now()), undefined, { signal });
    }
  };
  const observedFetch: typeof fetch = async (request, init) => {
    const url = new URL(request instanceof Request ? request.url : String(request));
    if (url.origin === new URL(inputs.apiUrl).origin && init?.body) {
      if (typeof init.body !== 'string') throw new Error('long_oidc_body_unobservable');
      const body: unknown = JSON.parse(init.body);
      if (body && typeof body === 'object' && 'oidcToken' in body && !('authorizationId' in body)) {
        if (++authorizationCount !== 1 || typeof body.oidcToken !== 'string')
          throw new Error('long_oidc_reauthorization_forbidden');
        const segments = body.oidcToken.split('.');
        if (segments.length !== 3) throw new Error('long_oidc_jwt_invalid');
        const claims: unknown = JSON.parse(Buffer.from(segments[1]!, 'base64url').toString());
        if (!claims || typeof claims !== 'object' || !('iss' in claims) ||
            claims.iss !== 'https://token.actions.githubusercontent.com' ||
            !('exp' in claims) || typeof claims.exp !== 'number' ||
            !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= Date.now())
          throw new Error('long_oidc_github_mint_required');
        mintExpiresAt = claims.exp * 1000;
        // Decoding is observation only. Normal RR verifies issuer/JWKS/claims.
      }
    }
    return network(request, init);
  };
  await runAccountGatewayRuntime(inputs, {
    ...ports,
    fetchImpl: observedFetch,
    review: { run: async (input) => {
      const gateway = input.accountGateway;
      if (!gateway || !mintExpiresAt || authorizationCount !== 1)
        throw new Error('long_oidc_verified_admission_missing');
      const authorization = gateway.controlPlane.currentAuthorization();
      authorityFingerprint = fingerprint(authorization);
      authorizationId = authorization.authorizationId;
      deadline = Date.parse(authorization.expiresAt);
      outerBearerExpiresAt = deadline;
      currentAuthorization = () => gateway.controlPlane.currentAuthorization();
      if (!Number.isFinite(deadline) || deadline <= mintExpiresAt + 120_000 ||
          deadline > Date.now() + 900_000)
        throw new Error('long_oidc_approved_deadline_unsuitable');
      emit('mint');
      await waitUntil(mintExpiresAt + 1_500, gateway.signal);
      assertOriginal();
      if (Date.now() >= deadline - 60_000) throw new Error('long_oidc_run_window_lost');
      const deadlineKey = 'REVIEWROUTER_EXECUTION_DEADLINE_EPOCH_MS';
      const configured = process.env[deadlineKey];
      const configuredDeadline = Number(configured);
      if (!configured || !Number.isSafeInteger(configuredDeadline) || configuredDeadline <= Date.now())
        throw new Error('long_oidc_normal_execution_deadline_missing');
      // Normal T0 needs executable window + five minutes publication reserve.
      // Tighten the trusted client's existing deadline; never extend server authority.
      executionDeadline = Math.min(configuredDeadline, deadline - 300_000 - 15_000);
      if (executionDeadline - Date.now() < 150_000)
        throw new Error('long_oidc_execution_window_insufficient');
      emit('after-expiry');
      process.env[deadlineKey] = String(executionDeadline);
      let result: Awaited<ReturnType<Ports['review']['run']>>;
      try {
        result = await ports.review.run(input);
      } finally {
        // Normal runtime runs in its dedicated job process; restore caller config.
        process.env[deadlineKey] = configured;
      }
      try {
        record({ stage: 'review-returned', observedAt: new Date().toISOString(),
          elapsedMs: Math.round(performance.now() - started),
          mintExpiresAt: new Date(mintExpiresAt).toISOString(), ...projectLongReviewResult(result) });
      } catch {
        // A receipt writer cannot change the returned normal review outcome.
      }
      if (result.outcome !== 'completed') throw new Error('long_oidc_review_not_completed');
      assertOriginal();
      if (Date.now() >= deadline) throw new Error('long_oidc_review_missed_deadline');
      emit('review-complete');
      return result;
    } },
    terminalFailure: async (error, context) => {
      failureReason = error instanceof Error && knownReasons.has(error.message)
        ? error.message : 'long_oidc_runtime_failure';
      try {
        record({ stage: 'failed', reason: failureReason, observedAt: new Date().toISOString(),
          elapsedMs: Math.round(performance.now() - started),
          mintExpiresAt: new Date(mintExpiresAt).toISOString() });
      } catch {
        // Diagnostics cannot replace the original runtime failure reporting.
      }
      await ports.terminalFailure(error, context);
    },
    terminalReview: async (review, signal) => {
      await ports.terminalReview(review, signal);
      const current = assertOriginal();
      await waitUntil(deadline + 1_500, signal);
      const response = await network(new URL('/api/action/v2/account-gateway/responses', inputs.apiUrl), {
        method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
        headers: { authorization: `Bearer ${current.authorizationToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: expected.model, input: 'Must not dispatch after deadline.' }),
      });
      await response.body?.cancel();
      if (response.status !== 401) throw new Error('long_oidc_deadline_did_not_deny');
      // Both outer bearer and fixed gateway deadline have elapsed. Backend
      // zero-dispatch proof joins this E2E denial; it does not isolate native expiry.
      emit('deadline-denied', response.status);
      caseCompleted = true;
    },
  });
  if (!caseCompleted) throw new Error(failureReason ?? 'long_oidc_case_incomplete');
}
