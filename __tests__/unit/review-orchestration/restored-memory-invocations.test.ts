import { createHash } from 'node:crypto';
import { PromptBuilder } from '../../../src/analysis/llm/prompt-builder';
import { DEFAULT_CONFIG } from '../../../src/config/defaults';
import { canonicalJson } from '../../../src/context-gateway/context-gateway-contract';
import { freezeReviewMemorySnapshot } from '../../../src/control-plane/review-memory-v2';
import {
  ProviderKind,
  createPreparedProviderInvocation,
} from '../../../src/providers/prepared-invocation';
import type { CodexProvider } from '../../../src/providers/codex';
import {
  ReviewExecutionProviderKind,
  ReviewTaskKind,
  RestoredReviewWorkSlotState,
  type RestoredReviewExecution,
} from '../../../src/review-orchestration/application';
import {
  CodexReviewInvocationAdapter,
  prepareCodexReviewPrompt,
  type CodexReviewAssignment,
} from '../../../src/review-orchestration/infrastructure/codex-review-invocation-adapter';
import {
  restoredLifecycleInvocations,
  restoredLifecycleManifestAssembler,
} from '../../../src/review-orchestration/infrastructure/restored-lifecycle-invocations';
import { reviewMemoryBundle } from '../../helpers/review-memory-v2-fixture';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
async function fixture() {
  const snapshot = freezeReviewMemorySnapshot(reviewMemoryBundle());
  let current: typeof snapshot | null = snapshot;
  const workSlot = {
    workSlotId: 'slot-memory',
    taskKind: ReviewTaskKind.FindingDiscovery,
    providerKind: ReviewExecutionProviderKind.Codex,
    providerVoteIdentityHash: 'a'.repeat(64),
    shardKey: 'batch-1',
    required: true,
    attemptBudget: 1,
    retryPolicyVersion: 'retry-v1',
  };
  const provider = {
    prepareInvocation: jest.fn(async (prompt: string) =>
      createPreparedProviderInvocation({
        providerKind: ProviderKind.CodexCli,
        providerName: 'codex/gpt-test',
        requestedModel: 'gpt-test',
        timeoutMs: 1000,
        request: { prompt },
        observableRequest: { prompt },
      })
    ),
    describePreparedEnvironmentContract: () => ({}),
    executePreparedInvocation: jest.fn(),
  };
  const assignment: CodexReviewAssignment = {
    workSlot,
    reviewRevisionHash: 'b'.repeat(64),
    mergeBaseSha: 'c'.repeat(40),
    context: {
      number: 7,
      title: 'Update timeout',
      body: 'Bound external requests',
      author: 'owner',
      draft: false,
      labels: [],
      files: [
        {
          filename: 'request.ts',
          status: 'modified',
          additions: 1,
          deletions: 1,
          changes: 2,
          patch: '@@ -1 +1 @@\n-const timeout = 0;\n+const timeout = 30;',
        },
      ],
      diff: '@@ -1 +1 @@\n-const timeout = 0;\n+const timeout = 30;',
      additions: 1,
      deletions: 1,
      baseSha: 'c'.repeat(40),
      headSha: 'd'.repeat(40),
    },
    lifecycleTargets: [],
    liveLifecycleStateHash: 'e'.repeat(64),
  };
  const adapter = new CodexReviewInvocationAdapter(
    provider as unknown as CodexProvider,
    new PromptBuilder(DEFAULT_CONFIG),
    [assignment],
    1000,
    false,
    undefined,
    false,
    'xhigh',
    undefined,
    undefined,
    { current: () => current }
  );
  const first = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
  current = null;
  const rebuilt = await adapter.prepare({ workSlot, attemptOrdinal: 1 });
  const original = {
    workSlotId: workSlot.workSlotId,
    manifestCanonicalJson: canonicalJson({
      ...first.manifestFacts,
      requestedModel: first.requestedModel,
    }),
    manifestKey: 'e'.repeat(64),
    providerInvocationKey: 'f'.repeat(64),
    providerVoteIdentityHash: workSlot.providerVoteIdentityHash,
  };
  const restored = {
    reviewRevisionHash: 'b'.repeat(64),
    workSlots: [
      {
        workSlotId: workSlot.workSlotId,
        state: RestoredReviewWorkSlotState.Satisfied,
      },
    ],
    persistedPlan: { acceptedManifests: [original] },
  } as unknown as RestoredReviewExecution;
  return {
    adapter,
    provider,
    first,
    rebuilt,
    original,
    restored,
    workSlot,
    snapshot,
    assignment,
  };
}

test('restores exact original memory manifest with verified memory-independent Codex coverage and no executable request', async () => {
  const f = await fixture();
  const readonly = restoredLifecycleInvocations(f.restored, f.adapter);
  const recovered = await readonly.prepare({
    workSlot: f.workSlot,
    attemptOrdinal: 1,
  });
  expect(recovered.coverageManifest).toEqual(f.first.coverageManifest);
  expect(recovered.manifestFacts).toMatchObject(f.first.manifestFacts);
  expect(recovered.reviewPrompt).toBe('');
  expect(recovered.immutableRequest).toBeNull();
  expect(JSON.stringify(recovered)).not.toContain(f.snapshot.renderedPrompt);
  const assemble = jest.fn();
  await expect(
    restoredLifecycleManifestAssembler(f.restored, { assemble }).assemble(
      recovered
    )
  ).resolves.toEqual(f.original);
  expect(assemble).not.toHaveBeenCalled();
  await expect(
    readonly.execute({ invocation: recovered } as never)
  ).rejects.toThrow('review_restore_inference_forbidden');
  expect(f.provider.executePreparedInvocation).not.toHaveBeenCalled();
});

test.each([
  'title',
  'reviewSkills',
  'investigationProbePlanHash',
  'coverageHash',
])('rejects changed %s instead of inventing original coverage', async (key) => {
  const f = await fixture();
  const context = JSON.parse(f.rebuilt.manifestPreimages.contextManifestHash);
  context[key] =
    key === 'reviewSkills'
      ? { capturedDigest: '0'.repeat(64), executionDigest: '1'.repeat(64) }
      : 'changed';
  const preimage = canonicalJson(context);
  const prepare = jest.fn(async () => ({
    ...f.rebuilt,
    manifestPreimages: {
      ...f.rebuilt.manifestPreimages,
      contextManifestHash: preimage,
    },
    manifestFacts: {
      ...f.rebuilt.manifestFacts,
      contextManifestHash: hash(preimage),
    },
  }));
  const readonly = restoredLifecycleInvocations(f.restored, {
    prepare,
    execute: jest.fn(),
  });
  await expect(
    readonly.prepare({ workSlot: f.workSlot, attemptOrdinal: 1 })
  ).rejects.toThrow('review_restore_coverage_commitment_mismatch');
});

test('rejects changed source patches before restoring accepted coverage', async () => {
  const f = await fixture();
  const prepare = jest.fn(async () => ({
    ...f.rebuilt,
    manifestFacts: {
      ...f.rebuilt.manifestFacts,
      filePatchManifestHash: '0'.repeat(64),
    },
  }));
  const readonly = restoredLifecycleInvocations(f.restored, {
    prepare,
    execute: jest.fn(),
  });
  await expect(
    readonly.prepare({ workSlot: f.workSlot, attemptOrdinal: 1 })
  ).rejects.toThrow('review_restore_coverage_commitment_mismatch');
});

test('investigation preparation excludes memory even when a direct caller supplies a captured snapshot', async () => {
  const f = await fixture();
  const prepared = await prepareCodexReviewPrompt(
    new PromptBuilder(DEFAULT_CONFIG),
    f.assignment,
    true,
    f.snapshot
  );
  expect(prepared.preparedPrompt.memoryBundleHash).toBeUndefined();
  expect(prepared.prompt).not.toContain(f.snapshot.renderedPrompt);
  expect(prepared.investigationContextPrompt).not.toContain(
    'AUTHORIZED REVIEWROUTER MEMORY'
  );
});
