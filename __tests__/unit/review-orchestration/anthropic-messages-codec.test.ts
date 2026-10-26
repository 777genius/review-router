import { createHash } from 'crypto';
import {
  decodeAnthropicMessagesResponse,
  encodeAnthropicVerificationRequest,
} from '../../../src/review-orchestration/infrastructure/anthropic-messages-codec';
import { buildOcrManagedConfigJson } from '../../../src/review-orchestration/infrastructure/ocr-review-managed-run';

const model = 'claude-fixture';
function response(change: Record<string, unknown> = {}): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      model,
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"results":[]}' }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
      ...change,
    })
  );
}
function decode(bytes: Uint8Array, allowedToolNames?: readonly string[]) {
  return decodeAnthropicMessagesResponse({
    responseBytes: bytes,
    expectedModel: model,
    maxOutputTokens: 100,
    maxResponseBytes: 4096,
    allowedToolNames,
  });
}

describe('native Anthropic Messages verifier wire', () => {
  it('preserves semantic prompt in a native no-tool envelope and hashes its actual bytes', () => {
    const prepared = encodeAnthropicVerificationRequest({
      model,
      instructions: 'shared rules',
      userText: '{"packet":"synthetic"}',
      outputCap: 100,
      maxRequestBytes: 4096,
      reasoningEffort: 'high',
    });
    const wire = JSON.parse(
      Buffer.from(prepared.requestBytes).toString('utf8')
    );
    expect(wire).toEqual({
      model,
      stream: false,
      max_tokens: 100,
      system: 'shared rules',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: '{"packet":"synthetic"}' }],
        },
      ],
      output_config: { effort: 'high' },
    });
    expect(prepared.requestHash).toBe(
      createHash('sha256').update(prepared.requestBytes).digest('hex')
    );
    expect(wire).not.toHaveProperty('input');
    expect(wire).not.toHaveProperty('service_tier');
  });

  it('uses native managed config without exposing upstream auth or Responses-only knobs', () => {
    const config = JSON.parse(
      buildOcrManagedConfigJson({
        baseUrl: 'http://127.0.0.1:1234',
        rawCapability: 'a'.repeat(32),
        model,
        protocol: 'anthropic-messages',
        limits: { requestTimeoutSec: 15 },
        modelReasoningEffort: 'medium',
        language: 'en',
      })
    );
    expect(config.custom_providers.reviewrouter).toEqual({
      protocol: 'anthropic',
      url: 'http://127.0.0.1:1234',
      api_key: 'a'.repeat(32),
      model,
      timeout_sec: 15,
      extra_body: { output_config: { effort: 'medium' } },
    });
  });

  it('accepts only complete matching output with observed normalized usage', () => {
    const receipt = decode(response());
    expect(receipt.actualModel).toBe(model);
    expect(Buffer.from(receipt.body).toString()).toBe('{"results":[]}');
    expect(receipt.usage).toEqual({
      promptTokens: 13,
      completionTokens: 5,
      totalTokens: 18,
    });
  });

  it.each([
    { stop_reason: undefined },
    { stop_reason: 'max_tokens' },
    { stop_reason: 'future' },
    { model: 'other' },
    { usage: undefined },
    { usage: { input_tokens: 10 } },
    { usage: { input_tokens: 1, output_tokens: 101 } },
    { content: [{ type: 'thinking', thinking: 'unfinished' }] },
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'call', name: 'task_done', input: {} }],
    },
  ])('rejects an unqualified final response %j', (change) => {
    expect(() => decode(response(change))).toThrow();
  });

  it('accepts an offered discovery tool round but never treats it as verifier text', () => {
    const bytes = response({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'call', name: 'task_done', input: {} }],
    });
    expect(decode(bytes, ['task_done']).stopReason).toBe('tool_use');
    expect(() => decode(bytes)).toThrow('anthropic_response_tool_invalid');
  });

  it('rejects truncated or invalid UTF-8 bodies and over-limit wire before normalization', () => {
    expect(() => decode(Buffer.from('{'))).toThrow(
      'anthropic_response_malformed'
    );
    expect(() => decode(new Uint8Array([0xff]))).toThrow(
      'anthropic_response_malformed'
    );
    expect(() => decode(Buffer.alloc(4097))).toThrow(
      'anthropic_response_bound'
    );
  });
});
