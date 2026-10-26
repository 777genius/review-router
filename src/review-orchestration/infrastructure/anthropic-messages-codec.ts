import { createHash } from 'crypto';
import { TextDecoder } from 'util';
import {
  canonicalJson,
  type CanonicalJsonValue,
} from '../../review-investigation/domain/canonical-json';
import type { TokenUsage } from '../../types';

/** Native Messages wire only. Authentication, route selection and dispatch claims
 * belong to the prepared transport; verifier packet/verdict rules stay shared. */
export function encodeAnthropicVerificationRequest(input: {
  readonly model: string;
  readonly instructions: string;
  readonly userText: string;
  readonly outputCap: number;
  readonly maxRequestBytes: number;
  readonly reasoningEffort?: string | null;
}): Readonly<{ requestBytes: Uint8Array; requestHash: string }> {
  if (
    !input.model ||
    !input.instructions ||
    !input.userText ||
    !positive(input.outputCap) ||
    !positive(input.maxRequestBytes)
  )
    throw new Error('anthropic_verification_request_invalid');
  const request = {
    model: input.model,
    stream: false,
    max_tokens: input.outputCap,
    system: input.instructions,
    messages: [
      { role: 'user', content: [{ type: 'text', text: input.userText }] },
    ],
    ...(input.reasoningEffort != null
      ? {
          output_config: {
            effort: anthropicReasoningEffort(input.reasoningEffort),
          },
        }
      : {}),
  };
  const requestBytes = Buffer.from(
    canonicalJson(request as CanonicalJsonValue),
    'utf8'
  );
  if (requestBytes.byteLength > input.maxRequestBytes)
    throw new Error('anthropic_verification_request_oversized');
  return Object.freeze({
    requestBytes,
    requestHash: createHash('sha256').update(requestBytes).digest('hex'),
  });
}

/** A finite captured setting. Provider/model qualification may constrain it further. */
export function anthropicReasoningEffort(
  value: string
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  if (
    value !== 'low' &&
    value !== 'medium' &&
    value !== 'high' &&
    value !== 'xhigh' &&
    value !== 'max'
  )
    throw new Error('anthropic_reasoning_effort_unsupported');
  return value;
}

export type AnthropicMessagesReceipt = Readonly<{
  body: Uint8Array;
  actualModel: string;
  usage: TokenUsage;
  stopReason: 'end_turn' | 'tool_use';
}>;

/** Fully consumed non-streaming response, checked before any normalization.
 * Missing usage is unavailable; it is never guessed as zero. No model aliases
 * are inferred, and max_tokens/refusal/unknown stop reasons cannot prove a fix. */
export function decodeAnthropicMessagesResponse(input: {
  readonly responseBytes: Uint8Array;
  readonly expectedModel: string;
  readonly maxOutputTokens: number;
  readonly maxResponseBytes: number;
  readonly allowedToolNames?: readonly string[];
}): AnthropicMessagesReceipt {
  if (
    !positive(input.maxResponseBytes) ||
    !positive(input.maxOutputTokens) ||
    !input.responseBytes.byteLength ||
    input.responseBytes.byteLength > input.maxResponseBytes
  )
    throw new Error('anthropic_response_bound');
  let message: unknown;
  try {
    message = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(input.responseBytes)
    );
  } catch {
    throw new Error('anthropic_response_malformed');
  }
  if (
    !record(message) ||
    message.type !== 'message' ||
    message.role !== 'assistant' ||
    typeof message.id !== 'string' ||
    !message.id ||
    message.model !== input.expectedModel
  )
    throw new Error('anthropic_response_identity_mismatch');
  if (message.stop_reason !== 'end_turn' && message.stop_reason !== 'tool_use')
    throw new Error('anthropic_response_incomplete');
  if (!record(message.usage)) throw new Error('anthropic_usage_unavailable');
  const usage = message.usage;
  const inputTokens = counter(usage.input_tokens);
  const completionTokens = counter(usage.output_tokens);
  const cacheRead =
    usage.cache_read_input_tokens === undefined
      ? 0
      : counter(usage.cache_read_input_tokens);
  const cacheWrite =
    usage.cache_creation_input_tokens === undefined
      ? 0
      : counter(usage.cache_creation_input_tokens);
  const promptTokens = inputTokens + cacheRead + cacheWrite;
  const totalTokens = promptTokens + completionTokens;
  if (
    !Number.isSafeInteger(totalTokens) ||
    completionTokens > input.maxOutputTokens
  )
    throw new Error('anthropic_usage_invalid');
  if (!Array.isArray(message.content) || message.content.length === 0)
    throw new Error('anthropic_response_content_invalid');
  const toolIds = new Set<string>();
  const tools = new Set(input.allowedToolNames ?? []);
  const texts: string[] = [];
  for (const block of message.content) {
    if (!record(block)) throw new Error('anthropic_response_content_invalid');
    switch (block.type) {
      case 'text':
        if (typeof block.text !== 'string')
          throw new Error('anthropic_response_content_invalid');
        texts.push(block.text);
        break;
      case 'thinking':
      case 'redacted_thinking':
        // Native OCR retains signatures. They are never verifier final text.
        break;
      case 'tool_use':
        if (
          typeof block.id !== 'string' ||
          !block.id ||
          toolIds.has(block.id) ||
          typeof block.name !== 'string' ||
          !tools.has(block.name) ||
          !record(block.input)
        )
          throw new Error('anthropic_response_tool_invalid');
        toolIds.add(block.id);
        break;
      default:
        throw new Error('anthropic_response_content_unsupported');
    }
  }
  const text = texts.join('\n');
  if (
    (message.stop_reason === 'tool_use' && toolIds.size === 0) ||
    (message.stop_reason === 'end_turn' && (toolIds.size !== 0 || !text.trim()))
  )
    throw new Error('anthropic_response_incomplete');
  return Object.freeze({
    body: Buffer.from(text, 'utf8'),
    actualModel: input.expectedModel,
    usage: Object.freeze({ promptTokens, completionTokens, totalTokens }),
    stopReason: message.stop_reason,
  });
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
function counter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('anthropic_usage_invalid');
  return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
