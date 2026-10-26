/**
 * Managed OCR run primitives (plan 56, §5.1, §7.4, §8.4, §9).
 *
 * Deterministic argv/config/environment construction, bounded output reads
 * after process close, and the strict §8.4 acceptance order. Nothing here
 * performs model calls or derives success from a readable JSON alone.
 */

import {
  OcrNativeResultContractViolation,
  parseOcrNativeReviewResult,
  classifyOcrReviewOutcome,
  type OcrNativeManifestAdmission,
  type OcrNativeReviewResult,
  type OcrOutcomeClassification,
} from './ocr-review-outcome-contract';
import {
  OcrOutputTooLargeError,
  normalizeOcrFindings,
  type OcrNormalizedFindings,
} from './ocr-review-normalization';
import type { TokenUsage } from '../../types';
import type { AdmittedRuntimeConfig } from '../../control-plane/runtime-config';
import { resolveAdmittedGatewayOcrReasoningEffort } from '../../control-plane/admitted-gateway-codex-model-settings';
import { anthropicReasoningEffort } from './anthropic-messages-codec';

export type OcrModelProtocol = 'openai-responses' | 'anthropic-messages';

/** Managed result file bound from the OCR release manifest (§9). */
export const OCR_RESULT_FILE_LIMIT_BYTES = 16 * 1024 * 1024;
/** Bounded stdout/stderr tail per stream (§9). */
export const OCR_DIAGNOSTIC_TAIL_LIMIT_BYTES = 64 * 1024;

export type OcrManagedLimits = Readonly<{
  /** Captured per-subtask timeout in minutes; absent stays absent (§5.1). */
  timeoutMinutes?: number;
  /** Captured per-group max tokens; absent stays absent. */
  maxTokens?: number;
  /** Captured aggregate token budget; absent stays absent. */
  maxTokensBudget?: number;
  /** Captured per-HTTP-request cap in seconds; always positive. */
  requestTimeoutSec: number;
}>;

export type OcrReviewArgvInput = Readonly<{
  binaryPath: string;
  /** Isolated checkout root passed as --repo. */
  repoPath: string;
  mergeBaseSha: string;
  headSha: string;
  model: string;
  rulePath: string;
  backgroundPath: string | null;
  outputPath: string;
  /** OCR engine effort for the first approved profile: medium (§6). */
  effort: 'low' | 'medium' | 'high';
  limits: OcrManagedLimits;
  /** Deterministic prepare-time preview; never a model run (§5.1). */
  preview: boolean;
}>;

function requirePositiveSetting(
  value: number | undefined,
  field: string
): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value <= 0) {
    // 0 is never a stand-in for "unlimited"; absence omits the flag (§5.1).
    throw new Error(`review_action_v2_ocr_limit_invalid:${field}`);
  }
}

/**
 * Normative §5.1 argv. The caller launches it with execFile/spawn and
 * shell=false; names here are captured values, never shell substitutions.
 * No --resume, --commit or --tools; native embedded tools are used.
 */
export function buildOcrReviewArgv(
  input: OcrReviewArgvInput
): readonly string[] {
  requirePositiveSetting(input.limits.timeoutMinutes, 'timeout');
  requirePositiveSetting(input.limits.maxTokens, 'max_tokens');
  requirePositiveSetting(input.limits.maxTokensBudget, 'max_tokens_budget');
  if (
    !Number.isSafeInteger(input.limits.requestTimeoutSec) ||
    input.limits.requestTimeoutSec <= 0
  ) {
    throw new Error('review_action_v2_ocr_limit_invalid:timeout_sec');
  }
  if (
    !/^[a-f0-9]{40}$/i.test(input.mergeBaseSha) ||
    !/^[a-f0-9]{40}$/i.test(input.headSha)
  ) {
    throw new Error('review_action_v2_ocr_argv_refs_invalid');
  }
  const argv = [
    'review',
    '--reviewrouter-managed',
    '--repo',
    input.repoPath,
    '--from',
    input.mergeBaseSha.toLowerCase(),
    '--to',
    input.headSha.toLowerCase(),
    '--provider',
    'reviewrouter',
    '--model',
    input.model,
    '--rule',
    input.rulePath,
  ];
  if (input.backgroundPath !== null) {
    argv.push('--background-file', input.backgroundPath);
  }
  argv.push(
    '--effort',
    input.effort,
    '--concurrency',
    '1',
    '--format',
    'json',
    '--audience',
    'agent'
  );
  if (input.limits.timeoutMinutes !== undefined) {
    argv.push('--timeout', String(input.limits.timeoutMinutes));
  }
  if (input.limits.maxTokens !== undefined) {
    argv.push('--max-tokens', String(input.limits.maxTokens));
  }
  if (input.limits.maxTokensBudget !== undefined) {
    argv.push('--max-tokens-budget', String(input.limits.maxTokensBudget));
  }
  if (input.preview) argv.push('--preview');
  argv.push('--output', input.outputPath);
  return Object.freeze(argv);
}

/**
 * The controlled provider section written to HOME/.opencodereview/config.json
 * (§5.1 table). `url` is exactly the loopback baseUrl: no /v1 and no extra
 * /responses suffix. `api_key` is the raw loopback capability without the
 * Bearer prefix; the Go SDK adds it.
 */
export function buildOcrManagedConfigJson(input: {
  readonly baseUrl: string;
  readonly rawCapability: string;
  readonly model: string;
  readonly protocol?: OcrModelProtocol;
  readonly limits: OcrManagedLimits;
  readonly modelReasoningEffort: string | null;
  readonly admittedRuntimeConfig?: AdmittedRuntimeConfig;
  readonly language: string | null;
  readonly contextTools?: Readonly<{
    url: string;
    capability: string;
    tools: readonly string[];
  }>;
}): string {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(input.baseUrl)) {
    throw new Error('review_action_v2_ocr_config_base_url_invalid');
  }
  if (!/^[A-Za-z0-9._~+/=-]{16,512}$/.test(input.rawCapability)) {
    throw new Error('review_action_v2_ocr_config_capability_invalid');
  }
  requirePositiveSetting(input.limits.timeoutMinutes, 'timeout');
  const protocol = input.protocol ?? 'openai-responses';
  if (protocol !== 'openai-responses' && protocol !== 'anthropic-messages')
    throw new Error('review_action_v2_ocr_protocol_invalid');
  const extraBody: Record<string, unknown> =
    protocol === 'anthropic-messages' ? {} : { service_tier: 'default' };
  if (protocol === 'anthropic-messages') {
    if (input.modelReasoningEffort !== null)
      extraBody.output_config = {
        effort: anthropicReasoningEffort(input.modelReasoningEffort),
      };
  } else {
    const modelReasoningEffort = resolveAdmittedGatewayOcrReasoningEffort(
      input.admittedRuntimeConfig,
      input.model,
      input.modelReasoningEffort
    );
    if (modelReasoningEffort !== null)
      extraBody.reasoning = { effort: modelReasoningEffort };
  }
  const provider: Record<string, unknown> = {
    protocol:
      protocol === 'anthropic-messages' ? 'anthropic' : 'openai-responses',
    url: input.baseUrl,
    api_key: input.rawCapability,
    model: input.model,
    timeout_sec: input.limits.requestTimeoutSec,
    extra_body: extraBody,
  };
  const config: Record<string, unknown> = {
    provider: 'reviewrouter',
    custom_providers: { reviewrouter: provider },
    telemetry: { enabled: false },
  };
  if (input.contextTools) {
    const mcp = input.contextTools;
    if (
      !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/mcp$/.test(mcp.url) ||
      !/^[a-f0-9]{64}$/.test(mcp.capability) ||
      !mcp.tools.length ||
      new Set(mcp.tools).size !== mcp.tools.length ||
      mcp.tools.some((name) => !/^[A-Za-z0-9_]{1,64}$/.test(name))
    )
      throw new Error('context_tools_managed_config_invalid');
    config.mcp_servers = {
      reviewrouter_context: {
        type: 'remote',
        url: mcp.url,
        headers: { Authorization: `Bearer ${mcp.capability}` },
        tools: [...mcp.tools],
      },
    };
  }
  if (input.language !== null) config.language = input.language;
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Extract the raw loopback capability from the bridge Authorization value
 * `Bearer HEX_TOKEN` (§5.1). Exactly one expected prefix; never log the value.
 */
export function extractRawLoopbackCapability(
  authorizationValue: string
): string {
  const match = authorizationValue.match(
    /^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/
  );
  if (!match) {
    throw new Error('review_action_v2_ocr_capability_format_invalid');
  }
  return match[1];
}

/**
 * Minimal isolated child environment (§5.1/§5): no parent SCM/control
 * credentials, no inherited OCR config or telemetry; only the fixed trusted
 * PATH, the private HOME, hardened Git settings and the loopback capability.
 */
export function buildOcrChildEnvironment(input: {
  readonly homeDirectory: string;
  readonly capabilityAuthorization: string;
  readonly path: string | undefined;
}): Readonly<NodeJS.ProcessEnv> {
  if (
    !/^Bearer [A-Za-z0-9._~+/=-]{16,512}$/.test(input.capabilityAuthorization)
  ) {
    throw new Error('review_action_v2_ocr_capability_format_invalid');
  }
  return Object.freeze({
    PATH: input.path ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: input.homeDirectory,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    REVIEWROUTER_LOCAL_MODEL_TOKEN: input.capabilityAuthorization,
  });
}

export type OcrReviewProcessResult = Readonly<{
  /** True only after the child closed and all streams drained. */
  closed: true;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: string;
  stdoutTail: string;
  stderrTail: string;
}>;

/**
 * Read the managed --output file strictly after process close (§8.4 step 4).
 * Bounded to the 16 MiB release limit; oversized output is an explicit
 * failure, never silent truncation.
 */
export async function readOcrOutputFileAfterClose(
  readFile: (path: string) => Promise<Buffer>,
  statSize: (path: string) => Promise<number>,
  outputPath: string
): Promise<Buffer> {
  const size = await statSize(outputPath);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error('review_action_v2_ocr_output_stat_invalid');
  }
  if (size > OCR_RESULT_FILE_LIMIT_BYTES) {
    throw new OcrOutputTooLargeError('result_file');
  }
  const bytes = await readFile(outputPath);
  if (bytes.length > OCR_RESULT_FILE_LIMIT_BYTES) {
    throw new OcrOutputTooLargeError('result_file');
  }
  return bytes;
}

export function truncateDiagnosticTail(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= OCR_DIAGNOSTIC_TAIL_LIMIT_BYTES) return value;
  return bytes.subarray(0, OCR_DIAGNOSTIC_TAIL_LIMIT_BYTES).toString('utf8');
}

export class OcrReviewAcceptanceError extends Error {
  constructor(
    readonly code:
      | 'gateway_effect_unknown'
      | 'review_agent_not_dispatched'
      | 'process_failed'
      | 'output_unreadable'
      | 'result_contract'
      | 'no_model_requests'
      | 'actual_model_missing'
      | 'coverage_mismatch',
    detail: string
  ) {
    super(`review_action_v2_ocr_${code}${detail ? `:${detail}` : ''}`);
    this.name = 'OcrReviewAcceptanceError';
  }
}

export type OcrAcceptedReviewResult = Readonly<{
  native: OcrNativeReviewResult;
  classification: OcrOutcomeClassification;
  normalized: OcrNormalizedFindings;
  /** Observed model attribution; never requestedModel (§8.4 step 5). */
  actualModel: string;
  usage: TokenUsage;
  /** Bounded local diagnostic codes; never new wire keys (§8.2). */
  reasons: readonly string[];
  partial: boolean;
  /** Inventory paths with no outcome group (§8.2 missing_paths limitation). */
  uncoveredPaths: readonly string[];
}>;

/**
 * §8.4 acceptance order 1-8 for a fresh execute. The caller has already
 * checked authority/revision (step 1) and passes only a fully closed process.
 * A readable JSON never rescues a failed process, an unknown Gateway effect,
 * missing model attribution or a coverage mismatch.
 */
export function acceptOcrManagedReviewResult(input: {
  readonly admission: OcrNativeManifestAdmission;
  /** Gateway effect facts of the run; terminal/unknown effect fails closed. */
  readonly effectFacts?: Readonly<{ effect: string }> | undefined;
  readonly process: OcrReviewProcessResult;
  /** Result bytes read after close via readOcrOutputFileAfterClose. */
  readonly resultBytes: Buffer;
  /** Observed completed-response model from the loopback bridge. */
  readonly observedActualModel: string | undefined;
  /** Observed request count from the loopback bridge; 0 means no requests. */
  readonly observedRequestCount: number | undefined;
  /** Canonical assigned inventory prepared before dispatch (§8.4 step 6). */
  readonly expectedPaths: readonly string[];
  /** path -> authorized HEAD content; a lazy loader is allowed. */
  readonly headFiles: Readonly<{ get(path: string): string | undefined }>;
  readonly diffPositions?: ReadonlyMap<string, ReadonlyMap<number, number>>;
}): OcrAcceptedReviewResult {
  // Step 2: Gateway effect facts before any output interpretation.
  // A positively proven not_dispatched effect is a distinct retry-safe failure
  // (§8.4 step 2), not an unknown effect that could have been paid.
  if (input.effectFacts && input.effectFacts.effect !== 'none') {
    if (input.effectFacts.effect === 'not_dispatched') {
      throw new OcrReviewAcceptanceError(
        'review_agent_not_dispatched',
        input.effectFacts.effect
      );
    }
    throw new OcrReviewAcceptanceError(
      'gateway_effect_unknown',
      input.effectFacts.effect
    );
  }
  // Step 3: only a cleanly closed exit-0 process may produce an observation.
  if (
    input.process.spawnError !== undefined ||
    input.process.exitCode !== 0 ||
    input.process.signal !== null ||
    !input.process.closed
  ) {
    throw new OcrReviewAcceptanceError(
      'process_failed',
      `exit=${input.process.exitCode ?? 'none'}${
        input.process.signal ? ` signal=${input.process.signal}` : ''
      }${input.process.spawnError ? ' spawn_error' : ''}`
    );
  }
  // Step 4: output parsed only after close, strictly bounded.
  let native: OcrNativeReviewResult;
  let raw: unknown;
  try {
    raw = JSON.parse(input.resultBytes.toString('utf8'));
  } catch {
    throw new OcrReviewAcceptanceError('result_contract', 'unparsable_json');
  }
  try {
    native = parseOcrNativeReviewResult(raw, input.admission);
  } catch (error) {
    if (error instanceof OcrNativeResultContractViolation) {
      throw new OcrReviewAcceptanceError(
        'result_contract',
        error.issues.map((issue) => issue.code).join(',')
      );
    }
    throw error;
  }
  // Step 5: observed actualModel is required; requestedModel never substitutes.
  if (input.observedRequestCount === 0) {
    // Proven zero requests: no success observation is possible (§8.4 table).
    throw new OcrReviewAcceptanceError('no_model_requests', '');
  }
  if (input.observedActualModel === undefined) {
    throw new OcrReviewAcceptanceError('actual_model_missing', '');
  }
  // Step 6: reconcile outcome paths with the prepared canonical inventory.
  // Paths reported outside the inventory (or duplicated) are a genuine
  // contradiction and fail closed; inventory paths without any outcome group
  // (deleted/binary/preview-excluded files the producer never grouped) are a
  // bounded missing_paths limitation, not a fatal mismatch (§8.1/§8.2).
  const expected = new Set(input.expectedPaths);
  const observed = new Set<string>();
  for (const group of native.outcome.groups) {
    for (const path of group.paths) {
      if (!expected.has(path) || observed.has(path)) {
        throw new OcrReviewAcceptanceError('coverage_mismatch', path);
      }
      observed.add(path);
    }
  }
  const uncoveredPaths = Object.freeze(
    [...expected].filter((path) => !observed.has(path)).sort()
  );
  // Step 7: normalize only usable findings; §8.2 skips and bounds apply.
  let normalized: OcrNormalizedFindings;
  try {
    normalized = normalizeOcrFindings({
      comments: native.comments,
      assignedPaths: input.expectedPaths,
      headFiles: input.headFiles,
      ...(input.diffPositions ? { diffPositions: input.diffPositions } : {}),
    });
  } catch (error) {
    if (error instanceof OcrOutputTooLargeError) {
      throw new OcrReviewAcceptanceError(
        'result_contract',
        `bound=${error.bound}`
      );
    }
    throw error;
  }
  const classification = classifyOcrReviewOutcome(native.outcome);
  const reasons = [
    ...new Set([
      ...classification.reasons,
      ...normalized.diagnostics.reasons,
      ...(uncoveredPaths.length > 0 ? ['missing_paths'] : []),
    ]),
  ].sort();
  const usage: TokenUsage = {
    promptTokens: native.usage.inputTokens ?? 0,
    completionTokens: native.usage.outputTokens ?? 0,
    totalTokens:
      native.usage.totalTokens ??
      (native.usage.inputTokens ?? 0) + (native.usage.outputTokens ?? 0),
  };
  return Object.freeze({
    native,
    classification,
    normalized,
    actualModel: input.observedActualModel,
    usage,
    reasons: Object.freeze(reasons),
    partial:
      classification.partial ||
      normalized.diagnostics.partialFlagsRequired ||
      uncoveredPaths.length > 0,
    uncoveredPaths,
  });
}
