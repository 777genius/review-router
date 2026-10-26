import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { createServer } from 'http';
import { TextDecoder } from 'util';
import {
  isClaudeSubscriptionSetupToken,
  type ClaudeSubscriptionCredentialLifetime,
} from '../../providers/claude-subscription-credential';
import {
  LOCAL_MODEL_CAPABILITY_ENV,
  type GatewayFailureFact,
  type LocalGatewayModelTransport,
} from './account-gateway-model-transport';
import {
  PreparedModelDispatch,
  type PreparedModelDispatchTicket,
  type PreparedModelInvocationScope,
} from './prepared-model-dispatch';
import {
  anthropicReasoningEffort,
  decodeAnthropicMessagesResponse,
  encodeAnthropicVerificationRequest,
} from './anthropic-messages-codec';

/** Immutable candidate wire contract. Its owning producer must qualify real
 * subscription compatibility separately; a fixture never grants that authority.
 * No official-client identity headers or system prompt are impersonated. */
export const RUNNER_LOCAL_ANTHROPIC_ROUTE = Object.freeze({
  descriptor: 'claude-subscription-messages.v1',
  endpoint: 'https://api.anthropic.com/v1/messages',
  version: '2023-06-01',
  beta: 'oauth-2025-04-20',
  userAgent: 'reviewrouter/ocr-native-v1',
});

/** One already selected account/model. The adapter cannot select or refresh an
 * account, create budgets, retry requests, or publish review results. */
export async function startRunnerLocalAnthropicModelTransport(input: {
  readonly readToken: () => string | Promise<string>;
  readonly modelDispatch: PreparedModelDispatch;
  readonly credentialLifetime: ClaudeSubscriptionCredentialLifetime;
  readonly deadlineMs?: number;
  readonly reasoningEffort?: string | null;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}): Promise<
  LocalGatewayModelTransport & { readonly protocol: 'anthropic-messages' }
> {
  input.signal?.throwIfAborted();
  const dispatch = input.modelDispatch;
  const cap = dispatch.capability;
  const originalDeadline = Date.parse(cap.deadline);
  const deadline = Math.min(
    originalDeadline,
    input.deadlineMs ?? originalDeadline
  );
  if (
    cap.transport !== 'runner_local_anthropic' ||
    cap.wireProtocol !== 'anthropic-messages' ||
    cap.outputTokenLimit !== 'upstream_request' ||
    !Number.isSafeInteger(deadline) ||
    deadline <= Date.now() ||
    (input.credentialLifetime.kind === 'proven_expiry'
      ? !Number.isSafeInteger(input.credentialLifetime.credentialValidUntil) ||
        input.credentialLifetime.credentialValidUntil <
          originalDeadline + 60_000
      : input.credentialLifetime.kind !== 'opaque_provider_validated')
  )
    throw new Error('anthropic_prepared_route_invalid');
  let token = await input.readToken();
  if (!isClaudeSubscriptionSetupToken(token))
    throw new Error('anthropic_subscription_credential_invalid');
  input.signal?.throwIfAborted();
  if (Date.now() >= deadline)
    throw new Error('anthropic_prepared_route_expired');
  const effort =
    input.reasoningEffort == null
      ? null
      : anthropicReasoningEffort(input.reasoningEffort);
  const capability = randomBytes(32).toString('hex');
  const expectedAuthorization = Buffer.from(`Bearer ${capability}`);
  let address = '';
  let stopping = false;
  let fenced = false;
  let busy = false;
  let localRequests = 0;
  let requestsDispatched = 0;
  let actualModel: string | undefined;
  let failure: GatewayFailureFact | undefined;
  let contextGuard: (() => void) | undefined;
  let disposal: Promise<void> | undefined;
  const active = new Set<AbortController>();
  const flights = new Set<Promise<unknown>>();

  const execute = async (
    bytes: Uint8Array,
    signal: AbortSignal,
    scope?: PreparedModelInvocationScope,
    responseLimit = cap.maxResponseBytes,
    verifier = false,
    outputCap = cap.maxOutputTokens
  ) => {
    signal.throwIfAborted();
    if (stopping || fenced || busy || Date.now() >= deadline)
      throw new Error('anthropic_route_unavailable');
    contextGuard?.();
    const prepared = normalizeRequest(bytes, verifier, outputCap);
    const controller = new AbortController();
    active.add(controller);
    busy = true;
    const combined = AbortSignal.any([
      signal,
      controller.signal,
      ...(input.signal ? [input.signal] : []),
    ]);
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, deadline - Date.now())
    );
    let ticket: PreparedModelDispatchTicket | undefined;
    let forwarded = false;
    try {
      ticket = await dispatch.reserve(prepared.bytes, combined, scope);
      combined.throwIfAborted();
      if (Date.now() >= deadline) throw new Error('anthropic_route_expired');
      contextGuard?.();
      ticket.forwarded();
      forwarded = true;
      if (!verifier) requestsDispatched++;
      const response = await (input.fetchImpl ?? fetch)(
        RUNNER_LOCAL_ANTHROPIC_ROUTE.endpoint,
        {
          method: 'POST',
          redirect: 'error',
          signal: combined,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json',
            'anthropic-version': RUNNER_LOCAL_ANTHROPIC_ROUTE.version,
            'anthropic-beta': RUNNER_LOCAL_ANTHROPIC_ROUTE.beta,
            'user-agent': RUNNER_LOCAL_ANTHROPIC_ROUTE.userAgent,
          },
          body: prepared.bytes.toString('utf8'),
        }
      );
      if (
        response.status !== 200 ||
        !response.body ||
        !/^application\/json(?:\s*;.*)?$/i.test(
          response.headers.get('content-type') ?? ''
        )
      ) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403)
          throw new Error('anthropic_subscription_authentication_failed');
        throw new Error('anthropic_upstream_unavailable');
      }
      const responseBytes = await boundedBytes(
        response.body,
        Math.min(responseLimit, cap.maxResponseBytes),
        combined
      );
      const normalized = decodeAnthropicMessagesResponse({
        responseBytes,
        expectedModel: cap.model,
        maxOutputTokens: prepared.maxOutputTokens,
        maxResponseBytes: Math.min(responseLimit, cap.maxResponseBytes),
        allowedToolNames: verifier ? [] : prepared.toolNames,
      });
      combined.throwIfAborted();
      await ticket.complete({
        actualModel: normalized.actualModel,
        responseHash: hash(responseBytes),
        responseBytes: responseBytes.byteLength,
        usage: {
          inputTokens: normalized.usage.promptTokens,
          outputTokens: normalized.usage.completionTokens,
          totalTokens: normalized.usage.totalTokens,
        },
      });
      // A consumer that disappeared after a paid completion must not cause a
      // fresh ordinal replay even though the durable upstream effect is known.
      combined.throwIfAborted();
      actualModel = normalized.actualModel;
      return { responseBytes, normalized, requestHash: hash(prepared.bytes) };
    } catch (error) {
      if (forwarded) fenced = true;
      failure = {
        code:
          error instanceof Error &&
          error.message === 'anthropic_subscription_authentication_failed'
            ? 'anthropic_subscription_authentication_failed'
            : 'anthropic_dispatch_unavailable',
        effect: forwarded ? 'effect_unknown' : 'not_dispatched',
      };
      if (ticket)
        await ticket.failed().catch(() => {
          fenced = true;
        });
      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
      active.delete(controller);
      busy = false;
    }
  };

  function normalizeRequest(
    bytes: Uint8Array,
    verifier: boolean,
    outputCap: number
  ) {
    if (
      !Number.isSafeInteger(outputCap) ||
      outputCap < 1 ||
      outputCap > cap.maxOutputTokens
    )
      throw new Error('anthropic_verification_output_cap_invalid');
    if (!bytes.byteLength || bytes.byteLength > cap.maxRequestBytes)
      throw new Error('anthropic_request_bound');
    const row: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    );
    if (
      !record(row) ||
      row.model !== cap.model ||
      (row.stream !== undefined && row.stream !== false) ||
      !Array.isArray(row.messages) ||
      row.messages.length === 0 ||
      typeof row.max_tokens !== 'number' ||
      !Number.isSafeInteger(row.max_tokens) ||
      row.max_tokens < 1
    )
      throw new Error('anthropic_request_invalid');
    const keys = new Set([
      'model',
      'messages',
      'system',
      'max_tokens',
      'stream',
      'tools',
      'tool_choice',
      'temperature',
      'top_p',
      'top_k',
      'thinking',
      'output_config',
    ]);
    if (Object.keys(row).some((key) => !keys.has(key)))
      throw new Error('anthropic_request_field_unavailable');
    if (
      row.output_config !== undefined &&
      (!record(row.output_config) ||
        Object.keys(row.output_config).length !== 1 ||
        row.output_config.effort !== effort)
    )
      throw new Error('anthropic_request_settings_mismatch');
    if (effort !== null && row.output_config === undefined)
      throw new Error('anthropic_request_settings_mismatch');
    const toolNames: string[] = [];
    if (row.tools !== undefined) {
      if (!Array.isArray(row.tools) || row.tools.length > 128)
        throw new Error('anthropic_request_tools_invalid');
      for (const tool of row.tools) {
        if (
          !record(tool) ||
          (tool.type !== undefined && tool.type !== 'custom') ||
          typeof tool.name !== 'string' ||
          !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(tool.name) ||
          toolNames.includes(tool.name) ||
          !record(tool.input_schema)
        )
          throw new Error('anthropic_request_tools_invalid');
        toolNames.push(tool.name);
      }
    }
    if (
      verifier &&
      (row.tools !== undefined ||
        row.tool_choice !== undefined ||
        row.max_tokens !== outputCap)
    )
      throw new Error('anthropic_verification_wire_invalid');
    // Parent-prepared verifier bytes stay exact. Discovery is serialized once
    // before hashing, so the upstream cannot interpret duplicate JSON keys
    // differently from the parent that approved its route and output cap.
    if (!verifier) {
      const maxOutputTokens = Math.min(row.max_tokens, cap.maxOutputTokens);
      row.max_tokens = maxOutputTokens;
      const normalized = Buffer.from(JSON.stringify(row), 'utf8');
      if (normalized.length > cap.maxRequestBytes)
        throw new Error('anthropic_request_bound');
      return {
        bytes: normalized,
        maxOutputTokens,
        toolNames,
      };
    }
    return {
      bytes: Buffer.from(bytes),
      maxOutputTokens: row.max_tokens,
      toolNames,
    };
  }

  const server = createServer({ maxHeaderSize: 16_384 }, (request, reply) => {
    const flight = (async () => {
      const supplied = Buffer.from(request.headers.authorization ?? '');
      if (
        stopping ||
        supplied.length !== expectedAuthorization.length ||
        !timingSafeEqual(supplied, expectedAuthorization) ||
        request.method !== 'POST' ||
        !['/messages', '/v1/messages'].includes(request.url ?? '') ||
        request.headers.host !== address ||
        request.headers['content-encoding'] !== undefined ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          request.headers['content-type'] ?? ''
        )
      ) {
        request.resume();
        reply.writeHead(403).end();
        return;
      }
      if (localRequests !== 0 || busy || fenced) {
        request.resume();
        reply.writeHead(503).end();
        return;
      }
      localRequests++;
      const controller = new AbortController();
      active.add(controller);
      const startCount = requestsDispatched;
      const abort = () => controller.abort();
      const destroyRequest = () => request.destroy();
      const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
      const closed = () => {
        if (!reply.writableFinished) {
          controller.abort();
          if (requestsDispatched > startCount) fenced = true;
        }
      };
      request.once('aborted', abort);
      reply.once('close', closed);
      controller.signal.addEventListener('abort', destroyRequest, {
        once: true,
      });
      try {
        const bytes = await boundedBytes(
          request,
          cap.maxRequestBytes,
          controller.signal
        );
        const result = await execute(bytes, controller.signal);
        controller.signal.throwIfAborted();
        // Complete durable settlement before exposing a successful body/EOF.
        reply.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        await new Promise<void>((resolve, reject) => {
          reply.once('error', reject);
          reply.end(result.responseBytes, resolve);
        });
      } catch {
        if (reply.headersSent) reply.destroy();
        else
          reply
            .writeHead(502, { 'content-type': 'application/json' })
            .end('{"error":{"code":"native_route_unavailable"}}');
      } finally {
        clearTimeout(timer);
        request.removeListener('aborted', abort);
        reply.removeListener('close', closed);
        controller.signal.removeEventListener('abort', destroyRequest);
        controller.abort();
        active.delete(controller);
        localRequests--;
      }
    })();
    flights.add(flight);
    void flight
      .catch(() => reply.destroy())
      .finally(() => flights.delete(flight));
  });
  server.maxConnections = 4;
  server.maxRequestsPerSocket = 1;
  server.headersTimeout = 10_000;
  server.requestTimeout = Math.max(1, deadline - Date.now());
  server.keepAliveTimeout = 1_000;
  server.setTimeout(300_000, (socket) => socket.destroy());
  const abortAll = () => {
    fenced = true;
    for (const controller of active) controller.abort();
  };
  input.signal?.addEventListener('abort', abortAll, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const bound = server.address();
    if (!bound || typeof bound === 'string')
      throw new Error('anthropic_loopback_unavailable');
    address = `127.0.0.1:${bound.port}`;
    input.signal?.throwIfAborted();
  } catch (error) {
    input.signal?.removeEventListener('abort', abortAll);
    server.closeAllConnections();
    server.close();
    throw error;
  }
  const transport: LocalGatewayModelTransport & {
    readonly protocol: 'anthropic-messages';
  } = {
    protocol: 'anthropic-messages',
    baseUrl: `http://${address}`,
    environment: Object.freeze({
      [LOCAL_MODEL_CAPABILITY_ENV]: `Bearer ${capability}`,
    }),
    configuration: Object.freeze([]),
    actualModel: () => actualModel,
    requestCount: () => requestsDispatched,
    failureFact: () => failure,
    releaseRetrySafeFailure: () => false,
    reopenConsumer: () => false,
    setContextToolsGuard: (guard) => {
      contextGuard = guard;
    },
    beginInvocation: (scope) => dispatch.beginInvocation(scope),
    encodeLifecycleRequest: (semantic) =>
      encodeAnthropicVerificationRequest({
        ...semantic,
        reasoningEffort: effort,
      }).requestBytes,
    generateLifecycleVerification: (request) => {
      const flight = (async () => {
        if (
          localRequests !== 0 ||
          !Number.isSafeInteger(request.deadlineMs) ||
          request.deadlineMs <= 0 ||
          !Number.isSafeInteger(request.maxResponseBytes) ||
          request.maxResponseBytes <= 0
        )
          throw new Error('anthropic_route_unavailable');
        const timeout = AbortSignal.timeout(
          Math.min(request.deadlineMs, Math.max(1, deadline - Date.now()))
        );
        const result = await execute(
          request.requestBody,
          AbortSignal.any([request.signal, timeout]),
          request.dispatch,
          request.maxResponseBytes,
          true,
          request.maxOutputTokens
        );
        return Object.freeze({
          body: result.normalized.body,
          actualModel: result.normalized.actualModel,
          providerRequestEnvelopeHash: result.requestHash,
        });
      })();
      flights.add(flight);
      void flight.catch(() => undefined).finally(() => flights.delete(flight));
      return flight;
    },
    dispose: () => {
      disposal ??= (async () => {
        stopping = true;
        input.signal?.removeEventListener('abort', abortAll);
        abortAll();
        server.closeAllConnections();
        await Promise.allSettled([...flights]);
        await new Promise<void>((resolve) => server.close(() => resolve()));
        token = '';
      })();
      return disposal;
    },
  };
  return Object.freeze(transport);
}

async function boundedBytes(
  source: AsyncIterable<Uint8Array>,
  limit: number,
  signal: AbortSignal
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    signal.throwIfAborted();
    size += chunk.byteLength;
    if (size > limit) throw new Error('anthropic_body_bound');
    chunks.push(chunk);
  }
  signal.throwIfAborted();
  return Buffer.concat(chunks);
}
function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
