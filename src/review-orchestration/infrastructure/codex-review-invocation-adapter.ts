import { createHash } from 'crypto';
import { PromptBuilder } from '../../analysis/llm/prompt-builder';
import {
  canonicalizeProviderInvocationManifestV1,
  providerInvocationIdentityPreimageV1,
  serializeProviderInvocationManifestV1CanonicalWireJson,
} from '../../control-plane/generated/review-action-v2/provider-invocation-manifest-v1';
import { CodexProvider } from '../../providers/codex';
import {
  describeEnvironmentContract,
  PROVIDER_EXECUTION_CONTRACT_VERSION,
  type PreparedProviderInvocation,
} from '../../providers/prepared-invocation';
import type { LifecycleTarget, PRContext, ReviewConfig } from '../../types';
import {
  ReviewExecutionProviderKind,
  ReviewTaskKind,
  type PreparedReviewInvocation,
  type PreparedReviewInvocationPort,
  type ProviderInvocationManifestAssemblerPort,
  type ReviewInvocationLeaseSupervisorPort,
  type ReviewInvocationLease,
  type ReviewOrchestrationDelayPort,
  type ReviewOrchestrationIdentityPort,
  type ReviewRunAuthorization,
  type ReviewWorkSlotPlan,
} from '../application';
import {
  createReviewPromptCoverageManifest,
  serializeReviewPromptCoverageManifest,
} from '../domain';
import { normalizeReviewObservation } from './review-observation-normalizer';

export type CodexReviewAssignment = {
  readonly workSlot: ReviewWorkSlotPlan;
  readonly reviewRevisionHash: string;
  readonly context: PRContext;
  readonly lifecycleTargets: readonly LifecycleTarget[];
  readonly liveLifecycleStateHash: string;
};

export class CodexReviewInvocationAdapter implements PreparedReviewInvocationPort {
  private readonly assignments = new Map<string, CodexReviewAssignment>();
  private readonly prepared = new WeakSet<object>();

  constructor(
    private readonly provider: CodexProvider,
    private readonly promptBuilder: PromptBuilder,
    assignments: readonly CodexReviewAssignment[],
    private readonly timeoutMs: number,
    private readonly agenticContext: boolean
  ) {
    for (const assignment of assignments) {
      if (this.assignments.has(assignment.workSlot.workSlotId)) {
        throw new Error('review_action_v2_assignment_duplicate');
      }
      this.assignments.set(assignment.workSlot.workSlotId, assignment);
    }
  }

  async prepare(input: {
    readonly workSlot: ReviewWorkSlotPlan;
    readonly attemptOrdinal: number;
  }): Promise<PreparedReviewInvocation> {
    const assignment = this.assignments.get(input.workSlot.workSlotId);
    if (!assignment || assignment.workSlot !== input.workSlot) {
      throw new Error('review_action_v2_assignment_missing');
    }
    const preparedPrompt = await this.promptBuilder.buildPreparedV2(
      assignment.context,
      assignment.context.number,
      [...assignment.lifecycleTargets]
    );
    const coverageManifest = createReviewPromptCoverageManifest({
      workSlotId: input.workSlot.workSlotId,
      reviewRevisionHash: assignment.reviewRevisionHash,
      assignedPaths: assignment.context.files.map((file) => file.filename),
      pathCoverage: preparedPrompt.pathCoverage,
    });
    const coverageCanonicalJson =
      serializeReviewPromptCoverageManifest(coverageManifest);
    const prompt = `${preparedPrompt.prompt}\n\nREVIEWROUTER_COVERAGE_MANIFEST_V2_BASE64URL:${Buffer.from(
      coverageCanonicalJson,
      'utf8'
    ).toString('base64url')}`;
    const prepared = await this.provider.prepareInvocation(
      prompt,
      this.timeoutMs
    );
    this.prepared.add(prepared as object);
    const request = prepared.request as Readonly<Record<string, unknown>>;
    const environment = isStringRecord(request.environment)
      ? request.environment
      : {};
    const taskKindSet = Object.freeze(
      Array.from(
        new Set([
          input.workSlot.taskKind,
          ...(assignment.lifecycleTargets.length > 0
            ? [ReviewTaskKind.LifecycleRevalidation]
            : []),
        ])
      ).sort()
    ) as readonly ReviewTaskKind[];
    return Object.freeze({
      workSlotId: input.workSlot.workSlotId,
      attemptOrdinal: input.attemptOrdinal,
      provider: prepared.providerName,
      requestedModel: prepared.requestedModel,
      immutableRequest: prepared,
      coverageManifest,
      manifestFacts: Object.freeze({
        taskKindSet,
        providerKind: ReviewExecutionProviderKind.Codex,
        providerCapabilityHash: sha256(
          canonicalJson({
            agenticContext: this.agenticContext,
            preparedInvocationContract: PROVIDER_EXECUTION_CONTRACT_VERSION,
            providerKind: prepared.providerKind,
          })
        ),
        providerRequestEnvelopeHash: sha256(prepared.observableInputPreimage),
        outputSchemaHash: sha256(canonicalJson(request.outputSchema ?? null)),
        filePatchManifestHash: sha256(
          canonicalJson(
            assignment.context.files.map((file) => ({
              additions: file.additions,
              changes: file.changes,
              deletions: file.deletions,
              filename: file.filename,
              patch: file.patch ?? null,
              previousFilename: file.previousFilename ?? null,
              status: file.status,
            }))
          )
        ),
        contextManifestHash: sha256(
          canonicalJson({
            author: assignment.context.author,
            body: assignment.context.body,
            coverageHash: coverageManifest.coverageHash,
            lifecycleTargetIds: assignment.lifecycleTargets
              .map((target) => target.targetId)
              .sort(),
            number: assignment.context.number,
            title: assignment.context.title,
          })
        ),
        lifecycleTargetSetHash:
          assignment.lifecycleTargets.length > 0
            ? sha256(
                canonicalJson(
                  assignment.lifecycleTargets
                    .map((target) => ({
                      fingerprint: target.fingerprint,
                      targetId: target.targetId,
                    }))
                    .sort((left, right) =>
                      compareCodeUnits(left.targetId, right.targetId)
                    )
                )
              )
            : null,
        liveLifecycleStateHash:
          assignment.lifecycleTargets.length > 0
            ? assignment.liveLifecycleStateHash
            : null,
        toolPolicyHash: sha256(
          canonicalJson({
            sandbox: 'read-only',
            network: 'provider-controlled',
            workspaceMutation: false,
          })
        ),
        executionProfile: this.agenticContext
          ? 'agentic_unbounded_v1'
          : 'prompt_only_envelope_v1',
        baseTreeHash: null,
        environmentContractHash: sha256(
          canonicalJson(describeEnvironmentContract(environment))
        ),
      }),
    });
  }

  async execute(input: {
    readonly invocation: PreparedReviewInvocation;
    readonly lease: ReviewInvocationLease;
    readonly signal: AbortSignal;
  }) {
    const prepared = input.invocation
      .immutableRequest as PreparedProviderInvocation;
    if (
      !prepared ||
      typeof prepared !== 'object' ||
      !this.prepared.has(prepared as object) ||
      prepared.providerName !== input.invocation.provider ||
      prepared.requestedModel !== input.invocation.requestedModel
    ) {
      throw new Error('review_action_v2_prepared_invocation_identity_mismatch');
    }
    const result = await this.provider.executePreparedInvocation(
      prepared,
      undefined,
      input.signal
    );
    return normalizeReviewObservation({
      workSlotId: input.invocation.workSlotId,
      attemptOrdinal: input.invocation.attemptOrdinal,
      providerName: input.invocation.provider,
      requestedModel: input.invocation.requestedModel,
      result,
    });
  }
}

export class GeneratedProviderInvocationManifestAssembler implements ProviderInvocationManifestAssemblerPort {
  private readonly scopeHash: string;
  private readonly reviewConfigHash: string;

  constructor(
    private readonly authorization: ReviewRunAuthorization,
    reviewConfig: ReviewConfig,
    private readonly runtimeCompatibilityKey: string
  ) {
    this.scopeHash = sha256(
      canonicalJson({
        pullRequestNumber: authorization.facts.pullRequestNumber,
        repositoryConnectionId: authorization.facts.repositoryConnectionId,
        scmRepositoryIdentityId: authorization.facts.scmRepositoryIdentityId,
        workspaceId: authorization.facts.workspaceId,
      })
    );
    this.reviewConfigHash = sha256(canonicalJson(reviewConfig));
  }

  async assemble(invocation: PreparedReviewInvocation) {
    const facts = invocation.manifestFacts;
    const manifestInput = {
      manifestVersion: 1 as const,
      scopeHash: this.scopeHash,
      taskKindSet: facts.taskKindSet,
      providerKind: facts.providerKind,
      providerCapabilityHash: facts.providerCapabilityHash,
      requestedModel: invocation.requestedModel,
      providerPolicyVersion: 'codex-provider-policy.v2-t0',
      producerReleaseId: this.authorization.facts.producerReleaseId,
      selectedProtocolVersion: this.authorization.facts.selectedProtocolVersion,
      providerRequestEnvelopeHash: facts.providerRequestEnvelopeHash,
      outputSchemaHash: facts.outputSchemaHash,
      reviewConfigHash: this.reviewConfigHash,
      runtimeCompatibilityKey: this.runtimeCompatibilityKey,
      filePatchManifestHash: facts.filePatchManifestHash,
      contextManifestHash: facts.contextManifestHash,
      memoryBundleHash: null,
      codeGraphProjectionHash: null,
      lifecycleTargetSetHash: facts.lifecycleTargetSetHash,
      liveLifecycleStateHash: facts.liveLifecycleStateHash,
      toolPolicyHash: facts.toolPolicyHash,
      executionProfile: facts.executionProfile,
      baseTreeHash: facts.baseTreeHash,
      environmentContractHash: facts.environmentContractHash,
    };
    const manifestKey = sha256Bytes(
      canonicalizeProviderInvocationManifestV1(manifestInput)
    );
    const lane = this.authorization.facts.providerVoteLanes.find(
      (candidate) => candidate.providerKind === facts.providerKind
    );
    if (!lane) throw new Error('review_action_v2_provider_vote_lane_missing');
    const providerInvocationKey = sha256Bytes(
      providerInvocationIdentityPreimageV1(
        manifestKey,
        lane.providerVoteIdentityHash
      )
    );
    return Object.freeze({
      manifestCanonicalJson:
        serializeProviderInvocationManifestV1CanonicalWireJson(manifestInput),
      manifestKey,
      providerInvocationKey,
      providerVoteIdentityHash: lane.providerVoteIdentityHash,
    });
  }
}

export class DeterministicReviewOrchestrationIdentity implements ReviewOrchestrationIdentityPort {
  deterministicId(namespace: string, parts: readonly string[]): string {
    if (!/^[a-z0-9-]{1,80}$/.test(namespace)) {
      throw new Error('review_action_v2_identity_namespace_invalid');
    }
    return `rr:${namespace}:${sha256(canonicalJson(parts)).slice(0, 40)}`;
  }
}

export class CooperativeReviewLeaseSupervisor implements ReviewInvocationLeaseSupervisorPort {
  async run<T>(input: {
    readonly lease: ReviewInvocationLease;
    readonly renew: () => Promise<ReviewInvocationLease>;
    readonly operation: (signal: AbortSignal) => Promise<T>;
  }): Promise<T> {
    let stopped = false;
    let stopWake: (() => void) | undefined;
    let currentLease = input.lease;
    const abort = new AbortController();
    let rejectLeaseFailure!: (reason: unknown) => void;
    const leaseFailure = new Promise<never>((_resolve, reject) => {
      rejectLeaseFailure = reject;
    });
    const failLease = (error: unknown) => {
      if (stopped || abort.signal.aborted) return;
      abort.abort(error);
      rejectLeaseFailure(error);
    };
    const wait = async (delayMs: number) => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        timer.unref?.();
        stopWake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    };
    const renewLoop = (async () => {
      while (!stopped) {
        const remaining = Date.parse(currentLease.expiresAt) - Date.now();
        if (!Number.isFinite(remaining) || remaining <= 0) {
          failLease(new Error('review_action_v2_lease_expired'));
          return;
        }
        await wait(
          currentLease.renewalCeilingReached
            ? remaining
            : Math.min(30_000, Math.max(1_000, Math.floor(remaining / 2)))
        );
        if (stopped) return;
        if (currentLease.renewalCeilingReached) {
          failLease(new Error('review_action_v2_lease_expired'));
          return;
        }
        try {
          currentLease = await input.renew();
        } catch (error) {
          failLease(error);
          return;
        }
      }
    })();

    try {
      return await Promise.race([
        Promise.resolve().then(() => input.operation(abort.signal)),
        leaseFailure,
      ]);
    } finally {
      stopped = true;
      stopWake?.();
      await renewLoop;
    }
  }
}

export class SystemReviewOrchestrationDelay implements ReviewOrchestrationDelayPort {
  async sleep(delayMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function isStringRecord(value: unknown): value is Readonly<NodeJS.ProcessEnv> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (item) => item === undefined || typeof item === 'string'
    )
  );
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

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
