import { randomBytes, timingSafeEqual } from 'crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
} from 'http';
import { request as httpsRequest } from 'https';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';

const BASE = '/api/action/v2/account-gateway';
export const LOCAL_MODEL_CAPABILITY_ENV = 'REVIEWROUTER_LOCAL_MODEL_TOKEN';
// Enforced consumer ceilings; production qualification belongs to D-final.
export const ACCOUNT_GATEWAY_BOUNDS = Object.freeze({
  requestBytes: 16_777_216,
  outputBytes: 1_048_576,
  jsonBytes: 65_536,
  headerBytes: 16_384,
  bufferBytes: 65_536,
  requestMs: 3_600_000,
  idleMs: 60_000,
  controlMs: 30_000,
  inFlight: 1,
  localConnections: 4,
  cliOutputBytes: 8_388_608,
});

export type GatewayReadback = Readonly<{ httpStatus: number; value: unknown }>;
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
export type LocalGatewayModelTransport = Readonly<{
  baseUrl: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  configuration: readonly string[];
  actualModel(): string | undefined;
  dispose(): Promise<void>;
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
    private readonly authorization: () => string
  ) {
    this.origin = trustedGatewayOrigin(apiUrl);
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

  async responses(
    bytes: Uint8Array,
    signal?: AbortSignal
  ): Promise<GatewayResponses> {
    if (
      this.terminal ||
      this.inferenceDenied ||
      this.held.size >= ACCOUNT_GATEWAY_BOUNDS.inFlight
    ) {
      throw new Error('account_gateway_inference_denied');
    }
    // Snapshot before awaiting authorization; no mutable caller payload.
    const body = Buffer.from(bytes);
    if (body.length > ACCOUNT_GATEWAY_BOUNDS.requestBytes)
      throw new Error('account_gateway_request_bound');
    const controller = new AbortController();
    this.held.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, ACCOUNT_GATEWAY_BOUNDS.requestMs);
    const dispose = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.held.delete(controller);
    };
    try {
      const response = await this.request(
        'POST',
        `${BASE}/responses`,
        body,
        controller.signal
      );
      const status = response.statusCode ?? 502;
      const contentType = response.headers['content-type'] ?? '';
      const requestRef = safeReference(
        response.headers['x-reviewrouter-request-ref']
      );
      if (requestRef) this.requestRef = requestRef;
      const isStream =
        status === 200 && /^text\/event-stream(?:\s*;.*)?$/i.test(contentType);
      // Even pending/LOCAL busy is terminal to this consumer. The RR server alone waits.
      if (!isStream) this.inferenceDenied = true;
      if (status === 200 && !isStream)
        throw new Error('account_gateway_invalid_stream');
      let count = 0;
      const diagnostic: Buffer[] = [];
      const audit = isStream
        ? responsesStreamAudit((model) => {
            if (
              !model ||
              (this.observedModel !== undefined && this.observedModel !== model)
            )
              this.modelUncertain = true;
            else this.observedModel = model;
          })
        : undefined;
      const bounded = new Transform({
        highWaterMark: ACCOUNT_GATEWAY_BOUNDS.bufferBytes,
        transform: (chunk: Buffer, _encoding, done) => {
          count += chunk.length;
          const maximum = isStream
            ? ACCOUNT_GATEWAY_BOUNDS.outputBytes
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
      response.setTimeout(ACCOUNT_GATEWAY_BOUNDS.idleMs, abort);
      const fail = () => {
        this.inferenceDenied = true;
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
      void pipeline(response, bounded, { signal: controller.signal }).then(
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
        fail
      );
      return {
        httpStatus: status,
        contentType,
        ...(requestRef ? { requestRef } : {}),
        body: bounded,
        cancel: abort,
      };
    } catch {
      this.inferenceDenied = true;
      this.failure ??= { code: 'transport', effect: 'effect_unknown' };
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
    request: Readonly<Record<string, never>>,
    signal?: AbortSignal
  ): Promise<GatewayReadback> {
    return this.json('POST', `${BASE}/checkout`, request, signal);
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
    body: Buffer | undefined,
    signal: AbortSignal
  ): Promise<IncomingMessage> {
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
            ...(body ? { 'content-length': String(body.length) } : {}),
          },
        },
        resolve
      );
      request.once('error', reject);
      request.end(body);
    });
  }
}

/** Tiny per-run loopback adapter for CLI clients that capture auth once. Only
 * POST /responses exists; destinations/headers are never supplied by the CLI. */
export async function startLocalGatewayModelTransport(
  transport: AccountGatewayModelTransport
): Promise<LocalGatewayModelTransport> {
  const capability = randomBytes(32).toString('hex');
  let stopping = false;
  let inFlight = 0;
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
        const abort = () => controller.abort();
        const downstreamClosed = () => {
          if (!reply.writableFinished) abort();
        };
        const timer = setTimeout(abort, ACCOUNT_GATEWAY_BOUNDS.requestMs);
        request.once('aborted', abort);
        reply.once('close', downstreamClosed);
        let upstream: GatewayResponses | undefined;
        try {
          const bytes = await boundedBytes(
            request,
            ACCOUNT_GATEWAY_BOUNDS.requestBytes,
            controller.signal
          );
          upstream = await transport.responses(bytes, controller.signal);
          reply.writeHead(upstream.httpStatus, {
            'content-type': upstream.contentType,
            'cache-control': 'no-store',
            ...(upstream.requestRef
              ? { 'x-reviewrouter-request-ref': upstream.requestRef }
              : {}),
          });
          await pipeline(upstream.body, reply, { signal: controller.signal });
        } catch {
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
  server.requestTimeout = ACCOUNT_GATEWAY_BOUNDS.requestMs;
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
    configuration: codexGatewayConfiguration(baseUrl),
    actualModel: () => transport.actualModel,
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
    'service_tier="default"',
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
function responsesStreamAudit(observe: (model: string | undefined) => void) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '';
  let skipLf = false;
  let data: string[] = [];
  let event = '';
  let completed = false;
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
    accept(bytes: Uint8Array) {
      consume(decoder.decode(bytes, { stream: true }));
    },
    finish() {
      consume(decoder.decode());
      if (line || data.length || !completed) throw new Error();
    },
  };
}
