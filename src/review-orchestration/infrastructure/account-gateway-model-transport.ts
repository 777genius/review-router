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
  prDescriptionContract,
} from '../../control-plane/generated/review-action-v2/companion-contracts';
import { setTimeout as wait } from 'timers/promises';

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
}>;
export type GatewayResponses = Readonly<{
  httpStatus: number;
  contentType: string;
  requestRef?: string;
  body: Readable;
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
type DirectOpenRouterLimits = Readonly<{
  requestMs: number;
  streamFrameBytes: number;
}>;
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
  baseUrl: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  configuration: readonly string[];
  actualModel(): string | undefined;
  /** Dispatched model-request observations (upstream relay attempts). Additive
   * run evidence only: a managed engine may not claim success with zero model
   * requests, so acceptance reads this instead of guessing from exit status. */
  requestCount?(): number;
  failureFact(): GatewayFailureFact | undefined;
  /** Trusted parent only; its receipt never contributes review-engine evidence. */
  generatePrDescription?(input: {
    requestBody: Uint8Array;
    signal: AbortSignal;
  }): Promise<PrDescriptionModelReceipt>;
  dispose(): Promise<void>;
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
  private terminal = false;
  private failure?: GatewayFailureFact;
  private requestRef?: string;
  private observedModel?: string;
  private modelUncertain = false;

  constructor(
    apiUrl: string,
    private readonly authorization: () => string,
    private readonly observe?: ObserveTransport,
    private readonly directOpenRouter?: DirectOpenRouterLimits,
    private readonly auxiliaryDescription: boolean = false,
    private readonly completedDescriptionResponse?: (response: unknown) => void
  ) {
    this.origin = trustedGatewayOrigin(apiUrl);
    if (directOpenRouter && this.origin.origin !== 'https://openrouter.ai')
      throw new Error('provider_api_origin_invalid');
  }

  get lastFailure(): GatewayFailureFact | undefined {
    return this.failure;
  }
  get lastRequestRef(): string | undefined {
    return this.requestRef;
  }
  get actualModel(): string | undefined {
    return this.inferenceDenied || this.modelUncertain
      ? undefined
      : this.observedModel;
  }

  async generatePrDescription(input: {
    requestBody: Uint8Array;
    signal: AbortSignal;
  }): Promise<PrDescriptionModelReceipt> {
    input.signal.throwIfAborted();
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
      typeof request.input !== 'string' ||
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
      this.directOpenRouter,
      true,
      (response) => {
        markdown = completedPrDescriptionText(response);
      }
    );
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

  async responses(
    bytes: Uint8Array | Readable,
    signal?: AbortSignal
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
    // Snapshot before awaiting authorization; no mutable caller payload.
    const body =
      this.directOpenRouter && bytes instanceof Readable
        ? bytes
        : Buffer.from(bytes as Uint8Array);
    if (
      !this.directOpenRouter &&
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
    if (signal?.aborted) abort();
    const timer = setTimeout(
      abort,
      this.directOpenRouter?.requestMs ?? ACCOUNT_GATEWAY_BOUNDS.requestMs
    );
    const dispose = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.held.delete(controller);
    };
    let responseReceived = false;
    let httpStatus: number | null = null;
    let currentRequestRef: string | undefined;
    try {
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
          this.directOpenRouter ? '/api/v1/responses' : `${BASE}/responses`,
          body,
          controller.signal
        );
        responseReceived = true;
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
          !this.directOpenRouter &&
          !this.auxiliaryDescription &&
          httpStatus === 503 &&
          !referenced &&
          /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
            response.headers['content-type'] ?? ''
          ) &&
          denial !== undefined &&
          relaySaturated(denial)
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
              : this.directOpenRouter?.streamFrameBytes,
            this.completedDescriptionResponse
          )
        : undefined;
      const bounded = new Transform({
        highWaterMark: ACCOUNT_GATEWAY_BOUNDS.bufferBytes,
        transform: (chunk: Buffer, _encoding, done) => {
          count += chunk.length;
          const maximum = isStream
            ? this.directOpenRouter && !this.auxiliaryDescription
              ? Infinity
              : ACCOUNT_GATEWAY_BOUNDS.streamOutputBytes
            : ACCOUNT_GATEWAY_BOUNDS.jsonBytes;
          if (count > maximum) done(new Error('account_gateway_output_bound'));
          else
            try {
              audit?.accept(chunk);
              if (!isStream) diagnostic.push(chunk);
              done(null, chunk); // Always the original bytes, no conversion.
            } catch {
              done(new Error('account_gateway_stream_unknown'));
            }
        },
        flush: (done) => {
          try {
            audit?.finish();
            done();
          } catch {
            done(new Error('account_gateway_stream_unknown'));
          }
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
      void pipeline(isStream ? response : Readable.from([denial!]), bounded, {
        signal: controller.signal,
      }).then(
        () => {
          if (!isStream) {
            this.failure = failureFact(
              Buffer.concat(diagnostic),
              requestRef
            ) ?? {
              code: status === 202 ? 'pending' : 'relay_unknown',
              effect: 'effect_unknown',
              ...(requestRef ? { requestRef } : {}),
            };
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
          fail(error);
        }
      );
      return {
        httpStatus: status,
        contentType,
        ...(requestRef ? { requestRef } : {}),
        body: bounded,
        cancel: abort,
      };
    } catch (error) {
      observeTransport(
        this.observe,
        responseReceived ? 'upstream_headers' : 'upstream_request',
        responseReceived,
        httpStatus,
        error
      );
      this.inferenceDenied = true;
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
    this.cancelHeldStreams();
  }

  /** Required companion endpoint: current authorized run -> scoped SCM read only.
   * This is deliberately a product adapter request, not a new gateway protocol. */
  checkoutCapability(
    request: AccountGatewayCheckoutRequest,
    signal?: AbortSignal
  ): Promise<GatewayReadback> {
    return this.json('POST', `${BASE}/checkout`, request, signal);
  }

  providerApiCheckoutCapability(
    signal?: AbortSignal
  ): Promise<GatewayReadback> {
    const { path: route, ...request } = providerApiCheckoutCompanionContract;
    return this.json('POST', route, request, signal);
  }

  private async json(
    method: string,
    route: string,
    payload?: unknown,
    signal?: AbortSignal
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
      const bytes = await boundedBytes(
        response,
        ACCOUNT_GATEWAY_BOUNDS.jsonBytes
      );
      return {
        httpStatus: response.statusCode ?? 0,
        value: JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        ) as unknown,
      };
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
    signal: AbortSignal
  ): Promise<IncomingMessage> {
    if (
      this.directOpenRouter &&
      (method !== 'POST' || route !== '/api/v1/responses')
    )
      throw new Error('provider_api_control_route_denied');
    const token = this.authorization();
    if (signal.aborted || !/^[A-Za-z0-9._~-]{1,16377}$/.test(token))
      throw new Error('account_gateway_authorization_unavailable');
    return await new Promise((resolve, reject) => {
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
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: route.endsWith('/responses')
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
  directOpenRouter?: DirectOpenRouterLimits
): Promise<LocalGatewayModelTransport> {
  const capability = randomBytes(32).toString('hex');
  let stopping = false;
  let inFlight = 0;
  let dispatchedRequests = 0;
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
          directOpenRouter?.requestMs ?? ACCOUNT_GATEWAY_BOUNDS.requestMs
        );
        request.once('aborted', abort);
        reply.once('close', downstreamClosed);
        let upstream: GatewayResponses | undefined;
        let stage: GatewayTransportDiagnostic['stage'] = 'request_body';
        try {
          const normalized = directOpenRouter
            ? request
            : normalizeCodexGatewayServiceTier(
                await boundedBytes(
                  request,
                  ACCOUNT_GATEWAY_BOUNDS.requestBytes,
                  controller.signal
                )
              );
          stage = 'upstream_request';
          dispatchedRequests++;
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
      void handle().catch(() => reply.destroy());
    }
  );
  server.maxConnections = ACCOUNT_GATEWAY_BOUNDS.localConnections;
  server.maxRequestsPerSocket = 1;
  server.headersTimeout = 10_000;
  server.requestTimeout =
    directOpenRouter?.requestMs ?? ACCOUNT_GATEWAY_BOUNDS.requestMs;
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
    configuration: directOpenRouter
      ? codexGatewayConfiguration(baseUrl).map((setting) =>
          setting
            .replaceAll('reviewrouter_account_gateway', 'openrouter')
            .replaceAll('ReviewRouter account gateway', 'OpenRouter')
        )
      : codexGatewayConfiguration(baseUrl),
    actualModel: () => transport.actualModel,
    requestCount: () => dispatchedRequests,
    failureFact: () => transport.lastFailure,
    generatePrDescription: (input) => transport.generatePrDescription(input),
    async dispose() {
      stopping = true;
      transport.cancelHeldStreams();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  });
}

/** Fixed upstream, local credential and passive wire evidence. No Gateway control API. */
export function startDirectOpenRouterModelTransport(
  credential: () => string,
  limits: DirectOpenRouterLimits
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
      'https://openrouter.ai',
      credential,
      undefined,
      limits
    ),
    undefined,
    limits
  );
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
function relaySaturated(bytes: Buffer): boolean {
  try {
    // Closed JSON envelope: no extra fields, duplicate keys or requestRef.
    const space = '[ \\t\\r\\n]*';
    const code = `"code"${space}:${space}"relay_saturated"`;
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
      ? { code, effect, ...(requestRef ? { requestRef } : {}) }
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
  observeCompleted?: (response: unknown) => void
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
          const raw: unknown = JSON.parse(joined);
          if (
            !raw ||
            typeof raw !== 'object' ||
            !('type' in raw) ||
            typeof raw.type !== 'string'
          )
            throw new Error();
          if (event && event !== raw.type) throw new Error();
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

function completedPrDescriptionText(raw: unknown): string {
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
      if (bytes > prDescriptionContract.maxGeneratedMarkdownBytes)
        throw new Error('pr_description_output_bound');
      parts.push(content.text);
    }
  }
  const markdown = parts.join('').trim();
  if (!markdown) throw new Error('pr_description_output_empty');
  if (hasOwnedPrDescriptionMarker(markdown))
    throw new Error('pr_description_output_reserved_marker');
  return markdown;
}
