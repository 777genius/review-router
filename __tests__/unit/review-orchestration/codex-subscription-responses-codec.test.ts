import { createHash } from 'crypto';
import {
  CODEX_SUBSCRIPTION_RESPONSES_ROUTE,
  codexSubscriptionResponsesHeaders,
  decodeCodexSubscriptionCompletedResponse,
  encodeCodexSubscriptionVerificationRequest,
  normalizeCodexSubscriptionResponsesRequest,
} from '../../../src/review-orchestration/infrastructure/codex-subscription-responses-codec';

const model = 'codex-fixture';
const semantic = {
  model,
  instructions: 'shared verifier instructions',
  userText: '{"packet":"fixture"}',
  outputCap: 80,
  maxRequestBytes: 4096,
  reasoningEffort: 'high',
};
function normalize(changes: Record<string, unknown> = {}) {
  return normalizeCodexSubscriptionResponsesRequest({
    requestBytes: Buffer.from(
      JSON.stringify({
        model,
        input: [{ role: 'user', content: 'fixture' }],
        stream: true,
        store: false,
        reasoning: { effort: 'high' },
        ...changes,
      })
    ),
    model,
    maxRequestBytes: 4096,
    maxOutputTokens: 100,
    reasoningEffort: 'high',
  });
}
function response(changes: Record<string, unknown> = {}) {
  return {
    id: 'resp_fixture',
    object: 'response',
    model,
    status: 'completed',
    output: [
      { type: 'reasoning', encrypted_content: 'opaque-native-context' },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '{"results":[]}' }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    ...changes,
  };
}
function decode(value: unknown, allowToolCalls = false) {
  return decodeCodexSubscriptionCompletedResponse({
    response: value,
    expectedModel: model,
    maxOutputTokens: 100,
    maxOutputBytes: 4096,
    allowToolCalls,
  });
}

describe('Codex subscription native Responses wire', () => {
  it('preserves common verifier semantics and binds acceptance cap separately from actual wire bytes', () => {
    const result = encodeCodexSubscriptionVerificationRequest(semantic);
    const body = JSON.parse(Buffer.from(result.requestBytes).toString());
    expect(body).toEqual({
      model,
      instructions: semantic.instructions,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: semantic.userText }],
        },
      ],
      tools: [],
      tool_choice: 'none',
      parallel_tool_calls: false,
      stream: true,
      store: false,
      service_tier: 'default',
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'high' },
    });
    expect(result.outputTokenAcceptanceCap).toBe(80);
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(result.requestHash).toBe(
      createHash('sha256').update(result.requestBytes).digest('hex')
    );
    const normalized = normalizeCodexSubscriptionResponsesRequest({
      requestBytes: result.requestBytes,
      model,
      maxRequestBytes: 4096,
      maxOutputTokens: 80,
      reasoningEffort: 'high',
    });
    expect(normalized.requestBytes).toEqual(result.requestBytes);
    expect(normalized.requestHash).toBe(result.requestHash);
  });

  it('removes an API-shaped output hint before hashing while preserving the stricter acceptance ceiling', () => {
    const small = normalize({ max_output_tokens: 40 });
    expect(small.outputTokenAcceptanceCap).toBe(40);
    expect(
      JSON.parse(Buffer.from(small.requestBytes).toString())
    ).not.toHaveProperty('max_output_tokens');
    expect(normalize({ max_output_tokens: 999 }).outputTokenAcceptanceCap).toBe(
      100
    );
    expect(normalize().outputTokenAcceptanceCap).toBe(100);
    expect(CODEX_SUBSCRIPTION_RESPONSES_ROUTE.outputTokenLimit).toBe(
      'terminal_acceptance'
    );
  });

  it.each([
    { model: 'other' },
    { stream: false },
    { store: true },
    { temperature: 0 },
    { top_p: 1 },
    { previous_response_id: 'hidden-state' },
    { max_output_tokens: 0 },
    { max_output_tokens: 1.5 },
    { max_output_tokens: '100' },
    { reasoning: { effort: 'low' } },
    { service_tier: 'priority' },
  ])('rejects unbound native request semantics %j', (change) => {
    expect(() => normalize(change)).toThrow();
  });

  it('uses only fixed subscription auth headers and an honest ReviewRouter identity', () => {
    expect(CODEX_SUBSCRIPTION_RESPONSES_ROUTE.endpoint).toBe(
      'https://chatgpt.com/backend-api/codex/responses'
    );
    const headers = codexSubscriptionResponsesHeaders({
      accessToken: 'synthetic.access.signature',
      accountId: 'account-1',
    });
    expect(headers).toEqual({
      authorization: 'Bearer synthetic.access.signature',
      'chatgpt-account-id': 'account-1',
      'content-type': 'application/json',
      accept: 'text/event-stream',
      originator: 'reviewrouter',
      'user-agent': 'reviewrouter/ocr-native-v1',
    });
    expect(() =>
      codexSubscriptionResponsesHeaders({
        accessToken: 'x\r\nInjected: yes',
        accountId: 'account',
      })
    ).toThrow();
  });

  it('accepts only matching completed output with observed bounded usage', () => {
    const receipt = decode(response());
    expect(Buffer.from(receipt.body).toString()).toBe('{"results":[]}');
    expect(receipt.actualModel).toBe(model);
    expect(receipt.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    expect(
      decode(response({ usage: { input_tokens: 10, output_tokens: 5 } })).usage
        .totalTokens
    ).toBe(15);
  });

  it.each([
    { status: 'incomplete' },
    { object: undefined },
    { model: 'other' },
    { incomplete_details: { reason: 'max_output_tokens' } },
    { error: { code: 'error' } },
    { usage: undefined },
    { usage: { input_tokens: 10 } },
    { usage: { input_tokens: 10, output_tokens: 101 } },
    { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 1 } },
    { usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 5 } },
    { output: [{ type: 'reasoning' }] },
    {
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
      ],
    },
    {
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'refusal', refusal: 'fixture' }],
        },
      ],
    },
  ])(
    'rejects missing, over-cap or incomplete terminal evidence %j',
    (change) => {
      expect(() => decode(response(change))).toThrow();
    }
  );

  it('permits well-formed native discovery tool rounds but never verifier tool requests', () => {
    const tool = {
      type: 'function_call',
      call_id: 'call-1',
      name: 'task_done',
      arguments: '{}',
    };
    const wire = response({ output: [tool] });
    expect(decode(wire, true).actualModel).toBe(model);
    expect(() => decode(wire)).toThrow('codex_subscription_tool_invalid');
    expect(() => decode(response({ output: [tool, tool] }), true)).toThrow(
      'codex_subscription_tool_invalid'
    );
    expect(() =>
      decode(response({ output: [{ ...tool, arguments: 'null' }] }), true)
    ).toThrow('codex_subscription_tool_invalid');
    expect(
      decode(
        response({
          output: [
            {
              type: 'custom_tool_call',
              call_id: 'custom-1',
              name: 'apply_patch',
              input: 'synthetic patch',
            },
          ],
        }),
        true
      ).actualModel
    ).toBe(model);
  });
});
