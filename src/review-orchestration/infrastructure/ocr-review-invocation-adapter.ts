import {
  projectReviewSkillsForPaths,
  type ReviewSkillsExecutionInput,
} from '../../review-skills/review-skills';
import type { FreshReviewSkillsSupply } from '../../review-skills/review-skills-receipt';
import { CONTEXT_TOOLS_PROFILE } from '../../context-tools/contract';
import type { ReviewMemorySession } from '../../control-plane/review-memory-v2';
import {
  ReviewInvocationConfigurationMismatchError,
  ReviewInvocationConfigurationMismatchReason,
} from '../application/review-invocation-failure';
import type {
  ContextToolsBroker,
  ContextToolsReceipt,
} from '../../context-tools/broker';
/**
 * Managed OCR invocation adapter (plan 56, §4.2-4.3, §5.1, §8.2-8.4).
 *
 * One FindingDiscovery slot covers the whole canonical eligible inventory
 * with a single vote identity. prepare is model-free: deterministic preview
 * plus semantic capture. execute runs exactly one managed OCR review and
 * accepts its result only through the §8.4 order. OCR never carries an RR
 * investigation probe plan; `investigationProbePlan` stays null.
 */

import { createHash } from 'crypto';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { mapLinesToPositions } from '../../utils/diff';
import { PROVIDER_EXECUTION_CONTRACT_VERSION } from '../../providers/prepared-invocation';
import type {
  LifecycleTarget,
  PRContext,
  ReviewConfig,
  ReviewResult,
} from '../../types';
import {
  ReviewExecutionProviderKind,
  ReviewTaskKind,
  type PreparedReviewInvocation,
  type PreparedReviewInvocationPort,
  type ProviderInvocationManifest,
  type ReviewInvocationLease,
  type ReviewObservationPayload,
  type ReviewRunAuthorization,
  type ReviewWorkSlotPlan,
} from '../application';
import {
  createReviewPromptCoverageManifest,
  createStableReviewBatchId,
  createStableReviewWorkPlan,
} from '../domain';
import {
  PreparedPromptPathCoverageKind,
  type PreparedPromptPathCoverage,
} from '../../analysis/llm/prepared-review-prompt';
import { normalizeReviewObservation } from './review-observation-normalizer';
import {
  OCR_NORMALIZATION_LIMITS,
  OcrOutputTooLargeError,
} from './ocr-review-normalization';
import {
  OCR_OUTCOME_SCHEMA_VERSION,
  OCR_OUTCOME_DIAGNOSTIC_REASONS,
  type OcrNativeManifestAdmission,
} from './ocr-review-outcome-contract';
import {
  acceptOcrManagedReviewResult,
  buildOcrChildEnvironment,
  buildOcrReviewArgv,
  readOcrOutputFileAfterClose,
  truncateDiagnosticTail,
  type OcrManagedLimits,
  type OcrReviewProcessResult,
} from './ocr-review-managed-run';

const OCR_ADAPTER_CONTRACT_VERSION = 'ocr-managed-review.v1';
const OCR_RETRY_POLICY_VERSION = 'ocr-managed-bounded-retry.v2';
/** Bounded retries after positively proven unpaid denials only; a paid or
 * unknown effect never replays (§8.4 step 2). */
const OCR_ATTEMPT_BUDGET = 3;

export type OcrReviewAssignment = Readonly<{
  workSlot: ReviewWorkSlotPlan;
  reviewRevisionHash: string;
  mergeBaseSha: string;
  context: PRContext;
  lifecycleTargets: readonly LifecycleTarget[];
  liveLifecycleStateHash: string;
}>;

export type OcrLoopbackBridge = Readonly<{
  baseUrl: string;
  /** Full loopback Authorization value `Bearer <hex>`; never logged. */
  capabilityAuthorization: string;
  /** Observed completed-response model; undefined without attribution. */
  actualModel(): string | undefined;
  /** Observed model requests of this run; proven 0 rejects any success. */
  requestCount(): number | undefined;
  /** Terminal Gateway effect facts; `effect: 'none'` is the safe state. */
  effectFacts?(): Readonly<{ effect: string }> | undefined;
  /** Releases only positively proven unpaid pre-dispatch denials (§8.4 step 2);
   * false for unknown/paid effects. */
  releaseRetrySafeFailure?(): boolean;
  /** Compatibility seam only. OCR dispatch uses the positive unpaid-denial
   * release above and never reopens an ambiguous dispatch through this seam. */
  reopenConsumer?(): boolean;
}>;

export type OcrReviewProcessRunner = (input: {
  readonly binaryPath: string;
  readonly argv: readonly string[];
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly cwd: string;
  readonly signal: AbortSignal;
}) => Promise<OcrReviewProcessResult>;

export type OcrPreviewRunner = (input: {
  readonly binaryPath: string;
  readonly argv: readonly string[];
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly outputPath: string;
}) => Promise<OcrReviewProcessResult>;

export type OcrManagedRunLayout = Readonly<{
  /** Private disposable run directory owned by this run (§5.1). */
  runDirectory: string;
  homeDirectory: string;
  configPath: string;
  rulePath: string;
  backgroundPath: string | null;
}>;

const OCR_ACCEPTANCE_DIAGNOSTIC_REASONS = [
  ...OCR_OUTCOME_DIAGNOSTIC_REASONS,
  'unverified_native_span',
  'unclassified_native_severity',
] as const;

export type OcrReviewAcceptanceDiagnostic = Readonly<{
  reasons: readonly (typeof OCR_ACCEPTANCE_DIAGNOSTIC_REASONS)[number][];
  acceptedPartial: boolean;
  classificationPartial: boolean;
  normalizationPartial: boolean;
  skippedFindingCount: number;
  uncoveredPathCount: number;
  nativeCommentCount: number;
  normalizedFindingCount: number;
}>;

export type OcrReviewInvocationOptions = Readonly<{
  /** Root cancellation also owns the model-free preparation process. */
  signal?: AbortSignal;
  /** Remaining preparation window captured from the execution deadline. */
  previewTimeoutMs?: () => number;
  model: string;
  binaryPath: string;
  binarySha256: string;
  packageVersion: string;
  profileRef: string;
  run: OcrManagedRunLayout;
  bridge: OcrLoopbackBridge;
  limits: OcrManagedLimits;
  ocrEffort: 'low' | 'medium' | 'high';
  modelReasoningEffort: string | null;
  language: string | null;
  /** Controlled additive rule text; also the full reviewPrompt (§4.2). */
  ruleText: string;
  reviewSkills?: ReviewSkillsExecutionInput;
  reviewMemory?: Pick<ReviewMemorySession, 'current'>;
  freshReviewSkillsSupply?: (supply: FreshReviewSkillsSupply) => void;
  /** Untrusted PR business context; repository text, never tool policy. */
  backgroundText: string | null;
  checkoutRoot: string;
  processRunner: OcrReviewProcessRunner;
  previewRunner: OcrPreviewRunner;
  acceptanceDiagnostic?: (diagnostic: OcrReviewAcceptanceDiagnostic) => void;
  contextTools?: Pick<ContextToolsBroker, 'receipt' | 'beginNativeSession'>;
  contextToolsReceipt?: (receipt: ContextToolsReceipt) => void;
}>;

export type OcrPreparedReviewInvocation = PreparedReviewInvocation & {
  /** In-memory only; never log or persist these hashes' preimages. */
  readonly manifestPreimages: Readonly<{
    semanticIdentityPreimage: string;
    providerCapabilityHash: string;
    outputSchemaHash: string;
    filePatchManifestHash: string;
    contextManifestHash: string;
    toolPolicyHash: string;
    environmentContractHash: string;
  }>;
  readonly semanticIdentityHash: string;
  readonly previewSelectedPaths: readonly string[];
};

/** Typed in-memory request without upstream/control credentials (§4.2). */
export type OcrManagedInvocationRequest = Readonly<{
  kind: typeof OCR_ADAPTER_CONTRACT_VERSION;
  revision: OcrNativeManifestAdmission;
  assignedPaths: readonly string[];
  ruleTextHash: string;
  backgroundTextHash: string | null;
  binary: Readonly<{
    profileRef: string;
    sha256: string;
    packageVersion: string;
  }>;
  model: string;
  ocrEffort: 'low' | 'medium' | 'high';
  modelReasoningEffort: string | null;
  language: string | null;
  limits: OcrManagedLimits;
  outputContract: typeof OCR_OUTCOME_SCHEMA_VERSION;
  retryPolicyVersion: typeof OCR_RETRY_POLICY_VERSION;
}>;

/**
 * §6 additive rule text only: output language, material introduced/aggravated
 * issues, causal base-to-head description and allowed scope. Never the Codex
 * prompt, gateway instructions or previous investigation results.
 */
export function buildOcrControlledRuleText(input: {
  readonly language: string | null;
  readonly assignedPaths: readonly string[];
}): string {
  const rule = [
    'ReviewRouter managed additive policy (reviewrouter-managed-v1).',
    'Report only issues material to this change: introduced or aggravated by the base-to-head diff.',
    'For every finding describe the causal base-to-head change that creates or worsens the issue.',
    'Allowed finding scope is the reviewed changed paths assigned to this run.',
    input.language !== null
      ? `Write finding titles and messages in ${input.language}.`
      : 'Write finding titles and messages in the repository language.',
  ].join('\n');
  return `${JSON.stringify(
    {
      merge_system_rule: true,
      include: [...input.assignedPaths].sort(),
      rules: [{ id: 'reviewrouter-managed-v1', content: rule }],
    },
    null,
    2
  )}\n`;
}

/** Corrected transport for a qualified Skills profile. Every exact path owns
 * one precomposed rule, because the upstream resolver uses first match wins. */
export function buildOcrSkillsControlledRuleText(input: {
  readonly language: string | null;
  readonly assignedPaths: readonly string[];
  readonly reviewSkills: ReviewSkillsExecutionInput;
}): string {
  if (input.reviewSkills.kind !== 'captured')
    throw new Error('review_skills_attachment_required');
  const legacy = JSON.parse(buildOcrControlledRuleText(input)) as {
    rules: { content: string }[];
  };
  const paths = [...new Set(input.assignedPaths)].sort();
  return `${JSON.stringify(
    {
      reviewrouter_managed_paths: paths,
      rules: projectReviewSkillsForPaths(input.reviewSkills, paths).map(
        (item) => ({
          path: item.path,
          rule: [
            legacy.rules[0].content,
            `Captured review skills: ${input.reviewSkills.kind === 'captured' ? input.reviewSkills.capture.digest : ''}`,
            `Materialized review skills: ${input.reviewSkills.kind === 'captured' ? input.reviewSkills.bundle.executionDigest : ''}`,
            'Text-only instructions for this exact reviewed path; no additional tool, network, execution or file authority.',
            item.instructions,
          ].join('\n'),
          merge_system_rule: true,
          reviewrouter_exact_path: true,
        })
      ),
    },
    null,
    2
  )}\n`;
}

/**
 * Upstream OCR hard-aborts when --background-file content exceeds 8000
 * characters ("background content is N characters, exceeding the hard limit
 * of 8000 (aborting)"), so bound the background before it reaches the
 * semantic identity preimage and the background file. Verified boundary:
 * 8000 characters continue, 8001 abort.
 */
/** Append the identical memory bytes to every exact-path rule. The managed
 * runner chooses one rule per path; adding an unrelated global rule would lose
 * either memory or the captured review skills under first-match resolution. */
function appendOcrReviewMemory(ruleText: string, memory: string): string {
  const document = JSON.parse(ruleText) as { rules: Record<string, unknown>[] };
  if (!Array.isArray(document.rules) || document.rules.length === 0) {
    throw new Error('review_memory_ocr_rule_invalid');
  }
  for (const rule of document.rules) {
    const key = typeof rule.rule === 'string' ? 'rule' : 'content';
    if (typeof rule[key] !== 'string')
      throw new Error('review_memory_ocr_rule_invalid');
    rule[key] = `${rule[key]}\n\n${memory}`;
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

export const OCR_BACKGROUND_HARD_CHAR_LIMIT = 8000;

export function boundOcrBackgroundText(
  backgroundText: string | null
): string | null {
  if (
    backgroundText === null ||
    backgroundText.length <= OCR_BACKGROUND_HARD_CHAR_LIMIT
  ) {
    return backgroundText;
  }
  const kept: string[] = [];
  let utf16Length = 0;
  for (const char of backgroundText) {
    if (
      kept.length + 1 > OCR_BACKGROUND_HARD_CHAR_LIMIT ||
      utf16Length + char.length > OCR_BACKGROUND_HARD_CHAR_LIMIT
    ) {
      break;
    }
    kept.push(char);
    utf16Length += char.length;
  }
  return kept.join('');
}

/**
 * §8.3 semantic identity preimage: refs/trees, engine + binary identity,
 * rules/background, model, effort, budgets and output contract. Excludes URL,
 * capability token, temp paths, session ids and loopback ports entirely; those
 * change per run while the semantic identity must not.
 */
export function buildOcrSemanticInvocationPreimage(input: {
  readonly revision: OcrNativeManifestAdmission;
  readonly assignedPaths: readonly string[];
  readonly ruleText: string;
  readonly backgroundText: string | null;
  readonly binary: Readonly<{
    profileRef: string;
    sha256: string;
    packageVersion: string;
  }>;
  readonly model: string;
  readonly ocrEffort: 'low' | 'medium' | 'high';
  readonly modelReasoningEffort: string | null;
  readonly language: string | null;
  readonly limits: OcrManagedLimits;
  readonly retryPolicyVersion: string;
  readonly attemptBudget: number;
  readonly contextToolsPolicy?: Readonly<{
    planDigest: string;
    schemaDigest: string;
    tools: readonly string[];
  }>;
}): string {
  return canonicalJson({
    contract: 'ocr-semantic-identity.v1',
    ...(input.contextToolsPolicy
      ? { contextToolsPolicy: input.contextToolsPolicy }
      : {}),
    revision: {
      baseSha: input.revision.baseSha.toLowerCase(),
      mergeBaseSha: input.revision.mergeBaseSha.toLowerCase(),
      headSha: input.revision.headSha.toLowerCase(),
    },
    assignedPaths: [...new Set(input.assignedPaths)].sort(),
    engine: {
      profileRef: input.binary.profileRef,
      binarySha256: input.binary.sha256,
      packageVersion: input.binary.packageVersion,
    },
    rules: {
      ruleTextHash: sha256(input.ruleText),
      backgroundTextHash:
        input.backgroundText === null ? null : sha256(input.backgroundText),
    },
    model: {
      model: input.model,
      ocrEffort: input.ocrEffort,
      modelReasoningEffort: input.modelReasoningEffort,
      language: input.language,
    },
    budgets: {
      timeoutMinutes: input.limits.timeoutMinutes ?? null,
      maxTokens: input.limits.maxTokens ?? null,
      maxTokensBudget: input.limits.maxTokensBudget ?? null,
      requestTimeoutSec: input.limits.requestTimeoutSec,
    },
    transportPolicy: 'account-gateway-loopback-v1',
    outputContract: OCR_OUTCOME_SCHEMA_VERSION,
    retryPolicyVersion: input.retryPolicyVersion,
    attemptBudget: input.attemptBudget,
  });
}

/**
 * One FindingDiscovery slot over the whole canonical eligible inventory with
 * one vote identity (§4.3). RR batching/token compaction never split this
 * input; OCR groups internally. OCR findings are not lifecycle verdicts, so
 * lifecycle targets stay carried-unverified ("resolution not established")
 * instead of revalidated.
 */
export function planOcrReviewAssignments(input: {
  readonly reviewerId?: string;
  readonly reviewerRequired?: boolean;
  readonly prDescriptionEnabled?: boolean;
  readonly authorization: ReviewRunAuthorization;
  readonly pr: PRContext;
  readonly config: ReviewConfig;
  readonly compatibilityKey: string;
  readonly lifecycleTargets: readonly LifecycleTarget[];
  readonly liveLifecycleStateHash: string;
}): {
  readonly plan: ReturnType<typeof createStableReviewWorkPlan>;
  readonly assignments: readonly OcrReviewAssignment[];
  readonly uncoveredPaths: readonly string[];
  readonly uncoveredLifecycleTargetIds: readonly string[];
} {
  const ocrLanes = input.authorization.facts.providerVoteLanes.filter(
    (lane) => lane.providerKind === ReviewExecutionProviderKind.Ocr
  );
  if (ocrLanes.length !== 1) {
    throw new Error('review_action_v2_ocr_vote_lane_ambiguous');
  }
  const files = [...input.pr.files].sort((left, right) =>
    left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0
  );
  const paths = files.map((file) => file.filename);
  // OCR produces no lifecycle verdicts (§4.3), so no lifecycle target can be
  // revalidated here. Targets keep their carried-unverified facts ("resolution
  // not established") exactly like a codex slot that returned no verdict, and a
  // verdict gap is not dropped coverage the way an unassigned target would be.
  const uncoveredLifecycleTargetIds = Object.freeze([]) as readonly string[];
  const plan = createStableReviewWorkPlan({
    reviewRevisionHash: input.authorization.facts.reviewRevisionHash,
    compatibilityKey: input.compatibilityKey,
    providers: [
      {
        providerName: input.reviewerId
          ? `ocr/managed:${input.reviewerId}`
          : 'ocr/managed',
        providerKind: ReviewExecutionProviderKind.Ocr,
        providerVoteIdentityHash: ocrLanes[0].providerVoteIdentityHash,
        required: input.reviewerRequired ?? true,
        attemptBudget: Math.min(
          OCR_ATTEMPT_BUDGET,
          Math.max(1, input.authorization.limits.maxAttemptsPerSlot)
        ),
        retryPolicyVersion: OCR_RETRY_POLICY_VERSION,
      },
    ],
    batches: [
      {
        batchId: createStableReviewBatchId({
          taskKind: ReviewTaskKind.FindingDiscovery,
          members: files,
        }),
        taskKind: ReviewTaskKind.FindingDiscovery,
        required: true,
        paths,
        schedulingOrdinal: 0,
      },
      ...(input.prDescriptionEnabled &&
      input.authorization.limits.maxWorkSlots > 1
        ? [
            {
              batchId: createStableReviewBatchId({
                taskKind: ReviewTaskKind.PrDescription,
                members: [],
              }),
              taskKind: ReviewTaskKind.PrDescription,
              required: false,
              paths: [] as readonly string[],
              schedulingOrdinal: 1,
            },
          ]
        : []),
    ],
    eligiblePaths: paths,
    uncoveredPaths: [],
    excludedPaths: [],
    maxWorkSlots: Math.max(1, input.authorization.limits.maxWorkSlots),
    maxAttemptsPerSlot: input.authorization.limits.maxAttemptsPerSlot,
  });
  const assignments = plan.assignments
    .filter(
      (assignment) =>
        assignment.workSlot.taskKind !== ReviewTaskKind.PrDescription
    )
    .map((assignment) =>
      Object.freeze({
        workSlot: assignment.workSlot,
        reviewRevisionHash: input.authorization.facts.reviewRevisionHash,
        mergeBaseSha: input.authorization.facts.mergeBaseSha,
        context: input.pr,
        lifecycleTargets: Object.freeze([]) as readonly LifecycleTarget[],
        liveLifecycleStateHash: input.liveLifecycleStateHash,
      })
    );
  return Object.freeze({
    plan,
    assignments: Object.freeze(assignments),
    uncoveredPaths: Object.freeze([]) as readonly string[],
    uncoveredLifecycleTargetIds,
  });
}

/** Default process runner: argv array with shell=false, detached process
 * group, root-cancellation group kill and bounded stdout/stderr tails (§5.1,
 * §7.2, §9). The result is reported only after close and stream drain. */
export function runOcrReviewProcess(input: {
  readonly binaryPath: string;
  readonly argv: readonly string[];
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly cwd: string;
  readonly signal: AbortSignal;
}): Promise<OcrReviewProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(input.binaryPath, [...input.argv], {
      cwd: input.cwd,
      env: { ...input.env },
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let spawnError: string | undefined;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let done = false;
    const killGroup = () => {
      try {
        if (process.platform !== 'win32' && child.pid)
          process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const cancel = () => killGroup();
    input.signal.addEventListener('abort', cancel, { once: true });
    if (input.signal.aborted) killGroup();
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= 64 * 1024) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      spawnError = error.name;
    });
    child.on('close', (exitCode, signal) => {
      if (done) return;
      done = true;
      input.signal.removeEventListener('abort', cancel);
      resolve({
        closed: true,
        exitCode,
        signal: signal as NodeJS.Signals | null,
        ...(spawnError !== undefined ? { spawnError } : {}),
        stdoutTail: truncateDiagnosticTail(stdout),
        stderrTail: truncateDiagnosticTail(stderr),
      });
    });
  });
}

export class OcrReviewInvocationAdapter implements PreparedReviewInvocationPort {
  private readonly assignments = new Map<string, OcrReviewAssignment>();
  private readonly prepared = new WeakMap<object, OcrReviewAssignment>();
  private readonly preimages = new WeakMap<
    object,
    OcrPreparedReviewInvocation
  >();
  private inFlight: Promise<unknown> = Promise.resolve();
  private running = false;
  /** Slots whose engine run may already have paid for model requests. */
  private readonly dispatchedSlots = new Set<string>();

  constructor(
    assignments: readonly OcrReviewAssignment[],
    private readonly options: OcrReviewInvocationOptions
  ) {
    for (const assignment of assignments) {
      if (this.assignments.has(assignment.workSlot.workSlotId)) {
        throw new Error('review_action_v2_assignment_duplicate');
      }
      this.assignments.set(assignment.workSlot.workSlotId, assignment);
    }
  }

  /** Model-free: deterministic preview and semantic capture only (§5.2). */
  async prepare(input: {
    readonly workSlot: ReviewWorkSlotPlan;
    readonly attemptOrdinal: number;
    readonly signal?: AbortSignal;
  }): Promise<OcrPreparedReviewInvocation> {
    this.options.signal?.throwIfAborted();
    input.signal?.throwIfAborted();
    const assignment = this.assignments.get(input.workSlot.workSlotId);
    if (!assignment || assignment.workSlot !== input.workSlot) {
      throw new Error('review_action_v2_assignment_missing');
    }
    if (
      assignment.workSlot.attemptBudget < 1 ||
      assignment.workSlot.attemptBudget > OCR_ATTEMPT_BUDGET ||
      assignment.workSlot.taskKind !== ReviewTaskKind.FindingDiscovery
    ) {
      throw new Error('review_action_v2_ocr_slot_contract_invalid');
    }
    // Snapshot captured values before the first await (§5.2).
    const assignedPaths = Object.freeze(
      assignment.context.files.map((file) => file.filename).sort()
    );
    if (assignedPaths.length === 0) {
      // RR policy excluded everything: nothing_to_review without inference
      // and without claiming an OCR observation (§4.3).
      throw new Error('review_action_v2_ocr_nothing_to_review');
    }
    const memorySnapshot = this.options.reviewMemory?.current();
    const ruleText = memorySnapshot
      ? appendOcrReviewMemory(
          this.options.ruleText,
          memorySnapshot.renderedPrompt
        )
      : this.options.ruleText;
    const backgroundText = boundOcrBackgroundText(this.options.backgroundText);
    const revision: OcrNativeManifestAdmission = Object.freeze({
      baseSha: assignment.context.baseSha,
      mergeBaseSha: assignment.mergeBaseSha,
      headSha: assignment.context.headSha,
    });
    const contextReceipt = this.options.contextTools?.receipt();
    const contextToolsPolicy = contextReceipt
      ? {
          profile: CONTEXT_TOOLS_PROFILE,
          planDigest: contextReceipt.planDigest,
          schemaDigest: contextReceipt.schemaDigest,
          tools: contextReceipt.availableTools,
        }
      : undefined;
    const semanticPreimage = buildOcrSemanticInvocationPreimage({
      ...(contextToolsPolicy ? { contextToolsPolicy } : {}),
      revision,
      assignedPaths,
      ruleText,
      backgroundText,
      binary: {
        profileRef: this.options.profileRef,
        sha256: this.options.binarySha256,
        packageVersion: this.options.packageVersion,
      },
      model: this.options.model,
      ocrEffort: this.options.ocrEffort,
      modelReasoningEffort: this.options.modelReasoningEffort,
      language: this.options.language,
      limits: this.options.limits,
      retryPolicyVersion: OCR_RETRY_POLICY_VERSION,
      attemptBudget: assignment.workSlot.attemptBudget,
    });
    fs.writeFileSync(this.options.run.rulePath, ruleText, { mode: 0o600 });
    if (backgroundText !== null && this.options.run.backgroundPath !== null) {
      fs.writeFileSync(this.options.run.backgroundPath, backgroundText, {
        mode: 0o600,
      });
    }
    // Deterministic preview on the same refs/config: zero model requests.
    const previewOutputPath = path.join(
      this.options.run.runDirectory,
      'preview.json'
    );
    const timeoutMs =
      this.options.previewTimeoutMs?.() ??
      this.options.limits.requestTimeoutSec * 1000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error('review_action_v2_ocr_preview_timeout');
    }
    const previewSignal = AbortSignal.any([
      ...(this.options.signal ? [this.options.signal] : []),
      ...(input.signal ? [input.signal] : []),
      AbortSignal.timeout(timeoutMs),
    ]);
    previewSignal.throwIfAborted();
    const previewResult = await this.options.previewRunner({
      binaryPath: this.options.binaryPath,
      argv: buildOcrReviewArgv({
        binaryPath: this.options.binaryPath,
        repoPath: this.options.checkoutRoot,
        mergeBaseSha: revision.mergeBaseSha,
        headSha: revision.headSha,
        model: this.options.model,
        rulePath: this.options.run.rulePath,
        backgroundPath:
          backgroundText !== null ? this.options.run.backgroundPath : null,
        outputPath: previewOutputPath,
        effort: this.options.ocrEffort,
        limits: this.options.limits,
        preview: true,
      }),
      env: buildOcrChildEnvironment({
        homeDirectory: this.options.run.homeDirectory,
        capabilityAuthorization: this.options.bridge.capabilityAuthorization,
        path: process.env.PATH,
      }),
      cwd: this.options.run.runDirectory,
      signal: previewSignal,
      outputPath: previewOutputPath,
    });
    previewSignal.throwIfAborted();
    if (
      previewResult.exitCode !== 0 ||
      previewResult.spawnError !== undefined
    ) {
      throw new Error('review_action_v2_ocr_preview_failed');
    }
    const previewSelectedPaths = Object.freeze(
      parseOcrPreviewSelection(readPreviewOutput(previewOutputPath))
    );

    const pathCoverage: readonly PreparedPromptPathCoverage[] =
      assignedPaths.map((path) => {
        const file = assignment.context.files.find(
          (candidate) => candidate.filename === path
        );
        return {
          path,
          // The full canonical patch of every assigned path is in the exact
          // revision OCR reviews; a preview-skipped path stays visible as
          // unreviewed, never as an RR policy exclusion (§8.1).
          kind: previewSelectedPaths.includes(path)
            ? PreparedPromptPathCoverageKind.FullPatch
            : PreparedPromptPathCoverageKind.Unavailable,
          contentHash: sha256(
            canonicalJson({
              filename: path,
              patch: file?.patch ?? null,
              status: file?.status ?? null,
            })
          ),
        };
      });
    const coverageManifest = createReviewPromptCoverageManifest({
      workSlotId: input.workSlot.workSlotId,
      reviewRevisionHash: assignment.reviewRevisionHash,
      assignedPaths,
      pathCoverage,
    });
    const manifestPreimages = Object.freeze({
      semanticIdentityPreimage: semanticPreimage,
      providerCapabilityHash: canonicalJson({
        adapterVersion: OCR_ADAPTER_CONTRACT_VERSION,
        preparedInvocationContract: PROVIDER_EXECUTION_CONTRACT_VERSION,
        outputContract: OCR_OUTCOME_SCHEMA_VERSION,
        binary: {
          profileRef: this.options.profileRef,
          sha256: this.options.binarySha256,
          packageVersion: this.options.packageVersion,
        },
        modelTransport: 'account_gateway',
      }),
      outputSchemaHash: canonicalJson({
        outputContract: OCR_OUTCOME_SCHEMA_VERSION,
        nativeManifestSchema: 'ocr.run-manifest/v1',
      }),
      filePatchManifestHash: canonicalJson(
        assignment.context.files.map((file) => ({
          additions: file.additions,
          changes: file.changes,
          deletions: file.deletions,
          filename: file.filename,
          patch: file.patch ?? null,
          previousFilename: file.previousFilename ?? null,
          status: file.status,
        }))
      ),
      contextManifestHash: canonicalJson({
        ...(memorySnapshot ? { memoryBundleHash: memorySnapshot.hash } : {}),
        ...(this.options.reviewSkills?.kind === 'captured'
          ? {
              reviewSkills: {
                capturedDigest: this.options.reviewSkills.capture.digest,
                executionDigest:
                  this.options.reviewSkills.bundle.executionDigest,
              },
            }
          : {}),
        author: assignment.context.author,
        body: assignment.context.body,
        coverageHash: coverageManifest.coverageHash,
        lifecycleTargetIds: [] as string[],
        number: assignment.context.number,
        title: assignment.context.title,
      }),
      toolPolicyHash: canonicalJson({
        sandbox: 'read-only',
        network: 'loopback-only',
        workspaceMutation: false,
        builtinTools: 'native_embedded',
        ...(contextToolsPolicy
          ? {
              contextToolsPolicy,
              parentContextNetwork: 'approved_https_pinned',
            }
          : {}),
        concurrency: 1,
      }),
      environmentContractHash: canonicalJson({
        credentialKeys: ['REVIEWROUTER_LOCAL_MODEL_TOKEN'],
        ...(contextToolsPolicy
          ? { contextToolsPolicy, parentCredentialIsolation: true }
          : {}),
        gitConfigGlobal: '/dev/null',
        gitConfigNoSystem: '1',
        homeMode: '0700',
        configMode: '0600',
      }),
    });
    const immutableRequest: OcrManagedInvocationRequest = Object.freeze({
      kind: OCR_ADAPTER_CONTRACT_VERSION,
      revision,
      assignedPaths,
      ruleTextHash: sha256(ruleText),
      backgroundTextHash:
        backgroundText === null ? null : sha256(backgroundText),
      binary: Object.freeze({
        profileRef: this.options.profileRef,
        sha256: this.options.binarySha256,
        packageVersion: this.options.packageVersion,
      }),
      model: this.options.model,
      ocrEffort: this.options.ocrEffort,
      modelReasoningEffort: this.options.modelReasoningEffort,
      language: this.options.language,
      limits: this.options.limits,
      outputContract: OCR_OUTCOME_SCHEMA_VERSION,
      retryPolicyVersion: OCR_RETRY_POLICY_VERSION,
    });
    const prepared: OcrPreparedReviewInvocation = Object.freeze({
      workSlotId: input.workSlot.workSlotId,
      attemptOrdinal: input.attemptOrdinal,
      provider: `ocr/${this.options.profileRef}`,
      requestedModel: this.options.model,
      // Additive controlled rule text only (§4.2).
      reviewPrompt: ruleText,
      investigationContextPrompt: null,
      immutableRequest,
      coverageManifest,
      // OCR performs no RR model investigation; no fabricated plan (§4.2).
      investigationProbePlan: null,
      investigationSeedEnvelope: null,
      manifestPreimages,
      semanticIdentityHash: sha256(semanticPreimage),
      previewSelectedPaths,
      manifestFacts: Object.freeze({
        taskKindSet: Object.freeze([ReviewTaskKind.FindingDiscovery]),
        providerKind: ReviewExecutionProviderKind.Ocr,
        providerCapabilityHash: sha256(
          manifestPreimages.providerCapabilityHash
        ),
        providerRequestEnvelopeHash: sha256(semanticPreimage),
        outputSchemaHash: sha256(manifestPreimages.outputSchemaHash),
        filePatchManifestHash: sha256(manifestPreimages.filePatchManifestHash),
        contextManifestHash: sha256(manifestPreimages.contextManifestHash),
        memoryBundleHash: memorySnapshot?.hash ?? null,
        lifecycleTargetSetHash: null,
        liveLifecycleStateHash: null,
        toolPolicyHash: sha256(manifestPreimages.toolPolicyHash),
        executionProfile: 'agentic_unbounded_v1',
        baseTreeHash: null,
        environmentContractHash: sha256(
          manifestPreimages.environmentContractHash
        ),
      }),
    });
    this.prepared.set(prepared as object, assignment);
    this.preimages.set(prepared as object, prepared);
    return prepared;
  }

  async execute(input: {
    readonly invocation: PreparedReviewInvocation;
    readonly manifest: ProviderInvocationManifest;
    readonly lease: ReviewInvocationLease;
    readonly currentLease?: () => ReviewInvocationLease;
    readonly sourceExecutionId: string;
    readonly sourceReviewRevisionHash: string;
    readonly signal: AbortSignal;
  }): Promise<ReviewObservationPayload> {
    const assignment = this.prepared.get(input.invocation as object);
    const preimages = this.preimages.get(input.invocation as object);
    if (
      !assignment ||
      !preimages ||
      input.invocation.investigationProbePlan !== null ||
      input.invocation.manifestFacts.providerKind !==
        ReviewExecutionProviderKind.Ocr
    ) {
      throw new Error('review_action_v2_prepared_invocation_identity_mismatch');
    }
    // §8.4 step 1: outer signal and current lease authority before dispatch.
    assertOcrInvocationLive(input);
    // One engine invocation in flight; aborting callers never dispatch late.
    // The effect fence runs inside the gate so no check outlives a dispatch.
    const run = this.gate(async () => {
      this.assertDispatchPermitted(assignment.workSlot.workSlotId);
      return await this.runInvocation(input, assignment);
    });
    return await run;
  }

  /** §8.4 step 2: known-terminal/unknown Gateway effect fences new calls. A
   * positively proven not_dispatched denial paid nothing, so releasing it
   * lifts the fence for one fresh dispatch; unknown/paid effects never do.
   * After an earlier engine run of the slot only that release reopens
   * dispatch: without it the earlier run may have paid for its requests. */
  private assertDispatchPermitted(workSlotId: string): void {
    const effectBefore = this.options.bridge.effectFacts?.();
    const effectKnown =
      effectBefore !== undefined && effectBefore.effect !== 'none';
    if (
      (effectKnown || this.dispatchedSlots.has(workSlotId)) &&
      (effectBefore?.effect !== 'not_dispatched' ||
        this.options.bridge.releaseRetrySafeFailure?.() !== true)
    ) {
      throw new Error(
        effectBefore?.effect === 'not_dispatched'
          ? 'review_action_v2_ocr_not_dispatched'
          : effectKnown
            ? 'review_action_v2_ocr_gateway_effect_unknown'
            : 'review_action_v2_ocr_replay_fenced'
      );
    }
  }

  private gate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.inFlight.then(async () => {
      if (this.running) throw new Error('review_action_v2_ocr_invocation_busy');
      this.running = true;
      try {
        return await operation();
      } finally {
        this.running = false;
      }
    });
    this.inFlight = next.catch(() => undefined);
    return next;
  }

  private async runInvocation(
    input: {
      readonly invocation: PreparedReviewInvocation;
      readonly manifest: ProviderInvocationManifest;
      readonly signal: AbortSignal;
      readonly lease: ReviewInvocationLease;
      readonly currentLease?: () => ReviewInvocationLease;
    },
    assignment: OcrReviewAssignment
  ): Promise<ReviewObservationPayload> {
    assertOcrInvocationLive(input);
    const outputPath = path.join(this.options.run.runDirectory, 'result.json');
    const argv = buildOcrReviewArgv({
      binaryPath: this.options.binaryPath,
      repoPath: this.options.checkoutRoot,
      mergeBaseSha: assignment.mergeBaseSha,
      headSha: assignment.context.headSha,
      model: this.options.model,
      rulePath: this.options.run.rulePath,
      backgroundPath:
        this.options.backgroundText !== null
          ? this.options.run.backgroundPath
          : null,
      outputPath,
      effort: this.options.ocrEffort,
      limits: this.options.limits,
      preview: false,
    });
    this.options.contextTools?.beginNativeSession();
    let processResult: OcrReviewProcessResult;
    this.dispatchedSlots.add(assignment.workSlot.workSlotId);
    const requestsBefore = this.options.bridge.requestCount();
    let requestsAfter: number | undefined;
    try {
      processResult = await this.options.processRunner({
        binaryPath: this.options.binaryPath,
        argv,
        env: buildOcrChildEnvironment({
          homeDirectory: this.options.run.homeDirectory,
          capabilityAuthorization: this.options.bridge.capabilityAuthorization,
          path: process.env.PATH,
        }),
        cwd: this.options.run.runDirectory,
        signal: input.signal,
      });
      requestsAfter = this.options.bridge.requestCount();
    } finally {
      const receipt = this.options.contextTools?.receipt();
      if (receipt)
        try {
          this.options.contextToolsReceipt?.(receipt);
        } catch {
          /* Diagnostics never change settlement. */
        }
    }
    assertOcrInvocationLive(input);
    const contextReceipt = this.options.contextTools?.receipt();
    if (
      contextReceipt &&
      (!contextReceipt.nativeConnected || contextReceipt.hadFailure)
    )
      throw new ReviewInvocationConfigurationMismatchError(
        ReviewInvocationConfigurationMismatchReason.RequiredContextToolsUnavailable
      );
    // Step 3 gate first: a failed process keeps any JSON local diagnostics.
    const failedProcess =
      processResult.spawnError !== undefined ||
      processResult.exitCode !== 0 ||
      processResult.signal !== null ||
      !processResult.closed;
    // Step 4: read the output file only after close, bounded.
    const resultBytes = failedProcess
      ? Buffer.alloc(0)
      : await readOcrOutputFileAfterClose(
          async (file) => fs.readFileSync(file),
          async (file) => fs.statSync(file).size,
          outputPath
        );
    assertOcrInvocationLive(input);
    const headFiles = {
      get: (file: string): string | undefined => {
        const resolved = path.join(this.options.checkoutRoot, file);
        try {
          return fs.readFileSync(resolved, 'utf8');
        } catch {
          return undefined;
        }
      },
    };
    const diffPositions = new Map<string, ReadonlyMap<number, number>>(
      assignment.context.files.map((file) => [
        file.filename,
        mapLinesToPositions(file.patch),
      ])
    );
    const accepted = acceptOcrManagedReviewResult({
      admission: {
        baseSha: assignment.context.baseSha,
        mergeBaseSha: assignment.mergeBaseSha,
        headSha: assignment.context.headSha,
      },
      effectFacts: this.options.bridge.effectFacts?.(),
      process: processResult,
      resultBytes,
      observedActualModel: this.options.bridge.actualModel(),
      observedRequestCount: this.options.bridge.requestCount(),
      expectedPaths: assignment.context.files.map((file) => file.filename),
      headFiles,
      diffPositions,
    });
    try {
      this.options.acceptanceDiagnostic?.({
        reasons: Object.freeze(
          OCR_ACCEPTANCE_DIAGNOSTIC_REASONS.filter((reason) =>
            accepted.reasons.includes(reason)
          )
        ),
        acceptedPartial: accepted.partial,
        classificationPartial: accepted.classification.partial,
        normalizationPartial:
          accepted.normalized.diagnostics.partialFlagsRequired,
        skippedFindingCount: accepted.normalized.diagnostics.skipped.length,
        uncoveredPathCount: accepted.uncoveredPaths.length,
        nativeCommentCount: accepted.native.comments.length,
        normalizedFindingCount: accepted.normalized.findings.length,
      });
    } catch {
      // Local diagnostics cannot change engine acceptance or publication.
    }
    const result: ReviewResult = {
      content: accepted.reasons.join(','),
      findings: [...accepted.normalized.findings],
      usage: accepted.usage,
      actualModel: accepted.actualModel,
      // One engine invocation; model calls are accounted separately (§9).
      transportAttemptCount: 1,
    };
    // §8.2 mapping invariant: every degraded/partial outcome carries
    // context_inspection_incomplete + provider_warning; natural
    // not_applicable skips stay unflagged; provider_warning alone never
    // makes the projection partial. One tier is lighter: when the only
    // degradation is an invalid filter decision that preserved the comments
    // (§7.3) and inspection/coverage are intact, the advisory
    // provider_warning alone is truthful — claiming
    // context_inspection_incomplete there would over-escalate into a
    // coverage failure for a run whose findings were preserved.
    const qualityFlags = accepted.partial
      ? accepted.classification.filterCommentsPreserved &&
        !accepted.normalized.diagnostics.partialFlagsRequired &&
        accepted.uncoveredPaths.length === 0
        ? ['provider_warning']
        : ['context_inspection_incomplete', 'provider_warning']
      : [];
    const observation = normalizeReviewObservation({
      workSlotId: input.invocation.workSlotId,
      attemptOrdinal: input.invocation.attemptOrdinal,
      providerName: input.invocation.provider,
      requestedModel: input.invocation.requestedModel,
      result,
      transportAttemptCount: 1,
      qualityFlags,
    });
    // §8.2: the payload bound is checked exactly here, after the existing
    // normalizer serializes the observation. Oversized payloads fail
    // explicitly with the shared output-too-large error, never silently.
    if (observation.byteCount > OCR_NORMALIZATION_LIMITS.maxPayloadBytes) {
      throw new OcrOutputTooLargeError('payload');
    }
    if (
      typeof requestsBefore === 'number' &&
      Number.isFinite(requestsBefore) &&
      requestsBefore >= 0 &&
      typeof requestsAfter === 'number' &&
      Number.isFinite(requestsAfter) &&
      requestsAfter > requestsBefore
    ) {
      try {
        this.options.freshReviewSkillsSupply?.({
          providerInvocationKey: input.manifest.providerInvocationKey,
          payloadHash: observation.payloadHash,
        });
      } catch {
        /* Optional local reporting never changes engine acceptance. */
      }
    }
    return observation;
  }
}

function assertOcrInvocationLive(input: {
  readonly signal: AbortSignal;
  readonly lease: ReviewInvocationLease;
  readonly currentLease?: () => ReviewInvocationLease;
}): void {
  input.signal.throwIfAborted();
  const lease = input.currentLease?.() ?? input.lease;
  const expiresAt = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error('review_action_v2_lease_expired');
  }
}

function readPreviewOutput(outputPath: string): unknown {
  try {
    const bytes = fs.readFileSync(outputPath);
    if (bytes.length > 4 * 1024 * 1024) return undefined;
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Lenient preview selection read (§5.1): the preview format is distinct
 * from the terminal review JSON and is never confused with it. The managed
 * preview lists `files: [{path, will_review, ...}]`; legacy preview shapes
 * with direct path arrays are also accepted. */
function parseOcrPreviewSelection(raw: unknown): readonly string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const value = raw as Record<string, unknown>;
  const collect = (candidate: unknown): string[] =>
    Array.isArray(candidate)
      ? candidate.filter((item): item is string => typeof item === 'string')
      : [];
  const direct = [
    ...collect(value.paths),
    ...collect(value.selected_paths),
    ...collect(value.selectedPaths),
  ];
  if (direct.length > 0) return Object.freeze([...new Set(direct)]);
  if (Array.isArray(value.files)) {
    const selected = value.files.flatMap((file) => {
      if (typeof file !== 'object' || file === null) return [];
      const entry = file as Record<string, unknown>;
      const path = entry.path;
      if (typeof path !== 'string') return [];
      // A file is selected for review only when the preview says so; an
      // absent will_review keeps the conservative "not reviewed" reading.
      return entry.will_review === true ? [path] : [];
    });
    return Object.freeze([...new Set(selected)]);
  }
  if (Array.isArray(value.groups)) {
    return Object.freeze([
      ...new Set(
        value.groups.flatMap((group) =>
          collect(
            typeof group === 'object' && group !== null
              ? (group as Record<string, unknown>).paths
              : undefined
          )
        )
      ),
    ]);
  }
  return Object.freeze([]);
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
