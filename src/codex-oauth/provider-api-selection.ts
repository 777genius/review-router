import * as core from '../actions/core';
import { ConfigLoader } from '../config/loader';
import {
  isProviderApiAuthMode,
  providerApiAuthModes,
  providerApiDescriptors,
  type ProviderApiAuthMode,
} from '../control-plane/generated/review-action-v2/companion-contracts';
import type { CodexModelProvider } from '../providers/codex-output-schema';
import type { ReviewConfig } from '../types';
import {
  clearCodexRotatingProviderSecretEnv,
  clearCodexRotatingProviderSecretInputs,
} from './auth-input';

export type DirectProviderSelection = Readonly<{
  mode: ProviderApiAuthMode;
  providerName: string;
  model: string;
  modelProvider: CodexModelProvider;
}>;

/** Provider identity comes from the captured policy, never key presence or a URL. */
export function selectDirectProvider(
  config: ReviewConfig,
  expectedMode?: ProviderApiAuthMode
): DirectProviderSelection {
  const selected = config.providers[0];
  const mode = providerApiAuthModes.find((candidate) =>
    selected?.startsWith(`${providerApiDescriptors[candidate].runtimePrefix}/`)
  );
  if (
    !selected ||
    !mode ||
    (expectedMode !== undefined && mode !== expectedMode) ||
    config.providers.length !== 1 ||
    config.providerLimit !== 1 ||
    config.providerMaxParallel !== 1 ||
    config.inlineMinAgreement !== 1 ||
    config.synthesisModel !== selected ||
    config.fallbackProviders.length !== 0 ||
    config.requiredHealthyProviders?.length !== 1 ||
    config.requiredHealthyProviders[0] !== selected
  )
    throw new Error('review_action_v2_direct_provider_policy_invalid');
  const descriptor = providerApiDescriptors[mode];
  const model = selected.slice(descriptor.runtimePrefix.length + 1);
  if (
    mode === 'openrouter-api'
      ? !/^[A-Za-z0-9_.:~-]+(?:\/[A-Za-z0-9_.:~-]+)+$/.test(model)
      : model !== descriptor.defaultModel
  )
    throw new Error('review_action_v2_direct_provider_model_invalid');
  return Object.freeze({
    mode,
    providerName: selected,
    model,
    modelProvider:
      mode === 'mimo-token-plan-api'
        ? 'mimo'
        : mode === 'kimi-code-api'
          ? 'kimi'
          : 'openrouter',
  });
}

export function readDirectProviderSelection(
  env: Readonly<Record<string, string>>
): DirectProviderSelection {
  if (!isProviderApiAuthMode(env.REVIEW_AUTH_MODE))
    throw new Error('provider_api_admitted_configuration_invalid');
  const selection = selectDirectProvider(
    ConfigLoader.loadRuntimeEnvironment(env, { modelTransport: true }),
    env.REVIEW_AUTH_MODE
  );
  if (
    selection.mode === 'mimo-token-plan-api' &&
    env.CODEX_FAST_MODE === 'true'
  )
    throw new Error('provider_api_mimo_fast_unsupported');
  if (
    selection.mode === 'kimi-code-api' &&
    (env.CODEX_REASONING_EFFORT !== undefined || env.CODEX_FAST_MODE === 'true')
  )
    throw new Error('provider_api_kimi_options_unsupported');
  return selection;
}

export function providerApiSecretInputNames(
  mode: ProviderApiAuthMode
): readonly string[] {
  const secret = providerApiDescriptors[mode].secretName;
  return [`INPUT_${secret}`, `INPUT_${secret.replaceAll('_', '-')}`];
}

/** Raw direct-provider keys must never survive bootstrap or failure cleanup. */
export function clearProviderApiSecretEnv(
  env: NodeJS.ProcessEnv = process.env
): void {
  clearCodexRotatingProviderSecretEnv(env);
  for (const descriptor of Object.values(providerApiDescriptors))
    delete env[descriptor.secretName];
}

/** Read once into parent custody and scrub every selected/unselected input alias. */
export function readProviderApiSecret(
  mode: ProviderApiAuthMode,
  env: NodeJS.ProcessEnv = process.env
): string {
  try {
    let selected: string | undefined;
    for (const candidate of providerApiAuthModes) {
      for (const name of providerApiSecretInputNames(candidate)) {
        const value = env[name]?.trim();
        if (!value) continue;
        core.setSecret(value);
        if (
          candidate !== mode ||
          (selected !== undefined && selected !== value)
        )
          throw new Error('provider_api_alternate_auth_input');
        selected = value;
      }
    }
    if (!selected) throw new Error('provider_api_credential_missing');
    return selected;
  } finally {
    clearCodexRotatingProviderSecretInputs(env);
    clearProviderApiSecretEnv(env);
  }
}
