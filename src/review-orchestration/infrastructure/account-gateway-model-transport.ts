import { createResponsesUsageObserver } from '../../provider-usage/responses-observer';
import type { UsageDelivery } from '../../provider-usage/delivery';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
} from 'http';
import { request as httpsRequest } from 'https';
import { performance } from 'perf_hooks';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { hasOwnedPrDescriptionMarker } from '../../github/pr-description-markers';
import {
  providerApiCheckoutCompanionContract,
  providerApiDescriptors,
  type ProviderApiAuthMode,
  prDescriptionContract,
  lifecycleVerificationContract,
  type ReviewCompanionDispatchContextV1,
} from '../../control-plane/generated/review-action-v2/companion-contracts';
import { setTimeout as wait } from 'timers/promises';
import type { LifecycleRequestEncoder } from '../../finding-revalidation/domain/packet';
import {
  PreparedModelDispatch,
  type PreparedModelDispatchTicket,
  type PreparedModelInvocationScope,
} from './prepared-model-dispatch';
import {
  CODEX_SUBSCRIPTION_RESPONSES_ROUTE,
  codexSubscriptionResponsesHeaders,
  decodeCodexSubscriptionCompletedResponse,
  encodeCodexSubscriptionVerificationRequest,
  normalizeCodexSubscriptionResponsesRequest,
} from './codex-subscription-responses-codec';

const BASE = '/api/action/v2/account-gateway';
export const LOCAL_MODEL_CAPABILITY_ENV = 'REVIEWROUTER_LOCAL_MODEL_TOKEN';
// Enforced consumer ceilings; production qualification belongs to D-final.
export const ACCOUNT_GATEWAY_BOUNDS = Object.freeze({
  requestBytes: 16_777_216,
  outputBytes: 1_048_576,
  // Raw SSE includes repeated deltas/tool events; final review files remain bounded above.
  streamOutputBytes: 8_388_608,
  streamFrameBytes: 1_048_576,
  jsonBytes: 65_536,
  checkoutV4JsonBytes: 131_072,
  headerBytes: 16_384,
  bufferBytes: 65_536,
  requestMs: 3_600_000,
  // Codex times parsed SSE events; comments can keep native bytes alive
  // without satisfying that event wait.
  idleMs: 300_000,
  controlMs: 30_000,
  waitBudgetMs: 120_000,
  maxWaits: 128,
  inFlight: 1,
  localConnections: 4,
  cliOutputBytes: 8_388_608,
});
// Closed pre-dispatch saturation denials a later attempt may retry once released.
const RELEASABLE_SATURATION_CODES: readonly string[] = [
  'relay_saturated',
  'lane_saturated',
];

export type GatewayReadback = Readonly<{ httpStatus: number; value: unknown }>;
/** RR-specific selectors are checked against the authorized run by the server. */
export type AccountGatewayCheckoutRequest = Readonly<{
  providerInstanceId: string;
  workflowSchemaVersion: number;
}>;
export type GatewayCloseReason = 'completed' | 'failed' | 'cancelled';
export type GatewayFailureFact = Readonly<{
  code: string;
  effect: string;
  requestRef?: string;
  failureScope?: 'reviewer' | 'allocation' | 'run';
  concurrencyGroupId?: string;
}>;
export type GatewayResponses = Readonly<{
  httpStatus: number;
  contentType: string;
  requestRef?: string;
  body: Readable;
  providerRequestEnvelopeHash?: string;
  cancel(): void;
}>;
export type GatewayTransportDiagnostic = Readonly<{
  stage:
    | 'request_body'
    | 'upstream_request'
    | 'upstream_headers'
    | 'upstream_stream'
    | 'downstream_stream';
  responseReceived: boolean;
  httpStatus: number | null;
  streamFacts?: Readonly<{
    callerAborted: boolean;
    upstreamIdleExpired: boolean;
    completedObserved: boolean;
  }>;
  downstreamIdleExpired?: boolean;
  errorCategory:
    | 'none'
    | 'AbortError'
    | 'TypeError'
    | 'RangeError'
    | 'Error'
    | 'other';
}>;
type DirectProviderApiLimits = Readonly<{
  mode?: ProviderApiAuthMode;
  requestMs: number;
  streamFrameBytes: number;
  usage?: { delivery: UsageDelivery; requestedModel: string };
  modelDispatch?: PreparedModelDispatch;
}>;
/** Finite native destinations. Only the preparation factories construct these;
 * credentials, headers, paths and protocol are never supplied by the child. */
type PreparedCodexResponsesRoute = Readonly<{
  modelDispatch: PreparedModelDispatch;
  reasoningEffort?: string | null;
  signal?: AbortSignal;
}> &
  (
    | Readonly<{ kind: 'subscription'; accountId: string }>
    | Readonly<{ kind: 'hosted_pool'; readGrant: () => string }>
  );
export const HOSTED_POOL_CODEX_RESPONSES_PATH =
  '/api/action/v2/model-route/hosted-responses';
type ObserveTransport = (
  diagnostic: GatewayTransportDiagnostic
) => void | Promise<void>;

// Diagnostics must never change transport settlement or include arbitrary error data.
function observeTransport(
  observe: ObserveTransport | undefined,
  stage: GatewayTransportDiagnostic['stage'],
  responseReceived: boolean,
  httpStatus: number | null,
  error?: unknown,
  facts: Pick<
    GatewayTransportDiagnostic,
    'streamFacts' | 'downstreamIdleExpired'
  > = {}
): void {
  try {
    void Promise.resolve(
      observe?.({
        stage,
        ...facts,
        responseReceived,
        httpStatus,
        errorCategory:
          error === undefined
            ? 'none'
            : error instanceof TypeError
              ? 'TypeError'
              : error instanceof RangeError
                ? 'RangeError'
                : error instanceof Error
                  ? error.name === 'AbortError'
                    ? 'AbortError'
                    : 'Error'
                  : 'other',
      })
    ).catch(() => {
      /* A rejected diagnostic observer cannot fail a provider request. */
    });
  } catch {
    /* A diagnostic observer cannot fail a provider request. */
  }
}
export type LocalGatewayModelTransport = Readonly<{
  /** Managed OCR client protocol; native Codex is normalized by the parent. */
  protocol?: 'openai-responses' | 'anthropic-messages';
  baseUrl: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  configuration: readonly string[];
  actualModel(): string | undefined;
  /** Dispatched model-request observations (upstream relay attempts). Additive
   * run evidence only: a managed engine may not claim success with zero model
   * requests, so acceptance reads this instead of guessing from exit status. */
  requestCount?(): number;
  failureFact(): GatewayFailureFact | undefined;
  /** Releases only positively proven unpaid pre-dispatch denials; false keeps
   * the inference fence for unknown/paid effects. */
  releaseRetrySafeFailure?(): boolean;
  /** Compatibility alias for positive unpaid-denial release; unknown/paid,
   * terminal and cancelled consumers keep their fence. */
  reopenConsumer?(): boolean;
  setContextToolsGuard?(guard: (() => void) | undefined): void;
  beginInvocation?(scope: () => PreparedModelInvocationScope): () => void;
  encodeLifecycleRequest?: LifecycleRequestEncoder;
  /** Trusted parent only; its receipt never contributes review-engine evidence. */
  generatePrDescription?(input: {
    requestBody: Uint8Array;
    dispatch?: ReviewCompanionDispatchContextV1;
    signal: AbortSignal;
  }): Promise<PrDescriptionModelReceipt>;
  generateLifecycleVerification?(input: {
    requestBody: Uint8Array;
    dispatch: ReviewCompanionDispatchContextV1;
    signal: AbortSignal;
    maxResponseBytes: number;
    maxOutputTokens: number;
    deadlineMs: number;
  }): Promise<LifecycleVerificationModelReceipt>;
  dispose(): Promise<void>;
}>;

export type LifecycleVerificationModelReceipt = Readonly<{
  body: Uint8Array;
  actualModel: string;
  providerRequestEnvelopeHash: string;
}>;

export type PrDescriptionModelReceipt = Readonly<{
  generatedMarkdown: string;
  actualModel: string;
  providerRequestEnvelopeHash: string;
}>;

/** Gateway lifecycle HTTP only. Failed seals/releases retain a bounded cleanup
 * channel; every normal attempt (including client retries) observes run abort. */
export function createAccountGatewayRunFetch(
  fetchImpl: typeof fetch,
  signal: AbortSignal
): typeof fetch {
  return (input, init) => {
    const route = new URL(input instanceof Request ? input.url : String(input))
      .pathname;
    const cleanup =
      [
        '/api/action/v2/review-invocation-leases/release',
        '/api/action/v2/review-investigations/leases/release',
        '/api/action/v2/review-investigations/turns/abort',
      ].includes(route) ||
      ([
        '/api/action/v2/review-context/gateway/seal',
        '/api/action/v2/review-investigations/context-gateway/seal',
      ].includes(route) &&
        typeof init?.body === 'string' &&
        (JSON.parse(init.body) as { providerSucceeded?: unknown })
          .providerSucceeded === false);
    if (!cleanup) signal.throwIfAborted();
    const signals = [AbortSignal.timeout(ACCOUNT_GATEWAY_BOUNDS.controlMs)];
    if (!cleanup) signals.push(signal);
    const requestSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (requestSignal) signals.push(requestSignal);
    return fetchImpl(input, { ...init, signal: AbortSignal.any(signals) });
  };
}

/** One fixed RR origin, current v2 run authorization, ordinary Responses bytes.
 * No SDK/control bearer, account selection, protocol conversion or replay. */
export class AccountGatewayModelTransport {
  private readonly origin: URL;
  private readonly held = new Set<AbortController>();
  private inferenceDenied = false;
  private inferenceCancelled = false;
  private terminal = false;
  /** Set once any response other than a closed, unreferenced 503 saturation
   * denial (or a transport error) is observed: something may have been paid. */
  private mayHaveDispatched = false;
  private failure?: GatewayFailureFact;
  private requestRef?: string;
  private observedModel?: string;
  private modelUncertain = false;
  private observedRequests = 0;
  private modelDispatch?: PreparedModelDispatch;
  private contextToolsGuard?: () => void;
  private readonly pendingSettlements = new Set<Promise<unknown>>();

  constructor(
    apiUrl: string,
    private readonly authorization: () => string,
    private readonly observe?: ObserveTransport,
    private readonly directProvider?: DirectProviderApiLimits,
    private readonly auxiliaryDescription: boolean = false,
    private readonly completedDescriptionResponse?: (
      response: unknown,
      nativeBody?: Uint8Array
    ) => void,
    private readonly companionDispatch?: ReviewCompanionDispatchContextV1,
    private readonly reviewerId?: string,
    private readonly codexRoute?: PreparedCodexResponsesRoute
  ) {
    this.origin = trustedGatewayOrigin(apiUrl);
    if (
      directProvider &&
      this.origin.origin !==
        new URL(
          providerApiDescriptors[directProvider.mode ?? 'openrouter-api']
            .fixedResponsesUrl
        ).origin
    )
      throw new Error('provider_api_origin_invalid');
    if (
      codexRoute &&
      (directProvider ||
        (codexRoute.kind === 'subscription' &&
          this.origin.origin !==
            new URL(CODEX_SUBSCRIPTION_RESPONSES_ROUTE.endpoint).origin))
    )
      throw new Error('codex_prepared_origin_invalid');
    this.modelDispatch =
      codexRoute?.modelDispatch ?? directProvider?.modelDispatch;
  }

  setModelDispatch(controller: PreparedModelDispatch): void {
    if (
      this.held.size ||
      (this.modelDispatch && this.modelDispatch !== controller)
    )
      throw new Error('model_dispatch_route_already_prepared');
    this.modelDispatch = controller;
  }

  beginInvocation(scope: () => PreparedModelInvocationScope): () => void {
    return this.modelDispatch?.beginInvocation(scope) ?? (() => undefined);
  }

  setContextToolsGuard(guard: (() => void) | undefined): void {
    this.contextToolsGuard = guard;
  }

  async drainSettlements(): Promise<void> {
    while (this.pendingSettlements.size)
      await Promise.allSettled([...this.pendingSettlements]);
  }

  get lastFailure(): GatewayFailureFact | undefined {
    return this.failure;
  }
  get lastRequestRef(): string | undefined {
    return this.requestRef;
  }

  /** Positively proven pre-dispatch denial (closed relay_saturated/lane_saturated
   * 503 envelope, no request reference) paid nothing: a fresh dispatch may
   * proceed. A consumer that ever saw any other response, a transport error or
   * cancellation keeps denying inference: earlier requests may have been paid. */
  releaseRetrySafeFailure(): boolean {
    const failure = this.failure;
    if (
      this.terminal ||
      this.inferenceCancelled ||
      this.mayHaveDispatched ||
      !failure ||
      failure.requestRef !== undefined ||
      failure.effect !== 'not_dispatched' ||
      !RELEASABLE_SATURATION_CODES.includes(failure.code)
    )
      return false;
    this.failure = undefined;
    this.inferenceDenied = false;
    return true;
  }
  /** Compatibility entry point with the same positive unpaid proof as release.
   * An ambiguous dispatch remains fenced regardless of the attempt budget. */
  reopenConsumer(): boolean {
    return this.releaseRetrySafeFailure();
  }
  get actualModel(): string | undefined {
    return this.inferenceDenied || this.modelUncertain
      ? undefined
      : this.observedModel;
  }
  get requestCount(): number {
    return this.observedRequests;
  }

  async generatePrDescription(input: {
    requestBody: Uint8Array;
    dispatch?: ReviewCompanionDispatchContextV1;
    signal: AbortSignal;
  }): Promise<PrDescriptionModelReceipt> {
    input.signal.throwIfAborted();
    if (this.codexRoute)
      throw new Error('pr_description_native_route_unavailable');
    if (this.terminal || this.inferenceDenied || this.held.size > 0)
      throw new Error('pr_description_connection_unavailable');
    const bytes = Buffer.from(input.requestBody);
    if (bytes.length > prDescriptionContract.maxPromptBytes)
      throw new Error('pr_description_input_bound');
    const envelope: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    );
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
      throw new Error('pr_description_request_invalid');
    const request = envelope as Record<string, unknown>;
    if (
      Object.keys(request).some(
        (key) =>
          ![
            'model',
            'instructions',
            'input',
            'tools',
            'tool_choice',
            'store',
            'stream',
            'service_tier',
            'max_output_tokens',
          ].includes(key)
      ) ||
      typeof request.model !== 'string' ||
      !request.model ||
      typeof request.instructions !== 'string' ||
      !isPrDescriptionMessageInput(request.input) ||
      !Array.isArray(request.tools) ||
      request.tools.length !== 0 ||
      request.tool_choice !== 'none' ||
      request.store !== false ||
      request.stream !== true ||
      request.service_tier !== 'default' ||
      request.max_output_tokens !== prDescriptionContract.maxOutputTokens
    )
      throw new Error('pr_description_request_invalid');
    let markdown: string | undefined;
    // Same fixed endpoint/credential authority, independent evidence and failure state.
    const auxiliary = new AccountGatewayModelTransport(
      this.origin.origin,
      this.authorization,
      undefined,
      this.directProvider,
      true,
      (response) => {
        markdown = completedPrDescriptionText(response);
      },
      input.dispatch,
      this.reviewerId
    );
    if (this.modelDispatch) auxiliary.setModelDispatch(this.modelDispatch);
    const abort = new AbortController();
    this.held.add(abort);
    const signal = AbortSignal.any([input.signal, abort.signal]);
    const timer = setTimeout(
      () => abort.abort(),
      prDescriptionContract.deadlineMs
    );
    try {
      const response = await auxiliary.responses(bytes, signal);
      if (response.httpStatus !== 200) {
        response.cancel();
        throw new Error('pr_description_http_unavailable');
      }
      // Drain through the existing strict, bounded SSE audit before accepting text.
      for await (const _chunk of response.body) {
        signal.throwIfAborted();
      }
      if (!markdown || !auxiliary.actualModel)
        throw new Error('pr_description_model_evidence_unavailable');
      return Object.freeze({
        generatedMarkdown: markdown,
        actualModel: auxiliary.actualModel,
        providerRequestEnvelopeHash: createHash('sha256')
          .update(bytes)
          .digest('hex'),
      });
    } finally {
      clearTimeout(timer);
      this.held.delete(abort);
      abort.abort();
      auxiliary.cancelHeldStreams();
    }
  }

  /** Parent-only, one HTTP attempt: a denied or uncertain dispatch is never replayed. */
  async generateLifecycleVerification(input: {
    requestBody: Uint8Array;
    dispatch: ReviewCompanionDispatchContextV1;
    signal: AbortSignal;
    maxResponseBytes: number;
    maxOutputTokens: number;
    deadlineMs: number;
  }): Promise<LifecycleVerificationModelReceipt> {
    input.signal.throwIfAborted();
    if (
      (this.directProvider && !this.modelDispatch) ||
      this.terminal ||
      this.inferenceDenied ||
      this.held.size > 0
    )
      throw new Error('lifecycle_verification_connection_unavailable');
    if (
      !Number.isSafeInteger(input.maxOutputTokens) ||
      input.maxOutputTokens < 1 ||
      !Number.isSafeInteger(input.maxResponseBytes) ||
      input.maxResponseBytes < 1 ||
      !Number.isSafeInteger(input.deadlineMs) ||
      input.deadlineMs < 1 ||
      (this.modelDispatch &&
        input.maxOutputTokens > this.modelDispatch.capability.maxOutputTokens)
    )
      throw new Error('lifecycle_verification_output_bound');
    const bytes = Buffer.from(input.requestBody);
    if (bytes.length > lifecycleVerificationContract.maxPromptBytes)
      throw new Error('lifecycle_verification_input_bound');
    let text: string | undefined;
    const auxiliary = new AccountGatewayModelTransport(
      this.origin.origin,
      this.authorization,
      this.observe,
      this.directProvider,
      true,
      (response, nativeBody) => {
        if (
          nativeBody &&
          nativeBody.byteLength >
            Math.min(
              input.maxResponseBytes,
              lifecycleVerificationContract.maxResponseBytes
            )
        )
          throw new Error('lifecycle_verification_output_bound');
        text = nativeBody
          ? Buffer.from(nativeBody).toString('utf8')
          : completedPrDescriptionText(
              response,
              Math.min(
                input.maxResponseBytes,
                lifecycleVerificationContract.maxResponseBytes
              ),
              false
            );
      },
      input.dispatch,
      this.reviewerId,
      this.codexRoute
    );
    if (this.modelDispatch) auxiliary.setModelDispatch(this.modelDispatch);
    auxiliary.setContextToolsGuard(this.contextToolsGuard);
    const abort = new AbortController();
    this.held.add(abort);
    const signal = AbortSignal.any([input.signal, abort.signal]);
    const timer = setTimeout(
      () => abort.abort(),
      Math.min(input.deadlineMs, lifecycleVerificationContract.deadlineMs)
    );
    try {
      const response = await auxiliary.responses(
        bytes,
        signal,
        input.maxOutputTokens
      );
      if (response.httpStatus !== 200) {
        response.cancel();
        throw new Error('lifecycle_verification_dispatch_unavailable');
      }
      for await (const _chunk of response.body) signal.throwIfAborted();
      if (!text || !auxiliary.actualModel)
        throw new Error('lifecycle_verification_model_evidence_unavailable');
      return Object.freeze({
        body: Buffer.from(text, 'utf8'),
        actualModel: auxiliary.actualModel,
        providerRequestEnvelopeHash:
          response.providerRequestEnvelopeHash ??
          createHash('sha256').update(bytes).digest('hex'),
      });
    } finally {
      clearTimeout(timer);
      this.held.delete(abort);
      abort.abort();
      auxiliary.cancelHeldStreams();
      await auxiliary.drainSettlements();
    }
  }

  async responses(
    bytes: Uint8Array | Readable,
    signal?: AbortSignal,
    explicitOutputCap?: number
  ): Promise<GatewayResponses> {
    if (
      this.terminal ||
      this.inferenceDenied ||
      this.held.size >= ACCOUNT_GATEWAY_BOUNDS.inFlight
    ) {
      const error = new Error('account_gateway_inference_denied');
      observeTransport(this.observe, 'upstream_request', false, null, error);
      throw error;
    }
    this.codexRoute?.signal?.throwIfAborted();
    this.contextToolsGuard?.();
    // Snapshot before awaiting authorization; no mutable caller payload.
    const captured =
      this.modelDispatch && bytes instanceof Readable
        ? await boundedBytes(
            bytes,
            this.modelDispatch.capability.maxRequestBytes,
            signal
          )
        : bytes;
    const cap = this.modelDispatch?.capability;
    const nativeRequest =
      this.codexRoute && cap
        ? normalizeCodexSubscriptionResponsesRequest({
            requestBytes: captured as Uint8Array,
            model: cap.model,
            maxRequestBytes: cap.maxRequestBytes,
            maxOutputTokens: explicitOutputCap ?? cap.maxOutputTokens,
            reasoningEffort: this.codexRoute.reasoningEffort,
          })
        : undefined;
    const body = nativeRequest
      ? Buffer.from(nativeRequest.requestBytes)
      : this.modelDispatch
        ? this.modelDispatch.normalizeResponsesRequest(captured as Uint8Array)
        : this.directProvider && captured instanceof Readable
          ? captured
          : Buffer.from(captured as Uint8Array);
    if (
      nativeRequest &&
      this.auxiliaryDescription &&
      (nativeRequest.allowedToolNames.length !== 0 ||
        JSON.parse(Buffer.from(nativeRequest.requestBytes).toString('utf8'))
          .tool_choice !== 'none')
    )
      throw new Error('lifecycle_verification_native_tools_forbidden');
    if (
      explicitOutputCap !== undefined &&
      (!Number.isSafeInteger(explicitOutputCap) ||
        explicitOutputCap < 1 ||
        (cap && explicitOutputCap > cap.maxOutputTokens) ||
        (nativeRequest
          ? nativeRequest.outputTokenAcceptanceCap !== explicitOutputCap
          : JSON.parse(Buffer.from(body as Uint8Array).toString('utf8'))
              .max_output_tokens !== explicitOutputCap))
    )
      throw new Error('lifecycle_verification_output_bound');
    if (
      !this.directProvider &&
      Buffer.isBuffer(body) &&
      body.length > ACCOUNT_GATEWAY_BOUNDS.requestBytes
    ) {
      const error = new Error('account_gateway_request_bound');
      observeTransport(this.observe, 'upstream_request', false, null, error);
      throw error;
    }
    const controller = new AbortController();
    this.held.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    this.codexRoute?.signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (this.codexRoute?.signal?.aborted) abort();
    const timer = setTimeout(
      abort,
      Math.max(
        1,
        Math.min(
          this.directProvider?.requestMs ?? ACCOUNT_GATEWAY_BOUNDS.requestMs,
          cap ? Date.parse(cap.deadline) - Date.now() : Infinity
        )
      )
    );
    const dispose = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.codexRoute?.signal?.removeEventListener('abort', abort);
      this.held.delete(controller);
    };
    const usage = this.directProvider?.usage
      ? createResponsesUsageObserver(
          this.directProvider.usage.delivery,
          this.directProvider.usage.requestedModel,
          this.directProvider.mode === 'mimo-token-plan-api'
            ? 'mimo'
            : this.directProvider.mode === 'kimi-code-api'
              ? 'kimi'
              : 'openrouter'
        )
      : undefined;
    let responseReceived = false;
    let httpStatus: number | null = null;
    let currentRequestRef: string | undefined;
    let ticket: PreparedModelDispatchTicket | undefined;
    let completedResponse: unknown;
    let nativeCompleted:
      | ReturnType<typeof decodeCodexSubscriptionCompletedResponse>
      | undefined;
    try {
      if (this.modelDispatch)
        ticket = await this.modelDispatch.reserve(
          body as Buffer,
          controller.signal,
          this.companionDispatch,
          nativeRequest?.outputTokenAcceptanceCap ?? explicitOutputCap
        );
      this.contextToolsGuard?.();
      const waitUntil = performance.now() + ACCOUNT_GATEWAY_BOUNDS.waitBudgetMs;
      let waits = 0;
      let response: IncomingMessage;
      let denial: Buffer | undefined;
      for (;;) {
        if (this.terminal || this.inferenceDenied)
          throw new Error('account_gateway_inference_denied');
        responseReceived = false;
        httpStatus = null;
        currentRequestRef = undefined;
        denial = undefined;
        // Admission/model headers retain the existing whole-request deadline.
        // Socket errors can happen after application dispatch. Never infer non-entry.
        response = await this.request(
          'POST',
          this.codexRoute
            ? this.codexRoute.kind === 'subscription'
              ? new URL(CODEX_SUBSCRIPTION_RESPONSES_ROUTE.endpoint).pathname
              : HOSTED_POOL_CODEX_RESPONSES_PATH
            : this.directProvider
              ? new URL(
                  providerApiDescriptors[
                    this.directProvider.mode ?? 'openrouter-api'
                  ].fixedResponsesUrl
                ).pathname
              : `${BASE}/responses`,
          body,
          controller.signal,
          () => {
            ticket?.forwarded();
            this.observedRequests++;
            usage?.dispatched();
          },
          ticket &&
            !this.directProvider &&
            this.codexRoute?.kind !== 'subscription'
            ? {
                ...Object.fromEntries(
                  Object.entries(
                    lifecycleVerificationContract.dispatchHeaders
                  ).map(([key, header]) => [
                    header,
                    String(
                      ticket!.claim[
                        key as keyof PreparedModelDispatchTicket['claim']
                      ]
                    ),
                  ])
                ),
                'x-reviewrouter-model-dispatch-version': '2',
                'x-reviewrouter-model-request-ordinal': String(
                  ticket.claim.requestOrdinal
                ),
                'x-reviewrouter-model-route-identity-hash':
                  ticket.claim.routeIdentityHash,
              }
            : undefined
        );
        responseReceived = true;
        usage?.responseReceived();
        httpStatus = response.statusCode ?? 502;
        currentRequestRef = safeReference(
          response.headers['x-reviewrouter-request-ref']
        );
        if (currentRequestRef) this.requestRef = currentRequestRef;
        if (httpStatus === 200) break;
        // Only a non-200 body's drainage receives the short control bound.
        const controlTimer = setTimeout(
          abort,
          ACCOUNT_GATEWAY_BOUNDS.controlMs
        );
        try {
          denial = await boundedBytes(
            response,
            ACCOUNT_GATEWAY_BOUNDS.jsonBytes,
            controller.signal
          );
          if (!response.complete)
            throw new Error('account_gateway_transport_unknown');
        } finally {
          clearTimeout(controlTimer);
        }
        // Only the closed, positive pre-request denial permits another POST.
        // Missing response headers/references and bare proxy errors prove nothing.
        const referenced =
          response.headers['x-reviewrouter-request-ref'] !== undefined;
        if (
          !this.directProvider &&
          !this.modelDispatch &&
          !this.auxiliaryDescription &&
          httpStatus === 503 &&
          !referenced &&
          /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
            response.headers['content-type'] ?? ''
          ) &&
          denial !== undefined &&
          saturationDenial(denial, ['relay_saturated'])
        ) {
          if (
            waits >= ACCOUNT_GATEWAY_BOUNDS.maxWaits ||
            performance.now() + 1000 > waitUntil
          )
            break;
          await wait(1000, undefined, { signal: controller.signal });
          waits++;
          if (performance.now() >= waitUntil) break;
          continue;
        }
        break;
      }
      // Waited-out denials above paid nothing; only a closed saturation
      // denial as the final response keeps that proof.
      if (
        this.directProvider ||
        httpStatus !== 503 ||
        response.headers['x-reviewrouter-request-ref'] !== undefined ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          response.headers['content-type'] ?? ''
        ) ||
        denial === undefined ||
        !saturationDenial(denial, RELEASABLE_SATURATION_CODES)
      )
        this.mayHaveDispatched = true;
      const status = response.statusCode ?? 502;
      responseReceived = true;
      httpStatus = status;
      if (status !== 200)
        observeTransport(this.observe, 'upstream_headers', true, status);
      const contentType = response.headers['content-type'] ?? '';
      const requestRef = currentRequestRef;
      const isStream =
        status === 200 && /^text\/event-stream(?:\s*;.*)?$/i.test(contentType);
      // Every final non-stream response remains terminal to this consumer.
      if (!isStream) this.inferenceDenied = true;
      if (status === 200 && !isStream)
        throw new Error('account_gateway_invalid_stream');
      let count = 0;
      const responseDigest = createHash('sha256');
      const terminalChunks: Buffer[] = [];
      const diagnostic: Buffer[] = [];
      const audit = isStream
        ? responsesStreamAudit(
            (model) => {
              if (
                !model ||
                (this.observedModel !== undefined &&
                  this.observedModel !== model)
              )
                this.modelUncertain = true;
              else this.observedModel = model;
            },
            this.auxiliaryDescription
              ? ACCOUNT_GATEWAY_BOUNDS.streamFrameBytes
              : this.directProvider?.streamFrameBytes,
            usage?.observe,
            (value) => {
              if (ticket) {
                const terminal = value as {
                  status?: unknown;
                  output?: unknown;
                  error?: unknown;
                  incomplete_details?: unknown;
                } | null;
                if (
                  !terminal ||
                  terminal.status !== 'completed' ||
                  !Array.isArray(terminal.output) ||
                  terminal.error != null ||
                  terminal.incomplete_details != null
                )
                  throw new Error('model_dispatch_terminal_invalid');
                completedResponse = value;
                if (nativeRequest && cap)
                  nativeCompleted = decodeCodexSubscriptionCompletedResponse({
                    response: value,
                    expectedModel: cap.model,
                    maxOutputTokens: nativeRequest.outputTokenAcceptanceCap,
                    maxOutputBytes: Math.min(
                      cap.maxResponseBytes,
                      this.auxiliaryDescription
                        ? lifecycleVerificationContract.maxResponseBytes
                        : cap.maxResponseBytes
                    ),
                    allowToolCalls: !this.auxiliaryDescription,
                    allowedToolNames: nativeRequest.allowedToolNames,
                  });
              }
              this.completedDescriptionResponse?.(value, nativeCompleted?.body);
            },
            !!ticket
          )
        : undefined;
      const bounded = new Transform({
        highWaterMark: ACCOUNT_GATEWAY_BOUNDS.bufferBytes,
        transform: (chunk: Buffer, _encoding, done) => {
          count += chunk.length;
          const maximum = this.modelDispatch
            ? this.modelDispatch.capability.maxResponseBytes
            : isStream
              ? this.directProvider && !this.auxiliaryDescription
                ? Infinity
                : ACCOUNT_GATEWAY_BOUNDS.streamOutputBytes
              : ACCOUNT_GATEWAY_BOUNDS.jsonBytes;
          if (count > maximum) done(new Error('account_gateway_output_bound'));
          else
            try {
              audit?.accept(chunk);
              responseDigest.update(chunk);
              if (!isStream) diagnostic.push(chunk);
              // Native clients can stop at response.completed without reading
              // HTTP EOF. Hold the terminal frame's final bytes until the
              // durable fully-consumed receipt is confirmed by the control plane.
              if (ticket && isStream && audit?.hasCompleted()) {
                terminalChunks.push(Buffer.from(chunk));
                done();
              } else done(null, chunk); // Original bytes, no conversion.
            } catch {
              done(new Error('account_gateway_stream_unknown'));
            }
        },
        flush: (done) => {
          void (async () => {
            audit?.finish();
            if (ticket) {
              if (!isStream) await ticket.failed();
              else {
                if (
                  !response.complete ||
                  !completedResponse ||
                  !this.actualModel
                )
                  throw new Error('model_dispatch_terminal_unconfirmed');
                await ticket.complete({
                  actualModel: this.actualModel,
                  responseHash: responseDigest.digest('hex'),
                  responseBytes: count,
                  usage: nativeCompleted
                    ? {
                        inputTokens: nativeCompleted.usage.promptTokens,
                        outputTokens: nativeCompleted.usage.completionTokens,
                        totalTokens: nativeCompleted.usage.totalTokens,
                      }
                    : terminalUsage(completedResponse),
                });
                for (const chunk of terminalChunks) bounded.push(chunk);
              }
            }
          })().then(
            () => done(),
            () => done(new Error('account_gateway_stream_unknown'))
          );
        },
      });
      let upstreamIdleExpired = false;
      if (isStream)
        response.setTimeout(ACCOUNT_GATEWAY_BOUNDS.idleMs, () => {
          upstreamIdleExpired = true;
          abort();
        });
      let terminalCancellation = false;
      let streamFailureObserved = false;
      const fail = (error: unknown) => {
        // Codex ends a turn at response.completed, before the HTTP EOF.
        // Ignore only the propagated Node cancellation of that audited turn.
        if (
          (!ticket || ticket.isCompleted()) &&
          audit?.hasCompleted() &&
          controller.signal.aborted &&
          signal?.aborted &&
          error instanceof Error &&
          error.name === 'AbortError' &&
          'code' in error &&
          error.code === 'ABORT_ERR' &&
          error.cause === controller.signal.reason
        ) {
          terminalCancellation = true;
          return;
        }
        this.inferenceDenied = true;
        if (ticket) this.trackSettlement(ticket.failed());
        if (!streamFailureObserved) {
          streamFailureObserved = true;
          observeTransport(
            this.observe,
            'upstream_stream',
            true,
            status,
            error,
            {
              streamFacts: {
                callerAborted: signal?.aborted === true,
                upstreamIdleExpired,
                completedObserved: audit?.hasCompleted() === true,
              },
            }
          );
        }
        this.failure ??= {
          code: 'transport',
          effect: 'effect_unknown',
          ...(requestRef ? { requestRef } : {}),
        };
        controller.abort();
      };
      bounded.once('error', fail);
      // Retain cancellation/time bounds until the consumer drains or closes the
      // readable side, including an upstream EOF with downstream backpressure.
      bounded.once('end', dispose);
      bounded.once('close', dispose);
      // pipeline supplies backpressure and tears down both streams on failure/cancel.
      this.trackSettlement(
        pipeline(isStream ? response : Readable.from([denial!]), bounded, {
          signal: controller.signal,
        }).then(
          () => {
            usage?.finish(status !== 200, controller.signal.aborted);
            if (!isStream) {
              this.failure =
                this.codexRoute?.kind === 'subscription' &&
                (status === 401 || status === 403)
                  ? {
                      code: 'codex_subscription_authentication_failed',
                      effect: 'effect_unknown',
                    }
                  : (failureFact(Buffer.concat(diagnostic), requestRef) ?? {
                      code: status === 202 ? 'pending' : 'relay_unknown',
                      effect: 'effect_unknown',
                      ...(requestRef ? { requestRef } : {}),
                    });
              if (this.failure.requestRef)
                this.requestRef = this.failure.requestRef;
            }
          },
          (error) => {
            // HTTP teardown can reset upstream after the proven terminal abort.
            if (
              terminalCancellation &&
              audit?.hasCompleted() &&
              controller.signal.aborted &&
              signal?.aborted &&
              error instanceof Error &&
              'code' in error &&
              error.code === 'ECONNRESET'
            )
              return;
            usage?.finish(true, controller.signal.aborted);
            fail(error);
          }
        )
      );
      return {
        httpStatus: status,
        contentType,
        ...(requestRef ? { requestRef } : {}),
        body: bounded,
        ...(Buffer.isBuffer(body)
          ? {
              providerRequestEnvelopeHash: createHash('sha256')
                .update(body)
                .digest('hex'),
            }
          : {}),
        cancel: abort,
      };
    } catch (error) {
      await ticket?.failed().catch(() => undefined);
      usage?.finish(true, controller.signal.aborted);
      observeTransport(
        this.observe,
        responseReceived ? 'upstream_headers' : 'upstream_request',
        responseReceived,
        httpStatus,
        error
      );
      this.inferenceDenied = true;
      this.mayHaveDispatched = true;
      this.failure ??= {
        code: 'transport',
        effect: 'effect_unknown',
        ...(currentRequestRef ? { requestRef: currentRequestRef } : {}),
      };
      controller.abort();
      dispose();
      throw new Error('account_gateway_transport_unknown');
    }
  }

  private trackSettlement(promise: Promise<unknown>): void {
    this.pendingSettlements.add(promise);
    void promise
      .catch(() => undefined)
      .finally(() => this.pendingSettlements.delete(promise));
  }

  /** Explicit same-operation recovery only; neither method submits Responses. */
  recoverSameOperation(): Promise<GatewayReadback> {
    return this.json('POST', `${BASE}/recover`, {});
  }
  readRequest(requestRef: string): Promise<GatewayReadback> {
    if (!safeReference(requestRef))
      throw new Error('account_gateway_request_ref_invalid');
    return this.json(
      'GET',
      `${BASE}/requests/${encodeURIComponent(requestRef)}`
    );
  }

  async close(reason: GatewayCloseReason): Promise<GatewayReadback> {
    this.terminal = true;
    this.cancelHeldStreams();
    try {
      return await this.json('POST', `${BASE}/close`, { reason });
    } catch {
      return { httpStatus: 0, value: { state: 'unknown' } };
    }
  }

  cancelHeldStreams(): void {
    for (const controller of this.held) controller.abort();
  }
  cancelInference(): void {
    this.inferenceDenied = true;
    this.inferenceCancelled = true;
    this.cancelHeldStreams();
  }

  /** Required companion endpoint: current authorized run -> scoped SCM read only.
   * This is deliberately a product adapter request, not a new gateway protocol. */
  checkoutCapability(
    request: AccountGatewayCheckoutRequest,
    signal?: AbortSignal
  ): Promise<GatewayReadback> {
    return this.json(
      'POST',
      `${BASE}/checkout`,
      request,
      signal,
      ACCOUNT_GATEWAY_BOUNDS.checkoutV4JsonBytes
    );
  }

  providerApiCheckoutCapability(
    signal?: AbortSignal,
    mode: ProviderApiAuthMode = providerApiCheckoutCompanionContract.providerApiAuthMode
  ): Promise<GatewayReadback> {
    return this.json(
      'POST',
      providerApiCheckoutCompanionContract.path,
      {
        providerApiAuthMode: mode,
        workflowSchemaVersion:
          providerApiCheckoutCompanionContract.workflowSchemaVersion,
      },
      signal
    );
  }

  private async json(
    method: string,
    route: string,
    payload?: unknown,
    signal?: AbortSignal,
    maximumBytes: number = ACCOUNT_GATEWAY_BOUNDS.jsonBytes
  ): Promise<GatewayReadback> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(
      () => controller.abort(),
      ACCOUNT_GATEWAY_BOUNDS.controlMs
    );
    try {
      const response = await this.request(
        method,
        route,
        payload === undefined
          ? undefined
          : Buffer.from(JSON.stringify(payload)),
        controller.signal
      );
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          response.headers['content-type'] ?? ''
        )
      )
        throw new Error();
      const bytes = await boundedBytes(response, maximumBytes);
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      );
      if (
        bytes.length > ACCOUNT_GATEWAY_BOUNDS.jsonBytes &&
        !hasReviewerPlan(value)
      )
        throw new Error('account_gateway_legacy_checkout_too_large');
      return { httpStatus: response.statusCode ?? 0, value };
    } catch {
      throw new Error('account_gateway_readback_unknown');
    } finally {
      signal?.removeEventListener('abort', abort);
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async request(
    method: string,
    route: string,
    body: Buffer | Readable | undefined,
    signal: AbortSignal,
    onDispatch?: () => void,
    dispatchHeaders?: Readonly<Record<string, string>>
  ): Promise<IncomingMessage> {
    if (
      this.codexRoute &&
      (method !== 'POST' ||
        route !==
          (this.codexRoute.kind === 'subscription'
            ? new URL(CODEX_SUBSCRIPTION_RESPONSES_ROUTE.endpoint).pathname
            : HOSTED_POOL_CODEX_RESPONSES_PATH))
    )
      throw new Error('codex_prepared_control_route_denied');
    if (
      this.directProvider &&
      (method !== 'POST' ||
        route !==
          new URL(
            providerApiDescriptors[this.directProvider.mode ?? 'openrouter-api']
              .fixedResponsesUrl
          ).pathname)
    )
      throw new Error('provider_api_control_route_denied');
    const token = this.authorization();
    if (
      signal.aborted ||
      (this.codexRoute?.kind !== 'subscription' &&
        !/^[A-Za-z0-9._~-]{1,16377}$/.test(token))
    )
      throw new Error('account_gateway_authorization_unavailable');
    const nativeHeaders =
      this.codexRoute?.kind === 'subscription'
        ? codexSubscriptionResponsesHeaders({
            accessToken: token,
            accountId: this.codexRoute.accountId,
          })
        : undefined;
    const grant =
      this.codexRoute?.kind === 'hosted_pool'
        ? this.codexRoute.readGrant()
        : undefined;
    if (grant !== undefined && !/^[A-Za-z0-9._~-]{16,16384}$/.test(grant))
      throw new Error('hosted_model_grant_invalid');
    return await new Promise((resolve, reject) => {
      onDispatch?.();
      const request = (
        this.origin.protocol === 'https:' ? httpsRequest : httpRequest
      )(
        new URL(route, this.origin),
        {
          method,
          agent: false,
          signal,
          maxHeaderSize: ACCOUNT_GATEWAY_BOUNDS.headerBytes,
          headers: {
            ...(nativeHeaders ?? { authorization: `Bearer ${token}` }),
            ...(grant !== undefined
              ? { 'x-reviewrouter-hosted-grant': grant }
              : {}),
            ...(this.reviewerId
              ? { 'x-reviewrouter-reviewer-id': this.reviewerId }
              : {}),
            ...(this.directProvider
              ? {
                  'user-agent': 'ReviewRouter/1.0 provider-api',
                  'x-title': 'ReviewRouter',
                }
              : {}),
            ...(this.companionDispatch &&
            !dispatchHeaders &&
            !this.directProvider &&
            !this.codexRoute
              ? Object.fromEntries(
                  Object.entries(
                    lifecycleVerificationContract.dispatchHeaders
                  ).map(([key, header]) => [
                    header,
                    String(
                      this.companionDispatch![
                        key as keyof ReviewCompanionDispatchContextV1
                      ]
                    ),
                  ])
                )
              : {}),
            ...dispatchHeaders,
            'content-type': 'application/json',
            accept:
              this.codexRoute || route.endsWith('/responses')
                ? 'text/event-stream'
                : 'application/json',
            ...(Buffer.isBuffer(body)
              ? { 'content-length': String(body.length) }
              : {}),
          },
        },
        resolve
      );
      request.once('error', reject);
      if (body instanceof Readable) {
        // One upload only, with backpressure and cancellation in both directions.
        void pipeline(body, request, { signal }).catch(reject);
      } else request.end(body);
    });
  }
}

/** Codex may omit its default tier on the wire; the gateway requires it explicit. */
export function normalizeCodexGatewayServiceTier(bytes: Uint8Array): Buffer {
  const original = Buffer.from(bytes);
  if (original.length > ACCOUNT_GATEWAY_BOUNDS.requestBytes)
    throw new Error('account_gateway_request_bound');
  let parsed: unknown;
  try {
    parsed = JSON.parse(original.toString('utf8')) as unknown;
  } catch {
    return original;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.prototype.hasOwnProperty.call(parsed, 'service_tier')
  )
    return original;
  // Parse only to inspect the object shape. Reserializing would round JSON
  // numbers outside JavaScript's safe integer range and alter the wire request.
  const closingBrace = original.lastIndexOf(0x7d);
  const normalized = Buffer.concat([
    original.subarray(0, closingBrace),
    Buffer.from(
      `${Object.keys(parsed).length > 0 ? ',' : ''}"service_tier":"default"`
    ),
    original.subarray(closingBrace),
  ]);
  if (normalized.length > ACCOUNT_GATEWAY_BOUNDS.requestBytes)
    throw new Error('account_gateway_request_bound');
  return normalized;
}

/** Tiny per-run loopback adapter for CLI clients that capture auth once. Only
 * POST /responses exists; destinations/headers are never supplied by the CLI. */
export async function startLocalGatewayModelTransport(
  transport: AccountGatewayModelTransport,
  observe?: ObserveTransport,
  directProvider?: DirectProviderApiLimits
): Promise<LocalGatewayModelTransport> {
  const capability = randomBytes(32).toString('hex');
  let stopping = false;
  let inFlight = 0;
  let contextToolsGuard: (() => void) | undefined;
  let contextToolsFailure: GatewayFailureFact | undefined;
  const flights = new Set<Promise<unknown>>();
  let disposal: Promise<void> | undefined;
  const server = createServer(
    { maxHeaderSize: ACCOUNT_GATEWAY_BOUNDS.headerBytes },
    (request, reply) => {
      const handle = async () => {
        const header = request.headers.authorization;
        const expected = Buffer.from(`Bearer ${capability}`);
        const supplied = Buffer.from(header ?? '');
        if (
          stopping ||
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected) ||
          request.method !== 'POST' ||
          request.url !== '/responses' ||
          request.headers.host !== address ||
          request.headers['content-encoding'] !== undefined ||
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
            request.headers['content-type'] ?? ''
          )
        ) {
          reply.writeHead(403, { 'content-type': 'application/json' });
          reply.end(
            '{"error":{"code":"authorization_denied","effect":"not_dispatched"}}'
          );
          return;
        }
        try {
          contextToolsGuard?.();
        } catch {
          contextToolsFailure = {
            code: 'context_tools_unavailable',
            effect: 'not_dispatched',
          };
          request.resume();
          reply.writeHead(503, { 'content-type': 'application/json' });
          reply.end(
            '{"error":{"code":"context_tools_unavailable","effect":"not_dispatched"}}'
          );
          return;
        }
        if (inFlight >= ACCOUNT_GATEWAY_BOUNDS.inFlight) {
          reply.writeHead(503);
          reply.end();
          return;
        }
        inFlight++;
        const controller = new AbortController();
        let downstreamIdleExpired = false;
        const markSocketIdle = () => {
          downstreamIdleExpired = true;
        };
        request.socket.once('timeout', markSocketIdle);
        const abort = () => controller.abort();
        const downstreamClosed = () => {
          if (!reply.writableFinished) abort();
        };
        const timer = setTimeout(
          abort,
          directProvider?.requestMs ?? ACCOUNT_GATEWAY_BOUNDS.requestMs
        );
        request.once('aborted', abort);
        reply.once('close', downstreamClosed);
        let upstream: GatewayResponses | undefined;
        let stage: GatewayTransportDiagnostic['stage'] = 'request_body';
        try {
          const normalized = directProvider
            ? request
            : normalizeCodexGatewayServiceTier(
                await boundedBytes(
                  request,
                  ACCOUNT_GATEWAY_BOUNDS.requestBytes,
                  controller.signal
                )
              );
          stage = 'upstream_request';
          upstream = await transport.responses(normalized, controller.signal);
          stage = 'downstream_stream';
          reply.writeHead(upstream.httpStatus, {
            'content-type': upstream.contentType,
            'cache-control': 'no-store',
            ...(upstream.requestRef
              ? { 'x-reviewrouter-request-ref': upstream.requestRef }
              : {}),
          });
          await pipeline(upstream.body, reply, { signal: controller.signal });
        } catch (error) {
          // The transport owns upstream receipt facts, including pre-request guards.
          if (stage !== 'upstream_request')
            observeTransport(
              observe,
              stage,
              upstream !== undefined,
              upstream?.httpStatus ?? null,
              error,
              { downstreamIdleExpired }
            );
          if (reply.headersSent) reply.destroy();
          else {
            reply.writeHead(502, { 'content-type': 'application/json' });
            reply.end(
              '{"error":{"code":"relay_unknown","effect":"effect_unknown"}}'
            );
          }
        } finally {
          if (!reply.writableFinished) upstream?.cancel();
          clearTimeout(timer);
          request.removeListener('aborted', abort);
          request.socket.removeListener('timeout', markSocketIdle);
          reply.removeListener('close', downstreamClosed);
          inFlight--;
        }
      };
      const flight = handle();
      flights.add(flight);
      void flight
        .catch(() => reply.destroy())
        .finally(() => flights.delete(flight));
    }
  );
  server.maxConnections = ACCOUNT_GATEWAY_BOUNDS.localConnections;
  server.maxRequestsPerSocket = 1;
  server.headersTimeout = 10_000;
  server.requestTimeout =
    directProvider?.requestMs ?? ACCOUNT_GATEWAY_BOUNDS.requestMs;
  server.keepAliveTimeout = 1_000;
  server.setTimeout(ACCOUNT_GATEWAY_BOUNDS.idleMs, (socket) =>
    socket.destroy()
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const bound = server.address();
  if (!bound || typeof bound === 'string') {
    server.close();
    throw new Error('account_gateway_loopback_unavailable');
  }
  const address = `127.0.0.1:${bound.port}`;
  const baseUrl = `http://${address}`;
  return Object.freeze({
    baseUrl,
    environment: Object.freeze({
      [LOCAL_MODEL_CAPABILITY_ENV]: `Bearer ${capability}`,
    }),
    configuration: directProvider
      ? codexGatewayConfiguration(baseUrl)
          .filter(
            (setting) =>
              directProvider.mode !== 'kimi-code-api' ||
              !setting.startsWith('service_tier=')
          )
          .map((setting) =>
            setting
              .replaceAll(
                'reviewrouter_account_gateway',
                directProvider.mode === 'mimo-token-plan-api'
                  ? 'mimo'
                  : directProvider.mode === 'kimi-code-api'
                    ? 'kimi'
                    : 'openrouter'
              )
              .replaceAll(
                'ReviewRouter account gateway',
                'ReviewRouter provider API'
              )
          )
      : codexGatewayConfiguration(baseUrl),
    actualModel: () => transport.actualModel,
    requestCount: () => transport.requestCount,
    failureFact: () => contextToolsFailure ?? transport.lastFailure,
    releaseRetrySafeFailure: () => transport.releaseRetrySafeFailure(),
    reopenConsumer: () => transport.reopenConsumer(),
    setContextToolsGuard: (guard: (() => void) | undefined) => {
      contextToolsGuard = guard;
      transport.setContextToolsGuard(guard);
    },
    beginInvocation: (scope) => transport.beginInvocation(scope),
    generatePrDescription: (input) => transport.generatePrDescription(input),
    generateLifecycleVerification: (input) => {
      const flight = transport.generateLifecycleVerification(input);
      flights.add(flight);
      void flight.catch(() => undefined).finally(() => flights.delete(flight));
      return flight;
    },
    dispose() {
      disposal ??= (async () => {
        stopping = true;
        transport.cancelInference();
        server.closeAllConnections();
        await Promise.allSettled([...flights]);
        await transport.drainSettlements();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      })();
      return disposal;
    },
  });
}

/** Fixed upstream, local credential and passive wire evidence. No Gateway control API. */
export function startDirectOpenRouterModelTransport(
  credential: () => string,
  limits: DirectProviderApiLimits
): Promise<LocalGatewayModelTransport> {
  return startDirectProviderApiModelTransport(
    'openrouter-api',
    credential,
    limits
  );
}

/** Closed native Responses destinations; callers supply only an approved mode. */
export function startDirectProviderApiModelTransport(
  mode: ProviderApiAuthMode,
  credential: () => string,
  limits: DirectProviderApiLimits
): Promise<LocalGatewayModelTransport> {
  if (
    !Number.isSafeInteger(limits.requestMs) ||
    limits.requestMs < 1 ||
    !Number.isSafeInteger(limits.streamFrameBytes) ||
    limits.streamFrameBytes < 1
  )
    throw new Error('provider_api_limits_invalid');
  return startLocalGatewayModelTransport(
    new AccountGatewayModelTransport(
      new URL(providerApiDescriptors[mode].fixedResponsesUrl).origin,
      credential,
      undefined,
      { ...limits, mode }
    ),
    undefined,
    { ...limits, mode }
  );
}

/** Repository-owned OAuth uses the already refreshed official credential. No
 * login, account selection, API-key conversion, auth retry or hidden fallback. */
export function startRunnerLocalCodexSubscriptionModelTransport(input: {
  readonly credential: Readonly<{
    accessToken: string;
    accountId: string;
    credentialValidUntil: number;
  }>;
  readonly modelDispatch: PreparedModelDispatch;
  readonly reasoningEffort?: string | null;
  readonly signal?: AbortSignal;
}): Promise<LocalGatewayModelTransport> {
  input.signal?.throwIfAborted();
  const deadline = validatePreparedCodexRoute(
    input.modelDispatch,
    'runner_local_responses'
  );
  if (
    !Number.isSafeInteger(input.credential.credentialValidUntil) ||
    input.credential.credentialValidUntil < deadline + 60_000
  )
    throw new Error('codex_prepared_credential_lifetime_invalid');
  const accountId = input.credential.accountId;
  let accessToken = input.credential.accessToken;
  codexSubscriptionResponsesHeaders({ accessToken, accountId });
  return startPreparedCodexModelTransport({
    apiUrl: new URL(CODEX_SUBSCRIPTION_RESPONSES_ROUTE.endpoint).origin,
    authorization: () => accessToken,
    route: {
      kind: 'subscription',
      accountId,
      modelDispatch: input.modelDispatch,
      reasoningEffort: input.reasoningEffort ?? null,
      signal: input.signal,
    },
    cleanupCredential: () => {
      accessToken = '';
    },
  });
}

/** Hosted custody and its original grant remain on the existing relay. The
 * captured capability deadline already includes that grant's original expiry. */
export function startHostedPoolCodexModelTransport(input: {
  readonly apiUrl: string;
  readonly authorization: () => string;
  readonly readGrant: () => string;
  readonly modelDispatch: PreparedModelDispatch;
  readonly reasoningEffort?: string | null;
  readonly signal?: AbortSignal;
}): Promise<LocalGatewayModelTransport> {
  validatePreparedCodexRoute(input.modelDispatch, 'hosted_pool');
  input.signal?.throwIfAborted();
  let grant = input.readGrant();
  if (!/^[A-Za-z0-9._~-]{16,16384}$/.test(grant))
    throw new Error('hosted_model_grant_invalid');
  return startPreparedCodexModelTransport({
    apiUrl: input.apiUrl,
    authorization: input.authorization,
    route: {
      kind: 'hosted_pool',
      readGrant: () => grant,
      modelDispatch: input.modelDispatch,
      reasoningEffort: input.reasoningEffort ?? null,
      signal: input.signal,
    },
    cleanupCredential: () => {
      grant = '';
    },
  });
}

function validatePreparedCodexRoute(
  dispatch: PreparedModelDispatch,
  transport: 'runner_local_responses' | 'hosted_pool'
): number {
  const cap = dispatch.capability;
  const deadline = Date.parse(cap.deadline);
  if (
    cap.transport !== transport ||
    cap.wireProtocol !== 'codex-responses' ||
    cap.outputTokenLimit !== 'terminal_acceptance' ||
    !Number.isSafeInteger(deadline) ||
    deadline <= Date.now()
  )
    throw new Error('codex_prepared_route_invalid');
  return deadline;
}

async function startPreparedCodexModelTransport(input: {
  readonly apiUrl: string;
  readonly authorization: () => string;
  readonly route: PreparedCodexResponsesRoute;
  readonly cleanupCredential: () => void;
}): Promise<LocalGatewayModelTransport> {
  let bridge: LocalGatewayModelTransport | undefined;
  let removeAbort: () => void = () => {};
  try {
    input.route.signal?.throwIfAborted();
    const transport = new AccountGatewayModelTransport(
      input.apiUrl,
      input.authorization,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      input.route
    );
    bridge = await startLocalGatewayModelTransport(transport);
    const abort = () => transport.cancelInference();
    input.route.signal?.addEventListener('abort', abort, { once: true });
    removeAbort = () => input.route.signal?.removeEventListener('abort', abort);
    input.route.signal?.throwIfAborted();
    let disposal: Promise<void> | undefined;
    const prepared = bridge;
    return Object.freeze({
      ...prepared,
      protocol: 'openai-responses' as const,
      encodeLifecycleRequest: (semantic) =>
        encodeCodexSubscriptionVerificationRequest({
          ...semantic,
          reasoningEffort: input.route.reasoningEffort,
        }).requestBytes,
      dispose: () => {
        disposal ??= (async () => {
          removeAbort();
          try {
            await prepared.dispose();
          } finally {
            input.cleanupCredential();
          }
        })();
        return disposal;
      },
    });
  } catch (error) {
    removeAbort();
    try {
      await bridge?.dispose();
    } finally {
      input.cleanupCredential();
    }
    throw error;
  }
}

/** Verified in rust-v0.147.0 model-provider-info/src/lib.rs + codex-client/src/retry.rs.
 * Zero means one initial HTTP attempt. No auth recovery or websocket transport. */
export function codexGatewayConfiguration(baseUrl: string): readonly string[] {
  if (
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(baseUrl) ||
    Number(new URL(baseUrl).port) > 65535
  )
    throw new Error('account_gateway_loopback_invalid');
  return Object.freeze([
    'model_provider="reviewrouter_account_gateway"',
    // Replace the provider table so user/project entries cannot add headers/auth.
    `model_providers={reviewrouter_account_gateway={name="ReviewRouter account gateway",base_url=${JSON.stringify(baseUrl)},wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0,stream_idle_timeout_ms=${ACCOUNT_GATEWAY_BOUNDS.idleMs},env_http_headers={Authorization="${LOCAL_MODEL_CAPABILITY_ENV}"}}}`,
    'cli_auth_credentials_store="ephemeral"',
    'agents.enabled=false',
    'service_tier="default"',
    'web_search="disabled"',
  ]);
}

function trustedGatewayOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('account_gateway_api_origin_invalid');
  return url;
}
async function boundedBytes(
  body: Readable,
  maximum: number,
  signal?: AbortSignal
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  const abort = () => body.destroy(new Error('account_gateway_cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    for await (const raw of body) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      length += chunk.length;
      if (length > maximum) {
        body.destroy();
        throw new Error('account_gateway_body_bound');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
function safeReference(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{1,200}$/.test(value)
    ? value
    : undefined;
}
function saturationDenial(bytes: Buffer, codes: readonly string[]): boolean {
  try {
    // Closed JSON envelope: no extra fields, duplicate keys or requestRef.
    const space = '[ \\t\\r\\n]*';
    const code = `"code"${space}:${space}"(?:${codes.join('|')})"`;
    const effect = `"effect"${space}:${space}"not_dispatched"`;
    return new RegExp(
      `^${space}\\{${space}"error"${space}:${space}\\{${space}(?:${code}${space},${space}${effect}|${effect}${space},${space}${code})${space}\\}${space}\\}${space}$`
    ).test(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return false;
  }
}
function failureFact(
  bytes: Buffer,
  ref?: string
): GatewayFailureFact | undefined {
  try {
    const raw: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    );
    if (!raw || typeof raw !== 'object' || !('error' in raw)) return undefined;
    const error: unknown = raw.error;
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      !('effect' in error)
    )
      return undefined;
    const code = safeReference(error.code);
    const effect = safeReference(error.effect);
    const requestRef =
      'requestRef' in error ? safeReference(error.requestRef) : ref;
    return code && effect
      ? {
          code,
          effect,
          ...(requestRef ? { requestRef } : {}),
          ...('failureScope' in error &&
          ['reviewer', 'allocation', 'run'].includes(String(error.failureScope))
            ? {
                failureScope: error.failureScope as
                  | 'reviewer'
                  | 'allocation'
                  | 'run',
              }
            : {}),
          ...('concurrencyGroupId' in error &&
          safeReference(error.concurrencyGroupId)
            ? { concurrencyGroupId: safeReference(error.concurrencyGroupId)! }
            : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Passive bounded SSE terminal/model evidence. Codex 0.147 ignores the ordinary
 * response.model field; T0 context attestation needs wire evidence instead of a
 * configured-model guess. This observer never changes a payload or tool event. */
function responsesStreamAudit(
  observe: (model: string | undefined) => void,
  maximumFrameBytes: number = ACCOUNT_GATEWAY_BOUNDS.streamFrameBytes,
  observeUsage?: (frame: unknown) => void,
  observeCompleted?: (response: unknown) => void,
  strictTerminal = false
) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '';
  let skipLf = false;
  let data: string[] = [];
  let event = '';
  let completed = false;
  let frameBytes = 0;
  let rawLineBytes = 0;
  let rawLineLastByte = 0;
  function endLine() {
    if (!line) {
      if (data.length) {
        const joined = data.join('\n');
        if (joined !== '[DONE]') {
          if (strictTerminal && completed) throw new Error();
          const raw: unknown = JSON.parse(joined);
          if (
            !raw ||
            typeof raw !== 'object' ||
            !('type' in raw) ||
            typeof raw.type !== 'string'
          )
            throw new Error();
          if (event && event !== raw.type) throw new Error();
          observeUsage?.(raw);
          if (raw.type === 'response.completed') {
            if (
              completed ||
              !('response' in raw) ||
              !raw.response ||
              typeof raw.response !== 'object'
            )
              throw new Error();
            completed = true;
            const response = raw.response;
            const model =
              'model' in response &&
              typeof response.model === 'string' &&
              /^[A-Za-z0-9._:/@+-]{1,200}$/.test(response.model)
                ? response.model
                : undefined;
            observe(model);
            observeCompleted?.(response);
          } else if (
            raw.type === 'response.failed' ||
            raw.type === 'response.incomplete' ||
            raw.type === 'error'
          )
            throw new Error();
        }
      }
      data = [];
      event = '';
    } else if (line.startsWith('data:'))
      data.push(line.slice(5).replace(/^ /, ''));
    else if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '');
    line = '';
  }
  function consume(text: string) {
    for (const character of text) {
      if (skipLf && character === '\n') {
        skipLf = false;
        continue;
      }
      skipLf = false;
      if (character === '\r' || character === '\n') {
        endLine();
        skipLf = character === '\r';
      } else line += character;
    }
  }
  return {
    hasCompleted: () => completed,
    accept(bytes: Uint8Array) {
      // Match the native raw SSE budget: LF/CRLF separators and comments count
      // toward the current event before its terminating blank line resets it.
      for (const byte of bytes) {
        frameBytes++;
        if (frameBytes > maximumFrameBytes)
          throw new Error('account_gateway_stream_frame_bound');
        if (byte === 0x0a) {
          if (
            rawLineBytes === 0 ||
            (rawLineBytes === 1 && rawLineLastByte === 0x0d)
          )
            frameBytes = 0;
          rawLineBytes = 0;
        } else {
          rawLineBytes++;
          rawLineLastByte = byte;
        }
      }
      consume(decoder.decode(bytes, { stream: true }));
    },
    finish() {
      consume(decoder.decode());
      if (line || data.length || !completed) throw new Error();
    },
  };
}

function terminalUsage(value: unknown): {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
} {
  const usage = (value as { usage?: Record<string, unknown> } | null)?.usage;
  const integer = (raw: unknown): number | null =>
    typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
      ? raw
      : null;
  const inputTokens = integer(usage?.input_tokens);
  const outputTokens = integer(usage?.output_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      integer(usage?.total_tokens) ??
      (inputTokens !== null && outputTokens !== null
        ? inputTokens + outputTokens
        : null),
  };
}

function completedPrDescriptionText(
  raw: unknown,
  maxBytes: number = prDescriptionContract.maxGeneratedMarkdownBytes,
  rejectReservedMarker = true
): string {
  const response = raw as { status?: unknown; output?: unknown } | null;
  if (response?.status !== 'completed' || !Array.isArray(response.output))
    throw new Error('pr_description_output_invalid');
  const parts: string[] = [];
  let bytes = 0;
  for (const item of response.output) {
    if (!item || typeof item !== 'object')
      throw new Error('pr_description_output_invalid');
    if (item.type === 'reasoning') continue;
    if (
      item.type !== 'message' ||
      item.role !== 'assistant' ||
      !Array.isArray(item.content)
    )
      throw new Error('pr_description_output_invalid');
    for (const content of item.content) {
      if (content?.type !== 'output_text' || typeof content.text !== 'string')
        throw new Error('pr_description_output_invalid');
      bytes += Buffer.byteLength(content.text, 'utf8');
      if (bytes > maxBytes) throw new Error('pr_description_output_bound');
      parts.push(content.text);
    }
  }
  const markdown = parts.join('').trim();
  if (!markdown) throw new Error('pr_description_output_empty');
  if (rejectReservedMarker && hasOwnedPrDescriptionMarker(markdown))
    throw new Error('pr_description_output_reserved_marker');
  return markdown;
}

function isPrDescriptionMessageInput(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const message = value[0] as Record<string, unknown> | null;
  if (
    !message ||
    typeof message !== 'object' ||
    Array.isArray(message) ||
    Object.keys(message).sort().join(',') !== 'content,role' ||
    message.role !== 'user' ||
    !Array.isArray(message.content) ||
    message.content.length !== 1
  )
    return false;
  const content = message.content[0] as Record<string, unknown> | null;
  return (
    !!content &&
    typeof content === 'object' &&
    !Array.isArray(content) &&
    Object.keys(content).sort().join(',') === 'text,type' &&
    content.type === 'input_text' &&
    typeof content.text === 'string'
  );
}

function hasReviewerPlan(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('runtimeConfig' in value))
    return false;
  const runtimeConfig = value.runtimeConfig;
  if (
    !runtimeConfig ||
    typeof runtimeConfig !== 'object' ||
    !('runtimeEnv' in runtimeConfig)
  )
    return false;
  const env = runtimeConfig.runtimeEnv;
  return (
    !!env &&
    typeof env === 'object' &&
    'REVIEW_ROUTER_REVIEWER_PLAN_JSON' in env &&
    typeof env.REVIEW_ROUTER_REVIEWER_PLAN_JSON === 'string'
  );
}
