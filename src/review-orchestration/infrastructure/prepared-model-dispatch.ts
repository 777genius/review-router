import { createHash } from 'crypto';
import {
  parseReviewModelDispatchCapabilityV2,
  reviewModelDispatchContract as contract,
  reviewModelDispatchIdPreimage,
  reviewModelDispatchOutputUsageIsWithinLimit,
  type ReviewModelDispatchCapabilityV2,
  type ReviewModelDispatchClaimV2,
  type ReviewModelDispatchClaimResultV2,
  type ReviewModelDispatchReadbackV2,
  type ReviewModelDispatchSettlementV2,
  type ReviewModelDispatchTerminalReceiptV2,
} from '../../control-plane/generated/review-action-v2/review-model-dispatch-contract';
import type { ReviewCompanionDispatchContextV1 } from '../../control-plane/generated/review-action-v2/companion-contracts';
import { canonicalJson } from '../../review-investigation/domain/canonical-json';
import type { PreparedReviewInvocationPort } from '../application';

/** One scope adapter for either approved engine. Restored observations never
 * enter execute, and therefore never obtain a fresh model-dispatch scope. */
export function scopedModelInvocations(
  invocations: PreparedReviewInvocationPort,
  transport: Readonly<{
    beginInvocation?(scope: () => PreparedModelInvocationScope): () => void;
  }>
): PreparedReviewInvocationPort {
  return {
    prepare: (input) => invocations.prepare(input),
    async execute(input) {
      const release = transport.beginInvocation?.(() => {
        input.signal.throwIfAborted();
        const lease = input.currentLease?.() ?? input.lease;
        return {
          executionId: input.sourceExecutionId,
          workSlotId: input.invocation.workSlotId,
          attemptOrdinal: input.invocation.attemptOrdinal,
          leaseId: lease.leaseId,
          leaseCapability: lease.leaseCapability,
          fencingToken: lease.fencingToken,
          preparedManifestKey: input.manifest.manifestKey,
        };
      });
      try {
        return await invocations.execute(input);
      } finally {
        release?.();
      }
    },
  };
}

export type PreparedModelInvocationScope = Omit<
  ReviewCompanionDispatchContextV1,
  'dispatchId'
>;

export type PreparedModelDispatchTicket = Readonly<{
  claim: ReviewModelDispatchClaimV2;
  forwarded(): void;
  isCompleted(): boolean;
  complete(
    receipt: Omit<
      ReviewModelDispatchTerminalReceiptV2,
      | 'version'
      | 'routeIdentityHash'
      | 'providerRequestEnvelopeHash'
      | 'fullyConsumed'
      | 'terminal'
    >
  ): Promise<void>;
  failed(): Promise<void>;
}>;

/** Parent-only adapter to the durable run allowance. It knows no credentials,
 * engine or finding rules. Reservations are permanent, including local failures.
 * A restored reservation never authorizes another upstream request. */
export class PreparedModelDispatch {
  readonly capability: ReviewModelDispatchCapabilityV2;
  private readonly origin: URL;
  private scope?: () => PreparedModelInvocationScope;
  private readonly ordinals = new Map<string, number>();
  private active = false;
  private fenced = false;

  constructor(
    private readonly input: Readonly<{
      apiUrl: string;
      capability: unknown;
      authorization: () => Readonly<{
        authorizationId: string;
        authorizationToken: string;
      }>;
      fetchImpl?: typeof fetch;
    }>
  ) {
    this.capability = parseReviewModelDispatchCapabilityV2(input.capability);
    this.origin = new URL(input.apiUrl);
    if (
      this.origin.username ||
      this.origin.password ||
      (this.origin.protocol !== 'https:' &&
        !(
          this.origin.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(this.origin.hostname)
        ))
    )
      throw new Error('model_dispatch_origin_invalid');
  }

  /** The runner installs a live lease getter only while its leased invocation
   * runs. An engine cannot submit its own scope or mint a new ordinal. */
  beginInvocation(scope: () => PreparedModelInvocationScope): () => void {
    if (this.scope || this.active || this.fenced)
      throw new Error('model_dispatch_scope_unavailable');
    this.scope = scope;
    return () => {
      if (this.scope === scope) this.scope = undefined;
      if (this.active) this.fenced = true;
    };
  }

  normalizeResponsesRequest(input: Uint8Array): Buffer {
    const cap = this.capability;
    if (cap.wireProtocol !== 'openai-responses')
      throw new Error('model_dispatch_wire_protocol_mismatch');
    if (input.byteLength > cap.maxRequestBytes)
      throw new Error('model_dispatch_request_bound');
    const request: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(input)
    );
    if (!request || typeof request !== 'object' || Array.isArray(request))
      throw new Error('model_dispatch_request_invalid');
    const row = request as Record<string, unknown>;
    if (row.model !== cap.model || row.stream !== true)
      throw new Error('model_dispatch_route_mismatch');
    const requested = row.max_output_tokens ?? cap.maxOutputTokens;
    if (
      typeof requested !== 'number' ||
      !Number.isSafeInteger(requested) ||
      requested <= 0
    )
      throw new Error('model_dispatch_output_bound');
    // Normalize once before claiming the actual wire hash. This removes
    // duplicate-key ambiguity; canonical parent verifier envelopes stay exact.
    row.max_output_tokens = Math.min(requested, cap.maxOutputTokens);
    return Buffer.from(JSON.stringify(row));
  }

  async reserve(
    bytes: Uint8Array,
    signal: AbortSignal,
    explicitScope?: PreparedModelInvocationScope,
    outputAcceptanceCap?: number
  ): Promise<PreparedModelDispatchTicket> {
    signal.throwIfAborted();
    const cap = this.capability;
    if (this.fenced || this.active || Date.now() >= Date.parse(cap.deadline))
      throw new Error('model_dispatch_fenced');
    const scope = explicitScope ?? this.scope?.();
    if (!scope || scope.attemptOrdinal !== 1)
      throw new Error('model_dispatch_scope_unavailable');
    const raw: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    );
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('model_dispatch_request_invalid');
    const wire = raw as Record<string, unknown>;
    const output =
      cap.wireProtocol === 'codex-responses'
        ? outputAcceptanceCap
        : wire[
            cap.wireProtocol === 'anthropic-messages'
              ? 'max_tokens'
              : 'max_output_tokens'
          ];
    if (
      wire.model !== cap.model ||
      !Number.isSafeInteger(output) ||
      Number(output) < 1 ||
      Number(output) > cap.maxOutputTokens ||
      bytes.byteLength > cap.maxRequestBytes ||
      (cap.wireProtocol === 'codex-responses' &&
        Object.hasOwn(wire, 'max_output_tokens')) ||
      (outputAcceptanceCap !== undefined && outputAcceptanceCap !== output)
    )
      throw new Error('model_dispatch_route_mismatch');
    const authorization = this.input.authorization();
    const requestOrdinal = (this.ordinals.get(scope.workSlotId) ?? 0) + 1;
    this.ordinals.set(scope.workSlotId, requestOrdinal);
    this.active = true;
    const claim: ReviewModelDispatchClaimV2 = {
      ...scope,
      dispatchVersion: 2,
      dispatchId: `rr-model-${hash(
        Buffer.from(
          reviewModelDispatchIdPreimage({
            authorizationId: authorization.authorizationId,
            workSlotId: scope.workSlotId,
            attemptOrdinal: 1,
            requestOrdinal,
          })
        )
      )}`,
      attemptOrdinal: 1,
      requestOrdinal,
      routeIdentityHash: cap.routeIdentityHash,
      providerRequestEnvelopeHash: hash(bytes),
      requestBytes: bytes.byteLength,
      maxOutputTokens: Number(output),
    };
    let result: ReviewModelDispatchClaimResultV2;
    try {
      result = (await this.json(
        contract.claimPath,
        'POST',
        claim,
        {
          authorization: `Bearer ${authorization.authorizationToken}`,
        },
        signal
      )) as ReviewModelDispatchClaimResultV2;
      if (
        result.status !== 'claimed' ||
        !/^[a-f0-9]{64}$/.test(result.receiptToken) ||
        !matchesClaim(result.dispatch, claim, authorization.authorizationId) ||
        result.dispatch.state !== 'dispatch_may_have_started' ||
        !Number.isFinite(Date.parse(result.notAfter)) ||
        Date.parse(result.notAfter) > Date.parse(cap.deadline)
      )
        throw new Error('model_dispatch_claim_unavailable');
    } catch {
      this.active = false;
      this.fenced = true;
      throw new Error('model_dispatch_claim_unavailable');
    }
    let forwarded = false;
    let settling = false;
    let completed = false;
    const settle = async (settlement: ReviewModelDispatchSettlementV2) => {
      if (settling) return;
      settling = true;
      const path = `${contract.basePath}/${encodeURIComponent(claim.dispatchId)}`;
      const headers = { [contract.receiptHeader]: result.receiptToken };
      const agrees = (value: unknown) => {
        const dispatch = (
          value as { dispatch?: ReviewModelDispatchReadbackV2 } | null
        )?.dispatch;
        return (
          !!dispatch &&
          matchesClaim(dispatch, claim, authorization.authorizationId) &&
          dispatch.state === settlement.state &&
          (settlement.state !== 'completed' ||
            canonicalJson(dispatch.terminalReceipt) ===
              canonicalJson(settlement.receipt))
        );
      };
      try {
        let response: unknown;
        try {
          response = await this.json(
            `${path}/settle`,
            'POST',
            settlement,
            headers
          );
        } catch {
          response = await this.json(path, 'GET', undefined, headers);
        }
        if (!agrees(response))
          throw new Error('model_dispatch_settlement_unconfirmed');
        completed = settlement.state === 'completed';
      } catch {
        this.fenced = true;
        throw new Error('model_dispatch_settlement_unconfirmed');
      } finally {
        this.active = false;
      }
    };
    if (signal.aborted || Date.now() >= Date.parse(result.notAfter)) {
      await settle({ state: 'not_dispatched', proof: 'local_before_forward' });
      throw new Error('model_dispatch_deadline');
    }
    return Object.freeze({
      claim,
      forwarded: () => {
        forwarded = true;
      },
      isCompleted: () => completed,
      complete: async (receipt) => {
        if (!forwarded) throw new Error('model_dispatch_not_forwarded');
        if (
          receipt.actualModel !== cap.model ||
          !reviewModelDispatchOutputUsageIsWithinLimit(
            receipt.usage,
            claim.maxOutputTokens
          )
        ) {
          this.fenced = true;
          await settle({ state: 'effect_unknown' });
          throw new Error('model_dispatch_terminal_evidence_invalid');
        }
        await settle({
          state: 'completed',
          receipt: {
            ...receipt,
            version: 2,
            routeIdentityHash: cap.routeIdentityHash,
            providerRequestEnvelopeHash: claim.providerRequestEnvelopeHash,
            fullyConsumed: true,
            terminal: 'completed',
          },
        });
      },
      failed: async () => {
        if (settling) return;
        if (forwarded) this.fenced = true;
        await settle(
          forwarded
            ? { state: 'effect_unknown' }
            : { state: 'not_dispatched', proof: 'local_before_forward' }
        );
      },
    });
  }

  private async json(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const response = await (this.input.fetchImpl ?? fetch)(
      new URL(path, this.origin),
      {
        method,
        redirect: 'error',
        headers: { ...headers, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      }
    );
    if (
      !response.ok ||
      !response.body ||
      !/^application\/json(?:\s*;.*)?$/i.test(
        response.headers.get('content-type') ?? ''
      )
    ) {
      await response.body?.cancel();
      throw new Error('model_dispatch_control_unavailable');
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > contract.maxReceiptBytes)
        throw new Error('model_dispatch_control_bound');
      chunks.push(chunk);
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    );
  }
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function matchesClaim(
  value: ReviewModelDispatchReadbackV2 | undefined,
  claim: ReviewModelDispatchClaimV2,
  authorizationId: string
): boolean {
  return (
    !!value &&
    value.authorizationId === authorizationId &&
    Object.entries(claim).every(
      ([key, field]) =>
        key === 'leaseCapability' ||
        value[key as keyof ReviewModelDispatchReadbackV2] === field
    )
  );
}
