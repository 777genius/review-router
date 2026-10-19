/**
 * Plan 56 managed OCR invocation adapter: one FindingDiscovery slot with a
 * single vote identity, model-free prepare with §8.3 semantic identity,
 * serialized execution (in-flight <= 1), cancellation cleanup and no rerun
 * after a truncated/malformed managed result.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildOcrControlledRuleText,
  OcrReviewInvocationAdapter,
  planOcrReviewAssignments,
  runOcrReviewProcess,
  type OcrLoopbackBridge,
  type OcrManagedRunLayout,
  type OcrReviewProcessRunner,
  type OcrPreviewRunner,
} from '../../../src/review-orchestration/infrastructure/ocr-review-invocation-adapter';
import type { OcrManagedLimits } from '../../../src/review-orchestration/infrastructure/ocr-review-managed-run';
import {
  ReviewExecutionProviderKind,
  ReviewTaskKind,
  type PreparedReviewInvocation,
  type ProviderInvocationManifest,
  type ReviewInvocationLease,
  type ReviewRunAuthorization,
  type ReviewWorkSlotPlan,
} from '../../../src/review-orchestration/application';
import { PreparedPromptPathCoverageKind } from '../../../src/analysis/llm/prepared-review-prompt';
import type {
  LifecycleTarget,
  PRContext,
  ReviewConfig,
} from '../../../src/types';

const MERGE_BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const BASE = 'a'.repeat(40);
const REVIEW_REVISION_HASH = 'e'.repeat(64);
const VOTE_IDENTITY = 'f'.repeat(64);

function prContext(overrides: Partial<PRContext> = {}): PRContext {
  return {
    number: 7,
    title: 'Fix add()',
    body: 'The add helper subtracted.',
    author: 'tester',
    draft: false,
    labels: [],
    files: [
      {
        filename: 'calc.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        changes: 2,
        patch:
          '@@ -1 +1 @@\n-function add(a, b) { return a + b }\n+function add(a, b) { return a - b }',
      },
    ],
    diff: '',
    additions: 1,
    deletions: 1,
    baseSha: BASE,
    headSha: HEAD,
    ...overrides,
  };
}

function authorization(overrides: Record<string, unknown> = {}): ReviewRunAuthorization {
  return {
    authorizationId: 'auth-1',
    authorizationToken: 'token',
    producerReleaseId: 'release-1',
    protocolLimitsProfileId: 'limits-1',
    operationalSloProfileId: 'slo-1',
    mutationEpoch: 'epoch-1',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    limits: {
      maxWorkSlots: 4,
      maxAttemptsPerSlot: 1,
      maxObservationBytes: 512 * 1024,
      maxObservationFindings: 200,
      maxProjectionBytes: 512 * 1024,
      maxProjectionFindings: 200,
      maxPublicationOperations: 50,
      maxPublicationChunks: 20,
      maxPublicationBodyBytes: 60_000,
      maxRequestBatchSize: 10,
      maxLeaseDurationMs: 600_000,
      maxResultReportDurationMs: 600_000,
      maxReconciliationDurationMs: 600_000,
    },
    facts: {
      workspaceId: 'ws-1',
      repositoryConnectionId: 'conn-1',
      scmRepositoryIdentityId: 'scm-1',
      pullRequestNumber: 7,
      sourceRunId: 'run-1',
      sourceRunAttempt: '1',
      baseSha: BASE,
      mergeBaseSha: MERGE_BASE,
      headSha: HEAD,
      reviewRevisionHash: REVIEW_REVISION_HASH,
      trustDomain: 'github:test/repo',
      producerReleaseId: 'release-1',
      selectedProtocolVersion: 'v2',
      schemaDigest: 'd'.repeat(64),
      providerVoteLanes: [
        {
          providerKind: ReviewExecutionProviderKind.Ocr,
          providerVoteIdentityHash: VOTE_IDENTITY,
        },
      ],
    },
    ...overrides,
  } as ReviewRunAuthorization;
}

function planInput(overrides: Record<string, unknown> = {}) {
  return {
    authorization: authorization(),
    pr: prContext(),
    config: {} as ReviewConfig,
    compatibilityKey: '9'.repeat(64),
    lifecycleTargets: [] as readonly LifecycleTarget[],
    liveLifecycleStateHash: '8'.repeat(64),
    ...overrides,
  };
}

describe('planOcrReviewAssignments (§4.3 one slot, one vote identity)', () => {
  it('covers the whole inventory with a single FindingDiscovery slot', () => {
    const planned = planOcrReviewAssignments(planInput());
    expect(planned.plan.assignments).toHaveLength(1);
    const slot = planned.plan.assignments[0].workSlot;
    expect(slot.taskKind).toBe(ReviewTaskKind.FindingDiscovery);
    expect(slot.providerKind).toBe(ReviewExecutionProviderKind.Ocr);
    expect(slot.providerVoteIdentityHash).toBe(VOTE_IDENTITY);
    // C9: exactly one attempt; no automatic replay after a paid request.
    expect(slot.attemptBudget).toBe(1);
    expect(
      planned.assignments[0].context.files.map((file) => file.filename)
    ).toEqual(['calc.ts']);
  });

  it('keeps in-scope lifecycle targets explicitly uncovered (OCR has no verdicts)', () => {
    const targets = [
      {
        targetId: 'target-1',
        originalPath: 'calc.ts',
        currentPath: 'calc.ts',
      },
      {
        targetId: 'target-2',
        originalPath: 'other.ts',
        currentPath: 'other.ts',
      },
    ] as unknown as readonly LifecycleTarget[];
    const planned = planOcrReviewAssignments(
      planInput({ lifecycleTargets: targets })
    );
    expect(planned.uncoveredLifecycleTargetIds).toEqual(['target-1']);
    expect(planned.assignments[0].lifecycleTargets).toEqual([]);
  });

  it('rejects missing or ambiguous OCR vote lanes', () => {
    const withoutLane = authorization();
    (withoutLane.facts as unknown as { providerVoteLanes: unknown[] }).providerVoteLanes = [];
    expect(() =>
      planOcrReviewAssignments(planInput({ authorization: withoutLane }))
    ).toThrow('review_action_v2_ocr_vote_lane_ambiguous');
    const twoLanes = authorization();
    (twoLanes.facts as unknown as { providerVoteLanes: unknown[] }).providerVoteLanes = [
      {
        providerKind: ReviewExecutionProviderKind.Ocr,
        providerVoteIdentityHash: VOTE_IDENTITY,
      },
      {
        providerKind: ReviewExecutionProviderKind.Ocr,
        providerVoteIdentityHash: '7'.repeat(64),
      },
    ];
    expect(() =>
      planOcrReviewAssignments(planInput({ authorization: twoLanes }))
    ).toThrow('review_action_v2_ocr_vote_lane_ambiguous');
  });
});

describe('OcrReviewInvocationAdapter', () => {
  let runDirectory: string;
  let checkoutRoot: string;
  let run: OcrManagedRunLayout;

  beforeEach(() => {
    runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ocr-adapter-'));
    fs.chmodSync(runDirectory, 0o700);
    checkoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ocr-checkout-'));
    fs.writeFileSync(
      path.join(checkoutRoot, 'calc.ts'),
      'function add(a, b) { return a - b }'
    );
    run = {
      runDirectory,
      homeDirectory: runDirectory,
      configPath: path.join(runDirectory, 'config.json'),
      rulePath: path.join(runDirectory, 'rule.json'),
      backgroundPath: path.join(runDirectory, 'background.md'),
    };
  });

  afterEach(() => {
    fs.rmSync(runDirectory, { recursive: true, force: true });
    fs.rmSync(checkoutRoot, { recursive: true, force: true });
  });

  function bridgeFixture(overrides: Partial<OcrLoopbackBridge> = {}): {
    bridge: OcrLoopbackBridge;
    requests: { count: number };
  } {
    const requests = { count: 0 };
    const bridge: OcrLoopbackBridge = {
      baseUrl: 'http://127.0.0.1:41000',
      capabilityAuthorization: `Bearer ${'a'.repeat(64)}`,
      actualModel: () => 'observed-model',
      requestCount: () => requests.count,
      effectFacts: () => ({ effect: 'none' }),
      ...overrides,
    };
    return { bridge, requests };
  }

  function previewRunner(): {
    runner: OcrPreviewRunner;
    calls: { argv: readonly string[]; env: NodeJS.ProcessEnv }[];
  } {
    const calls: { argv: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const runner: OcrPreviewRunner = async (input) => {
      calls.push({ argv: input.argv, env: input.env });
      fs.writeFileSync(
        input.outputPath,
        JSON.stringify({
          files: [{ path: 'calc.ts', status: 'modified', will_review: true }],
        })
      );
      return {
        closed: true,
        exitCode: 0,
        signal: null,
        stdoutTail: '',
        stderrTail: '',
      };
    };
    return { runner, calls };
  }

  function nativeResultBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      status: 'complete',
      llm: { provider: 'reviewrouter', model: 'requested-model' },
      summary: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      comments: [],
      manifest: {
        schema_version: 'ocr.run-manifest/v1',
        operation: 'review',
        terminal_state: 'complete',
        input: { mode: 'range', resolved_base: MERGE_BASE, resolved_head: HEAD },
      },
      reviewrouter_outcome: {
        schema_version: 'reviewrouter.ocr-outcome/v1',
        run_stop_cause: null,
        grouping: { state: 'completed', reason: null },
        groups: [
          {
            paths: ['calc.ts'],
            main_completed: true,
            stop_cause: null,
            rounds: { configured: 2, started: 1, completed: 1 },
            phases: {
              plan: { state: 'not_applicable', reason: 'threshold' },
              compression: { state: 'not_applicable', reason: 'no_zone' },
              relocation: { state: 'not_applicable', reason: 'no_candidates' },
              filter: { state: 'not_applicable', reason: 'no_candidates' },
            },
            filter_decision_valid: null,
          },
        ],
      },
      ...overrides,
    });
  }

  function processRunnerWriting(body: string): {
    runner: OcrReviewProcessRunner;
    calls: number[];
  } {
    const calls: number[] = [];
    const runner: OcrReviewProcessRunner = async (input) => {
      calls.push(1);
      const outputPath = input.argv[input.argv.indexOf('--output') + 1];
      fs.writeFileSync(outputPath, body);
      return {
        closed: true,
        exitCode: 0,
        signal: null,
        stdoutTail: '',
        stderrTail: '',
      };
    };
    return { runner, calls };
  }

  function adapterFixture(options: {
    readonly bridge: OcrLoopbackBridge;
    readonly processRunner: OcrReviewProcessRunner;
    readonly previewRunner: OcrPreviewRunner;
  }): {
    adapter: OcrReviewInvocationAdapter;
    workSlot: ReviewWorkSlotPlan;
  } {
    const planned = planOcrReviewAssignments(planInput());
    const adapter = new OcrReviewInvocationAdapter(planned.assignments, {
      model: 'admitted-model',
      binaryPath: '/opt/ocr/opencodereview',
      binarySha256: '1'.repeat(64),
      packageVersion: '1.2.3',
      profileRef: 'ocr-managed-v1',
      run,
      bridge: options.bridge,
      limits: { requestTimeoutSec: 600 } as OcrManagedLimits,
      ocrEffort: 'medium',
      modelReasoningEffort: 'medium',
      language: 'en',
      ruleText: buildOcrControlledRuleText({
        language: 'en',
        assignedPaths: ['calc.ts'],
      }),
      backgroundText: null,
      checkoutRoot,
      processRunner: options.processRunner,
      previewRunner: options.previewRunner,
    });
    return { adapter, workSlot: planned.assignments[0].workSlot };
  }

  function executionInput(
    invocation: PreparedReviewInvocation,
    signal?: AbortSignal
  ) {
    return {
      invocation,
      manifest: {
        manifestCanonicalJson: '{}',
        manifestKey: 'k',
        providerInvocationKey: 'pk',
        providerVoteIdentityHash: VOTE_IDENTITY,
      } as ProviderInvocationManifest,
      lease: {
        leaseId: 'lease-1',
        attemptId: 'attempt-1',
        leaseCapability: 'cap',
        fencingToken: 'fence-1',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        resultReportUntil: new Date(Date.now() + 3_600_000).toISOString(),
        renewalCeilingReached: false,
      } as ReviewInvocationLease,
      sourceExecutionId: 'execution-1',
      sourceReviewRevisionHash: REVIEW_REVISION_HASH,
      signal: signal ?? new AbortController().signal,
    };
  }

  const unusedRunner: OcrReviewProcessRunner = async () => {
    throw new Error('execute must not run on this path');
  };

  it('prepares model-free with a deterministic preview and no credentials in the request', async () => {
    const { bridge, requests } = bridgeFixture();
    const preview = previewRunner();
    const { adapter, workSlot } = adapterFixture({
      bridge,
      processRunner: unusedRunner,
      previewRunner: preview.runner,
    });
    const prepared = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    // Model-free prepare: only the preview CLI, zero model requests.
    expect(preview.calls).toHaveLength(1);
    expect(preview.calls[0].argv).toContain('--preview');
    expect(requests.count).toBe(0);
    // OCR never fabricates an investigation probe plan.
    expect(prepared.investigationProbePlan).toBeNull();
    // Additive controlled rule text is the whole reviewPrompt.
    expect(prepared.reviewPrompt).toContain('reviewrouter-managed-v1');
    expect(prepared.reviewPrompt).not.toMatch(/task_done|gateway/iu);
    // Preview selection read: FullPatch for reviewed paths only.
    expect(prepared.previewSelectedPaths).toEqual(['calc.ts']);
    expect(prepared.coverageManifest.paths[0].kind).toBe(
      PreparedPromptPathCoverageKind.FullPatch
    );
    // immutableRequest carries no upstream/control credentials or loopback URL.
    const serializedRequest = JSON.stringify(prepared.immutableRequest);
    expect(serializedRequest).not.toContain('Bearer');
    expect(serializedRequest).not.toContain('127.0.0.1');
    expect(serializedRequest).not.toContain(bridge.capabilityAuthorization);
  });

  it('keeps §8.3 semantic identity stable across URL/capability churn and sensitive to model', async () => {
    const preview = previewRunner();
    const first = adapterFixture({
      bridge: bridgeFixture().bridge,
      processRunner: unusedRunner,
      previewRunner: preview.runner,
    });
    const second = adapterFixture({
      bridge: bridgeFixture({
        baseUrl: 'http://127.0.0.1:42000',
        capabilityAuthorization: `Bearer ${'b'.repeat(64)}`,
      }).bridge,
      processRunner: unusedRunner,
      previewRunner: preview.runner,
    });
    const one = await first.adapter.prepare({
      workSlot: first.workSlot,
      attemptOrdinal: 1,
    });
    const two = await second.adapter.prepare({
      workSlot: second.workSlot,
      attemptOrdinal: 1,
    });
    expect(two.semanticIdentityHash).toBe(one.semanticIdentityHash);

    const changed = planOcrReviewAssignments(planInput());
    const third = new OcrReviewInvocationAdapter(changed.assignments, {
      model: 'other-admitted-model',
      binaryPath: '/opt/ocr/opencodereview',
      binarySha256: '1'.repeat(64),
      packageVersion: '1.2.3',
      profileRef: 'ocr-managed-v1',
      run,
      bridge: bridgeFixture().bridge,
      limits: { requestTimeoutSec: 600 },
      ocrEffort: 'medium',
      modelReasoningEffort: 'medium',
      language: 'en',
      ruleText: buildOcrControlledRuleText({
        language: 'en',
        assignedPaths: ['calc.ts'],
      }),
      backgroundText: null,
      checkoutRoot,
      processRunner: unusedRunner,
      previewRunner: preview.runner,
    });
    const three = await third.prepare({
      workSlot: changed.assignments[0].workSlot,
      attemptOrdinal: 1,
    });
    // Changing the captured model changes the semantic identity (§8.3).
    expect(three.semanticIdentityHash).not.toBe(one.semanticIdentityHash);
  });

  it('executes one managed run and reports the observed model with one transport attempt', async () => {
    const { bridge, requests } = bridgeFixture();
    requests.count = 1;
    const processRunner = processRunnerWriting(nativeResultBody());
    const { adapter, workSlot } = adapterFixture({
      bridge,
      processRunner: processRunner.runner,
      previewRunner: previewRunner().runner,
    });
    const prepared = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    const observation = await adapter.execute(executionInput(prepared));
    expect(processRunner.calls).toHaveLength(1);
    expect(observation.actualModel).toBe('observed-model');
    expect(observation.transportAttemptCount).toBe(1);
    expect(observation.qualityFlags).toEqual([]);
    expect(observation.findingCount).toBe(0);
    const payload = JSON.parse(observation.payloadCanonicalJson) as {
      safeUsage: { totalTokens: number | null };
    };
    // C9: usage is the observed sum, not a configured budget.
    expect(payload.safeUsage.totalTokens).toBe(15);
  });

  it('flags a degraded outcome with context_inspection_incomplete + provider_warning', async () => {
    const body = JSON.parse(nativeResultBody()) as Record<string, unknown>;
    const outcome = body.reviewrouter_outcome as {
      groups: Record<string, unknown>[];
    };
    outcome.groups[0].main_completed = false;
    outcome.groups[0].stop_cause = 'review_limit_reached';
    outcome.groups[0].rounds = { configured: 2, started: 1, completed: 0 };
    const { bridge, requests } = bridgeFixture();
    requests.count = 1;
    const { adapter, workSlot } = adapterFixture({
      bridge,
      processRunner: processRunnerWriting(JSON.stringify(body)).runner,
      previewRunner: previewRunner().runner,
    });
    const prepared = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    const observation = await adapter.execute(executionInput(prepared));
    expect(observation.qualityFlags).toEqual([
      'context_inspection_incomplete',
      'provider_warning',
    ]);
  });

  it('never reruns after a truncated managed result (no new inference)', async () => {
    const { bridge, requests } = bridgeFixture();
    requests.count = 1;
    const processRunner = processRunnerWriting('{"status": "complete", "trunc');
    const { adapter, workSlot } = adapterFixture({
      bridge,
      processRunner: processRunner.runner,
      previewRunner: previewRunner().runner,
    });
    const prepared = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    await expect(adapter.execute(executionInput(prepared))).rejects.toThrow(
      /review_action_v2_ocr_result_contract/u
    );
    // Exactly one engine invocation: a malformed result never triggers a
    // second model run.
    expect(processRunner.calls).toHaveLength(1);
  });

  it('rejects a nonzero process even when a valid JSON result exists', async () => {
    const { bridge } = bridgeFixture();
    const processRunner = processRunnerWriting(nativeResultBody());
    const { adapter, workSlot } = adapterFixture({
      bridge,
      processRunner: async (input) => {
        const result = await processRunner.runner(input);
        return { ...result, exitCode: 3 };
      },
      previewRunner: previewRunner().runner,
    });
    const prepared = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    await expect(adapter.execute(executionInput(prepared))).rejects.toThrow(
      /review_action_v2_ocr_process_failed/u
    );
    expect(processRunner.calls).toHaveLength(1);
  });

  it('serializes engine invocations (real in-flight <= 1)', async () => {
    const { bridge, requests } = bridgeFixture();
    requests.count = 1;
    let active = 0;
    let maxActive = 0;
    const { adapter, workSlot } = adapterFixture({
      bridge,
      processRunner: async (input) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
        const outputPath = input.argv[input.argv.indexOf('--output') + 1];
        fs.writeFileSync(outputPath, nativeResultBody());
        return {
          closed: true,
          exitCode: 0,
          signal: null,
          stdoutTail: '',
          stderrTail: '',
        };
      },
      previewRunner: previewRunner().runner,
    });
    const first = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    const second = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    const [one, two] = await Promise.all([
      adapter.execute(executionInput(first)),
      adapter.execute(executionInput(second)),
    ]);
    expect(maxActive).toBe(1);
    expect(one.transportAttemptCount).toBe(1);
    expect(two.transportAttemptCount).toBe(1);
  });

  it('does not dispatch when the root signal is already aborted', async () => {
    const { bridge } = bridgeFixture();
    const dispatched: number[] = [];
    const { adapter, workSlot } = adapterFixture({
      bridge,
      processRunner: async () => {
        dispatched.push(1);
        return {
          closed: true,
          exitCode: 0,
          signal: null,
          stdoutTail: '',
          stderrTail: '',
        };
      },
      previewRunner: previewRunner().runner,
    });
    const prepared = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.execute(executionInput(prepared, controller.signal))
    ).rejects.toThrow();
    expect(dispatched).toEqual([]);
  });

  it('kills the detached process tree on root cancellation', async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 50);
    const result = await runOcrReviewProcess({
      binaryPath: '/bin/sh',
      argv: ['-c', 'sleep 30'],
      env: { PATH: '/usr/bin:/bin' },
      cwd: os.tmpdir(),
      signal: controller.signal,
    });
    expect(result.closed).toBe(true);
    expect(result.signal === 'SIGKILL' || result.exitCode !== 0).toBe(true);
    // Cancellation stops the wait promptly instead of holding the timeout.
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);
});
