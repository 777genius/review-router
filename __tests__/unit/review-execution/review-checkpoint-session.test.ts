import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  ReviewCheckpointBatchResultStatus,
  ReviewCheckpointClientPort,
  ReviewCheckpointFinalizeStatus,
  ReviewCheckpointPlanIdentity,
  ReviewCheckpointRestoreStatus,
  ReviewCheckpointStartStatus,
  createReviewCheckpointPlanIdentity,
  normalizeReviewCheckpointBatchPayload,
  parseReviewCheckpointFinalizationMarker,
} from '../../../src/review-execution/domain/review-checkpoint';
import {
  ReviewCheckpointCommitStatus,
  ReviewCheckpointSession,
  ReviewCheckpointSessionFinalizeStatus,
} from '../../../src/review-execution/application/review-checkpoint-session';
import { FileReviewCheckpointFinalizationMarkerWriter } from '../../../src/review-execution/infrastructure/http-review-checkpoint-client';

const baseSha = '1'.repeat(40);
const headSha = '2'.repeat(40);
const compatibilityKey = '3'.repeat(64);
const planHash = '4'.repeat(64);
const firstWorkKey = '5'.repeat(64);
const secondWorkKey = '6'.repeat(64);

function plan(workKeys = [firstWorkKey, secondWorkKey]) {
  return createReviewCheckpointPlanIdentity({
    pullRequestNumber: 91,
    baseSha,
    headSha,
    compatibilityKey,
    planHash,
    workKeys,
  });
}

function clientMock(): jest.Mocked<ReviewCheckpointClientPort> {
  return {
    restore: jest.fn(),
    start: jest.fn(),
    commitBatchResult: jest.fn(),
    finalize: jest.fn(),
    clear: jest.fn(),
  };
}

function startedClient(
  checkpointClient: jest.Mocked<ReviewCheckpointClientPort>,
  checkpointPlan: ReviewCheckpointPlanIdentity
): void {
  checkpointClient.restore.mockResolvedValueOnce({
    status: ReviewCheckpointRestoreStatus.Missing,
    expectedVersion: 0,
  });
  checkpointClient.start.mockResolvedValueOnce({
    status: ReviewCheckpointStartStatus.Started,
    version: 1,
    headSha: checkpointPlan.headSha,
    planHash: checkpointPlan.planHash,
  });
}

function batchInput(workKey: string) {
  return {
    workKey,
    filePaths: [`src/${workKey.slice(0, 4)}.ts`],
    providerResults: [
      {
        name: 'codex/oauth',
        status: 'success',
        durationSeconds: 1,
        result: { findings: [] },
      },
    ],
  };
}

describe('ReviewCheckpointSession', () => {
  it.each([
    [ReviewCheckpointStartStatus.Started, 0],
    [ReviewCheckpointStartStatus.Replaced, 2],
  ] as const)(
    'rejects a state-changing %s acknowledgement unless it advances exactly one version',
    async (status, version) => {
      const checkpointPlan = plan();
      const checkpointClient = clientMock();
      checkpointClient.restore.mockResolvedValueOnce({
        status: ReviewCheckpointRestoreStatus.Missing,
        expectedVersion: 0,
      });
      checkpointClient.start.mockResolvedValueOnce({
        status,
        version,
        headSha,
        planHash,
      });

      const session = await ReviewCheckpointSession.open({
        client: checkpointClient,
        plan: checkpointPlan,
      });

      expect(session).toBeNull();
    }
  );

  it('restores accepted results in deterministic plan order', async () => {
    const checkpointPlan = plan();
    const checkpointClient = clientMock();
    const firstPayload = normalizeReviewCheckpointBatchPayload(
      batchInput(firstWorkKey)
    );
    const secondPayload = normalizeReviewCheckpointBatchPayload(
      batchInput(secondWorkKey)
    );
    checkpointClient.restore.mockResolvedValueOnce({
      status: ReviewCheckpointRestoreStatus.Found,
      expectedVersion: 9,
      checkpoint: {
        version: 9,
        plan: checkpointPlan,
        acceptedResults: [
          { workKey: secondWorkKey, payload: secondPayload },
          { workKey: firstWorkKey, payload: firstPayload },
        ],
        finalized: true,
      },
    });

    const session = await ReviewCheckpointSession.open({
      client: checkpointClient,
      plan: checkpointPlan,
    });

    expect(session).not.toBeNull();
    expect([...session!.acceptedBatchResults.keys()]).toEqual([
      firstWorkKey,
      secondWorkKey,
    ]);
    expect(checkpointClient.start).not.toHaveBeenCalled();
  });

  it('commits, replays locally, and reconciles one CAS conflict before retry', async () => {
    const checkpointPlan = plan();
    const checkpointClient = clientMock();
    startedClient(checkpointClient, checkpointPlan);
    const firstPayload = normalizeReviewCheckpointBatchPayload(
      batchInput(firstWorkKey)
    );
    checkpointClient.commitBatchResult
      .mockResolvedValueOnce({
        status: ReviewCheckpointBatchResultStatus.Accepted,
        version: 2,
        headSha,
        planHash,
        workKey: firstWorkKey,
      })
      .mockResolvedValueOnce({
        status: ReviewCheckpointBatchResultStatus.Conflict,
        currentVersion: 3,
      })
      .mockResolvedValueOnce({
        status: ReviewCheckpointBatchResultStatus.Accepted,
        version: 4,
        headSha,
        planHash,
        workKey: secondWorkKey,
      });
    checkpointClient.restore.mockResolvedValueOnce({
      status: ReviewCheckpointRestoreStatus.Found,
      expectedVersion: 3,
      checkpoint: {
        version: 3,
        plan: checkpointPlan,
        acceptedResults: [{ workKey: firstWorkKey, payload: firstPayload }],
        finalized: false,
      },
    });
    const session = await ReviewCheckpointSession.open({
      client: checkpointClient,
      plan: checkpointPlan,
    });

    const first = await session!.commitSuccessfulBatch(
      batchInput(firstWorkKey)
    );
    const replay = await session!.commitSuccessfulBatch(
      batchInput(firstWorkKey)
    );
    const second = await session!.commitSuccessfulBatch(
      batchInput(secondWorkKey)
    );

    expect(first.status).toBe(ReviewCheckpointCommitStatus.Accepted);
    expect(replay.status).toBe(ReviewCheckpointCommitStatus.Idempotent);
    expect(second.status).toBe(ReviewCheckpointCommitStatus.Accepted);
    expect(checkpointClient.commitBatchResult).toHaveBeenCalledTimes(3);
    expect(
      checkpointClient.commitBatchResult.mock.calls[2][0].expectedVersion
    ).toBe(3);
    expect(checkpointClient.commitBatchResult.mock.calls[2][0]).toMatchObject({
      workKey: secondWorkKey,
      batchId: secondWorkKey,
      batchIndex: 1,
    });
    expect(checkpointClient.restore.mock.calls[1][0]).toEqual({
      pullRequestNumber: 91,
      baseSha,
      headSha,
      compatibilityKey,
      planHash,
    });
    expect(session!.currentExpectedVersion).toBe(4);
    expect([...session!.acceptedBatchResults.keys()]).toEqual([
      firstWorkKey,
      secondWorkKey,
    ]);
  });

  it('disables instead of merging a mismatched plan after a CAS conflict', async () => {
    const checkpointPlan = plan([firstWorkKey]);
    const checkpointClient = clientMock();
    const warnings: string[] = [];
    startedClient(checkpointClient, checkpointPlan);
    checkpointClient.commitBatchResult.mockResolvedValueOnce({
      status: ReviewCheckpointBatchResultStatus.Conflict,
      currentVersion: 2,
    });
    checkpointClient.restore.mockResolvedValueOnce({
      status: ReviewCheckpointRestoreStatus.Found,
      expectedVersion: 2,
      checkpoint: {
        version: 2,
        plan: { ...checkpointPlan, headSha: '9'.repeat(40) },
        acceptedResults: [],
        finalized: false,
      },
    });
    const session = await ReviewCheckpointSession.open({
      client: checkpointClient,
      plan: checkpointPlan,
      logger: { warn: (message) => warnings.push(message) },
    });

    const result = await session!.commitSuccessfulBatch(
      batchInput(firstWorkKey)
    );

    expect(result.status).toBe(ReviewCheckpointCommitStatus.Disabled);
    expect(session!.isEnabled).toBe(false);
    expect(checkpointClient.commitBatchResult).toHaveBeenCalledTimes(1);
    expect(warnings.join('\n')).toContain(
      'checkpoint_plan_changed_during_reconcile'
    );
  });

  it('blocks finalize until every planned work key is accepted', async () => {
    const checkpointPlan = plan();
    const checkpointClient = clientMock();
    startedClient(checkpointClient, checkpointPlan);
    const session = await ReviewCheckpointSession.open({
      client: checkpointClient,
      plan: checkpointPlan,
    });

    const result = await session!.finalize({
      snapshotAdvancementRequired: true,
    });

    expect(result).toEqual({
      status: ReviewCheckpointSessionFinalizeStatus.Incomplete,
      missingWorkKeys: [firstWorkKey, secondWorkKey],
    });
    expect(checkpointClient.finalize).not.toHaveBeenCalled();
    expect(checkpointClient.clear).not.toHaveBeenCalled();
  });

  it.each([
    ReviewCheckpointFinalizeStatus.Finalized,
    ReviewCheckpointFinalizeStatus.Idempotent,
  ] as const)(
    'writes a strict 0600 marker after a %s finalize acknowledgement',
    async (finalizeStatus) => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'review-checkpoint-marker-')
      );
      const markerPath = path.join(directory, 'finalized.json');
      try {
        const checkpointPlan = plan([firstWorkKey]);
        const checkpointClient = clientMock();
        startedClient(checkpointClient, checkpointPlan);
        checkpointClient.commitBatchResult.mockResolvedValueOnce({
          status: ReviewCheckpointBatchResultStatus.Accepted,
          version: 2,
          headSha,
          planHash,
          workKey: firstWorkKey,
        });
        checkpointClient.finalize.mockResolvedValueOnce({
          status: finalizeStatus,
          version: 3,
          headSha,
          planHash,
        });
        const session = await ReviewCheckpointSession.open({
          client: checkpointClient,
          plan: checkpointPlan,
          markerWriter: new FileReviewCheckpointFinalizationMarkerWriter(
            markerPath
          ),
        });
        await session!.commitSuccessfulBatch(batchInput(firstWorkKey));

        const result = await session!.finalize({
          snapshotAdvancementRequired: true,
        });
        const rawMarker = await fs.readFile(markerPath, 'utf8');
        const marker = parseReviewCheckpointFinalizationMarker(rawMarker);
        const mode = (await fs.stat(markerPath)).mode & 0o777;

        expect(result).toEqual({
          status:
            finalizeStatus === ReviewCheckpointFinalizeStatus.Idempotent
              ? ReviewCheckpointSessionFinalizeStatus.Idempotent
              : ReviewCheckpointSessionFinalizeStatus.Finalized,
          expectedVersion: 3,
          markerWritten: true,
        });
        expect(marker).toEqual({
          protocolVersion: 1,
          pullRequestNumber: 91,
          headSha,
          planHash,
          expectedVersion: 3,
          snapshotAdvancementRequired: true,
        });
        expect(Object.keys(marker)).toEqual([
          'protocolVersion',
          'pullRequestNumber',
          'headSha',
          'planHash',
          'expectedVersion',
          'snapshotAdvancementRequired',
        ]);
        expect(mode).toBe(0o600);
        expect(checkpointClient.clear).not.toHaveBeenCalled();
        expect(() =>
          parseReviewCheckpointFinalizationMarker({
            ...marker,
            rawToken: 'must-be-rejected',
          })
        ).toThrow();
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.each([0, 1, 3])(
    'rejects a state-changing batch acknowledgement at invalid version %s',
    async (version) => {
      const checkpointPlan = plan([firstWorkKey]);
      const checkpointClient = clientMock();
      startedClient(checkpointClient, checkpointPlan);
      checkpointClient.commitBatchResult.mockResolvedValueOnce({
        status: ReviewCheckpointBatchResultStatus.Accepted,
        version,
        headSha,
        planHash,
        workKey: firstWorkKey,
      });
      const session = await ReviewCheckpointSession.open({
        client: checkpointClient,
        plan: checkpointPlan,
      });

      const result = await session!.commitSuccessfulBatch(
        batchInput(firstWorkKey)
      );

      expect(result.status).toBe(ReviewCheckpointCommitStatus.Disabled);
      expect(session!.currentExpectedVersion).toBe(1);
      expect(session!.acceptedBatchResults.size).toBe(0);
    }
  );

  it('accepts a non-regressing idempotent batch acknowledgement', async () => {
    const checkpointPlan = plan([firstWorkKey]);
    const checkpointClient = clientMock();
    startedClient(checkpointClient, checkpointPlan);
    checkpointClient.commitBatchResult.mockResolvedValueOnce({
      status: ReviewCheckpointBatchResultStatus.Idempotent,
      version: 3,
      headSha,
      planHash,
      workKey: firstWorkKey,
    });
    const session = await ReviewCheckpointSession.open({
      client: checkpointClient,
      plan: checkpointPlan,
    });

    const result = await session!.commitSuccessfulBatch(
      batchInput(firstWorkKey)
    );

    expect(result.status).toBe(ReviewCheckpointCommitStatus.Idempotent);
    expect(session!.currentExpectedVersion).toBe(3);
    expect(session!.acceptedBatchResults.size).toBe(1);
  });

  it.each([1, 2, 4])(
    'rejects a state-changing finalize acknowledgement at invalid version %s',
    async (version) => {
      const checkpointPlan = plan([firstWorkKey]);
      const checkpointClient = clientMock();
      startedClient(checkpointClient, checkpointPlan);
      checkpointClient.commitBatchResult.mockResolvedValueOnce({
        status: ReviewCheckpointBatchResultStatus.Accepted,
        version: 2,
        headSha,
        planHash,
        workKey: firstWorkKey,
      });
      checkpointClient.finalize.mockResolvedValueOnce({
        status: ReviewCheckpointFinalizeStatus.Finalized,
        version,
        headSha,
        planHash,
      });
      const markerWriter = { write: jest.fn() };
      const session = await ReviewCheckpointSession.open({
        client: checkpointClient,
        plan: checkpointPlan,
        markerWriter,
      });
      await session!.commitSuccessfulBatch(batchInput(firstWorkKey));

      const result = await session!.finalize({
        snapshotAdvancementRequired: false,
      });

      expect(result.status).toBe(
        ReviewCheckpointSessionFinalizeStatus.Disabled
      );
      expect(session!.currentExpectedVersion).toBe(2);
      expect(markerWriter.write).not.toHaveBeenCalled();
    }
  );
});
