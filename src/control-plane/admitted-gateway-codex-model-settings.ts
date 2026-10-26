import type { AdmittedRuntimeConfig } from './runtime-config';

export const GATEWAY_CODEX_MODEL_SETTINGS_ENV =
  'REVIEW_ROUTER_GATEWAY_MODEL_SETTINGS_JSON';

const canonicalEfforts = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type GatewayCodexReasoningEffort = (typeof canonicalEfforts)[number];
export type AdmittedGatewayCodexModelSettings = Readonly<{
  model: string;
  reasoning: Readonly<{
    allowed: readonly GatewayCodexReasoningEffort[];
    default: GatewayCodexReasoningEffort;
  }> | null;
}>;

/** Read producer-owned capture only. An absent key is qualified legacy behavior. */
export function readAdmittedGatewayCodexModelSettings(
  runtime: AdmittedRuntimeConfig | undefined,
  selectedModel: string
): AdmittedGatewayCodexModelSettings | undefined {
  const raw = runtime?.runtimeEnv[GATEWAY_CODEX_MODEL_SETTINGS_ENV];
  if (raw === undefined) return undefined;
  const invalid = () =>
    new Error('account_gateway_codex_model_settings_invalid');
  if (Buffer.byteLength(raw, 'utf8') > 2048) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (!hasKeys(value, ['model', 'reasoning'])) throw invalid();
  if (
    typeof value.model !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value.model) ||
    value.model !== selectedModel
  )
    throw invalid();
  if (value.reasoning === null)
    return Object.freeze({ model: value.model, reasoning: null });
  if (!hasKeys(value.reasoning, ['allowed', 'default'])) throw invalid();
  const { allowed, default: defaultEffort } = value.reasoning;
  if (
    !Array.isArray(allowed) ||
    allowed.length === 0 ||
    allowed.length > 7 ||
    allowed.some((effort) => !isCanonicalEffort(effort)) ||
    new Set(allowed).size !== allowed.length ||
    !isCanonicalEffort(defaultEffort) ||
    !allowed.includes(defaultEffort)
  )
    throw invalid();
  return Object.freeze({
    model: value.model,
    reasoning: Object.freeze({
      allowed: Object.freeze(
        canonicalEfforts.filter((effort) => allowed.includes(effort))
      ),
      default: defaultEffort,
    }),
  });
}

export function resolveAdmittedGatewayCodexReasoningEffort(
  settings: AdmittedGatewayCodexModelSettings,
  savedEffort: string | undefined
): GatewayCodexReasoningEffort | null {
  const effective = savedEffort === 'ultra' ? 'max' : savedEffort;
  if (settings.reasoning === null) {
    if (effective !== undefined)
      throw new Error('account_gateway_codex_reasoning_effort_unsupported');
    return null;
  }
  const selected = effective ?? settings.reasoning.default;
  if (
    !isCanonicalEffort(selected) ||
    !settings.reasoning.allowed.includes(selected)
  )
    throw new Error('account_gateway_codex_reasoning_effort_unsupported');
  return selected;
}

/** OCR may inherit an older saved effort from review configuration. A captured
 * model capability is authoritative for the request; absent metadata retains
 * the qualified legacy setting instead of inventing unsupported capabilities. */
export function resolveAdmittedGatewayOcrReasoningEffort(
  runtime: AdmittedRuntimeConfig | undefined,
  selectedModel: string,
  savedEffort: string | null
): string | null {
  const settings = readAdmittedGatewayCodexModelSettings(
    runtime,
    selectedModel
  );
  if (settings === undefined) return savedEffort;
  if (settings.reasoning === null) return null;
  const selected = resolveAdmittedGatewayCodexReasoningEffort(
    settings,
    savedEffort ?? undefined
  );
  // The approved managed OCR protocol supports through xhigh; Codex's max
  // cannot be passed to that binary merely because the model accepts it.
  if (selected === 'max')
    throw new Error('account_gateway_ocr_reasoning_effort_unsupported');
  return selected;
}

function isCanonicalEffort(
  value: unknown
): value is GatewayCodexReasoningEffort {
  return (
    typeof value === 'string' &&
    (canonicalEfforts as readonly string[]).includes(value)
  );
}

function hasKeys(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}
