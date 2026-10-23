/**
 * Plan 56 managed OCR invocation adapter: one FindingDiscovery slot with a
 * single vote identity, model-free prepare with §8.3 semantic identity,
 * serialized execution (in-flight <= 1), cancellation cleanup and no rerun
 * after a truncated/malformed managed result.
 */

import type { ContextToolsBroker } from '../../../src/context-tools/broker';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  boundOcrBackgroundText,
  buildOcrControlledRuleText,
  OcrReviewInvocationAdapter,
  planOcrReviewAssignments,
  runOcrReviewProcess,
  type OcrLoopbackBridge,
  type OcrReviewAcceptanceDiagnostic,
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

function authorization(
  overrides: Record<string, unknown> = {}
): ReviewRunAuthorization {
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
      maxAttemptsPerSlot: 4,
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
    // C9: bounded retries only after positively proven unpaid denials; a
    // paid/unknown effect never replays.
    expect(slot.attemptBudget).toBe(3);
    expect(
      planned.assignments[0].context.files.map((file) => file.filename)
    ).toEqual(['calc.ts']);
  });

  it('clamps the bounded retry budget to the granted per-slot limit', () => {
    const planned = planOcrReviewAssignments(
      planInput({
        authorization: authorization({
          limits: { ...authorization().limits, maxAttemptsPerSlot: 1 },
        }),
      })
    );
    expect(planned.plan.assignments[0].workSlot.attemptBudget).toBe(1);
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
    (
      withoutLane.facts as unknown as { providerVoteLanes: unknown[] }
    ).providerVoteLanes = [];
    expect(() =>
      planOcrReviewAssignments(planInput({ authorization: withoutLane }))
    ).toThrow('review_action_v2_ocr_vote_lane_ambiguous');
    const twoLanes = authorization();
    (
      twoLanes.facts as unknown as { providerVoteLanes: unknown[] }
    ).providerVoteLanes = [
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

describe('boundOcrBackgroundText (upstream 8000-character hard limit)', () => {
  it('passes null and within-limit text through unchanged', () => {
    expect(boundOcrBackgroundText(null)).toBeNull();
    expect(boundOcrBackgroundText('short')).toBe('short');
    const atLimit = 'a'.repeat(8_000);
    expect(boundOcrBackgroundText(atLimit)).toBe(atLimit);
  });

  it('truncates over-limit text to the limit preserving the prefix', () => {
    const input = `Fix add()\n\n${'x'.repeat(8_541)}`;
    expect(boundOcrBackgroundText(input)).toBe(input.slice(0, 8_000));
  });

  it('bounds astral text on both code points and UTF-16 units', () => {
    const bounded = boundOcrBackgroundText('\u{1F389}'.repeat(5_000)) ?? '';
    expect(bounded).toBe('\u{1F389}'.repeat(4_000));
    expect([...bounded].length).toBeLessThanOrEqual(8_000);
    expect(bounded.length).toBeLessThanOrEqual(8_000);
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
        input: {
          mode: 'range',
          resolved_base: MERGE_BASE,
          resolved_head: HEAD,
        },
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

  /** Native comments whose serialized observation payload is ~16.7 KiB each. */
  function bulkyNativeComments(count: number): Record<string, unknown>[] {
    return Array.from({ length: count }, () => ({
      path: 'calc.ts',
      content: `Finding: ${'x'.repeat(16_000 - 9)}`,
      suggestion_code: null,
      existing_code: null,
      start_line: null,
      end_line: null,
      category: 'correctness',
      severity: 'high',
    }));
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
    readonly contextTools?: Pick<
      ContextToolsBroker,
      'receipt' | 'beginNativeSession'
    >;
    readonly contextToolsReceipt?: (
      receipt: ReturnType<ContextToolsBroker['receipt']>
    ) => void;
    readonly bridge: OcrLoopbackBridge;
    readonly processRunner: OcrReviewProcessRunner;
    readonly previewRunner: OcrPreviewRunner;
    readonly acceptanceDiagnostic?: (
      diagnostic: OcrReviewAcceptanceDiagnostic
    ) => void;
    readonly planInputOverrides?: Record<string, unknown>;
    /** Adds a second, distinct FindingDiscovery slot to the same adapter. */
    readonly secondSlotPlanInputOverrides?: Record<string, unknown>;
    readonly lifecycle?: {
      readonly signal?: AbortSignal;
      readonly previewTimeoutMs?: () => number;
    };
    readonly backgroundText?: string | null;
  }): {
    adapter: OcrReviewInvocationAdapter;
    workSlot: ReviewWorkSlotPlan;
    secondWorkSlot?: ReviewWorkSlotPlan;
  } {
    const planned = planOcrReviewAssignments(
      planInput(options.planInputOverrides ?? {})
    );
    const second = options.secondSlotPlanInputOverrides
      ? planOcrReviewAssignments(
          planInput(options.secondSlotPlanInputOverrides)
        )
      : undefined;
    const assignments = [
      ...planned.assignments,
      ...(second?.assignments ?? []),
    ];
    const adapter = new OcrReviewInvocationAdapter(assignments, {
      ...options.lifecycle,
      model: 'admitted-model',
      binaryPath: '/opt/ocr/opencodereview',
      binarySha256: '1'.repeat(64),
      packageVersion: '1.2.3',
      profileRef: 'ocr-managed-v1',
      run,
      bridge: options.bridge,
      contextTools: options.contextTools,
      contextToolsReceipt: options.contextToolsReceipt,
      limits: { requestTimeoutSec: 600 } as OcrManagedLimits,
      ocrEffort: 'medium',
      modelReasoningEffort: 'medium',
      language: 'en',
      ruleText: buildOcrControlledRuleText({
        language: 'en',
        assignedPaths: ['calc.ts'],
      }),
      backgroundText: options.backgroundText ?? null,
      checkoutRoot,
      processRunner: options.processRunner,
      previewRunner: options.previewRunner,
      acceptanceDiagnostic: options.acceptanceDiagnostic,
    });
    return {
      adapter,
      workSlot: planned.assignments[0].workSlot,
      ...(second ? { secondWorkSlot: second.assignments[0].workSlot } : {}),
    };
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

  it('bounds background text to the binary hard limit before preview and identity', async () => {
    const { bridge } = bridgeFixture();
    const preview = previewRunner();
    const { adapter, workSlot } = adapterFixture({
      bridge,
      processRunner: unusedRunner,
      previewRunner: preview.runner,
      backgroundText: `Fix add()\n\n${'x'.repeat(8_541)}`,
    });
    await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    // Upstream OCR hard-aborts above 8000 characters, so the file behind
    // --background-file must be bounded to the value hashed into identity.
    const backgroundPath = path.join(runDirectory, 'background.md');
    const written = fs.readFileSync(backgroundPath, 'utf8');
    expect([...written].length).toBeLessThanOrEqual(8_000);
    expect(written.length).toBeLessThanOrEqual(8_000);
    expect(preview.calls[0].argv).toContain('--background-file');
    expect(preview.calls[0].argv).toContain(backgroundPath);
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

  it.each(['root', 'deadline'] as const)(
    'closes the real preview process on %s cancellation without inference',
    async (source) => {
      const root = new AbortController();
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let closedSignal: NodeJS.Signals | null = null;
      const processRunner = processRunnerWriting(nativeResultBody());
      const { adapter, workSlot } = adapterFixture({
        bridge: bridgeFixture().bridge,
        processRunner: processRunner.runner,
        lifecycle: {
          signal: root.signal,
          previewTimeoutMs: () => (source === 'deadline' ? 25 : 1000),
        },
        previewRunner: async (input) => {
          fs.writeFileSync(
            input.outputPath,
            JSON.stringify({ files: [{ path: 'calc.ts', will_review: true }] })
          );
          const child = runOcrReviewProcess({
            ...input,
            binaryPath: process.execPath,
            argv: ['-e', 'setTimeout(() => process.exit(0), 500)'],
          });
          started();
          const result = await child;
          closedSignal = result.signal;
          return result;
        },
      });
      const result = adapter.prepare({ workSlot, attemptOrdinal: 1 }).then(
        () => null,
        (error: unknown) => error as Error
      );
      await ready;
      if (source === 'root') root.abort(new Error('fixture_root_cancelled'));
      const failure = await result;
      expect(failure?.message).toMatch(
        source === 'root' ? /fixture_root_cancelled/ : /timeout/i
      );
      expect(closedSignal).toBe('SIGKILL');
      expect(processRunner.calls).toHaveLength(0);
    }
  );

  it('does not launch preview when the execution budget expires after composition', async () => {
    let remainingMs = 1000;
    const preview = previewRunner();
    const engine = processRunnerWriting(nativeResultBody());
    const { adapter, workSlot } = adapterFixture({
      bridge: bridgeFixture().bridge,
      processRunner: engine.runner,
      previewRunner: preview.runner,
      lifecycle: { previewTimeoutMs: () => remainingMs },
    });
    remainingMs = 0;
    await expect(
      adapter.prepare({ workSlot, attemptOrdinal: 1 })
    ).rejects.toThrow('review_action_v2_ocr_preview_timeout');
    expect(preview.calls).toHaveLength(0);
    expect(engine.calls).toHaveLength(0);
  });

  it('executes one managed run and reports the observed model with one transport attempt', async () => {
    const { bridge, requests } = bridgeFixture();
    requests.count = 1;
    const processRunner = processRunnerWriting(nativeResultBody());
    const receipt = {
      planDigest: 'sha256:' + 'a'.repeat(64),
      schemaDigest: 'sha256:' + 'b'.repeat(64),
      availableTools: ['rr_repository_docs_read'],
      nativeConnected: true,
      calls: 1,
      hadFailure: false,
    };
    const recordReceipt = jest.fn();
    const { adapter, workSlot } = adapterFixture({
      bridge,
      contextTools: { receipt: () => receipt, beginNativeSession: jest.fn() },
      contextToolsReceipt: recordReceipt,
      processRunner: async (input) => {
        const probe = await runOcrReviewProcess({
          ...input,
          binaryPath: process.execPath,
          argv: [
            '-e',
            'process.stdout.write(JSON.stringify({github:process.env.REVIEWROUTER_MCP_CREDENTIALS_JSON===undefined,dashboard:process.env.REVIEWROUTER_MCP_DASHBOARD_CREDENTIALS_JSON===undefined}))',
          ],
        });
        expect(JSON.parse(probe.stdoutTail)).toEqual({
          github: true,
          dashboard: true,
        });
        return processRunner.runner(input);
      },
      previewRunner: previewRunner().runner,
    });
    const prepared = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    const secretKeys = [
      'REVIEWROUTER_MCP_CREDENTIALS_JSON',
      'REVIEWROUTER_MCP_DASHBOARD_CREDENTIALS_JSON',
    ];
    const previous = secretKeys.map((key) => process.env[key]);
    for (const key of secretKeys)
      process.env[key] = '{"TOKEN":"synthetic-parent-only"}';
    let observation;
    try {
      observation = await adapter.execute(executionInput(prepared));
    } finally {
      secretKeys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
    expect(processRunner.calls).toHaveLength(1);
    expect(recordReceipt).toHaveBeenCalledTimes(1);
    expect(recordReceipt).toHaveBeenCalledWith(receipt);
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

  it('binds external context policy into semantic identity and rejects native success after required context failure', async () => {
    const { bridge, requests } = bridgeFixture();
    requests.count = 1;
    const engine = processRunnerWriting(nativeResultBody());
    const receipt = {
      planDigest: 'sha256:' + 'a'.repeat(64),
      schemaDigest: 'sha256:' + 'b'.repeat(64),
      availableTools: ['rr_mcp_docs_read'],
      nativeConnected: true,
      calls: 1,
      hadFailure: true,
    };
    const contextTools = {
      receipt: () => receipt,
      beginNativeSession: jest.fn(),
    };
    const recordReceipt = jest.fn();
    const selected = adapterFixture({
      bridge,
      processRunner: engine.runner,
      previewRunner: previewRunner().runner,
      contextTools,
      contextToolsReceipt: recordReceipt,
    });
    const base = adapterFixture({
      bridge,
      processRunner: engine.runner,
      previewRunner: previewRunner().runner,
    });
    const selectedPrepared = await selected.adapter.prepare({
      workSlot: selected.workSlot,
      attemptOrdinal: 1,
    });
    const basePrepared = await base.adapter.prepare({
      workSlot: base.workSlot,
      attemptOrdinal: 1,
    });
    expect(selectedPrepared.semanticIdentityHash).not.toBe(
      basePrepared.semanticIdentityHash
    );
    expect(selectedPrepared.manifestPreimages.toolPolicyHash).toContain(
      receipt.planDigest
    );
    expect(
      selectedPrepared.manifestPreimages.environmentContractHash
    ).toContain(receipt.schemaDigest);
    await expect(
      selected.adapter.execute(executionInput(selectedPrepared))
    ).rejects.toThrow('required_context_tools_unavailable');
    expect(contextTools.beginNativeSession).toHaveBeenCalledTimes(1);
    expect(recordReceipt).toHaveBeenCalledTimes(1);
    expect(recordReceipt).toHaveBeenCalledWith(receipt);
    expect(engine.calls).toHaveLength(1);
  });

  it('flags a degraded outcome with context_inspection_incomplete + provider_warning', async () => {
    const body = JSON.parse(nativeResultBody()) as Record<string, unknown>;
    const secretish = 'private_native_reason_and_model_content_923';
    body.comments = [
      {
        path: 'calc.ts',
        content: secretish,
        severity: 'unclassified',
        category: 'correctness',
        existing_code: secretish,
        start_line: 1,
        end_line: 1,
      },
      { path: 'private_path_923.ts', content: secretish },
    ];
    const outcome = body.reviewrouter_outcome as {
      groups: Record<string, unknown>[];
    };
    outcome.groups[0].main_completed = false;
    outcome.groups[0].stop_cause = 'review_limit_reached';
    outcome.groups[0].rounds = { configured: 2, started: 1, completed: 0 };
    (outcome.groups[0].phases as Record<string, unknown>).plan = {
      state: 'failed',
      reason: secretish,
    };
    const diagnostic = jest.fn<void, [OcrReviewAcceptanceDiagnostic]>();
    const { bridge, requests } = bridgeFixture();
    requests.count = 1;
    const { adapter, workSlot } = adapterFixture({
      bridge,
      acceptanceDiagnostic: diagnostic,
      processRunner: processRunnerWriting(JSON.stringify(body)).runner,
      previewRunner: previewRunner().runner,
    });
    const prepared = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    const observation = await adapter.execute(executionInput(prepared));
    expect(observation.qualityFlags).toEqual([
      'context_inspection_incomplete',
      'provider_warning',
    ]);
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledWith({
      reasons: [
        'late_round_stop',
        'review_limit',
        'phase_failed',
        'unverified_native_span',
        'unclassified_native_severity',
      ],
      acceptedPartial: true,
      classificationPartial: true,
      normalizationPartial: true,
      skippedFindingCount: 1,
      uncoveredPathCount: 0,
      nativeCommentCount: 2,
      normalizedFindingCount: 1,
    });
    const serialized = JSON.stringify(diagnostic.mock.calls);
    expect(serialized).not.toContain(secretish);
    expect(serialized).not.toContain('calc.ts');
    expect(serialized).not.toContain('private_path_923.ts');
  });

  it('tiers a preserved filter decision to provider_warning alone', async () => {
    const body = JSON.parse(nativeResultBody()) as Record<string, unknown>;
    const outcome = body.reviewrouter_outcome as {
      groups: Record<string, unknown>[];
    };
    (outcome.groups[0].phases as Record<string, unknown>).filter = {
      state: 'failed',
      reason: 'invalid_arguments',
    };
    outcome.groups[0].filter_decision_valid = false;
    const diagnostic = jest.fn<void, [OcrReviewAcceptanceDiagnostic]>();
    const { bridge, requests } = bridgeFixture();
    requests.count = 1;
    const { adapter, workSlot } = adapterFixture({
      bridge,
      acceptanceDiagnostic: diagnostic,
      processRunner: processRunnerWriting(JSON.stringify(body)).runner,
      previewRunner: previewRunner().runner,
    });
    const prepared = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    const observation = await adapter.execute(executionInput(prepared));
    // Comments were preserved: inspection and path coverage are intact, so
    // the advisory warning must not claim context inspection was incomplete.
    expect(observation.qualityFlags).toEqual(['provider_warning']);
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        acceptedPartial: true,
        classificationPartial: true,
      })
    );
  });

  it('keeps context_inspection_incomplete when a preserved filter decision shares a phase failure', async () => {
    const body = JSON.parse(nativeResultBody()) as Record<string, unknown>;
    const outcome = body.reviewrouter_outcome as {
      groups: Record<string, unknown>[];
    };
    (outcome.groups[0].phases as Record<string, unknown>).filter = {
      state: 'failed',
      reason: 'invalid_arguments',
    };
    (outcome.groups[0].phases as Record<string, unknown>).plan = {
      state: 'failed',
      reason: 'provider_error',
    };
    outcome.groups[0].filter_decision_valid = false;
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

  const preservedFilterResultBody = (
    overrides: Record<string, unknown> = {}
  ): string => {
    const body = JSON.parse(nativeResultBody(overrides)) as Record<
      string,
      unknown
    >;
    const outcome = body.reviewrouter_outcome as {
      groups: Record<string, unknown>[];
    };
    (outcome.groups[0].phases as Record<string, unknown>).filter = {
      state: 'failed',
      reason: 'invalid_arguments',
    };
    outcome.groups[0].filter_decision_valid = false;
    return JSON.stringify(body);
  };

  it('keeps context_inspection_incomplete when a preserved filter decision meets a normalization gap', async () => {
    const diagnostic = jest.fn<void, [OcrReviewAcceptanceDiagnostic]>();
    const { bridge, requests } = bridgeFixture();
    requests.count = 1;
    const { adapter, workSlot } = adapterFixture({
      bridge,
      acceptanceDiagnostic: diagnostic,
      processRunner: processRunnerWriting(
        preservedFilterResultBody({
          comments: [
            {
              path: 'calc.ts',
              content: 'Finding',
              severity: 'unclassified',
              category: 'correctness',
            },
          ],
        })
      ).runner,
      previewRunner: previewRunner().runner,
    });
    const prepared = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    const observation = await adapter.execute(executionInput(prepared));
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        normalizationPartial: true,
        uncoveredPathCount: 0,
      })
    );
    expect(observation.qualityFlags).toEqual([
      'context_inspection_incomplete',
      'provider_warning',
    ]);
  });

  it('keeps context_inspection_incomplete when a preserved filter decision meets an uncovered path', async () => {
    const diagnostic = jest.fn<void, [OcrReviewAcceptanceDiagnostic]>();
    const { bridge, requests } = bridgeFixture();
    requests.count = 1;
    const { adapter, workSlot } = adapterFixture({
      bridge,
      acceptanceDiagnostic: diagnostic,
      processRunner: processRunnerWriting(preservedFilterResultBody()).runner,
      previewRunner: previewRunner().runner,
      planInputOverrides: {
        pr: prContext({
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
            {
              filename: 'gone.ts',
              status: 'removed',
              additions: 0,
              deletions: 3,
              changes: 3,
            },
          ],
        }),
      },
    });
    const prepared = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    const observation = await adapter.execute(executionInput(prepared));
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        normalizationPartial: false,
        uncoveredPathCount: 1,
      })
    );
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

  it('reports a proven not_dispatched effect as retry-safe, not gateway_effect_unknown', async () => {
    // §8.4 step 2: a positively proven not_dispatched effect is a distinct
    // retry-safe failure; it must never be conflated with an unknown/paid
    // effect and must fence the engine invocation before dispatch.
    const { bridge } = bridgeFixture({
      effectFacts: () => ({ effect: 'not_dispatched' }),
    });
    const processRunner = processRunnerWriting(nativeResultBody());
    const { adapter, workSlot } = adapterFixture({
      bridge,
      processRunner: processRunner.runner,
      previewRunner: previewRunner().runner,
    });
    const prepared = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    const failure = await adapter.execute(executionInput(prepared)).then(
      () => null,
      (error: unknown) => error as Error
    );
    expect(failure).not.toBeNull();
    expect(failure?.message).toMatch(/review_action_v2_ocr_not_dispatched/u);
    expect(failure?.message).not.toMatch(/gateway_effect_unknown/u);
    expect(processRunner.calls).toHaveLength(0);
  });

  it('re-dispatches after a proven not_dispatched denial is released', async () => {
    // §8.4 step 2 retry-safe class: the proven pre-dispatch denial paid
    // nothing, so releasing it must not fence the next attempt.
    let effect: { effect: string } | undefined = { effect: 'not_dispatched' };
    let released = 0;
    const { bridge, requests } = bridgeFixture({
      effectFacts: () => effect,
      releaseRetrySafeFailure: () => {
        if (effect?.effect !== 'not_dispatched') return false;
        released += 1;
        effect = undefined;
        return true;
      },
    });
    requests.count = 1;
    const processRunner = processRunnerWriting(nativeResultBody());
    const { adapter, workSlot } = adapterFixture({
      bridge,
      processRunner: processRunner.runner,
      previewRunner: previewRunner().runner,
    });
    const prepared = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    const observation = await adapter.execute(executionInput(prepared));
    expect(released).toBe(1);
    expect(processRunner.calls).toHaveLength(1);
    expect(observation.transportAttemptCount).toBe(1);
  });

  it('keeps fencing an unknown effect and never consults the release seam', async () => {
    // An unknown/paid effect is never released and never dispatches again.
    const { bridge } = bridgeFixture({
      effectFacts: () => ({ effect: 'effect_unknown' }),
      releaseRetrySafeFailure: () => {
        throw new Error('release must not run for unknown effects');
      },
    });
    const processRunner = processRunnerWriting(nativeResultBody());
    const { adapter, workSlot } = adapterFixture({
      bridge,
      processRunner: processRunner.runner,
      previewRunner: previewRunner().runner,
    });
    const prepared = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    await expect(adapter.execute(executionInput(prepared))).rejects.toThrow(
      /review_action_v2_ocr_gateway_effect_unknown/u
    );
    expect(processRunner.calls).toHaveLength(0);
  });

  it('never replays an engine run that failed without a proven unpaid denial', async () => {
    // The first run may have paid for its model requests before failing; no
    // gateway fact proves otherwise, so the next attempt must not dispatch.
    const { bridge, requests } = bridgeFixture({
      releaseRetrySafeFailure: () => {
        throw new Error('release must not run without a proven denial');
      },
    });
    const processRunner = processRunnerWriting(nativeResultBody());
    const { adapter, workSlot } = adapterFixture({
      bridge,
      processRunner: async (input) => {
        const result = await processRunner.runner(input);
        requests.count += 1;
        return processRunner.calls.length === 1
          ? { ...result, exitCode: 3 }
          : result;
      },
      previewRunner: previewRunner().runner,
    });
    const first = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    await expect(adapter.execute(executionInput(first))).rejects.toThrow(
      /review_action_v2_ocr_process_failed/u
    );
    const second = await adapter.prepare({ workSlot, attemptOrdinal: 2 });
    await expect(adapter.execute(executionInput(second))).rejects.toThrow(
      /review_action_v2_ocr_replay_fenced/u
    );
    expect(processRunner.calls).toHaveLength(1);
  });

  it('dispatches the next attempt once the previous run left a released proven denial', async () => {
    // Production failure class: the run's only relay request was denied
    // before dispatch, so the following attempt may run the engine again.
    let effect: { effect: string } | undefined;
    let released = 0;
    const { bridge, requests } = bridgeFixture({
      effectFacts: () => effect,
      releaseRetrySafeFailure: () => {
        if (effect?.effect !== 'not_dispatched') return false;
        released += 1;
        effect = undefined;
        return true;
      },
    });
    const processRunner = processRunnerWriting(nativeResultBody());
    const { adapter, workSlot } = adapterFixture({
      bridge,
      processRunner: async (input) => {
        const result = await processRunner.runner(input);
        requests.count += 1;
        if (processRunner.calls.length > 1) return result;
        effect = { effect: 'not_dispatched' };
        return { ...result, exitCode: 1 };
      },
      previewRunner: previewRunner().runner,
    });
    const first = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    await expect(adapter.execute(executionInput(first))).rejects.toThrow(
      /review_action_v2_ocr_review_agent_not_dispatched/u
    );
    const second = await adapter.prepare({ workSlot, attemptOrdinal: 2 });
    const observation = await adapter.execute(executionInput(second));
    expect(released).toBe(1);
    expect(processRunner.calls).toHaveLength(2);
    expect(observation.transportAttemptCount).toBe(1);
  });

  it('classifies an inventory gap as a partial missing_paths observation', async () => {
    // §8.1/§8.2: a deleted file stays in the RR inventory denominator but the
    // producer never groups it; that gap is a bounded missing_paths
    // limitation, not a fatal coverage mismatch.
    const { bridge, requests } = bridgeFixture();
    requests.count = 1;
    const processRunner = processRunnerWriting(nativeResultBody());
    const { adapter, workSlot } = adapterFixture({
      bridge,
      processRunner: processRunner.runner,
      previewRunner: previewRunner().runner,
      planInputOverrides: {
        pr: prContext({
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
            {
              filename: 'gone.ts',
              status: 'removed',
              additions: 0,
              deletions: 3,
              changes: 3,
            },
          ],
        }),
      },
    });
    const prepared = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    const observation = await adapter.execute(executionInput(prepared));
    expect(observation.qualityFlags).toEqual([
      'context_inspection_incomplete',
      'provider_warning',
    ]);
  });

  it('fails explicitly when the materialized observation payload exceeds 512 KiB', async () => {
    // §8.2: the payload bound is checked exactly by the adapter after the
    // existing normalizer serializes the observation; oversize is an explicit
    // OcrOutputTooLargeError('payload'), never silent truncation.
    const { bridge, requests } = bridgeFixture();
    requests.count = 1;
    const processRunner = processRunnerWriting(
      nativeResultBody({ comments: bulkyNativeComments(40) })
    );
    const { adapter, workSlot } = adapterFixture({
      bridge,
      processRunner: processRunner.runner,
      previewRunner: previewRunner().runner,
    });
    const prepared = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    const failure = await adapter.execute(executionInput(prepared)).then(
      () => null,
      (error: unknown) => error as Error
    );
    expect(failure?.name).toBe('OcrOutputTooLargeError');
    expect(failure?.message).toBe('ocr_review_output_too_large: payload');
  });

  it('accepts a materialized observation payload within the 512 KiB bound', async () => {
    const { bridge, requests } = bridgeFixture();
    requests.count = 1;
    const processRunner = processRunnerWriting(
      nativeResultBody({ comments: bulkyNativeComments(20) })
    );
    const { adapter, workSlot } = adapterFixture({
      bridge,
      processRunner: processRunner.runner,
      previewRunner: previewRunner().runner,
    });
    const prepared = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    const observation = await adapter.execute(executionInput(prepared));
    expect(observation.byteCount).toBeLessThanOrEqual(512 * 1024);
    expect(observation.findingCount).toBe(20);
  });

  function slowProcessRunner(counters: {
    active: number;
    maxActive: number;
    runs: number;
  }): OcrReviewProcessRunner {
    return async (input) => {
      counters.runs += 1;
      counters.active += 1;
      counters.maxActive = Math.max(counters.maxActive, counters.active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      counters.active -= 1;
      const outputPath = input.argv[input.argv.indexOf('--output') + 1];
      fs.writeFileSync(outputPath, nativeResultBody());
      return {
        closed: true,
        exitCode: 0,
        signal: null,
        stdoutTail: '',
        stderrTail: '',
      };
    };
  }

  it('serializes engine invocations (real in-flight <= 1)', async () => {
    const { bridge, requests } = bridgeFixture();
    requests.count = 1;
    const counters = { active: 0, maxActive: 0, runs: 0 };
    const { adapter, workSlot, secondWorkSlot } = adapterFixture({
      bridge,
      processRunner: slowProcessRunner(counters),
      previewRunner: previewRunner().runner,
      secondSlotPlanInputOverrides: { compatibilityKey: '7'.repeat(64) },
    });
    expect(secondWorkSlot?.workSlotId).not.toBe(workSlot.workSlotId);
    const first = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    const second = await adapter.prepare({
      workSlot: secondWorkSlot!,
      attemptOrdinal: 1,
    });
    const [one, two] = await Promise.all([
      adapter.execute(executionInput(first)),
      adapter.execute(executionInput(second)),
    ]);
    expect(counters.maxActive).toBe(1);
    expect(counters.runs).toBe(2);
    expect(one.transportAttemptCount).toBe(1);
    expect(two.transportAttemptCount).toBe(1);
  });

  it('never replays a finished run when executes of one slot race', async () => {
    // The fence is checked inside the gate, so a racing execute cannot pass
    // it before the first run dispatched and paid.
    const { bridge, requests } = bridgeFixture();
    requests.count = 1;
    const counters = { active: 0, maxActive: 0, runs: 0 };
    const { adapter, workSlot } = adapterFixture({
      bridge,
      processRunner: slowProcessRunner(counters),
      previewRunner: previewRunner().runner,
    });
    const first = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
    const second = await adapter.prepare({ workSlot, attemptOrdinal: 2 });
    const [one, two] = await Promise.allSettled([
      adapter.execute(executionInput(first)),
      adapter.execute(executionInput(second)),
    ]);
    expect(counters.runs).toBe(1);
    expect(one.status === 'fulfilled' && one.value.transportAttemptCount).toBe(
      1
    );
    expect(two.status === 'rejected' && String(two.reason)).toMatch(
      /review_action_v2_ocr_replay_fenced/u
    );
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
