import { createHash } from 'crypto';
import { TextDecoder } from 'util';
import type { LifecycleRequestEncoder } from '../../finding-revalidation';
import {
  canonicalJson,
  type CanonicalJsonValue,
} from '../../review-investigation/domain/canonical-json';
import type { TokenUsage } from '../../types';

/** Pinned Codex ResponsesApiRequest has no generation-token cap. This descriptor
 * qualifies accepted terminal usage, not an upstream spending ceiling. */
export const CODEX_SUBSCRIPTION_RESPONSES_ROUTE = Object.freeze({
  descriptor: 'openai-codex-subscription-responses.v1',
  sourceCommit: 'be6e8eac029b183056b7e4402879f15d2c85f61b',
  endpoint: 'https://chatgpt.com/backend-api/codex/responses',
  wireProtocol: 'codex-responses',
  outputTokenLimit: 'terminal_acceptance',
  originator: 'reviewrouter',
  userAgent: 'reviewrouter/ocr-native-v1',
} as const);

export function codexSubscriptionResponsesHeaders(input: {
  readonly accessToken: string;
  readonly accountId: string;
}): Readonly<Record<string, string>> {
  if (
    !/^[A-Za-z0-9._~+/-]+=*$/.test(input.accessToken) ||
    input.accessToken.length > 16_384 ||
    !/^[A-Za-z0-9:_-]{1,200}$/.test(input.accountId)
  )
    throw new Error('codex_subscription_credentials_invalid');
  return Object.freeze({
    authorization: `Bearer ${input.accessToken}`,
    'chatgpt-account-id': input.accountId,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    originator: CODEX_SUBSCRIPTION_RESPONSES_ROUTE.originator,
    'user-agent': CODEX_SUBSCRIPTION_RESPONSES_ROUTE.userAgent,
  });
}

export function encodeCodexSubscriptionVerificationRequest(
  input: Parameters<LifecycleRequestEncoder>[0] &
    Readonly<{ reasoningEffort?: string | null }>
): Readonly<{
  requestBytes: Uint8Array;
  requestHash: string;
  outputTokenAcceptanceCap: number;
}> {
  if (
    !input.model ||
    !input.instructions ||
    !input.userText ||
    !positive(input.outputCap)
  )
    throw new Error('codex_subscription_verification_request_invalid');
  const request = {
    model: input.model,
    instructions: input.instructions,
    input: [
      { role: 'user', content: [{ type: 'input_text', text: input.userText }] },
    ],
    tools: [],
    tool_choice: 'none',
    parallel_tool_calls: false,
    stream: true,
    store: false,
    service_tier: 'default',
    include: ['reasoning.encrypted_content'],
    ...(input.reasoningEffort != null
      ? { reasoning: { effort: effort(input.reasoningEffort) } }
      : {}),
  };
  return encoded(request, input.maxRequestBytes, input.outputCap);
}

/** Normalize before the durable claim and actual wire hash. The legacy client
 * output hint becomes acceptance metadata; it is never forwarded to Codex. */
export function normalizeCodexSubscriptionResponsesRequest(input: {
  readonly requestBytes: Uint8Array;
  readonly model: string;
  readonly maxRequestBytes: number;
  readonly maxOutputTokens: number;
  readonly reasoningEffort?: string | null;
}): Readonly<{
  requestBytes: Uint8Array;
  requestHash: string;
  outputTokenAcceptanceCap: number;
  allowedToolNames: readonly string[];
}> {
  if (
    !positive(input.maxRequestBytes) ||
    !positive(input.maxOutputTokens) ||
    !input.requestBytes.byteLength ||
    input.requestBytes.byteLength > input.maxRequestBytes
  )
    throw new Error('codex_subscription_request_bound');
  let row: unknown;
  try {
    row = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(input.requestBytes)
    );
  } catch {
    throw new Error('codex_subscription_request_malformed');
  }
  const allowed = new Set([
    'model',
    'instructions',
    'input',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'reasoning',
    'store',
    'stream',
    'stream_options',
    'include',
    'service_tier',
    'prompt_cache_key',
    'text',
    'client_metadata',
    'max_output_tokens',
  ]);
  if (
    !record(row) ||
    row.model !== input.model ||
    row.stream !== true ||
    (row.store !== undefined && row.store !== false) ||
    !Array.isArray(row.input) ||
    row.input.length === 0 ||
    Object.keys(row).some((key) => !allowed.has(key)) ||
    (row.instructions !== undefined && typeof row.instructions !== 'string') ||
    (row.tools !== undefined && !Array.isArray(row.tools)) ||
    (row.tool_choice !== undefined &&
      (typeof row.tool_choice !== 'string' ||
        !['auto', 'none', 'required'].includes(row.tool_choice))) ||
    (row.parallel_tool_calls !== undefined &&
      typeof row.parallel_tool_calls !== 'boolean') ||
    (row.service_tier !== undefined && row.service_tier !== 'default') ||
    (row.include !== undefined &&
      (!Array.isArray(row.include) ||
        row.include.some((item) => item !== 'reasoning.encrypted_content')))
  )
    throw new Error('codex_subscription_request_invalid');
  const toolNames: string[] = [];
  for (const tool of (row.tools ?? []) as unknown[]) {
    if (
      !record(tool) ||
      tool.type !== 'function' ||
      typeof tool.name !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(tool.name) ||
      toolNames.includes(tool.name) ||
      toolNames.length >= 128 ||
      !record(tool.parameters)
    )
      throw new Error('codex_subscription_request_tools_invalid');
    toolNames.push(tool.name);
  }
  const requestedCap = row.max_output_tokens;
  if (
    requestedCap !== undefined &&
    (typeof requestedCap !== 'number' || !positive(requestedCap))
  )
    throw new Error('codex_subscription_request_output_cap_invalid');
  if (row.reasoning === null) delete row.reasoning;
  if (row.reasoning !== undefined && !record(row.reasoning))
    throw new Error('codex_subscription_request_settings_invalid');
  const actualEffort = record(row.reasoning) ? row.reasoning.effort : undefined;
  if (actualEffort !== undefined && actualEffort !== null) effort(actualEffort);
  if (
    input.reasoningEffort !== undefined &&
    (actualEffort ?? null) !==
      (input.reasoningEffort === null ? null : effort(input.reasoningEffort))
  )
    throw new Error('codex_subscription_request_settings_mismatch');
  delete row.max_output_tokens;
  return Object.freeze({
    ...encoded(
      { ...row, stream: true, store: false, service_tier: 'default' },
      input.maxRequestBytes,
      Math.min(
        typeof requestedCap === 'number' ? requestedCap : input.maxOutputTokens,
        input.maxOutputTokens
      )
    ),
    allowedToolNames: Object.freeze(toolNames),
  });
}

/** Called by the existing SSE observer only for its unique response.completed
 * event. Stream framing, full consumption and durable settlement stay there. */
export function decodeCodexSubscriptionCompletedResponse(input: {
  readonly response: unknown;
  readonly expectedModel: string;
  readonly maxOutputTokens: number;
  readonly maxOutputBytes: number;
  readonly allowToolCalls?: boolean;
  readonly allowedToolNames?: readonly string[];
}): Readonly<{ body: Uint8Array; actualModel: string; usage: TokenUsage }> {
  const row = input.response;
  if (
    !positive(input.maxOutputTokens) ||
    !positive(input.maxOutputBytes) ||
    !record(row) ||
    row.object !== 'response' ||
    typeof row.id !== 'string' ||
    !row.id ||
    row.model !== input.expectedModel ||
    row.status !== 'completed' ||
    row.error != null ||
    row.incomplete_details != null ||
    !Array.isArray(row.output)
  )
    throw new Error('codex_subscription_terminal_invalid');
  if (!record(row.usage))
    throw new Error('codex_subscription_usage_unavailable');
  const promptTokens = counter(row.usage.input_tokens);
  const completionTokens = counter(row.usage.output_tokens);
  const totalTokens = promptTokens + completionTokens;
  if (
    !Number.isSafeInteger(totalTokens) ||
    (row.usage.total_tokens !== undefined &&
      counter(row.usage.total_tokens) !== totalTokens)
  )
    throw new Error('codex_subscription_usage_invalid');
  if (completionTokens > input.maxOutputTokens)
    throw new Error('codex_subscription_output_acceptance_exceeded');
  const text: string[] = [];
  const toolCalls = new Set<string>();
  for (const item of row.output) {
    if (
      !record(item) ||
      (item.status !== undefined && item.status !== 'completed')
    )
      throw new Error('codex_subscription_output_incomplete');
    if (item.type === 'reasoning') continue;
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      if (
        input.allowToolCalls !== true ||
        typeof item.call_id !== 'string' ||
        !item.call_id ||
        toolCalls.has(item.call_id) ||
        typeof item.name !== 'string' ||
        !item.name ||
        (input.allowedToolNames !== undefined &&
          !input.allowedToolNames.includes(item.name)) ||
        (item.namespace !== undefined &&
          (typeof item.namespace !== 'string' || !item.namespace))
      )
        throw new Error('codex_subscription_tool_invalid');
      if (item.type === 'function_call') {
        let argumentsValue: unknown;
        try {
          if (typeof item.arguments !== 'string') throw new Error();
          argumentsValue = JSON.parse(item.arguments);
        } catch {
          throw new Error('codex_subscription_tool_invalid');
        }
        if (!record(argumentsValue))
          throw new Error('codex_subscription_tool_invalid');
      } else if (typeof item.input !== 'string')
        throw new Error('codex_subscription_tool_invalid');
      toolCalls.add(item.call_id);
      continue;
    }
    if (
      item.type !== 'message' ||
      item.role !== 'assistant' ||
      !Array.isArray(item.content)
    )
      throw new Error('codex_subscription_output_unsupported');
    for (const content of item.content) {
      if (
        !record(content) ||
        content.type !== 'output_text' ||
        typeof content.text !== 'string'
      )
        throw new Error('codex_subscription_output_unsupported');
      text.push(content.text);
    }
  }
  const body = Buffer.from(text.join('\n'), 'utf8');
  if (body.byteLength > input.maxOutputBytes)
    throw new Error('codex_subscription_output_bound');
  if (!body.toString('utf8').trim() && toolCalls.size === 0)
    throw new Error('codex_subscription_output_empty');
  return Object.freeze({
    body,
    actualModel: input.expectedModel,
    usage: Object.freeze({ promptTokens, completionTokens, totalTokens }),
  });
}

function encoded(
  request: Record<string, unknown>,
  maxRequestBytes: number,
  outputTokenAcceptanceCap: number
) {
  if (!positive(maxRequestBytes))
    throw new Error('codex_subscription_request_bound');
  const requestBytes = Buffer.from(
    canonicalJson(request as CanonicalJsonValue),
    'utf8'
  );
  if (requestBytes.byteLength > maxRequestBytes)
    throw new Error('codex_subscription_request_bound');
  return Object.freeze({
    requestBytes,
    requestHash: createHash('sha256').update(requestBytes).digest('hex'),
    outputTokenAcceptanceCap,
  });
}
function effort(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)
  )
    throw new Error('codex_subscription_reasoning_effort_unsupported');
  return value;
}
function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
function counter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('codex_subscription_usage_invalid');
  return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
