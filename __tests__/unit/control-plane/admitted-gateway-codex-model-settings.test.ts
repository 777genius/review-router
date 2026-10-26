import {
  GATEWAY_CODEX_MODEL_SETTINGS_ENV,
  readAdmittedGatewayCodexModelSettings,
  resolveAdmittedGatewayCodexReasoningEffort,
  resolveAdmittedGatewayOcrReasoningEffort,
} from '../../../src/control-plane/admitted-gateway-codex-model-settings';
import type { AdmittedRuntimeConfig } from '../../../src/control-plane/runtime-config';

function capture(value: unknown): AdmittedRuntimeConfig {
  return {
    protocolVersion: 1,
    configVersion: 1,
    runtimeEnv: {
      [GATEWAY_CODEX_MODEL_SETTINGS_ENV]:
        typeof value === 'string' ? value : JSON.stringify(value),
    },
  };
}
const model = 'vendor/gpt-5.4-future';

describe('admitted Gateway Codex model settings', () => {
  it('binds and canonicalizes only admitted metadata, without ambient authority', () => {
    const previous = process.env[GATEWAY_CODEX_MODEL_SETTINGS_ENV];
    process.env[GATEWAY_CODEX_MODEL_SETTINGS_ENV] = JSON.stringify({
      model,
      reasoning: null,
    });
    try {
      expect(
        readAdmittedGatewayCodexModelSettings(undefined, model)
      ).toBeUndefined();
      const selected = readAdmittedGatewayCodexModelSettings(
        capture({
          model,
          reasoning: { allowed: ['max', 'minimal'], default: 'minimal' },
        }),
        model
      )!;
      expect(selected).toEqual({
        model,
        reasoning: { allowed: ['minimal', 'max'], default: 'minimal' },
      });
      expect(
        resolveAdmittedGatewayCodexReasoningEffort(selected, undefined)
      ).toBe('minimal');
      expect(
        resolveAdmittedGatewayCodexReasoningEffort(selected, 'ultra')
      ).toBe('max');
      expect(resolveAdmittedGatewayCodexReasoningEffort(selected, 'max')).toBe(
        'max'
      );
      expect(() =>
        resolveAdmittedGatewayCodexReasoningEffort(selected, 'high')
      ).toThrow('account_gateway_codex_reasoning_effort_unsupported');
      expect(Object.isFrozen(selected.reasoning!.allowed)).toBe(true);
    } finally {
      if (previous === undefined)
        delete process.env[GATEWAY_CODEX_MODEL_SETTINGS_ENV];
      else process.env[GATEWAY_CODEX_MODEL_SETTINGS_ENV] = previous;
    }
  });

  it('distinguishes disabled reasoning from missing legacy metadata', () => {
    const selected = readAdmittedGatewayCodexModelSettings(
      capture({ model, reasoning: null }),
      model
    )!;
    expect(
      resolveAdmittedGatewayCodexReasoningEffort(selected, undefined)
    ).toBeNull();
    expect(() =>
      resolveAdmittedGatewayCodexReasoningEffort(selected, 'minimal')
    ).toThrow('account_gateway_codex_reasoning_effort_unsupported');
    expect(
      readAdmittedGatewayCodexModelSettings(
        { protocolVersion: 1, configVersion: 1, runtimeEnv: {} },
        model
      )
    ).toBeUndefined();
  });

  it('retains legacy OCR effort only when captured metadata is absent', () => {
    expect(
      resolveAdmittedGatewayOcrReasoningEffort(undefined, model, 'high')
    ).toBe('high');
    expect(
      resolveAdmittedGatewayOcrReasoningEffort(
        capture({ model, reasoning: null }),
        model,
        'high'
      )
    ).toBeNull();
    expect(() =>
      resolveAdmittedGatewayOcrReasoningEffort(
        capture({ model: 'foreign-model', reasoning: null }),
        model,
        'high'
      )
    ).toThrow('account_gateway_codex_model_settings_invalid');
    expect(() =>
      resolveAdmittedGatewayOcrReasoningEffort(
        capture({
          model,
          reasoning: { allowed: ['minimal'], default: 'minimal' },
        }),
        model,
        'high'
      )
    ).toThrow('account_gateway_codex_reasoning_effort_unsupported');
    expect(() =>
      resolveAdmittedGatewayOcrReasoningEffort(
        capture({ model, reasoning: { allowed: ['max'], default: 'max' } }),
        model,
        null
      )
    ).toThrow('account_gateway_ocr_reasoning_effort_unsupported');
    expect(
      resolveAdmittedGatewayOcrReasoningEffort(undefined, model, 'max')
    ).toBe('max');
  });

  it.each([
    '',
    'x'.repeat(2049),
    { model, reasoning: null, instructions: 'untrusted' },
    { model: 'other-model', reasoning: null },
    { model: '../unsafe model', reasoning: null },
    { model, reasoning: { allowed: [], default: 'high' } },
    { model, reasoning: { allowed: ['high', 'high'], default: 'high' } },
    { model, reasoning: { allowed: ['high'], default: 'minimal' } },
    { model, reasoning: { allowed: ['ultra'], default: 'ultra' } },
    { model, reasoning: { allowed: ['none'], default: 'none' } },
    {
      model,
      reasoning: { allowed: ['high'], default: 'high', prompt: 'untrusted' },
    },
  ])('denies malformed, foreign or noncanonical settings %#', (value) => {
    expect(() =>
      readAdmittedGatewayCodexModelSettings(capture(value), model)
    ).toThrow('account_gateway_codex_model_settings_invalid');
  });
});
