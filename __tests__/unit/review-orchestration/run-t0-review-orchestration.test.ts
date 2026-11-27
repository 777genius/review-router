import {
  restoredLifecycleInvocations,
  restoredLifecycleManifestAssembler,
} from '../../../src/review-orchestration/infrastructure/restored-lifecycle-invocations';
import { createHash } from 'crypto';
import {
  ReviewEvidenceLookupKind,
  ReviewContextInspectionFailureReason,
  ReviewExecutionProviderKind,
  ReviewInvocationConfigurationMismatchError,
  ReviewInvocationConfigurationMismatchReason,
  ReviewInvocationFailureClass,
  ReviewInvocationLeaseAcquireOutcomeStatus,
  ReviewInvestigationDiagnosticOutcome,
  ReviewInvestigationRecordingMode,
  ReviewOrchestrationResultStatus,
  ReviewPublicationRequestOutcomeStatus,
  ReviewPublicationUnavailableFact,
  ReviewPublicationState,
  RestoredReviewExecutionState,
  RestoredReviewWorkSlotState,
  ReviewTaskKind,
  RetryableReviewContextInspectionFailure,
  RunT0ReviewOrchestration,
  FallbackLaneOutcome,
  ReviewWorkSlotExhaustionReason,
  fallbackLaneOutcome,
  orderedFallbackCoverage,
  stoppedReviewerExhaustion,
  reviewerCompletedRequiredWork,
  canonicalizeReviewWorkSlots,
  type ReviewActionV2ControlPlanePort,
  type ReviewOrchestrationDelayPort,
  type ReviewOrchestrationIdentityPort,
  type ReviewRunAuthorization,
  type ReviewWorkSlotPlan,
  type RunT0ReviewOrchestrationCommand,
  type RunT0ReviewOrchestrationDependencies,
  type PreparedReviewInvocationPort,
  type RestoredReviewExecution,
} from '../../../src/review-orchestration/application';
import {
  createReviewPromptCoverageManifest,
  ReviewOrchestrationPhase,
  ReviewPromptPathCoverageKind,
} from '../../../src/review-orchestration/domain';
import {
  ReviewInvestigationDeferredSignal,
  ReviewInvestigationLegacyFallbackSignal,
  type ReviewInvestigationDeferredRunStatus,
} from '../../../src/review-investigation/application/run-investigation-work-slot';
import { ReviewInvestigationRunStatus } from '../../../src/review-investigation/domain/investigation-state';
import { MergeGateConclusion } from '../../../src/review-projection/domain';
import { ExecutionDeadline } from '../../../src/review-execution/domain/execution-deadline';

import { GeneratedProviderInvocationManifestAssembler } from '../../../src/review-orchestration/infrastructure/codex-review-invocation-adapter';
import { ProviderInvocationFailureClassifier } from '../../../src/review-orchestration/infrastructure/provider-invocation-failure-classifier';
import type { ReviewConfig } from '../../../src/types';

describe('RunT0ReviewOrchestration', () => {
  it('finishes an already-admitted immutable snapshot after post-acquire revocation', async () => {
    const fixture = createFixture();
    let eligible = true;
    const prepare = (
      fixture.dependencies.invocations.prepare as jest.Mock
    ).getMockImplementation()!;
    (fixture.dependencies.invocations.prepare as jest.Mock).mockImplementation(
      async (input) => {
        const invocation = await prepare(input);
        return {
          ...invocation,
          manifestFacts: {
            ...invocation.manifestFacts,
            memoryBundleHash: eligible ? hash('memory') : null,
          },
        };
      }
    );
    Object.assign(fixture.dependencies, {
      memoryAdmission: {
        isEligible: jest.fn(async () => eligible),
        discard: jest.fn(() => {
          eligible = false;
        }),
      },
    });
    const acquire =
      fixture.controlPlane.acquireInvocationLease.getMockImplementation()!;
    fixture.controlPlane.acquireInvocationLease.mockImplementation(
      async (input) => {
        const result = await acquire(input);
        if (
          result.status === ReviewInvocationLeaseAcquireOutcomeStatus.Acquired
        )
          eligible = false;
        return result;
      }
    );
    const result = await fixture.useCase.execute(fixture.command);
    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({
          manifestFacts: expect.objectContaining({
            memoryBundleHash: hash('memory'),
          }),
        }),
      })
    );
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      1
    );
    expect(
      (fixture.dependencies.invocations.prepare as jest.Mock).mock.calls.map(
        ([input]) => input.attemptOrdinal
      )
    ).toEqual([1]);
  });

  it('drops memory on atomic precharge input_stale and prepares the same single-budget attempt without a phantom lease', async () => {
    const fixture = createFixture({
      investigationMode: ReviewInvestigationRecordingMode.Authoritative,
    });
    Object.assign(fixture.dependencies, {
      invocationManifestAssembler:
        new GeneratedProviderInvocationManifestAssembler(
          authorization,
          {} as ReviewConfig,
          hash('compatibility')
        ),
    });
    let captured = true;
    const prepare = (
      fixture.dependencies.invocations.prepare as jest.Mock
    ).getMockImplementation()!;
    (fixture.dependencies.invocations.prepare as jest.Mock).mockImplementation(
      async (input) => {
        const invocation = await prepare(input);
        return {
          ...invocation,
          reviewPrompt: captured ? 'with admitted memory' : 'without memory',
          manifestFacts: {
            ...invocation.manifestFacts,
            memoryBundleHash: captured ? hash('memory') : null,
          },
        };
      }
    );
    const discard = jest.fn(() => {
      captured = false;
    });
    Object.assign(fixture.dependencies, {
      memoryAdmission: { isEligible: jest.fn(async () => captured), discard },
    });
    fixture.controlPlane.acquireInvocationLease.mockResolvedValueOnce({
      status: ReviewInvocationLeaseAcquireOutcomeStatus.InputStale,
    });
    const result = await fixture.useCase.execute(fixture.command);
    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(fixture.investigationRecording!.execute).not.toHaveBeenCalled();
    expect(
      (fixture.dependencies.invocations.prepare as jest.Mock).mock.calls.map(
        ([input]) => input.attemptOrdinal
      )
    ).toEqual([1, 1]);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({
          reviewPrompt: 'without memory',
          manifestFacts: expect.objectContaining({ memoryBundleHash: null }),
        }),
      })
    );
    expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
      2
    );
    const calls = fixture.controlPlane.acquireInvocationLease.mock.calls;
    expect(calls[0]![0].manifest.providerInvocationKey).not.toBe(
      calls[1]![0].manifest.providerInvocationKey
    );
    // Only the actually granted capability is released. input_stale never
    // creates or releases an uncharged lease and never decrements server state.
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      1
    );
  });

  it('keeps memory-bearing finding inference on the ordinary authoritative path without investigation grants', async () => {
    const fixture = createFixture({
      investigationMode: ReviewInvestigationRecordingMode.Authoritative,
      investigationVerifiedCleanEffectsEnabled: true,
    });
    const prepare = (
      fixture.dependencies.invocations.prepare as jest.Mock
    ).getMockImplementation()!;
    (fixture.dependencies.invocations.prepare as jest.Mock).mockImplementation(
      async (input) => {
        const invocation = await prepare(input);
        return {
          ...invocation,
          manifestFacts: {
            ...invocation.manifestFacts,
            memoryBundleHash: hash('memory'),
          },
        };
      }
    );
    Object.assign(fixture.dependencies, {
      memoryAdmission: {
        isEligible: jest.fn(async () => true),
        discard: jest.fn(),
      },
    });
    const result = await fixture.useCase.execute(fixture.command);
    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(
      fixture.dependencies.investigationInvocations!.prepare
    ).not.toHaveBeenCalled();
    expect(fixture.investigationRecording!.execute).not.toHaveBeenCalled();
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({
          manifestFacts: expect.objectContaining({
            memoryBundleHash: hash('memory'),
          }),
        }),
      })
    );
  });

  it('reconciles exhausted attempts after input_stale using a fresh memory-free identity without inference', async () => {
    const fixture = createFixture();
    Object.assign(fixture.dependencies, {
      invocationManifestAssembler:
        new GeneratedProviderInvocationManifestAssembler(
          authorization,
          {} as ReviewConfig,
          hash('compatibility')
        ),
    });
    let captured = true;
    const prepare = (
      fixture.dependencies.invocations.prepare as jest.Mock
    ).getMockImplementation()!;
    (fixture.dependencies.invocations.prepare as jest.Mock).mockImplementation(
      async (input) => {
        const invocation = await prepare(input);
        return {
          ...invocation,
          reviewPrompt: captured ? 'with memory' : 'without memory',
          manifestFacts: {
            ...invocation.manifestFacts,
            memoryBundleHash: captured ? hash('memory') : null,
          },
        };
      }
    );
    const discard = jest.fn(() => {
      captured = false;
    });
    Object.assign(fixture.dependencies, {
      memoryAdmission: { isEligible: jest.fn(async () => captured), discard },
    });
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockRejectedValue(new Error('provider_failed'));
    const acquire =
      fixture.controlPlane.acquireInvocationLease.getMockImplementation()!;
    let acquisitions = 0;
    fixture.controlPlane.acquireInvocationLease.mockImplementation(
      async (input) => {
        acquisitions += 1;
        if (acquisitions === 2)
          return {
            status: ReviewInvocationLeaseAcquireOutcomeStatus.InputStale,
          };
        return acquire(input);
      }
    );
    const result = await fixture.useCase.execute({
      ...fixture.command,
      allowPartial: true,
    });
    expect(result.status).toBe(
      ReviewOrchestrationResultStatus.PartialCompleted
    );
    expect(result.failureCode).toBe('required_work_exhausted');
    expect(discard).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.prepare).toHaveBeenCalledTimes(2);
    expect(
      (fixture.dependencies.invocations.prepare as jest.Mock).mock.calls.map(
        ([input]) => input.attemptOrdinal
      )
    ).toEqual([1, 2]);
    expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
      3
    );
    const staleRequest =
      fixture.controlPlane.acquireInvocationLease.mock.calls[1]![0];
    const currentRequest =
      fixture.controlPlane.acquireInvocationLease.mock.calls[2]![0];
    expect(
      JSON.parse(staleRequest.manifest.manifestCanonicalJson).memoryBundleHash
    ).toBe(hash('memory'));
    expect(
      JSON.parse(currentRequest.manifest.manifestCanonicalJson).memoryBundleHash
    ).toBeNull();
    expect(currentRequest.manifest.providerInvocationKey).not.toBe(
      staleRequest.manifest.providerInvocationKey
    );
    expect(currentRequest.acquireRequestId).not.toBe(
      staleRequest.acquireRequestId
    );
    expect(currentRequest.idempotencyKey).not.toBe(staleRequest.idempotencyKey);
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      1
    );
    expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
    expect(fixture.controlPlane.terminalizeWorkSlot).not.toHaveBeenCalled();
  });

  it('reprepares without memory at the same attempt when revocation arrives during a cache lookup', async () => {
    const fixture = createFixture();
    let eligible = true;
    const prepare = (
      fixture.dependencies.invocations.prepare as jest.Mock
    ).getMockImplementation()!;
    (fixture.dependencies.invocations.prepare as jest.Mock).mockImplementation(
      async (input) => {
        const invocation = await prepare(input);
        return {
          ...invocation,
          reviewPrompt: eligible
            ? 'review with frozen memory'
            : 'review without memory',
          manifestFacts: {
            ...invocation.manifestFacts,
            memoryBundleHash: eligible ? hash('memory') : null,
          },
        };
      }
    );
    Object.assign(fixture.dependencies, {
      memoryAdmission: {
        isEligible: jest.fn(async () => eligible),
        discard: jest.fn(() => {
          eligible = false;
        }),
      },
    });
    fixture.controlPlane.lookupEvidence
      .mockImplementationOnce(async () => {
        eligible = false;
        return {
          kind: ReviewEvidenceLookupKind.Hit,
          observation: acceptedObservation,
          attachment: {
            kind: 'exact_revision_reuse',
            capability: 'stale-memory-capability',
            reuseSafetyDecisionHash: hash('reuse-safety'),
          },
        };
      })
      .mockResolvedValue({ kind: ReviewEvidenceLookupKind.Miss });
    const result = await fixture.useCase.execute(fixture.command);
    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.dependencies.invocations.prepare).toHaveBeenCalledTimes(2);
    expect(
      (fixture.dependencies.invocations.prepare as jest.Mock).mock.calls.map(
        ([input]) => input.attemptOrdinal
      )
    ).toEqual([1, 1]);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({
          reviewPrompt: 'review without memory',
          manifestFacts: expect.objectContaining({ memoryBundleHash: null }),
        }),
      })
    );
    expect(fixture.controlPlane.attachObservation).not.toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentCapability: 'stale-memory-capability',
      })
    );
    expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
      1
    );
  });

  it('looks up accepted lifecycle evidence under its original manifest without rebuilding source packets', async () => {
    const fixture = createFixture({ workSlotCount: 2, allowPartial: true });
    const slots = fixture.command.workSlots.map((slot, index) =>
      index === 1
        ? {
            ...slot,
            taskKind: ReviewTaskKind.LifecycleRevalidation,
            required: false,
            attemptBudget: 1,
          }
        : slot
    );
    const command = {
      ...fixture.command,
      workSlots: slots,
      workSlotsCanonicalJson: canonicalizeReviewWorkSlots(slots),
    };
    const prepared = await fixture.dependencies.invocations.prepare({
      workSlot: slots[1],
      attemptOrdinal: 1,
    });
    const original = {
      workSlotId: slots[1].workSlotId,
      manifestCanonicalJson: canonicalJson({
        ...prepared.manifestFacts,
        taskKindSet: [ReviewTaskKind.LifecycleRevalidation],
        requestedModel: 'gpt-test',
      }),
      manifestKey: hash('original-A-B-manifest'),
      providerInvocationKey: hash('original-A-B-invocation'),
      providerVoteIdentityHash: hash('vote'),
    };
    const restored = {
      ...restoredAdmission(command, {
        state: RestoredReviewWorkSlotState.Pending,
        acceptedObservationRefId: null,
      }).restoredExecution,
      persistedPlan: {
        planHash: command.planHash,
        assignmentManifestVersion: 2,
        assignmentManifestHash: command.assignmentManifestHash,
        assignmentManifestCanonicalJson:
          command.assignmentManifestCanonicalJson,
        workSlots: slots,
        artifact: null,
        acceptedManifests: [original],
      },
    };
    restored.workSlots[0] = {
      ...restored.workSlots[0],
      state: RestoredReviewWorkSlotState.Exhausted,
    };
    restored.workSlots[1] = {
      ...restored.workSlots[1],
      state: RestoredReviewWorkSlotState.Satisfied,
      acceptedObservationRefId: observationRef(
        command.executionId,
        slots[1].workSlotId,
        'accepted-A-B'
      ),
    };
    const prepareFresh = jest.mocked(fixture.dependencies.invocations.prepare);
    prepareFresh.mockClear();
    Object.assign(fixture.dependencies, {
      invocations: restoredLifecycleInvocations(
        restored,
        fixture.dependencies.invocations
      ),
      invocationManifestAssembler: restoredLifecycleManifestAssembler(
        restored,
        fixture.dependencies.invocationManifestAssembler
      ),
    });
    fixture.controlPlane.restoreExecution.mockResolvedValue(restored);
    fixture.controlPlane.lookupEvidence.mockResolvedValue({
      kind: ReviewEvidenceLookupKind.Hit,
      observation: {
        ...observationPayload,
        observationId: 'accepted-A-B',
        eligibilityPolicyVersion: 't0-v1',
        providerKind: ReviewExecutionProviderKind.Codex,
        providerInvocationKey: original.providerInvocationKey,
        providerVoteIdentityHash: original.providerVoteIdentityHash,
      },
      attachment: sameExecutionAttachment,
    });
    const result = await fixture.useCase.execute({
      ...command,
      restoredExecution: restored,
      restoreOnly: true,
    });
    expect(result.status).toBe(
      ReviewOrchestrationResultStatus.PartialCompleted
    );
    expect(fixture.controlPlane.lookupEvidence).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.lookupEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        workSlot: slots[1],
        manifest: original,
        planHash: command.planHash,
      })
    );
    expect(prepareFresh).not.toHaveBeenCalled();
    expect(fixture.controlPlane.startExecution).not.toHaveBeenCalled();
    expect(fixture.controlPlane.acquireInvocationLease).not.toHaveBeenCalled();
    expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
    expect(fixture.dependencies.projectionBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({
        acceptedEvidence: [
          expect.objectContaining({
            workSlotId: slots[1].workSlotId,
            observation: expect.objectContaining({
              observationId: 'accepted-A-B',
            }),
          }),
        ],
      })
    );
  });

  it.each(['exact_hit', 'replay_required', 'wrong_observation'] as const)(
    'restores satisfied memory-bearing discovery only through its original attached evidence: %s',
    async (outcome) => {
      const fixture = createFixture();
      const workSlot = fixture.command.workSlots[0]!;
      const prepared = await fixture.dependencies.invocations.prepare({
        workSlot,
        attemptOrdinal: 1,
      });
      const invocation = {
        ...prepared,
        manifestFacts: {
          ...prepared.manifestFacts,
          memoryBundleHash: hash('original-memory'),
        },
      };
      const original = {
        workSlotId: workSlot.workSlotId,
        manifestCanonicalJson: canonicalJson({
          ...invocation.manifestFacts,
          requestedModel: invocation.requestedModel,
        }),
        manifestKey: hash('original-manifest'),
        providerInvocationKey: hash('original-invocation'),
        providerVoteIdentityHash: workSlot.providerVoteIdentityHash,
      };
      const restored = {
        ...restoredAdmission(fixture.command, {
          state: RestoredReviewWorkSlotState.Satisfied,
          acceptedObservationRefId: observationRef(
            fixture.command.executionId,
            workSlot.workSlotId,
            'accepted-original'
          ),
        }).restoredExecution,
        persistedPlan: {
          planHash: fixture.command.planHash,
          assignmentManifestVersion: 1,
          assignmentManifestHash: fixture.command.assignmentManifestHash,
          assignmentManifestCanonicalJson:
            fixture.command.assignmentManifestCanonicalJson,
          workSlots: fixture.command.workSlots,
          artifact: null,
          acceptedManifests: [original],
        },
      };
      const isEligible = jest.fn(async () => false);
      Object.assign(fixture.dependencies, {
        memoryAdmission: { isEligible, discard: jest.fn() },
      });
      jest
        .mocked(fixture.dependencies.invocations.prepare)
        .mockResolvedValue(invocation);
      jest
        .mocked(fixture.dependencies.invocationManifestAssembler.assemble)
        .mockResolvedValue(original);
      fixture.controlPlane.restoreExecution.mockResolvedValue(restored);
      fixture.controlPlane.lookupEvidence.mockResolvedValue({
        kind:
          outcome === 'replay_required'
            ? ReviewEvidenceLookupKind.ReplayRequired
            : ReviewEvidenceLookupKind.Hit,
        observation: {
          ...observationPayload,
          observationId:
            outcome === 'wrong_observation' ? 'different' : 'accepted-original',
          eligibilityPolicyVersion: 't0-v1',
          providerKind: workSlot.providerKind,
          providerInvocationKey: original.providerInvocationKey,
          providerVoteIdentityHash: original.providerVoteIdentityHash,
        },
        attachment: sameExecutionAttachment,
      } as never);
      const result = await fixture.useCase.execute({
        ...fixture.command,
        restoredExecution: restored,
        restoreOnly: true,
      });
      if (outcome === 'exact_hit')
        expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
      else
        expect(result).toMatchObject({
          status: ReviewOrchestrationResultStatus.Failed,
          failureCode:
            'review_orchestration_restored_observation_identity_mismatch',
        });
      expect(isEligible).not.toHaveBeenCalled();
      expect(fixture.controlPlane.startExecution).not.toHaveBeenCalled();
      expect(
        fixture.controlPlane.acquireInvocationLease
      ).not.toHaveBeenCalled();
      expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
      expect(fixture.controlPlane.attachObservation).not.toHaveBeenCalled();
      expect(fixture.controlPlane.adoptObservation).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    'resumes never-started discovery in the same restored execution; persisted ordinal=%s',
    async (withOrdinal) => {
      const fixture = createFixture({
        workSlotCount: 1,
        allowPartial: true,
        investigationMode: ReviewInvestigationRecordingMode.Authoritative,
      });
      const native = restoredAdmission(fixture.command, {
        state: RestoredReviewWorkSlotState.Pending,
        acceptedObservationRefId: null,
      }).restoredExecution;
      const restored = {
        ...native,
        ...(withOrdinal
          ? {
              persistedPlan: {
                planHash: fixture.command.planHash,
                assignmentManifestVersion: 1,
                assignmentManifestHash: fixture.command.assignmentManifestHash,
                assignmentManifestCanonicalJson:
                  fixture.command.assignmentManifestCanonicalJson,
                workSlots: fixture.command.workSlots.map((slot) => ({
                  ...slot,
                  nextAttemptOrdinal: 1,
                })),
                artifact: null,
              },
            }
          : {}),
      };
      fixture.controlPlane.restoreExecution.mockResolvedValue({
        ...restored,
        version: '2',
        streamVersion: '2',
      });
      const result = await fixture.useCase.execute({
        ...fixture.command,
        restoredExecution: restored,
        restoreOnly: true,
      });
      expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
      expect(result.executionId).toBe(restored.executionId);
      expect(fixture.controlPlane.startExecution).not.toHaveBeenCalled();
      expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
        1
      );
      expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
      expect(fixture.investigationRecording!.execute).not.toHaveBeenCalled();
      expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledTimes(1);
    }
  );

  it.each([false, true])(
    'retains accepted discovery A while pending B resumes; frozen metadata=%s',
    async (withMetadata) => {
      const fixture = createFixture({ workSlotCount: 2 });
      const restored = {
        ...restoredAdmission(fixture.command, {
          state: RestoredReviewWorkSlotState.Pending,
          acceptedObservationRefId: null,
        }).restoredExecution,
        ...(withMetadata
          ? {
              persistedPlan: {
                planHash: fixture.command.planHash,
                assignmentManifestVersion: 1,
                assignmentManifestHash: fixture.command.assignmentManifestHash,
                assignmentManifestCanonicalJson:
                  fixture.command.assignmentManifestCanonicalJson,
                workSlots: fixture.command.workSlots.map((slot) => ({
                  ...slot,
                  nextAttemptOrdinal: 1,
                })),
                artifact: null,
              },
            }
          : {}),
      };
      restored.workSlots[0] = {
        ...restored.workSlots[0],
        state: RestoredReviewWorkSlotState.Satisfied,
        acceptedObservationRefId: observationRef(
          fixture.command.executionId,
          fixture.command.workSlots[0].workSlotId,
          'accepted-A'
        ),
      };
      const manifest =
        await fixture.dependencies.invocationManifestAssembler.assemble(
          await fixture.dependencies.invocations.prepare({
            workSlot: fixture.command.workSlots[0],
            attemptOrdinal: 1,
          })
        );
      fixture.controlPlane.lookupEvidence
        .mockReset()
        .mockResolvedValueOnce({
          kind: ReviewEvidenceLookupKind.Hit,
          observation: {
            ...observationPayload,
            observationId: 'accepted-A',
            eligibilityPolicyVersion: 't0-v1',
            providerKind: ReviewExecutionProviderKind.Codex,
            providerInvocationKey: manifest.providerInvocationKey,
            providerVoteIdentityHash: manifest.providerVoteIdentityHash,
          },
          attachment: sameExecutionAttachment,
        })
        .mockResolvedValue({ kind: ReviewEvidenceLookupKind.Miss });
      fixture.controlPlane.restoreExecution.mockResolvedValue({
        ...restored,
        version: '2',
        streamVersion: '2',
      });
      const result = await fixture.useCase.execute({
        ...fixture.command,
        restoredExecution: restored,
        restoreOnly: true,
      });
      expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
      expect(fixture.controlPlane.startExecution).not.toHaveBeenCalled();
      expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
        1
      );
      expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledWith(
        expect.objectContaining({ workSlot: fixture.command.workSlots[1] })
      );
      expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
      expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledTimes(1);
      expect(fixture.dependencies.projectionBuilder.build).toHaveBeenCalledWith(
        expect.objectContaining({
          acceptedEvidence: [
            expect.objectContaining({
              workSlotId: fixture.command.workSlots[0].workSlotId,
              observation: expect.objectContaining({
                observationId: 'accepted-A',
              }),
            }),
            expect.objectContaining({
              workSlotId: fixture.command.workSlots[1].workSlotId,
              observation: expect.objectContaining({
                observationId: 'observation-1',
              }),
            }),
          ],
          exhaustedWorkSlotIds: [],
        })
      );
    }
  );

  it.each([
    'lifecycle_pending',
    'discovery_consumed',
    'discovery_leased',
  ] as const)(
    'does not replay an unaccepted one-shot or uncertain dispatch: %s',
    async (scenario) => {
      const fixture = createFixture({ workSlotCount: 1, allowPartial: true });
      const slots = fixture.command.workSlots.map((slot) =>
        scenario === 'lifecycle_pending'
          ? {
              ...slot,
              taskKind: ReviewTaskKind.LifecycleRevalidation,
              required: false,
            }
          : slot
      );
      const command = {
        ...fixture.command,
        workSlots: slots,
        workSlotsCanonicalJson: canonicalizeReviewWorkSlots(slots),
      };
      const restored = {
        ...restoredAdmission(command, {
          state: RestoredReviewWorkSlotState.Pending,
          acceptedObservationRefId: null,
        }).restoredExecution,
        persistedPlan: {
          planHash: command.planHash,
          assignmentManifestVersion: 1,
          assignmentManifestHash: command.assignmentManifestHash,
          assignmentManifestCanonicalJson:
            command.assignmentManifestCanonicalJson,
          workSlots: slots.map((slot) => ({
            ...slot,
            nextAttemptOrdinal: 1,
          })),
          artifact: null,
        },
      };
      const latest = {
        ...restored,
        version: '2',
        streamVersion: '2',
        workSlots: restored.workSlots.map((slot) => ({ ...slot })),
        persistedPlan: {
          ...restored.persistedPlan,
          workSlots: restored.persistedPlan.workSlots.map((slot) => ({
            ...slot,
            nextAttemptOrdinal: scenario === 'discovery_consumed' ? 2 : 1,
          })),
        },
      };
      if (scenario === 'discovery_leased')
        latest.workSlots[0] = {
          ...latest.workSlots[0],
          state: RestoredReviewWorkSlotState.Leased,
          activeLeaseId: 'original-lease',
        };
      fixture.controlPlane.restoreExecution
        .mockReset()
        .mockResolvedValue(latest);
      const result = await fixture.useCase.execute({
        ...command,
        restoredExecution: restored,
        restoreOnly: true,
      });
      expect(result.executionId).toBe(restored.executionId);
      expect(fixture.controlPlane.startExecution).not.toHaveBeenCalled();
      expect(
        fixture.controlPlane.acquireInvocationLease
      ).not.toHaveBeenCalled();
      expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
      expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
    }
  );

  it.each(['rejection', 'synchronous throw'])(
    'continues without optional comparison history after a baseline %s',
    async (failure) => {
      const fixture = createFixture({ workSlotCount: 1 });
      const restore = jest.fn().mockImplementation(() => {
        const error = new Error('comparison_history_unavailable');
        if (failure === 'synchronous throw') throw error;
        return Promise.reject(error);
      });
      Object.assign(fixture.controlPlane, {
        restoreComparisonBaseline: restore,
      });
      const result = await fixture.useCase.execute(fixture.command);
      expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
      expect(restore).toHaveBeenCalledTimes(1);
      expect(fixture.controlPlane.restoreSnapshot).toHaveBeenCalledTimes(1);
      expect(fixture.controlPlane.restoreExecution).toHaveBeenCalled();
      expect(fixture.dependencies.projectionBuilder.build).toHaveBeenCalledWith(
        expect.objectContaining({ comparisonBaseline: null })
      );
      expect(fixture.controlPlane.requestPublication).toHaveBeenCalledTimes(1);
    }
  );

  it('preserves cancellation while optional comparison history is unavailable', async () => {
    const fixture = createFixture({ workSlotCount: 1 });
    const abort = new AbortController();
    Object.assign(fixture.dependencies, { signal: abort.signal });
    Object.assign(fixture.controlPlane, {
      restoreComparisonBaseline: jest.fn().mockImplementation(async () => {
        abort.abort(new Error('cancelled_during_comparison'));
        throw new Error('comparison_history_unavailable');
      }),
    });
    await expect(fixture.useCase.execute(fixture.command)).rejects.toThrow(
      'cancelled_during_comparison'
    );
    expect(fixture.controlPlane.startExecution).not.toHaveBeenCalled();
  });

  it.each(['restoreSnapshot', 'restoreExecution'] as const)(
    'retains required %s failures even when optional history also fails',
    async (operation) => {
      const fixture = createFixture({ workSlotCount: 1 });
      fixture.controlPlane[operation]
        .mockReset()
        .mockRejectedValueOnce(new Error('required_restore_failed'));
      Object.assign(fixture.controlPlane, {
        restoreComparisonBaseline: jest
          .fn()
          .mockRejectedValue(new Error('comparison_history_unavailable')),
      });
      const result = await fixture.useCase.execute(fixture.command);
      expect(result).toMatchObject({
        status: ReviewOrchestrationResultStatus.Failed,
        failureCode: 'required_restore_failed',
      });
      expect(fixture.controlPlane.startExecution).not.toHaveBeenCalled();
      expect(
        fixture.dependencies.projectionBuilder.build
      ).not.toHaveBeenCalled();
    }
  );
  it('forwards the immutable comparison baseline before projecting the current review', async () => {
    const fixture = createFixture({ workSlotCount: 1 });
    const baseline = Object.freeze({
      schemaVersion: 'comparison_baseline.v1' as const,
      appliedResolutions: [],
      sourceReviewedHeadSha: '1'.repeat(40),
      sourceReviewRevisionHash: 'b'.repeat(64),
      sourceExecutionGeneration: '1',
      snapshotVersion: 1,
      projectionPolicyVersion: 'review-projection-policy.v5-t0' as const,
      projectionEnvelopeVersion: 'review_projection.v1' as const,
      priorLineageHints: [],
    });
    const restore = jest.fn().mockResolvedValue(baseline);
    Object.assign(fixture.controlPlane, { restoreComparisonBaseline: restore });
    await fixture.useCase.execute(fixture.command);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.projectionBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({ comparisonBaseline: baseline })
    );
    expect(restore.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(fixture.dependencies.projectionBuilder.build).mock
        .invocationCallOrder[0]
    );
  });
  it.each([
    'generated',
    'unknown',
    'restored',
    'joined',
    'disabled',
    'busy-then-acquired',
    'busy-timeout',
    'busy-abort',
  ] as const)(
    'runs an optional PR description once after review slots (%s)',
    async (outcome) => {
      const fixture = createFixture({ workSlotCount: 2 });
      const descriptionSlot = {
        ...fixture.command.workSlots[0],
        workSlotId: 'description',
        taskKind: ReviewTaskKind.PrDescription,
        shardKey: 'description',
        required: false,
        attemptBudget: 1,
      };
      if (outcome !== 'disabled') {
        const workSlots = [...fixture.command.workSlots, descriptionSlot];
        Object.assign(fixture.command, {
          workSlots,
          workSlotsCanonicalJson: canonicalizeReviewWorkSlots(workSlots),
        });
      }
      const description = {
        generatedMarkdown: '## Summary\nPreserve invoice ownership.',
        generationProvenance: {
          leaseId: lease.leaseId,
          providerIndex: 0 as const,
          requestedModel: 'gpt-test',
          actualModel: 'gpt-test',
          providerRequestEnvelopeHash: hash('request'),
        },
      };
      let descriptionWaitStartedAt: number | undefined;
      let descriptionWaitElapsedMs = 0;
      const captureDescriptionWait = () => {
        if (descriptionWaitStartedAt !== undefined)
          descriptionWaitElapsedMs =
            fixture.dependencies.clock.monotonicNowMs() -
            descriptionWaitStartedAt;
      };
      const generator = {
        prepare: jest.fn(
          async (
            input: Parameters<PreparedReviewInvocationPort['prepare']>[0]
          ) => ({
            ...(await fixture.dependencies.invocations.prepare(input)),
            investigationContextPrompt: null,
            investigationProbePlan: null,
          })
        ),
        execute: jest.fn(async () => {
          expect(
            fixture.dependencies.invocations.execute
          ).toHaveBeenCalledTimes(2);
          expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledTimes(2);
          expect(fixture.controlPlane.finalizeExecution).not.toHaveBeenCalled();
          if (outcome === 'unknown')
            throw new Error('synthetic_effect_unknown');
          return description;
        }),
        unavailable: jest.fn(captureDescriptionWait),
      };
      Object.assign(fixture.dependencies, { prDescription: generator });
      if (outcome === 'joined' || outcome.startsWith('busy-')) {
        const acquire =
          fixture.controlPlane.acquireInvocationLease.getMockImplementation()!;
        let descriptionAttempts = 0;
        fixture.controlPlane.acquireInvocationLease.mockImplementation(
          async (input) => {
            if (input.workSlot.taskKind !== ReviewTaskKind.PrDescription)
              return acquire(input);
            descriptionWaitStartedAt ??=
              fixture.dependencies.clock.monotonicNowMs();
            captureDescriptionWait();
            descriptionAttempts += 1;
            if (outcome === 'busy-then-acquired' && descriptionAttempts > 1)
              return acquire(input);
            return {
              status:
                outcome === 'joined'
                  ? ReviewInvocationLeaseAcquireOutcomeStatus.NotRunnable
                  : ReviewInvocationLeaseAcquireOutcomeStatus.Busy,
            };
          }
        );
        if (outcome === 'busy-abort') {
          const abort = new AbortController();
          Object.assign(fixture.dependencies, { signal: abort.signal });
          fixture.dependencies.delay.sleep = jest.fn(async () => {
            abort.abort(new Error('description_wait_cancelled'));
          });
        }
      }
      if (outcome === 'restored') {
        const refresh =
          fixture.controlPlane.restoreExecution.getMockImplementation()!;
        fixture.controlPlane.restoreExecution
          .mockReset()
          .mockResolvedValueOnce(
            restoredAdmission(fixture.command, {
              state: RestoredReviewWorkSlotState.Pending,
              acceptedObservationRefId: null,
            }).restoredExecution
          )
          .mockImplementation(refresh);
      }
      if (outcome === 'busy-abort') {
        await expect(fixture.useCase.execute(fixture.command)).rejects.toThrow(
          'description_wait_cancelled'
        );
        expect(generator.execute).not.toHaveBeenCalled();
        expect(fixture.controlPlane.finalizeExecution).not.toHaveBeenCalled();
        return;
      }
      const result = await fixture.useCase.execute(fixture.command);
      expect([
        result.status,
        'failureCode' in result ? result.failureCode : null,
      ]).toEqual([ReviewOrchestrationResultStatus.Completed, null]);
      expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledTimes(2);
      expect(fixture.controlPlane.attachObservation).toHaveBeenCalledTimes(2);
      const invoked =
        outcome === 'generated' ||
        outcome === 'unknown' ||
        outcome === 'busy-then-acquired';
      expect(generator.execute).toHaveBeenCalledTimes(invoked ? 1 : 0);
      const descriptionAcquisitions =
        fixture.controlPlane.acquireInvocationLease.mock.calls.filter(
          ([input]) => input.workSlot.taskKind === ReviewTaskKind.PrDescription
        );
      if (outcome === 'busy-timeout') {
        expect(descriptionAcquisitions.length).toBeGreaterThan(1);
        expect(descriptionAcquisitions.length).toBeLessThanOrEqual(5);
      } else {
        expect(descriptionAcquisitions).toHaveLength(
          outcome === 'busy-then-acquired'
            ? 2
            : invoked || outcome === 'joined'
              ? 1
              : 0
        );
      }
      if (outcome.startsWith('busy-')) {
        expect(
          descriptionAcquisitions.every(
            ([input]) =>
              input.acquireRequestId ===
                descriptionAcquisitions[0][0].acquireRequestId &&
              input.idempotencyKey ===
                descriptionAcquisitions[0][0].idempotencyKey &&
              input.manifest === descriptionAcquisitions[0][0].manifest
          )
        ).toBe(true);
        expect(descriptionWaitElapsedMs).toBeLessThanOrEqual(5_000);
        expect(descriptionWaitElapsedMs).toBeGreaterThan(0);
      }
      expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
        invoked ? 3 : 2
      );
      const projectionInput = jest.mocked(
        fixture.dependencies.projectionBuilder.build
      ).mock.calls[0][0];
      expect(projectionInput.prDescription).toEqual(
        outcome === 'generated' || outcome === 'busy-then-acquired'
          ? description
          : undefined
      );
      expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledWith(
        expect.objectContaining({ allowPartial: false })
      );
    }
  );

  it.each(['AbortError', 'native_effect_unknown'])(
    'fails closed when a provider has no terminal output after %s',
    async (failureName) => {
      const fixture = createFixture();
      const failure = new Error('provider has no complete terminal output');
      failure.name = failureName;
      jest
        .mocked(fixture.dependencies.invocations.execute)
        .mockRejectedValue(failure);

      const result = await fixture.useCase.execute(fixture.command);

      expect(result).toMatchObject({
        status: ReviewOrchestrationResultStatus.Failed,
        failureCode: 'required_work_exhausted',
      });
      expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
      expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
      expect(fixture.controlPlane.attachObservation).not.toHaveBeenCalled();
      expect(fixture.controlPlane.finalizeExecution).not.toHaveBeenCalled();
      expect(fixture.controlPlane.requestPublication).not.toHaveBeenCalled();
    }
  );

  it('fails closed at the orchestration boundary when provider output is missing', async () => {
    const fixture = createFixture();
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockResolvedValue(undefined as never);

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode: 'review_orchestration_terminal_provider_result_missing',
    });
    expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
    expect(fixture.controlPlane.finalizeExecution).not.toHaveBeenCalled();
    expect(fixture.controlPlane.requestPublication).not.toHaveBeenCalled();
  });

  it('finishes a partial review without starting pending work inside the deadline reserve', async () => {
    const fixture = createFixture({ allowPartial: true });
    Object.assign(fixture.dependencies, {
      executionDeadline: orchestrationDeadline(
        149_999,
        fixture.dependencies.clock.monotonicNowMs
      ),
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.PartialCompleted,
      failureCode: 'required_execution_deadline_reached',
    });
    expect(fixture.dependencies.invocations.prepare).not.toHaveBeenCalled();
    expect(fixture.controlPlane.acquireInvocationLease).not.toHaveBeenCalled();
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledWith(
      expect.objectContaining({ allowPartial: true })
    );
  });

  it('finalizes a deadline partial after release exhausts the final provider attempt', async () => {
    const fixture = createFixture({ allowPartial: true });
    const providerSignal = jest.fn();
    let released = false;
    fixture.controlPlane.releaseInvocationLease.mockImplementation(async () => {
      released = true;
    });
    fixture.controlPlane.restoreExecution.mockImplementation(async () =>
      released
        ? exhaustedExecution(fixture.command)
        : restoredAdmission(fixture.command, {
            state: RestoredReviewWorkSlotState.Pending,
            acceptedObservationRefId: null,
          }).restoredExecution
    );
    // The API forbids changing the released final attempt from exhausted to cancelled.
    fixture.controlPlane.terminalizeWorkSlot.mockRejectedValue(
      new Error('review_action_v2_execution_work_slot_terminalize_conflict')
    );
    Object.assign(fixture.dependencies, {
      executionDeadline: orchestrationDeadline(
        155_000,
        fixture.dependencies.clock.monotonicNowMs
      ),
    });
    jest.mocked(fixture.dependencies.invocations.execute).mockImplementation(
      async ({ signal }: { readonly signal: AbortSignal }) =>
        await new Promise((_, reject) => {
          const abort = () => {
            providerSignal(signal.reason);
            reject(signal.reason);
          };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        })
    );

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.PartialCompleted,
      failureCode: 'required_execution_deadline_reached',
    });
    expect(providerSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'review_orchestration_execution_deadline_reached',
      })
    );
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      1
    );
    expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
    expect(fixture.controlPlane.terminalizeWorkSlot).not.toHaveBeenCalled();
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        allowPartial: true,
        execution: expect.objectContaining({
          restoredExecution: expect.objectContaining({
            workSlots: [
              expect.objectContaining({
                workSlotId: 'slot-1',
                state: RestoredReviewWorkSlotState.Exhausted,
                activeLeaseId: null,
              }),
            ],
          }),
        }),
      })
    );
    expect(fixture.controlPlane.requestPublication).toHaveBeenCalledTimes(1);
    expect(
      fixture.dependencies.invocationFailureClassifier.classify
    ).not.toHaveBeenCalled();
    expect(
      fixture.dependencies.invocationDiagnostics?.recordFailure
    ).not.toHaveBeenCalled();
  });

  it('rejects a provider result that resolves after the work cutoff race', async () => {
    const fixture = createFixture({ allowPartial: true });
    let now = 0;
    Object.assign(fixture.dependencies, {
      executionDeadline: orchestrationDeadline(151_000, () => now),
    });
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockImplementationOnce(async () => {
        now = 31_001;
        return observationPayload;
      });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.PartialCompleted,
      failureCode: 'required_execution_deadline_reached',
    });
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      1
    );
    expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
  });

  it('turns an investigation deadline into slot exhaustion before standard acquisition', async () => {
    const fixture = createFixture({
      allowPartial: true,
      executionProfile: 'context_gateway_v1',
      investigationMode: ReviewInvestigationRecordingMode.RecordOnly,
    });
    Object.assign(fixture.dependencies, {
      executionDeadline: orchestrationDeadline(
        155_000,
        fixture.dependencies.clock.monotonicNowMs
      ),
    });
    fixture.investigationRecording?.execute.mockImplementation(
      async ({ signal }: { readonly signal: AbortSignal }) =>
        await new Promise((_, reject) => {
          const abort = () => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        })
    );

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.PartialCompleted,
      failureCode: 'required_execution_deadline_reached',
    });
    expect(fixture.investigationRecording?.execute).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    expect(fixture.controlPlane.acquireInvocationLease).not.toHaveBeenCalled();
    expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
  });

  it('does not start another provider attempt after the retry window closes', async () => {
    const fixture = createFixture({ maxAttempts: 2, allowPartial: true });
    let now = 0;
    Object.assign(fixture.dependencies, {
      executionDeadline: orchestrationDeadline(151_000, () => now),
    });
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockImplementationOnce(async () => {
        now = 2_000;
        throw new Error('provider_failed');
      });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.PartialCompleted,
      failureCode: 'required_execution_deadline_reached',
    });
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
      1
    );
    expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
  });

  it('caps publication polling to the execution deadline', async () => {
    const fixture = createFixture();
    Object.assign(fixture.dependencies, {
      executionDeadline: orchestrationDeadline(
        200_000,
        fixture.dependencies.clock.monotonicNowMs
      ),
    });
    fixture.controlPlane.requestPublication.mockResolvedValue({
      status: ReviewPublicationRequestOutcomeStatus.Requested,
      publicationAttemptId: 'publication-1',
      pollAfterMs: 60_000,
    });
    fixture.controlPlane.readPublicationStatus.mockResolvedValue({
      terminal: false,
      pollAfterMs: 60_000,
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode: 'publication_poll_exhausted',
    });
    expect(
      fixture.controlPlane.readPublicationStatus.mock.calls.length
    ).toBeLessThanOrEqual(4);
    for (const [request] of fixture.controlPlane.readPublicationStatus.mock
      .calls) {
      expect(request.timeoutMs).toBeLessThanOrEqual(200_000);
      expect(request.timeoutMs).toBeGreaterThan(0);
    }
  });

  it('does not request publication after finalization consumes the deadline', async () => {
    const fixture = createFixture();
    let now = 0;
    Object.assign(fixture.dependencies, {
      executionDeadline: orchestrationDeadline(200_000, () => now),
    });
    fixture.controlPlane.finalizeExecution.mockImplementationOnce(async () => {
      now = 200_001;
      return { publicationPermit: 'publication.permit' };
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode: 'review_orchestration_execution_deadline_reached',
    });
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.requestPublication).not.toHaveBeenCalled();
  });

  it('completes a fresh exact-revision observation and publication', async () => {
    const fixture = createFixture();

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Completed,
      executionId: 'execution-1',
      publicationAttemptId: 'publication-1',
      canonicalReceiptSetHash: hash('receipt'),
    });
    expect(result.state.phase).toBe(ReviewOrchestrationPhase.Completed);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(
      jest.mocked(fixture.dependencies.invocations.execute).mock.calls[0][0]
        .invocation
    ).toBe(
      await jest.mocked(fixture.dependencies.invocations.prepare).mock
        .results[0].value
    );
    expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.attachObservation).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.attachObservation).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentCapability: lease.leaseCapability })
    );
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      1
    );
    expect(
      fixture.dependencies.identities.deterministicId
    ).toHaveBeenCalledWith('idempotency-lease-acquire', [
      'execution-1',
      'slot-1',
      expect.any(String),
    ]);
    expect(
      fixture.dependencies.identities.deterministicId
    ).toHaveBeenCalledWith('idempotency-publication', [
      'publication.permit',
      projection.projectionHash,
    ]);
  });

  it('waits beyond the legacy 20-minute poll cap', async () => {
    const fixture = createFixture();
    fixture.controlPlane.authorize.mockResolvedValue({
      ...authorization,
      limits: {
        ...authorization.limits,
        maxReconciliationDurationMs: 1_300_000,
      },
    });
    jest
      .mocked(fixture.dependencies.projectionBuilder.build)
      .mockResolvedValue({
        ...projection,
        publicationOperationCount: 4,
      });
    let poll = 0;
    fixture.controlPlane.readPublicationStatus.mockImplementation(async () => {
      poll += 1;
      return poll <= 1_200
        ? { terminal: false, pollAfterMs: 1_000 }
        : {
            terminal: true,
            outcome: {
              state: ReviewPublicationState.Succeeded,
              canonicalReceiptSetHash: hash('receipt'),
            },
          };
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.controlPlane.readPublicationStatus).toHaveBeenCalledTimes(
      1_201
    );
  });

  it('supports the complete publication and reconciliation horizon', async () => {
    const fixture = createFixture();
    fixture.controlPlane.authorize.mockResolvedValue({
      ...authorization,
      limits: {
        ...authorization.limits,
        maxReconciliationDurationMs: 1_800_000,
      },
    });
    let poll = 0;
    fixture.controlPlane.readPublicationStatus.mockImplementation(async () => {
      poll += 1;
      return poll < 3_599
        ? { terminal: false, pollAfterMs: 1_000 }
        : {
            terminal: true,
            outcome: {
              state: ReviewPublicationState.Succeeded,
              canonicalReceiptSetHash: hash('receipt'),
            },
          };
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.controlPlane.readPublicationStatus).toHaveBeenCalledTimes(
      3_599
    );
  });

  it('does not truncate a server horizon beyond two hours', async () => {
    const fixture = createFixture();
    fixture.controlPlane.authorize.mockResolvedValue({
      ...authorization,
      limits: {
        ...authorization.limits,
        maxReconciliationDurationMs: 3_700_000,
      },
    });
    let poll = 0;
    fixture.controlPlane.readPublicationStatus.mockImplementation(async () => {
      poll += 1;
      return poll < 7_201
        ? { terminal: false, pollAfterMs: 1_000 }
        : {
            terminal: true,
            outcome: {
              state: ReviewPublicationState.Succeeded,
              canonicalReceiptSetHash: hash('receipt'),
            },
          };
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.controlPlane.readPublicationStatus).toHaveBeenCalledTimes(
      7_201
    );
  });

  it('stops polling at the server-issued reconciliation deadline', async () => {
    const fixture = createFixture();
    fixture.controlPlane.authorize.mockResolvedValue({
      ...authorization,
      limits: {
        ...authorization.limits,
        maxReconciliationDurationMs: 2_000,
      },
    });
    fixture.controlPlane.readPublicationStatus.mockResolvedValue({
      terminal: false,
      pollAfterMs: 1_000,
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode: 'publication_poll_exhausted',
    });
    expect(fixture.controlPlane.readPublicationStatus).toHaveBeenCalledTimes(4);
    expect(
      jest.mocked(fixture.dependencies.delay.sleep).mock.calls.slice(-4)
    ).toEqual([[1_000], [1_000], [1_000], [1_000]]);
  });

  it('uses the final status reserve after an overshooting sleep', async () => {
    const fixture = createFixture();
    fixture.controlPlane.authorize.mockResolvedValue({
      ...authorization,
      limits: {
        ...authorization.limits,
        maxReconciliationDurationMs: 60_000,
      },
    });
    let nowMs = 0;
    jest
      .mocked(fixture.dependencies.clock.monotonicNowMs)
      .mockImplementation(() => nowMs);
    jest
      .mocked(fixture.dependencies.delay.sleep)
      .mockImplementation(async (delayMs: number) => {
        nowMs += delayMs + 120_000;
      });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.controlPlane.readPublicationStatus).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 29_000 })
    );
  });

  it('renews authorization before finalization and uses the renewed token', async () => {
    const fixture = createFixture();

    await fixture.useCase.execute(fixture.command);

    expect(fixture.controlPlane.renewAuthorization).toHaveBeenCalledTimes(2);
    expect(fixture.controlPlane.renewAuthorization).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        authorization,
        oidcToken: 'oidc.token',
        requestedTtlMs: 21_600_000,
      })
    );
    expect(fixture.controlPlane.renewAuthorization).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        oidcToken: 'oidc.token',
        requestedTtlMs: 420_000,
      })
    );
    expect(
      fixture.controlPlane.renewAuthorization.mock.invocationCallOrder[0]
    ).toBeLessThan(
      fixture.controlPlane.restoreSnapshot.mock.invocationCallOrder[0]
    );
    expect(fixture.dependencies.oidc.getToken).toHaveBeenCalledTimes(3);
    expect(fixture.controlPlane.restoreExecution).toHaveBeenLastCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          authorizationToken: 'authorization.renewed-token',
          mutationEpoch: '1',
        }),
      })
    );
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          authorizationToken: 'authorization.renewed-token',
        }),
      })
    );
    expect(fixture.controlPlane.readPublicationStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          authorizationToken: 'authorization.renewed-token',
        }),
        timeoutMs: 149_000,
      })
    );
  });

  it('completes execution and publication with a 55-minute deadline and immutable one-hour authorization cap', async () => {
    const fixture = createFixture();
    let nowMs = 0;
    jest
      .mocked(fixture.dependencies.clock.monotonicNowMs)
      .mockImplementation(() => nowMs);
    jest
      .mocked(fixture.dependencies.delay.sleep)
      .mockImplementation(async (delayMs: number, signal?: AbortSignal) => {
        if (!signal) nowMs += delayMs;
      });
    fixture.controlPlane.authorize.mockResolvedValue({
      ...authorization,
      limits: {
        ...authorization.limits,
        maxReconciliationDurationMs: 3_600_000,
      },
    });
    Object.assign(fixture.dependencies, {
      executionDeadline: orchestrationDeadline(
        3_300_000,
        fixture.dependencies.clock.monotonicNowMs
      ),
    });
    fixture.controlPlane.renewAuthorization.mockImplementation(async (input) =>
      renewedAuthorization(
        input.authorization,
        Math.min(input.requestedTtlMs, 3_600_000)
      )
    );

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Completed,
      publicationAttemptId: 'publication-1',
      canonicalReceiptSetHash: hash('receipt'),
    });
    expect(fixture.controlPlane.startExecution).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.requestPublication).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.renewAuthorization).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ requestedTtlMs: 21_600_000 })
    );
    expect(fixture.controlPlane.renewAuthorization).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ requestedTtlMs: 3_570_000 })
    );
    expect(fixture.controlPlane.startExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          expiresAt: '2026-07-22T13:00:00.000Z',
        }),
      })
    );
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          expiresAt: '2026-07-22T12:59:30.000Z',
        }),
      })
    );
    expect(fixture.controlPlane.readPublicationStatus).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 3_299_000 })
    );
  });

  it('denies insufficient or exhausted finite windows before the relevant effect', async () => {
    const insufficient = createFixture();
    Object.assign(insufficient.dependencies, {
      executionDeadline: orchestrationDeadline(
        3_300_000,
        insufficient.dependencies.clock.monotonicNowMs
      ),
    });
    insufficient.controlPlane.renewAuthorization.mockResolvedValueOnce(
      renewedAuthorization(authorization, 3_599_999)
    );

    expect(
      await insufficient.useCase.execute(insufficient.command)
    ).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode:
        'review_orchestration_execution_authorization_window_insufficient',
    });
    expect(insufficient.controlPlane.restoreSnapshot).not.toHaveBeenCalled();
    expect(insufficient.controlPlane.startExecution).not.toHaveBeenCalled();
    expect(
      insufficient.dependencies.invocations.execute
    ).not.toHaveBeenCalled();

    const exhausted = createFixture();
    Object.assign(exhausted.dependencies, {
      executionDeadline: orchestrationDeadline(
        0,
        exhausted.dependencies.clock.monotonicNowMs
      ),
    });

    expect(await exhausted.useCase.execute(exhausted.command)).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode: 'review_orchestration_execution_deadline_reached',
    });
    expect(exhausted.controlPlane.restoreSnapshot).not.toHaveBeenCalled();
    expect(exhausted.controlPlane.startExecution).not.toHaveBeenCalled();
    expect(exhausted.dependencies.invocations.execute).not.toHaveBeenCalled();

    const reserved = createFixture();
    let reservedNow = 0;
    Object.assign(reserved.dependencies, {
      executionDeadline: orchestrationDeadline(200_000, () => reservedNow),
    });
    jest
      .mocked(reserved.dependencies.projectionBuilder.build)
      .mockImplementationOnce(async () => {
        reservedNow = 170_000;
        return projection;
      });

    expect(await reserved.useCase.execute(reserved.command)).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode: 'review_orchestration_execution_deadline_reached',
    });
    expect(reserved.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(reserved.controlPlane.renewAuthorization).toHaveBeenCalledTimes(1);
    expect(reserved.controlPlane.finalizeExecution).not.toHaveBeenCalled();
    expect(reserved.controlPlane.requestPublication).not.toHaveBeenCalled();

    const elapsed = createFixture();
    let elapsedNow = 0;
    jest
      .mocked(elapsed.dependencies.clock.monotonicNowMs)
      .mockImplementation(() => elapsedNow);
    Object.assign(elapsed.dependencies, {
      executionDeadline: orchestrationDeadline(200_000, () => elapsedNow),
    });
    elapsed.controlPlane.renewAuthorization
      .mockResolvedValueOnce(renewedAuthorization(authorization, 500_000))
      .mockResolvedValueOnce(renewedAuthorization(authorization, 150_000));
    elapsed.controlPlane.finalizeExecution.mockImplementationOnce(async () => {
      elapsedNow = 1;
      return { publicationPermit: 'publication.permit' };
    });

    expect(await elapsed.useCase.execute(elapsed.command)).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode:
        'review_orchestration_publication_authorization_window_insufficient',
    });
    expect(elapsed.controlPlane.finalizeExecution).toHaveBeenCalledTimes(1);
    expect(elapsed.controlPlane.requestPublication).not.toHaveBeenCalled();
  });

  it('keeps the 185-minute execution guard and twice-protocol publication guard without a finite deadline', async () => {
    const insufficientExecution = createFixture();
    insufficientExecution.controlPlane.renewAuthorization.mockResolvedValueOnce(
      renewedAuthorization(authorization, 11_099_999)
    );

    expect(
      await insufficientExecution.useCase.execute(insufficientExecution.command)
    ).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode:
        'review_orchestration_execution_authorization_window_insufficient',
    });
    expect(
      insufficientExecution.controlPlane.startExecution
    ).not.toHaveBeenCalled();

    const unboundedAuthorization = {
      ...authorization,
      limits: {
        ...authorization.limits,
        maxReconciliationDurationMs: 3_600_000,
      },
    };
    const insufficientPublication = createFixture();
    insufficientPublication.controlPlane.authorize.mockResolvedValue(
      unboundedAuthorization
    );
    insufficientPublication.controlPlane.renewAuthorization
      .mockResolvedValueOnce(
        renewedAuthorization(unboundedAuthorization, 11_100_000)
      )
      .mockResolvedValueOnce(
        renewedAuthorization(unboundedAuthorization, 7_229_999)
      );

    expect(
      await insufficientPublication.useCase.execute(
        insufficientPublication.command
      )
    ).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode:
        'review_orchestration_publication_authorization_window_insufficient',
    });
    expect(
      insufficientPublication.controlPlane.startExecution
    ).toHaveBeenCalledTimes(1);
    expect(
      insufficientPublication.controlPlane.renewAuthorization
    ).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ requestedTtlMs: 7_500_000 })
    );
    expect(
      insufficientPublication.controlPlane.finalizeExecution
    ).not.toHaveBeenCalled();
    expect(
      insufficientPublication.controlPlane.requestPublication
    ).not.toHaveBeenCalled();

    const infinite = createFixture();
    Object.assign(infinite.dependencies, {
      executionDeadline: new ExecutionDeadline(
        undefined,
        {
          completionReserveMs: 120_000,
          minimumBatchStartWindowMs: 30_000,
          minimumOptionalRetryStartWindowMs: 30_000,
        },
        { now: infinite.dependencies.clock.monotonicNowMs }
      ),
    });
    infinite.controlPlane.authorize.mockResolvedValue(unboundedAuthorization);
    infinite.controlPlane.renewAuthorization
      .mockResolvedValueOnce(
        renewedAuthorization(unboundedAuthorization, 11_100_000)
      )
      .mockResolvedValueOnce(
        renewedAuthorization(unboundedAuthorization, 7_230_000)
      );

    expect(await infinite.useCase.execute(infinite.command)).toMatchObject({
      status: ReviewOrchestrationResultStatus.Completed,
    });
    expect(infinite.controlPlane.renewAuthorization).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ requestedTtlMs: 7_500_000 })
    );
    expect(infinite.controlPlane.requestPublication).toHaveBeenCalledTimes(1);
  });

  it('fails closed before finalization when renewal cannot provide a safe window', async () => {
    const fixture = createFixture();
    fixture.controlPlane.renewAuthorization.mockImplementation(async (input) =>
      input.requestedTtlMs > 1_000_000
        ? renewedAuthorization(input.authorization, input.requestedTtlMs)
        : renewedAuthorization(input.authorization, 149_999)
    );

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode:
        'review_orchestration_publication_authorization_window_insufficient',
    });
    expect(fixture.controlPlane.finalizeExecution).not.toHaveBeenCalled();
    expect(fixture.controlPlane.requestPublication).not.toHaveBeenCalled();
  });

  it('accepts an idempotently restored renewal with the required window intact', async () => {
    const fixture = createFixture();
    fixture.controlPlane.renewAuthorization.mockImplementation(async (input) =>
      renewedAuthorization(input.authorization, input.requestedTtlMs - 1_000)
    );

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.controlPlane.requestPublication).toHaveBeenCalledTimes(1);
  });

  it('fails closed before execution when the paired control plane cannot renew', async () => {
    const fixture = createFixture();
    fixture.controlPlane.renewAuthorization.mockRejectedValue(
      new Error('review_action_v2_capability_disabled')
    );

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode: 'review_action_v2_capability_disabled',
    });
    expect(fixture.controlPlane.restoreSnapshot).not.toHaveBeenCalled();
    expect(fixture.controlPlane.startExecution).not.toHaveBeenCalled();
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
  });

  it('completes publication while preserving a full-coverage blocking merge gate', async () => {
    const fixture = createFixture();
    jest
      .mocked(fixture.dependencies.projectionBuilder.build)
      .mockResolvedValue({
        ...projection,
        findingCount: 1,
        coverageComplete: true,
        mergeGateConclusion: MergeGateConclusion.Fail,
      });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Completed,
      mergeGateConclusion: MergeGateConclusion.Fail,
      canonicalReceiptSetHash: hash('receipt'),
    });
    expect(fixture.controlPlane.requestPublication).toHaveBeenCalledTimes(1);
    expect(result.state.phase).toBe(ReviewOrchestrationPhase.Completed);
  });

  it('records shadow investigation evidence without replacing the legacy observation', async () => {
    const fixture = createFixture({
      executionProfile: 'context_gateway_v1',
      investigationMode: ReviewInvestigationRecordingMode.RecordOnly,
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.investigationRecording?.execute).toHaveBeenCalledTimes(1);
    expect(
      fixture.investigationRecording?.execute.mock.calls[0][0].signal.aborted
    ).toBe(false);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(
      jest.mocked(fixture.dependencies.invocations.execute).mock.calls[0][0]
        .signal.aborted
    ).toBe(false);
    expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({
          payloadHash: observationPayload.payloadHash,
        }),
      })
    );
  });

  it('refuses unattested evidence at the context-gateway commit boundary', async () => {
    const fixture = createFixture({ executionProfile: 'context_gateway_v1' });
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockResolvedValue(observationPayload);

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode: 'review_context_gateway_attestation_required',
    });
    expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
  });

  it('uses certificate-backed investigation evidence only in authoritative mode', async () => {
    const fixture = createFixture({
      executionProfile: 'context_gateway_v1',
      investigationMode: ReviewInvestigationRecordingMode.Authoritative,
      investigationVerifiedCleanEffectsEnabled: true,
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.investigationRecording?.execute).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({
          payloadHash: investigationObservationPayload.payloadHash,
          investigationCertificateId: 'certificate-1',
        }),
      })
    );
  });

  it('keeps lifecycle-bearing authoritative evidence when investigation recording is authoritative', async () => {
    const fixture = createFixture({
      executionProfile: 'context_gateway_v1',
      investigationMode: ReviewInvestigationRecordingMode.Authoritative,
      investigationVerifiedCleanEffectsEnabled: true,
      lifecycleBearingAuthoritative: true,
      investigationPrepareError: new Error('investigation_should_not_start'),
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.investigationRecording?.execute).not.toHaveBeenCalled();
    expect(
      fixture.dependencies.investigationInvocations?.prepare
    ).not.toHaveBeenCalled();
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({
          payloadHash: attestedObservationPayload.payloadHash,
        }),
      })
    );
  });

  it('fails closed instead of running legacy evidence under an investigation manifest', async () => {
    const fixture = createFixture({
      executionProfile: 'investigation_gateway_v1',
      investigationMode: ReviewInvestigationRecordingMode.Authoritative,
      investigationVerifiedCleanEffectsEnabled: false,
    });
    jest
      .mocked(fixture.dependencies.invocationFailureClassifier.classify)
      .mockReturnValue(ReviewInvocationFailureClass.ConfigurationMismatch);

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode:
        'review_invocation_configuration_mismatch:investigation_legacy_fallback_manifest_mismatch',
    });
    expect(fixture.investigationRecording?.execute).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
  });

  it('does not reuse an investigation manifest after a pre-open fallback signal', async () => {
    const fixture = createFixture({
      executionProfile: 'investigation_gateway_v1',
      investigationMode: ReviewInvestigationRecordingMode.Authoritative,
      investigationError: new ReviewInvestigationLegacyFallbackSignal(),
    });
    jest
      .mocked(fixture.dependencies.invocationFailureClassifier.classify)
      .mockReturnValue(ReviewInvocationFailureClass.ConfigurationMismatch);

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode:
        'review_invocation_configuration_mismatch:investigation_legacy_fallback_manifest_mismatch',
    });
    expect(fixture.investigationRecording?.execute).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
  });

  it('falls back to the separately prepared authoritative invocation after a pre-open investigation signal', async () => {
    const fixture = createFixture({
      executionProfile: 'context_gateway_v1',
      investigationMode: ReviewInvestigationRecordingMode.Authoritative,
      investigationError: new ReviewInvestigationLegacyFallbackSignal(),
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.investigationRecording?.execute).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({
          payloadHash: observationPayload.payloadHash,
        }),
      })
    );
    expect(
      fixture.controlPlane.commitEvidence.mock.calls[0][0].observation
    ).not.toHaveProperty('investigationCertificateId');
  });

  it('does not silently fall back after investigation has mutated', async () => {
    const fixture = createFixture({
      executionProfile: 'investigation_gateway_v1',
      investigationMode: ReviewInvestigationRecordingMode.Authoritative,
      investigationError: new Error('capability_disabled_after_open'),
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode: 'capability_disabled_after_open',
    });
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
  });

  it('treats publication request conflicts as not applied instead of failing the run', async () => {
    const fixture = createFixture();
    fixture.controlPlane.requestPublication.mockResolvedValue({
      status: ReviewPublicationRequestOutcomeStatus.Conflict,
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.PublicationNotApplied,
      executionId: 'execution-1',
      failureCode: 'publication_request_conflict',
    });
    expect(result.state.phase).toBe(ReviewOrchestrationPhase.Completed);
    expect(fixture.controlPlane.readPublicationStatus).not.toHaveBeenCalled();
  });

  it('returns typed unavailable publication facts without polling or publication events', async () => {
    const fixture = createFixture();
    fixture.controlPlane.requestPublication.mockResolvedValue({
      status: ReviewPublicationRequestOutcomeStatus.FactsUnavailable,
      unavailableFacts: [ReviewPublicationUnavailableFact.Lifecycle],
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.PublicationUnavailable,
      executionId: 'execution-1',
      failureCode: 'publication_facts_unavailable',
      unavailablePublicationFacts: [ReviewPublicationUnavailableFact.Lifecycle],
    });
    expect(result.state.phase).toBe(ReviewOrchestrationPhase.Failed);
    expect(fixture.controlPlane.readPublicationStatus).not.toHaveBeenCalled();
  });

  it('treats stale publication requests as safely not applied', async () => {
    const fixture = createFixture();
    fixture.controlPlane.requestPublication.mockResolvedValue({
      status: ReviewPublicationRequestOutcomeStatus.Stale,
      reason: 'lifecycle_status_not_current',
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.PublicationStale,
      executionId: 'execution-1',
      failureCode: 'publication_request_lifecycle_status_not_current',
    });
    expect(result.state.phase).toBe(ReviewOrchestrationPhase.Completed);
    expect(fixture.controlPlane.readPublicationStatus).not.toHaveBeenCalled();
  });

  it('refreshes the server execution version immediately before finalize', async () => {
    const fixture = createFixture();
    const latest = restoredAdmission(fixture.command, {
      state: RestoredReviewWorkSlotState.Satisfied,
      acceptedObservationRefId: observationRef(
        'execution-1',
        'slot-1',
        acceptedObservation.observationId
      ),
    }).restoredExecution;
    fixture.controlPlane.restoreExecution
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ ...latest, version: '7', streamVersion: '2' });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: expect.objectContaining({ executionVersion: '7' }),
      })
    );
  });

  it('uses an eligible T0 observation without invoking the provider', async () => {
    const fixture = createFixture();
    fixture.controlPlane.lookupEvidence.mockResolvedValue({
      kind: ReviewEvidenceLookupKind.Hit,
      observation: acceptedObservation,
      attachment: {
        kind: 'exact_revision_reuse',
        capability: 'adoption.capability',
        reuseSafetyDecisionHash: hash('reuse-safety'),
      },
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    expect(fixture.controlPlane.acquireInvocationLease).not.toHaveBeenCalled();
    expect(fixture.controlPlane.attachObservation).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentCapability: 'adoption.capability' })
    );
  });

  it('reuses evidence completed by the incumbent while waiting for its lease', async () => {
    const fixture = createFixture();
    fixture.controlPlane.lookupEvidence
      .mockResolvedValueOnce({ kind: ReviewEvidenceLookupKind.Miss })
      .mockResolvedValueOnce({
        kind: ReviewEvidenceLookupKind.Hit,
        observation: acceptedObservation,
        attachment: {
          kind: 'exact_revision_reuse',
          capability: 'incumbent.attachment.capability',
          reuseSafetyDecisionHash: hash('incumbent-reuse-safety'),
        },
      });
    fixture.controlPlane.acquireInvocationLease.mockResolvedValueOnce({
      status: ReviewInvocationLeaseAcquireOutcomeStatus.Busy,
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.dependencies.invocations.prepare).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
      1
    );
    expect(fixture.controlPlane.lookupEvidence).toHaveBeenCalledTimes(2);
    expect(fixture.controlPlane.attachObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentCapability: 'incumbent.attachment.capability',
      })
    );
  });

  it('replays dependency-attested evidence before cross-revision attachment', async () => {
    const fixture = createFixture();
    const attestedObservation = {
      ...acceptedObservation,
      contextDependencyAttestationId: 'attestation-1',
      contextDependencyAttestationHash: hash('attestation'),
    };
    const replayPlanCanonicalJson = '{"planVersion":1}';
    fixture.controlPlane.lookupEvidence.mockResolvedValue({
      kind: ReviewEvidenceLookupKind.ReplayRequired,
      observation: attestedObservation,
      attestationId: 'attestation-1',
      attestationHash: hash('attestation'),
      replayCapability: 'replay.capability',
      replayPlanCanonicalJson,
      replayPlanHash: hash(replayPlanCanonicalJson),
    });
    const contextReplay = {
      replay: jest.fn().mockResolvedValue({
        targetCheckoutTreeOid: '4'.repeat(40),
        replayResultCanonicalJson: '{"manifestVersion":2}',
        replayResultHash: hash('{"manifestVersion":2}'),
      }),
    };
    const contextAttestations = {
      openGatewaySession: jest.fn(),
      sealGatewaySession: jest.fn(),
      abandonGatewaySession: jest.fn(),
      commitContextReplay: jest.fn().mockResolvedValue({
        attachmentCapability: 'replayed.attachment.capability',
      }),
    };
    Object.assign(fixture.dependencies, {
      contextReplay,
      contextAttestations,
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(contextReplay.replay).toHaveBeenCalledTimes(1);
    expect(contextAttestations.commitContextReplay).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    expect(fixture.controlPlane.acquireInvocationLease).not.toHaveBeenCalled();
    expect(fixture.controlPlane.attachObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: attestedObservation,
        attachmentCapability: 'replayed.attachment.capability',
      })
    );
  });

  it('restores an already satisfied slot without rerunning or reattaching it', async () => {
    const fixture = createFixture();
    fixture.controlPlane.lookupEvidence.mockResolvedValue({
      kind: ReviewEvidenceLookupKind.Hit,
      observation: acceptedObservation,
      attachment: sameExecutionAttachment,
    });
    fixture.controlPlane.startExecution.mockResolvedValue(
      restoredAdmission(fixture.command, {
        state: RestoredReviewWorkSlotState.Satisfied,
        acceptedObservationRefId: observationRef(
          'execution-1',
          'slot-1',
          acceptedObservation.observationId
        ),
      })
    );

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    expect(fixture.controlPlane.acquireInvocationLease).not.toHaveBeenCalled();
    expect(fixture.controlPlane.attachObservation).not.toHaveBeenCalled();
    expect(fixture.dependencies.projectionBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({
        acceptedEvidence: [
          expect.objectContaining({
            workSlotId: 'slot-1',
            observation: acceptedObservation,
            coverageManifest: expect.objectContaining({
              workSlotId: 'slot-1',
            }),
          }),
        ],
      })
    );
  });

  it('rejects a restored observation with the wrong identity', async () => {
    const fixture = createFixture();
    fixture.controlPlane.lookupEvidence.mockResolvedValue({
      kind: ReviewEvidenceLookupKind.Hit,
      observation: acceptedObservation,
      attachment: sameExecutionAttachment,
    });
    fixture.controlPlane.startExecution.mockResolvedValue(
      restoredAdmission(fixture.command, {
        state: RestoredReviewWorkSlotState.Satisfied,
        acceptedObservationRefId: `obsref:${hash('different-observation')}`,
      })
    );

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode:
        'review_orchestration_restored_observation_identity_mismatch',
    });
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
  });

  it('does not rerun a restored exhausted slot', async () => {
    const fixture = createFixture();
    fixture.controlPlane.startExecution.mockResolvedValue(
      restoredAdmission(fixture.command, {
        state: RestoredReviewWorkSlotState.Exhausted,
        acceptedObservationRefId: null,
      })
    );

    const result = await fixture.useCase.execute({
      ...fixture.command,
      allowPartial: true,
    });

    expect(result.status).toBe(
      ReviewOrchestrationResultStatus.PartialCompleted
    );
    expect(fixture.dependencies.invocations.prepare).not.toHaveBeenCalled();
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'adopts an exhausted original source below the provider window; refreshed hint omitted=%s',
    async (omitRefreshedHint) => {
      const fixture = unattachedAcceptedFixture();
      expect(fixture.deadline.canStartBatch()).toBe(false);
      if (omitRefreshedHint) {
        fixture.setCurrent({
          ...fixture.restored,
          persistedPlan: {
            ...fixture.restored.persistedPlan!,
            unattachedAcceptedManifests: [],
          },
        });
      }
      const result = await fixture.useCase.execute(fixture.command);
      expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
      expect(fixture.controlPlane.adoptObservation).toHaveBeenCalledTimes(1);
      expect(fixture.controlPlane.adoptObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          manifest: fixture.hint,
          observation: acceptedObservation,
          source: sameExecutionAttachment,
        })
      );
      expect(
        fixture.current().persistedPlan!.workSlots[0]!.nextAttemptOrdinal
      ).toBe(2);
      expect(fixture.controlPlane.startExecution).not.toHaveBeenCalled();
      expect(
        fixture.controlPlane.acquireInvocationLease
      ).not.toHaveBeenCalled();
      expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
      expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
      expect(fixture.controlPlane.attachObservation).not.toHaveBeenCalled();
      expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['queued', 'active', 'fallback'] as const)(
    'recovers accepted work before an allocation stops its %s lane',
    async (layout) => {
      const fixture = unattachedAcceptedFixture(true);
      const original = fixture.command.workSlots[0]!;
      const blocked = {
        ...fixture.command.workSlots[1]!,
        providerVoteIdentityHash:
          layout === 'active'
            ? original.providerVoteIdentityHash
            : hash('blocked-vote'),
      };
      const unused: ReviewWorkSlotPlan = {
        ...blocked,
        workSlotId: 'slot-3',
        shardKey: 'batch-3',
        providerVoteIdentityHash: hash('unused-fallback-vote'),
      };
      const workSlots = [
        blocked,
        original,
        ...(layout === 'fallback' ? [unused] : []),
      ];
      const restored: RestoredReviewExecution = {
        ...fixture.restored,
        workSlots: workSlots.map((slot) => ({
          workSlotId: slot.workSlotId,
          state:
            slot.workSlotId === original.workSlotId
              ? RestoredReviewWorkSlotState.Exhausted
              : RestoredReviewWorkSlotState.Pending,
          required: slot.required,
          providerVoteIdentityHash: slot.providerVoteIdentityHash,
          activeLeaseId: null,
          acceptedObservationRefId: null,
        })),
        persistedPlan: {
          ...fixture.restored.persistedPlan!,
          workSlots: workSlots.map((slot) => ({
            ...slot,
            nextAttemptOrdinal: slot.workSlotId === original.workSlotId ? 2 : 1,
          })),
        },
      };
      fixture.setCurrent(restored);
      Object.assign(fixture.dependencies, {
        reviewerScheduling: {
          ...(layout === 'fallback'
            ? { providerMode: 'fallback' as const }
            : {}),
          maxParallelReviewers: 1,
          reviewers: [
            {
              reviewerId: 'blocked',
              providerVoteIdentityHash: blocked.providerVoteIdentityHash,
              concurrencyGroupId: 'shared',
            },
            ...(layout === 'active'
              ? []
              : [
                  {
                    reviewerId: 'original',
                    providerVoteIdentityHash: original.providerVoteIdentityHash,
                    concurrencyGroupId: 'shared',
                  },
                ]),
            ...(layout === 'fallback'
              ? [
                  {
                    reviewerId: 'unused',
                    providerVoteIdentityHash: unused.providerVoteIdentityHash,
                    concurrencyGroupId: 'unused',
                  },
                ]
              : []),
          ],
          concurrencyGroups: [
            { id: 'shared', maxParallel: 1 },
            ...(layout === 'fallback'
              ? [{ id: 'unused', maxParallel: 1 }]
              : []),
          ],
        } satisfies NonNullable<
          RunT0ReviewOrchestrationDependencies['reviewerScheduling']
        >,
      });
      Object.assign(fixture.dependencies.invocationFailureClassifier, {
        classify: jest.fn(
          () => ReviewInvocationFailureClass.AuthenticationUnavailable
        ),
        scope: jest.fn(() => 'allocation'),
      });
      jest
        .mocked(fixture.dependencies.invocationManifestAssembler.assemble)
        .mockImplementation(async (invocation) => {
          if (invocation.workSlotId === original.workSlotId)
            return fixture.hint;
          const slot = workSlots.find(
            (candidate) => candidate.workSlotId === invocation.workSlotId
          );
          if (!slot) throw new Error('unexpected_work_slot');
          const canonical = JSON.stringify({ workSlotId: slot.workSlotId });
          return {
            manifestCanonicalJson: canonical,
            manifestKey: hash(canonical),
            providerInvocationKey: hash('invocation-' + slot.workSlotId),
            providerVoteIdentityHash: slot.providerVoteIdentityHash,
          };
        });
      fixture.controlPlane.lookupEvidence.mockImplementation(
        async ({ workSlot }) =>
          workSlot.workSlotId === original.workSlotId
            ? fixture.hit
            : { kind: ReviewEvidenceLookupKind.Miss }
      );
      const events: string[] = [];
      const adopt =
        fixture.controlPlane.adoptObservation.getMockImplementation()!;
      fixture.controlPlane.adoptObservation.mockImplementation(
        async (request) => {
          events.push('adopt');
          return adopt(request);
        }
      );
      jest
        .mocked(fixture.dependencies.invocations.execute)
        .mockImplementation(async () => {
          events.push('provider-stop');
          throw new Error('allocation_authentication_unavailable');
        });
      if (layout === 'fallback') {
        const finalize =
          fixture.controlPlane.finalizeExecution.getMockImplementation()!;
        fixture.controlPlane.finalizeExecution.mockImplementation(
          async (request) => {
            fixture.setCurrent({
              ...fixture.current(),
              state: RestoredReviewExecutionState.Completed,
            });
            return finalize(request);
          }
        );
      }

      const result = await fixture.useCase.execute({
        ...fixture.command,
        workSlots,
        workSlotsCanonicalJson: canonicalizeReviewWorkSlots(workSlots),
        restoredExecution: restored,
        allowPartial: true,
      });

      expect(result.status).toBe(
        layout === 'fallback'
          ? ReviewOrchestrationResultStatus.Completed
          : ReviewOrchestrationResultStatus.PartialCompleted
      );
      expect(events).toEqual(['adopt', 'provider-stop']);
      expect(fixture.controlPlane.adoptObservation).toHaveBeenCalledTimes(1);
      expect(
        jest
          .mocked(fixture.dependencies.invocations.prepare)
          .mock.calls.map(([request]) => request.workSlot.workSlotId)
      ).toEqual([original.workSlotId, blocked.workSlotId]);
      expect(
        fixture.controlPlane.acquireInvocationLease.mock.calls.map(
          ([request]) => request.workSlot.workSlotId
        )
      ).toEqual([blocked.workSlotId]);
      expect(
        jest
          .mocked(fixture.dependencies.invocations.execute)
          .mock.calls.map(([request]) => request.invocation.workSlotId)
      ).toEqual([blocked.workSlotId]);
      expect(fixture.dependencies.projectionBuilder.build).toHaveBeenCalledWith(
        expect.objectContaining({
          acceptedEvidence: [
            expect.objectContaining({
              workSlotId: original.workSlotId,
              observation: acceptedObservation,
            }),
          ],
          exhaustedWorkSlotIds:
            layout === 'fallback'
              ? [blocked.workSlotId, unused.workSlotId]
              : [blocked.workSlotId],
        })
      );
      expect(fixture.controlPlane.startExecution).not.toHaveBeenCalled();
      expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
      expect(fixture.controlPlane.attachObservation).not.toHaveBeenCalled();
      expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    'miss',
    'replay_required',
    'cross_execution',
    'observation',
    'payload',
    'invocation',
    'vote',
    'lease',
    'fence',
    'owner',
    'lookup_failure',
    'prepare_configuration',
    'disappearing_hint',
  ])(
    'fails hinted %s without provider admission or a fallback reviewer',
    async (failure) => {
      const fixture = unattachedAcceptedFixture(true);
      const hit = fixture.hit;
      switch (failure) {
        case 'miss':
        case 'disappearing_hint':
          fixture.controlPlane.lookupEvidence.mockResolvedValue({
            kind: ReviewEvidenceLookupKind.Miss,
          });
          if (failure === 'disappearing_hint') {
            fixture.setCurrent({
              ...fixture.restored,
              persistedPlan: {
                ...fixture.restored.persistedPlan!,
                unattachedAcceptedManifests: [],
              },
            });
          }
          break;
        case 'replay_required':
          fixture.controlPlane.lookupEvidence.mockResolvedValue({
            kind: ReviewEvidenceLookupKind.ReplayRequired,
            observation: acceptedObservation,
            attestationId: 'foreign-attestation',
            attestationHash: hash('foreign-attestation'),
            replayCapability: 'foreign-replay',
            replayPlanCanonicalJson: '{}',
            replayPlanHash: hash('{}'),
          });
          break;
        case 'cross_execution':
          fixture.controlPlane.lookupEvidence.mockResolvedValue({
            ...hit,
            attachment: {
              kind: 'exact_revision_reuse',
              capability: 'foreign-attachment',
              reuseSafetyDecisionHash: hash('foreign-attachment'),
            },
          });
          break;
        case 'observation':
          fixture.controlPlane.lookupEvidence.mockResolvedValue({
            ...hit,
            observation: { ...hit.observation, observationId: 'foreign' },
          });
          break;
        case 'payload':
          fixture.controlPlane.lookupEvidence.mockResolvedValue({
            ...hit,
            observation: { ...hit.observation, payloadHash: hash('foreign') },
          });
          break;
        case 'invocation':
          fixture.controlPlane.lookupEvidence.mockResolvedValue({
            ...hit,
            observation: {
              ...hit.observation,
              providerInvocationKey: hash('foreign'),
            },
          });
          break;
        case 'vote':
          fixture.controlPlane.lookupEvidence.mockResolvedValue({
            ...hit,
            observation: {
              ...hit.observation,
              providerVoteIdentityHash: hash('foreign'),
            },
          });
          break;
        case 'lease':
          fixture.controlPlane.lookupEvidence.mockResolvedValue({
            ...hit,
            attachment: { ...hit.attachment, sourceLeaseId: 'foreign' },
          });
          break;
        case 'fence':
          fixture.controlPlane.lookupEvidence.mockResolvedValue({
            ...hit,
            attachment: { ...hit.attachment, sourceFencingToken: '2' },
          });
          break;
        case 'owner':
          fixture.controlPlane.lookupEvidence.mockResolvedValue({
            ...hit,
            attachment: {
              ...hit.attachment,
              sourceOwnerIdHash: hash('foreign'),
            },
          });
          break;
        case 'lookup_failure':
          fixture.controlPlane.lookupEvidence.mockRejectedValue(
            new Error('read_failed')
          );
          break;
        case 'prepare_configuration':
          jest
            .mocked(fixture.dependencies.invocations.prepare)
            .mockRejectedValue(
              new ReviewInvocationConfigurationMismatchError(
                ReviewInvocationConfigurationMismatchReason.ContextGatewayPolicyMismatch
              )
            );
          break;
      }
      const result = await fixture.useCase.execute(fixture.command);
      expect(result).toMatchObject({
        status: ReviewOrchestrationResultStatus.Failed,
        failureCode: 'review_orchestration_unattached_observation_unavailable',
      });
      expect(fixture.dependencies.invocations.prepare).toHaveBeenCalledTimes(1);
      expect(
        fixture.controlPlane.acquireInvocationLease
      ).not.toHaveBeenCalled();
      expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
      expect(
        fixture.dependencies.invocationFailureClassifier.classify
      ).not.toHaveBeenCalled();
      expect(fixture.controlPlane.adoptObservation).not.toHaveBeenCalled();
      expect(fixture.controlPlane.attachObservation).not.toHaveBeenCalled();
      expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
      expect(fixture.controlPlane.finalizeExecution).not.toHaveBeenCalled();
      expect(fixture.controlPlane.requestPublication).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['deadline', 'before_lookup', false],
    ['deadline', 'after_refresh', false],
    ['abort', 'before_lookup', false],
    ['abort', 'after_refresh', false],
    ['deadline', 'before_lookup', true],
    ['deadline', 'after_refresh', true],
    ['abort', 'before_lookup', true],
    ['abort', 'after_refresh', true],
  ] as const)(
    'stops hinted adoption on %s %s with scheduling=%s',
    async (cause, boundary, scheduled) => {
      const fixture = unattachedAcceptedFixture(scheduled);
      const abort = new AbortController();
      const abortReason = new Error('outer_cancelled');
      Object.assign(fixture.dependencies, { signal: abort.signal });
      const stop = () => {
        if (cause === 'abort') abort.abort(abortReason);
        else fixture.expire();
      };
      if (boundary === 'before_lookup') {
        jest
          .mocked(fixture.dependencies.invocationManifestAssembler.assemble)
          .mockImplementation(async () => {
            stop();
            return fixture.hint;
          });
      } else {
        fixture.controlPlane.restoreExecution.mockImplementation(async () => {
          if (fixture.controlPlane.lookupEvidence.mock.calls.length > 0) stop();
          return fixture.current();
        });
      }
      const running = fixture.useCase.execute(fixture.command);
      if (cause === 'abort') await expect(running).rejects.toBe(abortReason);
      else
        await expect(running).resolves.toMatchObject({
          status: ReviewOrchestrationResultStatus.Failed,
          failureCode: 'review_orchestration_execution_deadline_reached',
        });
      expect(fixture.controlPlane.lookupEvidence).toHaveBeenCalledTimes(
        boundary === 'before_lookup' ? 0 : 1
      );
      expect(fixture.controlPlane.adoptObservation).not.toHaveBeenCalled();
      expect(
        fixture.controlPlane.acquireInvocationLease
      ).not.toHaveBeenCalled();
      expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
      expect(fixture.controlPlane.finalizeExecution).not.toHaveBeenCalled();
    }
  );

  it('adopts same-execution evidence without rerunning the provider', async () => {
    const fixture = createFixture();
    const pending = restoredAdmission(fixture.command, {
      state: RestoredReviewWorkSlotState.Pending,
      acceptedObservationRefId: null,
    }).restoredExecution;
    const satisfied = restoredAdmission(fixture.command, {
      state: RestoredReviewWorkSlotState.Satisfied,
      acceptedObservationRefId: observationRef(
        'execution-1',
        'slot-1',
        acceptedObservation.observationId
      ),
    }).restoredExecution;
    fixture.controlPlane.restoreExecution
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({
        ...satisfied,
        version: '2',
        streamVersion: '2',
      });
    fixture.controlPlane.lookupEvidence.mockResolvedValue({
      kind: ReviewEvidenceLookupKind.Hit,
      observation: acceptedObservation,
      attachment: sameExecutionAttachment,
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    expect(fixture.controlPlane.acquireInvocationLease).not.toHaveBeenCalled();
    expect(fixture.controlPlane.adoptObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: acceptedObservation,
        source: sameExecutionAttachment,
      })
    );
    expect(fixture.controlPlane.attachObservation).not.toHaveBeenCalled();
  });

  it('retries only provider execution under a new attempt', async () => {
    const fixture = createFixture({ maxAttempts: 2 });
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockRejectedValueOnce(new Error('provider_failed'))
      .mockResolvedValueOnce(observationPayload);

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.dependencies.invocations.prepare).toHaveBeenNthCalledWith(
      1,
      {
        workSlot: fixture.command.workSlots[0],
        attemptOrdinal: 1,
      }
    );
    expect(fixture.dependencies.invocations.prepare).toHaveBeenNthCalledWith(
      2,
      {
        workSlot: fixture.command.workSlots[0],
        attemptOrdinal: 2,
      }
    );
    expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledTimes(1);
  });

  it('keeps retry decisions independent from failure diagnostics', async () => {
    const fixture = createFixture({ maxAttempts: 2 });
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockRejectedValueOnce(new Error('provider_failed'))
      .mockResolvedValueOnce(observationPayload);
    jest
      .mocked(fixture.dependencies.invocationDiagnostics!.recordFailure)
      .mockImplementation(() => {
        throw new Error('diagnostics_failed');
      });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(
      fixture.dependencies.invocationDiagnostics!.recordFailure
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptBudget: 2,
        failureClass: ReviewInvocationFailureClass.Retryable,
        invocation: expect.objectContaining({
          attemptOrdinal: 1,
          workSlotId: 'slot-1',
        }),
      })
    );
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(2);
    expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledTimes(1);
  });

  it('retries a missing context witness within the existing attempt budget', async () => {
    const fixture = createFixture({
      executionProfile: 'context_gateway_v1',
      maxAttempts: 2,
    });
    const fallback = {
      ...observationPayload,
      qualityFlags: [
        'context_inspection_incomplete',
        'cross_revision_reuse_disabled',
      ],
    };
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockRejectedValueOnce(
        new RetryableReviewContextInspectionFailure(
          ReviewContextInspectionFailureReason.MissingChangedPathsWitness,
          fallback
        )
      )
      .mockResolvedValueOnce(attestedObservationPayload);

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(2);
    expect(
      fixture.dependencies.invocationFailureClassifier.classify
    ).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ observation: attestedObservationPayload })
    );
  });

  it('does not commit exhausted context inspection without an accepted attestation', async () => {
    const fixture = createFixture({
      executionProfile: 'context_gateway_v1',
      maxAttempts: 2,
    });
    const fallback = {
      ...observationPayload,
      qualityFlags: [
        'context_inspection_incomplete',
        'cross_revision_reuse_disabled',
      ],
    };
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockRejectedValue(
        new RetryableReviewContextInspectionFailure(
          ReviewContextInspectionFailureReason.MissingChangedPathsWitness,
          fallback
        )
      );

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode: 'required_work_exhausted',
    });
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(2);
    expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      2
    );
    expect(fixture.controlPlane.attachObservation).not.toHaveBeenCalled();
  });

  it('fails fast across the review when provider capacity is unavailable', async () => {
    const fixture = createFixture({ maxAttempts: 3 });
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockRejectedValue(new Error('quota_exceeded'));
    jest
      .mocked(fixture.dependencies.invocationFailureClassifier.classify)
      .mockReturnValue(ReviewInvocationFailureClass.CapacityUnavailable);

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode: 'provider_capacity_unavailable',
    });
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      1
    );
    expect(fixture.dependencies.projectionBuilder.build).not.toHaveBeenCalled();
    expect(fixture.controlPlane.finalizeExecution).not.toHaveBeenCalled();
  });

  it('fails fast when provider authentication is unavailable', async () => {
    const fixture = createFixture({ maxAttempts: 3 });
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockRejectedValue(new Error('refresh token was revoked'));
    jest
      .mocked(fixture.dependencies.invocationFailureClassifier.classify)
      .mockReturnValue(ReviewInvocationFailureClass.AuthenticationUnavailable);

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode: 'provider_authentication_unavailable',
    });
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.projectionBuilder.build).not.toHaveBeenCalled();
  });

  it('fails fast when invocation configuration cannot match the release contract', async () => {
    const fixture = createFixture({ maxAttempts: 3 });
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockRejectedValue(
        new ReviewInvocationConfigurationMismatchError(
          ReviewInvocationConfigurationMismatchReason.ContextGatewayPolicyMismatch
        )
      );
    jest
      .mocked(fixture.dependencies.invocationFailureClassifier.classify)
      .mockReturnValue(ReviewInvocationFailureClass.ConfigurationMismatch);

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode:
        'review_invocation_configuration_mismatch:context_gateway_policy_mismatch',
    });
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      1
    );
    expect(fixture.dependencies.projectionBuilder.build).not.toHaveBeenCalled();
  });

  it('stops the remaining work slots on terminal admission refusal without burning attempts', async () => {
    const fixture = createFixture({
      workSlotCount: 2,
      maxAttempts: 2,
      allowPartial: true,
    });
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockRejectedValue(new Error('account_gateway_inference_denied'));
    jest
      .mocked(fixture.dependencies.invocationFailureClassifier.classify)
      .mockReturnValue('admission_limited' as ReviewInvocationFailureClass);

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.PartialCompleted,
      failureCode: 'required_admission_limited',
    });
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
      1
    );
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      1
    );
    expect(fixture.dependencies.projectionBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({ exhaustedWorkSlotIds: ['slot-1', 'slot-2'] })
    );
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledWith(
      expect.objectContaining({ allowPartial: true })
    );
    expect(fixture.controlPlane.terminalizeWorkSlot).not.toHaveBeenCalled();
  });

  it('keeps record-only investigation failures isolated from the legacy review', async () => {
    const failure = new ReviewInvocationConfigurationMismatchError(
      ReviewInvocationConfigurationMismatchReason.ContextGatewayPolicyMismatch
    );
    const fixture = createFixture({
      maxAttempts: 3,
      executionProfile: 'context_gateway_v1',
      investigationMode: ReviewInvestigationRecordingMode.RecordOnly,
      investigationError: failure,
    });
    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.investigationRecording?.execute).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      1
    );
  });

  it('keeps an unsupported investigation candidate side-effect free', async () => {
    const fixture = createFixture({
      investigationMode: ReviewInvestigationRecordingMode.RecordOnly,
      investigationSupported: false,
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.investigationRecording?.execute).not.toHaveBeenCalled();
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
  });

  it('isolates record-only preparation failures and records bounded diagnostics', async () => {
    const fixture = createFixture({
      executionProfile: 'context_gateway_v1',
      investigationMode: ReviewInvestigationRecordingMode.RecordOnly,
      investigationPrepareError: new Error('secret preparation detail'),
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(
      fixture.dependencies.investigationDiagnostics!.record
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: ReviewInvestigationDiagnosticOutcome.LegacyFallback,
        attemptOrdinal: 1,
        providerKind: ReviewExecutionProviderKind.Codex,
        workSlotId: 'slot-1',
      })
    );
  });

  it.each([
    ReviewInvestigationRunStatus.Parked,
    ReviewInvestigationRunStatus.RecoveryRequired,
    ReviewInvestigationRunStatus.TransitionBudgetExhausted,
  ] satisfies readonly ReviewInvestigationDeferredRunStatus[])(
    'does not replenish investigation budgets after authoritative %s',
    async (status) => {
      const fixture = createFixture({
        maxAttempts: 2,
        allowPartial: true,
        executionProfile: 'context_gateway_v1',
        investigationMode: ReviewInvestigationRecordingMode.Authoritative,
        investigationError: new ReviewInvestigationDeferredSignal(status),
      });

      const result = await fixture.useCase.execute(fixture.command);

      expect(result).toMatchObject({
        status: ReviewOrchestrationResultStatus.PartialCompleted,
        failureCode: 'required_investigation_deferred',
      });
      expect(fixture.investigationRecording?.execute).toHaveBeenCalledTimes(1);
      expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
      expect(
        fixture.dependencies.investigationDiagnostics!.record
      ).toHaveBeenCalledTimes(1);
      expect(fixture.controlPlane.requestPublication).toHaveBeenCalledTimes(1);
    }
  );

  it('supersedes before scheduling stale work and never projects it', async () => {
    const fixture = createFixture();
    jest
      .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
      .mockResolvedValueOnce(revisionOf(fixture.command))
      .mockResolvedValueOnce({
        ...revisionOf(fixture.command),
        headSha: '9'.repeat(40),
        reviewRevisionHash: hash('new-head'),
      });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Superseded);
    expect(fixture.controlPlane.supersedeExecution).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.prepare).not.toHaveBeenCalled();
    expect(fixture.dependencies.projectionBuilder.build).not.toHaveBeenCalled();
    expect(fixture.controlPlane.requestPublication).not.toHaveBeenCalled();
  });

  it('cancels before scheduling another work slot when the pull request closes', async () => {
    const fixture = createFixture();
    jest
      .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
      .mockResolvedValueOnce(revisionOf(fixture.command))
      .mockResolvedValueOnce({
        ...revisionOf(fixture.command),
        headSha: '9'.repeat(40),
        reviewRevisionHash: hash('closed-new-head'),
        pullRequestState: 'closed',
      });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Cancelled);
    expect(fixture.controlPlane.startExecution).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.prepare).not.toHaveBeenCalled();
    expect(fixture.dependencies.projectionBuilder.build).not.toHaveBeenCalled();
    expect(fixture.controlPlane.requestPublication).not.toHaveBeenCalled();
    expect(fixture.controlPlane.supersedeExecution).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.supersedeExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          authorizationId: authorization.authorizationId,
          authorizationToken: 'authorization.renewed-token',
        }),
        execution: expect.objectContaining({
          executionId: 'execution-1',
          generation: '1',
          streamVersion: '2',
        }),
        targetRevisionHash: authorization.facts.reviewRevisionHash,
      })
    );
    expect(fixture.controlPlane.renewAuthorization).toHaveBeenCalledTimes(1);
  });

  it('does not mutate RR when the PR is already closed before any admission', async () => {
    const fixture = createFixture();
    jest
      .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
      .mockResolvedValue({
        ...revisionOf(fixture.command),
        pullRequestState: 'closed',
      });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Cancelled);
    expect(fixture.controlPlane.startExecution).not.toHaveBeenCalled();
    expect(fixture.controlPlane.restoreExecution).not.toHaveBeenCalled();
    expect(fixture.controlPlane.supersedeExecution).not.toHaveBeenCalled();
    expect(fixture.controlPlane.renewAuthorization).not.toHaveBeenCalled();
  });

  it.each(['closed', 'moved'] as const)(
    'reconciles the exact supplied execution when the PR is %s before restore admission',
    async (revision) => {
      const fixture = createFixture();
      const restored = restoredAdmission(fixture.command, {
        state: RestoredReviewWorkSlotState.Pending,
        acceptedObservationRefId: null,
      }).restoredExecution;
      fixture.controlPlane.restoreExecution.mockReset();
      fixture.controlPlane.restoreExecution.mockResolvedValue({
        ...restored,
        version: '2',
        streamVersion: '3',
      });
      jest
        .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
        .mockResolvedValue({
          ...revisionOf(fixture.command),
          pullRequestState: revision === 'closed' ? 'closed' : 'open',
          ...(revision === 'moved'
            ? {
                headSha: '9'.repeat(40),
                reviewRevisionHash: hash('moved-head'),
              }
            : {}),
        });

      const result = await fixture.useCase.execute({
        ...fixture.command,
        restoredExecution: restored,
        restoreOnly: true,
      });

      expect(result).toMatchObject({
        status:
          revision === 'closed'
            ? ReviewOrchestrationResultStatus.Cancelled
            : ReviewOrchestrationResultStatus.Superseded,
        executionId: restored.executionId,
      });
      expect(fixture.controlPlane.supersedeExecution).toHaveBeenCalledTimes(1);
      expect(fixture.controlPlane.supersedeExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          authorization,
          execution: expect.objectContaining({
            executionId: restored.executionId,
            generation: restored.generation,
            streamVersion: '3',
          }),
          targetRevisionHash: authorization.facts.reviewRevisionHash,
        })
      );
      expect(fixture.controlPlane.startExecution).not.toHaveBeenCalled();
      expect(fixture.controlPlane.renewAuthorization).not.toHaveBeenCalled();
      expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    }
  );

  it('does not claim supersession when the original execution cleanup is unconfirmed before restore admission', async () => {
    const fixture = createFixture();
    const restored = restoredAdmission(fixture.command, {
      state: RestoredReviewWorkSlotState.Pending,
      acceptedObservationRefId: null,
    }).restoredExecution;
    fixture.controlPlane.restoreExecution.mockResolvedValue(restored);
    fixture.controlPlane.supersedeExecution.mockRejectedValue(
      new Error('supersede_acknowledgement_lost')
    );
    jest
      .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
      .mockResolvedValue({
        ...revisionOf(fixture.command),
        headSha: '9'.repeat(40),
        reviewRevisionHash: hash('moved-head'),
      });

    const result = await fixture.useCase.execute({
      ...fixture.command,
      restoredExecution: restored,
      restoreOnly: true,
    });

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      executionId: restored.executionId,
      failureCode: 'review_orchestration_cancellation_unconfirmed',
    });
    expect(fixture.controlPlane.supersedeExecution).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.startExecution).not.toHaveBeenCalled();
    expect(fixture.controlPlane.acquireInvocationLease).not.toHaveBeenCalled();
    expect(fixture.controlPlane.renewAuthorization).not.toHaveBeenCalled();
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
  });

  it.each([
    { field: 'executionId', value: 'foreign-execution' },
    { field: 'generation', value: '2' },
    { field: 'authorizationId', value: 'foreign-authorization' },
    { field: 'reviewRevisionHash', value: hash('foreign-revision') },
    { field: 'planHash', value: hash('foreign-plan') },
  ])(
    'does not confirm cancellation from changed $field readback',
    async ({ field, value }) => {
      const fixture = createFixture();
      const restored = restoredAdmission(fixture.command, {
        state: RestoredReviewWorkSlotState.Pending,
        acceptedObservationRefId: null,
      }).restoredExecution;
      fixture.controlPlane.restoreExecution.mockReset();
      fixture.controlPlane.restoreExecution.mockResolvedValue({
        ...restored,
        state: RestoredReviewExecutionState.Superseded,
        [field]: value,
      });
      jest
        .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
        .mockResolvedValue({
          ...revisionOf(fixture.command),
          pullRequestState: 'closed',
        });

      const result = await fixture.useCase.execute({
        ...fixture.command,
        restoredExecution: restored,
        restoreOnly: true,
      });

      expect(result).toMatchObject({
        status: ReviewOrchestrationResultStatus.Failed,
        failureCode: 'review_orchestration_cancellation_unconfirmed',
      });
      expect(fixture.controlPlane.supersedeExecution).not.toHaveBeenCalled();
      expect(fixture.controlPlane.startExecution).not.toHaveBeenCalled();
    }
  );

  it('rejects a supplied execution from another authorization before cleanup I/O', async () => {
    const fixture = createFixture();
    const restored = restoredAdmission(fixture.command, {
      state: RestoredReviewWorkSlotState.Pending,
      acceptedObservationRefId: null,
    }).restoredExecution;
    jest
      .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
      .mockResolvedValue({
        ...revisionOf(fixture.command),
        pullRequestState: 'closed',
      });

    const result = await fixture.useCase.execute({
      ...fixture.command,
      restoredExecution: {
        ...restored,
        authorizationId: 'foreign-authorization',
      },
    });

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode: 'review_orchestration_cancellation_unconfirmed',
    });
    expect(fixture.controlPlane.restoreExecution).not.toHaveBeenCalled();
    expect(fixture.controlPlane.supersedeExecution).not.toHaveBeenCalled();
  });

  it.each(['present', 'absent', 'failed', 'foreign'] as const)(
    'joins an initial %s execution restore when a sibling restore fails after PR closure',
    async (outcome) => {
      const fixture = createFixture();
      const restored = restoredAdmission(fixture.command, {
        state: RestoredReviewWorkSlotState.Pending,
        acceptedObservationRefId: null,
      }).restoredExecution;
      let finishRestore!: (value: typeof restored | null) => void;
      let failRestore!: (reason: Error) => void;
      const pendingRestore = new Promise<typeof restored | null>(
        (resolve, reject) => {
          finishRestore = resolve;
          failRestore = reject;
        }
      );
      fixture.controlPlane.restoreExecution.mockReset();
      fixture.controlPlane.restoreExecution.mockReturnValue(pendingRestore);
      fixture.controlPlane.restoreSnapshot.mockRejectedValue(
        new Error('snapshot_restore_failed')
      );
      let closureObserved!: () => void;
      const closedRead = new Promise<void>((resolve) => {
        closureObserved = resolve;
      });
      jest
        .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
        .mockResolvedValueOnce(revisionOf(fixture.command))
        .mockImplementation(async () => {
          closureObserved();
          return {
            ...revisionOf(fixture.command),
            pullRequestState: 'closed',
          };
        });

      const resultPromise = fixture.useCase.execute(fixture.command);
      await closedRead;
      if (outcome === 'failed') {
        failRestore(new Error('execution_restore_failed'));
      } else {
        finishRestore(
          outcome === 'absent'
            ? null
            : outcome === 'foreign'
              ? { ...restored, executionId: 'foreign-execution' }
              : restored
        );
      }
      const result = await resultPromise;

      expect(result.status).toBe(
        outcome === 'failed' || outcome === 'foreign'
          ? ReviewOrchestrationResultStatus.Failed
          : ReviewOrchestrationResultStatus.Cancelled
      );
      if (outcome === 'failed' || outcome === 'foreign') {
        expect(result.failureCode).toBe(
          'review_orchestration_cancellation_unconfirmed'
        );
      }
      expect(fixture.controlPlane.restoreExecution).toHaveBeenCalledTimes(1);
      expect(fixture.controlPlane.supersedeExecution).toHaveBeenCalledTimes(
        outcome === 'present' ? 1 : 0
      );
      if (outcome === 'present') {
        expect(fixture.controlPlane.supersedeExecution).toHaveBeenCalledWith(
          expect.objectContaining({
            execution: expect.objectContaining({
              executionId: fixture.command.executionId,
              generation: restored.generation,
              streamVersion: restored.streamVersion,
            }),
            targetRevisionHash: authorization.facts.reviewRevisionHash,
          })
        );
      }
      expect(fixture.controlPlane.startExecution).not.toHaveBeenCalled();
      expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    }
  );

  it.each(['absent', 'present'] as const)(
    'keeps a lost start ACK unconfirmed after an initial %s restore',
    async (initialRead) => {
      const fixture = createFixture();
      if (initialRead === 'present') {
        fixture.controlPlane.restoreExecution.mockReset();
        fixture.controlPlane.restoreExecution.mockResolvedValue(
          restoredAdmission(fixture.command, {
            state: RestoredReviewWorkSlotState.Pending,
            acceptedObservationRefId: null,
          }).restoredExecution
        );
      }
      let startAttempted = false;
      fixture.controlPlane.startExecution.mockImplementation(async () => {
        startAttempted = true;
        throw new Error('lost_start_ack');
      });
      jest
        .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
        .mockImplementation(async () => ({
          ...revisionOf(fixture.command),
          pullRequestState: startAttempted ? 'closed' : 'open',
        }));

      const result = await fixture.useCase.execute(fixture.command);

      expect(result).toMatchObject({
        status: ReviewOrchestrationResultStatus.Failed,
        failureCode: 'review_orchestration_cancellation_unconfirmed',
      });
      expect(fixture.controlPlane.startExecution).toHaveBeenCalledTimes(1);
      expect(fixture.controlPlane.restoreExecution).toHaveBeenCalledTimes(1);
      expect(fixture.controlPlane.supersedeExecution).not.toHaveBeenCalled();
      expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    }
  );

  it('preserves exact already-terminal RR work on PR-closed readback', async () => {
    const fixture = createFixture();
    const restored = restoredAdmission(fixture.command, {
      state: RestoredReviewWorkSlotState.Satisfied,
      acceptedObservationRefId: observationRef(
        fixture.command.executionId,
        'slot-1',
        acceptedObservation.observationId
      ),
    }).restoredExecution;
    fixture.controlPlane.restoreExecution.mockReset();
    fixture.controlPlane.restoreExecution.mockResolvedValue({
      ...restored,
      version: '2',
      state: RestoredReviewExecutionState.Completed,
    });
    jest
      .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
      .mockResolvedValue({
        ...revisionOf(fixture.command),
        pullRequestState: 'closed',
      });

    const result = await fixture.useCase.execute({
      ...fixture.command,
      restoredExecution: restored,
    });

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Cancelled);
    expect(fixture.controlPlane.supersedeExecution).not.toHaveBeenCalled();
    expect(fixture.controlPlane.startExecution).not.toHaveBeenCalled();
    expect(fixture.controlPlane.requestPublication).not.toHaveBeenCalled();
  });

  it.each([
    'restore_failed',
    'supersede_refused',
    'supersede_ack_lost',
  ] as const)(
    'does not claim confirmed cancellation after %s',
    async (failure) => {
      const fixture = createFixture();
      const restored = restoredAdmission(fixture.command, {
        state: RestoredReviewWorkSlotState.Pending,
        acceptedObservationRefId: null,
      }).restoredExecution;
      if (failure === 'restore_failed') {
        fixture.controlPlane.restoreExecution.mockReset();
        fixture.controlPlane.restoreExecution.mockRejectedValue(
          new Error(failure)
        );
      } else {
        // A missing restore cannot turn either refusal or lost ACK into success.
        fixture.controlPlane.supersedeExecution.mockRejectedValue(
          new Error(failure)
        );
      }
      jest
        .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
        .mockResolvedValue({
          ...revisionOf(fixture.command),
          pullRequestState: 'closed',
        });

      const result = await fixture.useCase.execute({
        ...fixture.command,
        restoredExecution: restored,
      });

      expect(result).toMatchObject({
        status: ReviewOrchestrationResultStatus.Failed,
        failureCode: 'review_orchestration_cancellation_unconfirmed',
      });
      expect(fixture.controlPlane.restoreExecution).toHaveBeenCalledTimes(1);
      expect(fixture.controlPlane.supersedeExecution).toHaveBeenCalledTimes(
        failure === 'restore_failed' ? 0 : 1
      );
      expect(fixture.controlPlane.renewAuthorization).not.toHaveBeenCalled();
      expect(fixture.controlPlane.requestPublication).not.toHaveBeenCalled();
    }
  );

  it('settles an admitted execution when failure-time GitHub read confirms closure', async () => {
    const fixture = createFixture();
    let failed = false;
    fixture.controlPlane.lookupEvidence.mockImplementation(async () => {
      failed = true;
      throw new Error('evidence_lookup_failed');
    });
    jest
      .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
      .mockImplementation(async () => ({
        ...revisionOf(fixture.command),
        pullRequestState: failed ? 'closed' : 'open',
      }));

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Cancelled);
    expect(fixture.controlPlane.supersedeExecution).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.acquireInvocationLease).not.toHaveBeenCalled();
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    expect(fixture.controlPlane.requestPublication).not.toHaveBeenCalled();
  });

  it.each(['restore', 'supersede'] as const)(
    'preserves outer abort during cancellation %s',
    async (phase) => {
      const fixture = createFixture();
      const abort = new AbortController();
      const reason = new Error('outer_cancelled');
      Object.assign(fixture.dependencies, { signal: abort.signal });
      const restored = restoredAdmission(fixture.command, {
        state: RestoredReviewWorkSlotState.Pending,
        acceptedObservationRefId: null,
      }).restoredExecution;
      fixture.controlPlane.restoreExecution.mockReset();
      fixture.controlPlane.restoreExecution.mockImplementation(async () => {
        if (phase === 'restore') abort.abort(reason);
        return restored;
      });
      fixture.controlPlane.supersedeExecution.mockImplementation(async () => {
        abort.abort(reason);
      });
      jest
        .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
        .mockResolvedValue({
          ...revisionOf(fixture.command),
          pullRequestState: 'closed',
        });

      await expect(
        fixture.useCase.execute({
          ...fixture.command,
          restoredExecution: restored,
        })
      ).rejects.toBe(reason);
      expect(fixture.controlPlane.supersedeExecution).toHaveBeenCalledTimes(
        phase === 'restore' ? 0 : 1
      );
      expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    }
  );

  it('preserves outer abort during the failure-time GitHub read', async () => {
    const fixture = createFixture();
    const abort = new AbortController();
    const reason = new Error('outer_cancelled');
    Object.assign(fixture.dependencies, { signal: abort.signal });
    let failed = false;
    fixture.controlPlane.lookupEvidence.mockImplementation(async () => {
      failed = true;
      throw new Error('evidence_lookup_failed');
    });
    jest
      .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
      .mockImplementation(async () => {
        if (failed) abort.abort(reason);
        return revisionOf(fixture.command);
      });

    await expect(fixture.useCase.execute(fixture.command)).rejects.toBe(reason);
    expect(fixture.controlPlane.supersedeExecution).not.toHaveBeenCalled();
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
  });

  it('maps a control-plane race to cancellation when GitHub confirms the pull request closed', async () => {
    const fixture = createFixture();
    jest
      .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
      .mockResolvedValueOnce(revisionOf(fixture.command))
      .mockResolvedValueOnce({
        ...revisionOf(fixture.command),
        pullRequestState: 'closed',
      });
    fixture.controlPlane.renewAuthorization.mockRejectedValueOnce(
      new Error('review_action_v2:review_run_renew:not_found')
    );

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Cancelled);
    expect(fixture.dependencies.invocations.prepare).not.toHaveBeenCalled();
  });

  it('releases a lease acquired concurrently with pull request closure', async () => {
    const fixture = createFixture();
    const latest = {
      ...restoredAdmission(fixture.command, {
        state: RestoredReviewWorkSlotState.Exhausted,
        acceptedObservationRefId: null,
      }).restoredExecution,
      version: '5',
      streamVersion: '4',
    };
    fixture.controlPlane.restoreExecution
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockImplementation(async () => {
        expect(
          fixture.controlPlane.releaseInvocationLease
        ).toHaveBeenCalledTimes(1);
        // A concurrent parent transition, not lease release alone, advanced CAS.
        return latest;
      });
    jest
      .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
      .mockImplementation(async () =>
        fixture.controlPlane.acquireInvocationLease.mock.calls.length === 0
          ? revisionOf(fixture.command)
          : {
              ...revisionOf(fixture.command),
              pullRequestState: 'closed',
            }
      );

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Cancelled);
    expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
      1
    );
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      1
    );
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    expect(fixture.controlPlane.supersedeExecution).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.supersedeExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: expect.objectContaining({
          executionId: fixture.command.executionId,
          generation: '1',
          streamVersion: '4',
          executionVersion: '5',
        }),
        targetRevisionHash: authorization.facts.reviewRevisionHash,
      })
    );
  });

  it.each([
    ['unavailable', ReviewOrchestrationResultStatus.Failed],
    ['closed', ReviewOrchestrationResultStatus.Cancelled],
    ['moved', ReviewOrchestrationResultStatus.Superseded],
  ] as const)(
    'commits completed evidence before an %s revision read without replaying the provider',
    async (outcome, expectedStatus) => {
      const fixture = createFixture({ maxAttempts: 2 });
      const events: string[] = [];
      let providerCompleted = false;
      let unavailableReadFailed = false;
      jest.mocked(fixture.dependencies.delay.sleep).mockImplementation(
        (_delayMs, signal) =>
          new Promise<void>((resolve) => {
            if (!signal) {
              resolve();
              return;
            }
            const finish = () => {
              signal.removeEventListener('abort', finish);
              resolve();
            };
            signal.addEventListener('abort', finish, { once: true });
            if (signal.aborted) finish();
          })
      );
      jest
        .mocked(fixture.dependencies.invocations.execute)
        .mockImplementation(async () => {
          providerCompleted = true;
          events.push('provider-completed');
          return observationPayload;
        });
      fixture.controlPlane.commitEvidence.mockImplementation(async () => {
        events.push('evidence-committed');
        return {
          observationId: 'observation-1',
          historicalOnly: false,
          eligibilityPolicyVersion: 't0-v1',
        };
      });
      jest
        .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
        .mockImplementation(async () => {
          if (!providerCompleted || unavailableReadFailed)
            return revisionOf(fixture.command);
          events.push('revision-refused');
          if (outcome === 'unavailable') {
            unavailableReadFailed = true;
            throw new Error('review_action_v2_revision_guard_unavailable');
          }
          return outcome === 'closed'
            ? { ...revisionOf(fixture.command), pullRequestState: 'closed' }
            : {
                ...revisionOf(fixture.command),
                mergeBaseSha: '8'.repeat(40),
                reviewRevisionHash: hash('new-head'),
              };
        });

      const result = await fixture.useCase.execute(fixture.command);

      expect(result.status).toBe(expectedStatus);
      expect(events.slice(0, 3)).toEqual([
        'provider-completed',
        'evidence-committed',
        'revision-refused',
      ]);
      expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
      expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
        1
      );
      expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledTimes(1);
      expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledWith(
        expect.objectContaining({
          lease,
          ownerIdHash: fixture.command.ownerIdHash,
          observation: observationPayload,
        })
      );
      expect(fixture.controlPlane.attachObservation).not.toHaveBeenCalled();
      expect(fixture.controlPlane.adoptObservation).not.toHaveBeenCalled();
      expect(fixture.controlPlane.finalizeExecution).not.toHaveBeenCalled();
      expect(fixture.controlPlane.requestPublication).not.toHaveBeenCalled();
      expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
        1
      );
      expect(
        fixture.dependencies.invocationFailureClassifier.classify
      ).not.toHaveBeenCalled();
      expect(fixture.controlPlane.supersedeExecution).toHaveBeenCalledTimes(
        outcome === 'unavailable' ? 0 : 1
      );
      if (outcome === 'closed') {
        expect(fixture.controlPlane.supersedeExecution).toHaveBeenCalledWith(
          expect.objectContaining({
            targetRevisionHash: authorization.facts.reviewRevisionHash,
          })
        );
      }
    }
  );

  it('retains cancellation after the lease supervisor returns a completed result', async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    const reason = new Error('cancelled_after_provider_completion');
    Object.assign(fixture.dependencies, { signal: controller.signal });
    const supervise: RunT0ReviewOrchestrationDependencies['leaseSupervisor']['run'] =
      async ({ lease: currentLease, operation }) => {
        const result = await operation(
          new AbortController().signal,
          () => currentLease
        );
        controller.abort(reason);
        return result;
      };
    jest
      .mocked(fixture.dependencies.leaseSupervisor.run)
      .mockImplementation(supervise);

    await expect(fixture.useCase.execute(fixture.command)).rejects.toBe(reason);

    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
    expect(fixture.controlPlane.attachObservation).not.toHaveBeenCalled();
    expect(fixture.controlPlane.finalizeExecution).not.toHaveBeenCalled();
    expect(fixture.controlPlane.requestPublication).not.toHaveBeenCalled();
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      1
    );
  });

  it('aborts an active provider invocation when the revision moves', async () => {
    const fixture = createFixture();
    let releaseRevisionPoll!: () => void;
    jest.mocked(fixture.dependencies.delay.sleep).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseRevisionPoll = resolve;
        })
    );
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockImplementation(async ({ signal }) => {
        observedSignal = signal;
        providerStarted();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(signal.reason || new Error('aborted')),
            { once: true }
          );
        });
      });

    const resultPromise = fixture.useCase.execute(fixture.command);
    await started;
    jest
      .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
      .mockResolvedValue({
        ...revisionOf(fixture.command),
        headSha: '9'.repeat(40),
        reviewRevisionHash: hash('new-head-during-provider'),
      });
    releaseRevisionPoll();
    const result = await resultPromise;

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Superseded);
    expect(observedSignal?.aborted).toBe(true);
    expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      1
    );
  });

  it.each(['agentic_unbounded_v1', 'context_gateway_v1'] as const)(
    'aborts an active %s invocation when the pull request closes',
    async (executionProfile) => {
      const fixture = createFixture({ executionProfile });
      let releaseRevisionPoll!: () => void;
      jest.mocked(fixture.dependencies.delay.sleep).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseRevisionPoll = resolve;
          })
      );
      let providerStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        providerStarted = resolve;
      });
      let observedSignal: AbortSignal | undefined;
      jest
        .mocked(fixture.dependencies.invocations.execute)
        .mockImplementation(async ({ signal }) => {
          observedSignal = signal;
          providerStarted();
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(signal.reason || new Error('aborted')),
              { once: true }
            );
          });
        });

      const resultPromise = fixture.useCase.execute(fixture.command);
      await started;
      jest
        .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
        .mockResolvedValue({
          ...revisionOf(fixture.command),
          pullRequestState: 'closed',
        });
      releaseRevisionPoll();
      const result = await resultPromise;

      expect(result.status).toBe(ReviewOrchestrationResultStatus.Cancelled);
      expect(observedSignal?.aborted).toBe(true);
      expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
      expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
        1
      );
    }
  );

  it('drains a confined invocation and commits historical evidence after supersession', async () => {
    const fixture = createFixture({
      executionProfile: 'context_gateway_v1',
    });
    fixture.controlPlane.commitEvidence.mockResolvedValue({
      observationId: 'observation-historical',
      historicalOnly: true,
      eligibilityPolicyVersion: 't0-v1',
    });
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    let finishProvider!: () => void;
    const providerMayFinish = new Promise<void>((resolve) => {
      finishProvider = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockImplementation(async ({ signal }) => {
        observedSignal = signal;
        providerStarted();
        await providerMayFinish;
        return attestedObservationPayload;
      });

    const resultPromise = fixture.useCase.execute(fixture.command);
    await started;
    jest
      .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
      .mockResolvedValue({
        ...revisionOf(fixture.command),
        headSha: '9'.repeat(40),
        reviewRevisionHash: hash('new-head-during-confined-provider'),
      });
    finishProvider();
    const result = await resultPromise;

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Superseded);
    expect(observedSignal?.aborted).toBe(false);
    expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.attachObservation).not.toHaveBeenCalled();
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      1
    );
    expect(fixture.controlPlane.supersedeExecution).toHaveBeenCalledTimes(1);
  });

  it('publishes a blocking partial result after bounded attempt exhaustion', async () => {
    const fixture = createFixture();
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockRejectedValue(new Error('provider_failed'));

    const result = await fixture.useCase.execute({
      ...fixture.command,
      allowPartial: true,
    });

    expect(result.status).toBe(
      ReviewOrchestrationResultStatus.PartialCompleted
    );
    expect(result.failureCode).toBe('required_work_exhausted');
    expect(result.state.phase).toBe(ReviewOrchestrationPhase.PartialCompleted);
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledWith(
      expect.objectContaining({ allowPartial: true })
    );
    expect(fixture.dependencies.projectionBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({ exhaustedWorkSlotIds: ['slot-1'] })
    );
    expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
      2
    );
    expect(fixture.controlPlane.restoreExecution).toHaveBeenCalledTimes(3);
    expect(fixture.controlPlane.terminalizeWorkSlot).not.toHaveBeenCalled();
  });

  it('fails closed when exhaustion reconciliation becomes not runnable', async () => {
    const fixture = createFixture();
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockRejectedValue(new Error('provider_failed'));
    fixture.controlPlane.acquireInvocationLease
      .mockResolvedValueOnce({
        status: ReviewInvocationLeaseAcquireOutcomeStatus.Acquired,
        lease,
      })
      .mockResolvedValueOnce({
        status: ReviewInvocationLeaseAcquireOutcomeStatus.NotRunnable,
      });

    const result = await fixture.useCase.execute({
      ...fixture.command,
      allowPartial: true,
    });

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode:
        'review_orchestration_attempt_budget_reconciliation_not_runnable',
    });
    expect(fixture.controlPlane.terminalizeWorkSlot).not.toHaveBeenCalled();
  });

  it('does not consume a semantic attempt ordinal while a lease is busy', async () => {
    const fixture = createFixture({ maxAttempts: 1 });
    fixture.controlPlane.acquireInvocationLease
      .mockResolvedValueOnce({
        status: ReviewInvocationLeaseAcquireOutcomeStatus.Busy,
      })
      .mockResolvedValueOnce({
        status: ReviewInvocationLeaseAcquireOutcomeStatus.Acquired,
        lease,
      });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.dependencies.invocations.prepare).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ attemptOrdinal: 1 })
    );
    expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
      2
    );
    expect(fixture.dependencies.delay.sleep).toHaveBeenCalledWith(500);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
  });

  it('marks a persistently busy required lease as blocking partial coverage', async () => {
    const fixture = createFixture({ maxAttempts: 1 });
    fixture.controlPlane.acquireInvocationLease.mockResolvedValue({
      status: ReviewInvocationLeaseAcquireOutcomeStatus.Busy,
    });
    const useCase = new RunT0ReviewOrchestration(fixture.dependencies, 30, 2);

    const result = await useCase.execute({
      ...fixture.command,
      allowPartial: true,
    });

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.PartialCompleted,
      failureCode: 'required_provider_lane_busy',
    });
    expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
      2
    );
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    expect(fixture.dependencies.projectionBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({ exhaustedWorkSlotIds: ['slot-1'] })
    );
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledWith(
      expect.objectContaining({ allowPartial: true })
    );
  });

  it('resets the shared lane busy streak after a successful acquisition', async () => {
    const fixture = createFixture({ maxAttempts: 1 });
    const secondSlot: ReviewWorkSlotPlan = {
      ...fixture.command.workSlots[0]!,
      workSlotId: 'slot-2',
      shardKey: 'batch-2',
    };
    const workSlots = [...fixture.command.workSlots, secondSlot];
    const command = {
      ...fixture.command,
      workSlots,
      workSlotsCanonicalJson: canonicalizeReviewWorkSlots(workSlots),
    };
    jest
      .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
      .mockResolvedValue(revisionOf(command));
    fixture.controlPlane.restoreExecution
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        ...restoredAdmission(command, {
          state: RestoredReviewWorkSlotState.Pending,
          acceptedObservationRefId: null,
        }).restoredExecution,
        version: '2',
        streamVersion: '2',
      });
    fixture.controlPlane.acquireInvocationLease
      .mockResolvedValueOnce({
        status: ReviewInvocationLeaseAcquireOutcomeStatus.Busy,
      })
      .mockResolvedValueOnce({
        status: ReviewInvocationLeaseAcquireOutcomeStatus.Acquired,
        lease,
      })
      .mockResolvedValueOnce({
        status: ReviewInvocationLeaseAcquireOutcomeStatus.Busy,
      })
      .mockResolvedValueOnce({
        status: ReviewInvocationLeaseAcquireOutcomeStatus.Acquired,
        lease,
      });
    const useCase = new RunT0ReviewOrchestration(fixture.dependencies, 30, 2);

    const result = await useCase.execute(command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
      4
    );
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(2);
  });

  it('shares the busy poll budget across required slots on one provider lane', async () => {
    const fixture = createFixture({ maxAttempts: 1 });
    const secondSlot: ReviewWorkSlotPlan = {
      ...fixture.command.workSlots[0]!,
      workSlotId: 'slot-2',
      shardKey: 'batch-2',
    };
    const workSlots = [...fixture.command.workSlots, secondSlot];
    const command = {
      ...fixture.command,
      workSlots,
      workSlotsCanonicalJson: canonicalizeReviewWorkSlots(workSlots),
      allowPartial: true,
    };
    jest
      .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
      .mockResolvedValue(revisionOf(command));
    fixture.controlPlane.restoreExecution
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        ...restoredAdmission(command, {
          state: RestoredReviewWorkSlotState.Pending,
          acceptedObservationRefId: null,
        }).restoredExecution,
        version: '2',
        streamVersion: '2',
      });
    fixture.controlPlane.acquireInvocationLease.mockResolvedValue({
      status: ReviewInvocationLeaseAcquireOutcomeStatus.Busy,
    });
    const useCase = new RunT0ReviewOrchestration(fixture.dependencies, 30, 2);

    const result = await useCase.execute(command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.PartialCompleted,
      failureCode: 'required_provider_lane_busy',
    });
    expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
      2
    );
    expect(fixture.dependencies.invocations.prepare).toHaveBeenCalledTimes(1);
    expect(
      jest
        .mocked(fixture.dependencies.delay.sleep)
        .mock.calls.filter(([delayMs]) => delayMs === 500)
    ).toHaveLength(1);
    expect(fixture.dependencies.projectionBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({
        exhaustedWorkSlotIds: ['slot-1', 'slot-2'],
      })
    );
  });

  it('waits on a busy provider lane past the poll cap while the execution deadline allows', async () => {
    const fixture = createFixture({ maxAttempts: 1 });
    const secondSlot: ReviewWorkSlotPlan = {
      ...fixture.command.workSlots[0]!,
      workSlotId: 'slot-2',
      shardKey: 'batch-2',
    };
    const workSlots = [...fixture.command.workSlots, secondSlot];
    const command = {
      ...fixture.command,
      workSlots,
      workSlotsCanonicalJson: canonicalizeReviewWorkSlots(workSlots),
    };
    jest
      .mocked(fixture.dependencies.revisionGuard.loadCurrentRevision)
      .mockResolvedValue(revisionOf(command));
    fixture.controlPlane.restoreExecution
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        ...restoredAdmission(command, {
          state: RestoredReviewWorkSlotState.Pending,
          acceptedObservationRefId: null,
        }).restoredExecution,
        version: '2',
        streamVersion: '2',
      });
    fixture.controlPlane.acquireInvocationLease
      .mockResolvedValueOnce({
        status: ReviewInvocationLeaseAcquireOutcomeStatus.Busy,
      })
      .mockResolvedValueOnce({
        status: ReviewInvocationLeaseAcquireOutcomeStatus.Busy,
      })
      .mockResolvedValue({
        status: ReviewInvocationLeaseAcquireOutcomeStatus.Acquired,
        lease,
      });
    Object.assign(fixture.dependencies, {
      executionDeadline: orchestrationDeadline(
        600_000,
        fixture.dependencies.clock.monotonicNowMs
      ),
    });
    const useCase = new RunT0ReviewOrchestration(fixture.dependencies, 30, 1);

    const result = await useCase.execute(command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
      4
    );
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(2);
  });

  it('treats a server-side attempt budget exhaustion as an exhausted slot', async () => {
    const fixture = createFixture({ maxAttempts: 1 });
    fixture.controlPlane.acquireInvocationLease.mockResolvedValue({
      status: ReviewInvocationLeaseAcquireOutcomeStatus.AttemptBudgetExhausted,
    });
    fixture.controlPlane.restoreExecution.mockResolvedValue(
      exhaustedExecution(fixture.command)
    );

    const result = await fixture.useCase.execute({
      ...fixture.command,
      allowPartial: true,
    });

    expect(result.status).toBe(
      ReviewOrchestrationResultStatus.PartialCompleted
    );
    expect(result.failureCode).toBe('required_work_exhausted');
    expect(result.state.phase).toBe(ReviewOrchestrationPhase.PartialCompleted);
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    expect(fixture.dependencies.projectionBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({ exhaustedWorkSlotIds: ['slot-1'] })
    );
    expect(fixture.controlPlane.terminalizeWorkSlot).not.toHaveBeenCalled();
  });

  it('accepts monotonic execution advancement between restore and start', async () => {
    const fixture = createFixture();
    const older = restoredAdmission(fixture.command, {
      state: RestoredReviewWorkSlotState.Pending,
      acceptedObservationRefId: null,
    }).restoredExecution;
    const newer = restoredAdmission(fixture.command, {
      state: RestoredReviewWorkSlotState.Satisfied,
      acceptedObservationRefId: observationRef(
        'execution-1',
        'slot-1',
        acceptedObservation.observationId
      ),
    });
    const advanced = {
      ...newer,
      streamVersion: '2',
      executionVersion: '2',
      restoredExecution: {
        ...newer.restoredExecution,
        streamVersion: '2',
        version: '2',
      },
    };
    fixture.controlPlane.restoreExecution
      .mockReset()
      .mockResolvedValueOnce(older)
      .mockResolvedValue(advanced.restoredExecution);
    fixture.controlPlane.startExecution.mockResolvedValue(advanced);
    fixture.controlPlane.lookupEvidence.mockResolvedValue({
      kind: ReviewEvidenceLookupKind.Hit,
      observation: acceptedObservation,
      attachment: sameExecutionAttachment,
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
  });

  it('rejects lease renewal identity drift before evidence commit', async () => {
    const fixture = createFixture();
    (fixture.dependencies.leaseSupervisor.run as jest.Mock).mockImplementation(
      async ({
        renew,
        operation,
      }: {
        renew: () => Promise<unknown>;
        operation: (
          signal: AbortSignal,
          currentLease: () => unknown
        ) => Promise<unknown>;
      }) => {
        const currentLease = await renew();
        return operation(new AbortController().signal, () => currentLease);
      }
    );
    fixture.controlPlane.renewInvocationLease.mockResolvedValue({
      ...lease,
      leaseId: 'lease-drift',
      fencingToken: '2',
      expiresAt: '2026-07-22T12:11:00.000Z',
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode: 'required_work_exhausted',
    });
    expect(fixture.controlPlane.commitEvidence).not.toHaveBeenCalled();
  });

  it('propagates the rotated renewal capability to every later mutation', async () => {
    const fixture = createFixture();
    (fixture.dependencies.leaseSupervisor.run as jest.Mock).mockImplementation(
      async ({
        renew,
        operation,
      }: {
        renew: () => Promise<unknown>;
        operation: (
          signal: AbortSignal,
          currentLease: () => unknown
        ) => Promise<unknown>;
      }) => {
        let currentLease: unknown = lease;
        const result = operation(
          new AbortController().signal,
          () => currentLease
        );
        currentLease = await renew();
        return result;
      }
    );
    fixture.controlPlane.renewInvocationLease.mockResolvedValue({
      ...lease,
      leaseCapability: 'lease.capability.renewed',
      expiresAt: '2026-07-22T12:11:00.000Z',
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    const invocationInput = jest.mocked(
      fixture.dependencies.invocations.execute
    ).mock.calls[0][0];
    expect(invocationInput.lease).toBe(lease);
    expect(invocationInput.currentLease?.()).toMatchObject({
      leaseId: lease.leaseId,
      attemptId: lease.attemptId,
      fencingToken: lease.fencingToken,
      leaseCapability: 'lease.capability.renewed',
    });
    expect(fixture.controlPlane.commitEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: expect.objectContaining({
          leaseCapability: 'lease.capability.renewed',
        }),
      })
    );
    expect(fixture.controlPlane.attachObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentCapability: 'lease.capability.renewed',
      })
    );
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: expect.objectContaining({
          leaseCapability: 'lease.capability.renewed',
        }),
      })
    );
  });

  it('does not mark coverage partial when only an optional slot is exhausted', async () => {
    const fixture = createFixture();
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockRejectedValue(new Error('provider_failed'));

    const optionalWorkSlots = [
      { ...fixture.command.workSlots[0], required: false },
    ];
    const optionalCommand = {
      ...fixture.command,
      workSlots: optionalWorkSlots,
      workSlotsCanonicalJson: canonicalizeReviewWorkSlots(optionalWorkSlots),
    };
    fixture.controlPlane.restoreExecution
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(exhaustedExecution(optionalCommand));

    const result = await fixture.useCase.execute(optionalCommand);

    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledWith(
      expect.objectContaining({ allowPartial: false })
    );
  });

  it('derives final partial publication from projection coverage limitations', async () => {
    const fixture = createFixture();
    jest
      .mocked(fixture.dependencies.projectionBuilder.build)
      .mockResolvedValue({
        ...projection,
        coverageComplete: false,
      });

    const result = await fixture.useCase.execute({
      ...fixture.command,
      allowPartial: true,
    });

    expect(result.status).toBe(
      ReviewOrchestrationResultStatus.PartialCompleted
    );
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledWith(
      expect.objectContaining({ allowPartial: true })
    );
  });

  it('fails before durable execution when server limits reject the plan', async () => {
    const fixture = createFixture();
    fixture.controlPlane.authorize.mockResolvedValue({
      ...authorization,
      limits: { ...authorization.limits, maxWorkSlots: 0 },
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode: 'review_orchestration_work_slot_limit_exceeded',
    });
    expect(fixture.controlPlane.startExecution).not.toHaveBeenCalled();
  });

  it('blocks terminal_unknown instead of treating publication as complete', async () => {
    const fixture = createFixture();
    fixture.controlPlane.readPublicationStatus.mockResolvedValue({
      terminal: true,
      outcome: { state: ReviewPublicationState.TerminalUnknown },
    });

    const result = await fixture.useCase.execute(fixture.command);

    expect(result).toMatchObject({
      status: ReviewOrchestrationResultStatus.Failed,
      failureCode: 'publication_terminal_unknown',
    });
    expect(result.state.phase).toBe(ReviewOrchestrationPhase.Failed);
  });
});

function createFixture(
  options: {
    maxAttempts?: number;
    workSlotCount?: number;
    allowPartial?: boolean;
    investigationMode?: ReviewInvestigationRecordingMode;
    investigationVerifiedCleanEffectsEnabled?: boolean;
    investigationError?: unknown;
    investigationPrepareError?: unknown;
    investigationSupported?: boolean;
    lifecycleBearingAuthoritative?: boolean;
    executionProfile?:
      | 'prompt_only_envelope_v1'
      | 'agentic_unbounded_v1'
      | 'context_gateway_v1'
      | 'investigation_gateway_v1';
  } = {}
) {
  const controlPlane = {
    authorize: jest.fn().mockResolvedValue(authorization),
    renewAuthorization: jest
      .fn()
      .mockImplementation(async (input) =>
        renewedAuthorization(input.authorization, input.requestedTtlMs)
      ),
    restoreSnapshot: jest.fn().mockResolvedValue(undefined),
    restoreExecution: jest.fn().mockResolvedValue(null),
    startExecution: jest.fn().mockImplementation(async (input) => ({
      executionId: 'execution-1',
      generation: '1',
      streamVersion: '1',
      executionVersion: '1',
      restoredExecution: {
        executionId: 'execution-1',
        version: '1',
        streamVersion: '1',
        generation: '1',
        state: RestoredReviewExecutionState.Running,
        authorizationId: authorization.authorizationId,
        reviewRevisionHash: input.reviewRevisionHash,
        planHash: input.planHash,
        workSlots: input.workSlots.map((slot: ReviewWorkSlotPlan) => ({
          workSlotId: slot.workSlotId,
          state: RestoredReviewWorkSlotState.Pending,
          required: slot.required,
          providerVoteIdentityHash: slot.providerVoteIdentityHash,
          activeLeaseId: null,
          acceptedObservationRefId: null,
        })),
      },
    })),
    terminalizeWorkSlot: jest.fn().mockResolvedValue({ streamVersion: '1' }),
    supersedeExecution: jest.fn().mockResolvedValue(undefined),
    lookupEvidence: jest
      .fn()
      .mockResolvedValue({ kind: ReviewEvidenceLookupKind.Miss }),
    acquireInvocationLease: jest.fn().mockResolvedValue({
      status: ReviewInvocationLeaseAcquireOutcomeStatus.Acquired,
      lease,
    }),
    renewInvocationLease: jest.fn().mockResolvedValue(lease),
    releaseInvocationLease: jest.fn().mockResolvedValue(undefined),
    commitEvidence: jest.fn().mockResolvedValue({
      observationId: 'observation-1',
      historicalOnly: false,
      eligibilityPolicyVersion: 't0-v1',
    }),
    attachObservation: jest.fn().mockResolvedValue({ streamVersion: '2' }),
    adoptObservation: jest.fn().mockResolvedValue({ streamVersion: '2' }),
    finalizeExecution: jest
      .fn()
      .mockResolvedValue({ publicationPermit: 'publication.permit' }),
    requestPublication: jest.fn().mockResolvedValue({
      status: ReviewPublicationRequestOutcomeStatus.Requested,
      publicationAttemptId: 'publication-1',
      pollAfterMs: 0,
    }),
    readPublicationStatus: jest.fn().mockResolvedValue({
      terminal: true,
      outcome: {
        state: ReviewPublicationState.Succeeded,
        canonicalReceiptSetHash: hash('receipt'),
      },
    }),
  } as jest.Mocked<ReviewActionV2ControlPlanePort>;
  const workSlots = Array.from(
    { length: options.workSlotCount ?? 1 },
    (_, index) => ({
      workSlotId: `slot-${index + 1}`,
      taskKind: ReviewTaskKind.FindingDiscovery,
      providerKind: ReviewExecutionProviderKind.Codex,
      providerVoteIdentityHash: hash('vote'),
      shardKey: `batch-${index + 1}`,
      required: true,
      attemptBudget: options.maxAttempts ?? 1,
      retryPolicyVersion: 'retry-v1',
    })
  );
  const command: RunT0ReviewOrchestrationCommand = {
    executionId: 'execution-1',
    baseSha: '1'.repeat(40),
    mergeBaseSha: '2'.repeat(40),
    headSha: '3'.repeat(40),
    reviewRevisionHash: hash('revision'),
    compatibilityKey: hash('compatibility'),
    planHash: hash('plan'),
    workSlotsCanonicalJson: canonicalizeReviewWorkSlots(workSlots),
    assignmentManifestCanonicalJson: '{"manifestVersion":1}',
    assignmentManifestHash: hash('{"manifestVersion":1}'),
    workSlots,
    sourceRunId: 'run-1',
    sourceRunAttempt: '1',
    ownerIdHash: hash('owner'),
    allowPartial: options.allowPartial ?? false,
  };
  const acquiredProviderAttempts = new Map<string, number>();
  let serverExhausted = false;
  controlPlane.acquireInvocationLease.mockImplementation(async (input) => {
    const workSlotId = input.workSlot.workSlotId;
    const attempts = acquiredProviderAttempts.get(workSlotId) ?? 0;
    if (attempts >= (options.maxAttempts ?? 1)) {
      serverExhausted = true;
      return {
        status:
          ReviewInvocationLeaseAcquireOutcomeStatus.AttemptBudgetExhausted,
      };
    }
    acquiredProviderAttempts.set(workSlotId, attempts + 1);
    return {
      status: ReviewInvocationLeaseAcquireOutcomeStatus.Acquired,
      lease,
    };
  });
  controlPlane.restoreExecution
    .mockReset()
    .mockResolvedValueOnce(null)
    .mockImplementation(async () =>
      serverExhausted
        ? exhaustedExecution(command)
        : {
            ...restoredAdmission(command, {
              state: RestoredReviewWorkSlotState.Pending,
              acceptedObservationRefId: null,
            }).restoredExecution,
            version: '2',
            streamVersion: '2',
          }
    );
  let monotonicNowMs = 0;
  const dependencies = {
    controlPlane,
    revisionGuard: {
      loadCurrentRevision: jest.fn().mockResolvedValue(revisionOf(command)),
    },
    oidc: { getToken: jest.fn().mockResolvedValue('oidc.token') },
    invocationManifestAssembler: {
      assemble: jest.fn().mockImplementation(async (invocation) => ({
        manifestCanonicalJson: '{"fixture":true}',
        manifestKey: hash(
          `manifest-${invocation.attemptOrdinal}-${invocation.manifestFacts.executionProfile}`
        ),
        providerInvocationKey: hash(
          `invocation-${invocation.attemptOrdinal}-${invocation.manifestFacts.executionProfile}`
        ),
        providerVoteIdentityHash: hash('vote'),
      })),
    },
    invocations: {
      prepare: jest
        .fn()
        .mockImplementation(async ({ workSlot, attemptOrdinal }) => ({
          workSlotId: workSlot.workSlotId,
          attemptOrdinal,
          provider: 'codex',
          requestedModel: 'gpt-test',
          reviewPrompt: 'review',
          immutableRequest: Object.freeze({ prompt: 'review' }),
          coverageManifest: coverageManifest(workSlot.workSlotId),
          manifestFacts: Object.freeze({
            taskKindSet: options.lifecycleBearingAuthoritative
              ? [workSlot.taskKind, ReviewTaskKind.LifecycleRevalidation]
              : [workSlot.taskKind],
            providerKind: workSlot.providerKind,
            providerCapabilityHash: hash('capability'),
            providerRequestEnvelopeHash: hash('request'),
            outputSchemaHash: hash('schema'),
            filePatchManifestHash: hash('patch'),
            contextManifestHash: hash('context'),
            lifecycleTargetSetHash: options.lifecycleBearingAuthoritative
              ? hash('lifecycle-targets')
              : null,
            liveLifecycleStateHash: options.lifecycleBearingAuthoritative
              ? hash('lifecycle')
              : null,
            toolPolicyHash: hash('tool-policy'),
            executionProfile:
              options.executionProfile ?? 'agentic_unbounded_v1',
            baseTreeHash: null,
            environmentContractHash: hash('environment'),
          }),
        })),
      execute: jest
        .fn()
        .mockResolvedValue(
          options.executionProfile === 'context_gateway_v1'
            ? attestedObservationPayload
            : observationPayload
        ),
    },
    invocationFailureClassifier: {
      classify: jest
        .fn()
        .mockReturnValue(ReviewInvocationFailureClass.Retryable),
    },
    invocationDiagnostics: {
      recordFailure: jest.fn(),
    },
    investigationDiagnostics: {
      record: jest.fn(),
    },
    leaseSupervisor: {
      run: jest
        .fn()
        .mockImplementation(async ({ operation }) =>
          operation(new AbortController().signal, () => lease)
        ),
    },
    projectionBuilder: {
      build: jest.fn().mockResolvedValue(projection),
    },
    identities: {
      deterministicId: jest.fn(
        (namespace, parts) =>
          `rr:${namespace}:${hash(parts.join('|')).slice(0, 32)}`
      ),
    } satisfies ReviewOrchestrationIdentityPort,
    clock: {
      monotonicNowMs: jest.fn(() => monotonicNowMs),
    },
    delay: {
      sleep: jest.fn().mockImplementation(async (delayMs: number) => {
        monotonicNowMs += delayMs;
      }),
    } satisfies ReviewOrchestrationDelayPort,
  } as unknown as jest.Mocked<RunT0ReviewOrchestrationDependencies>;
  const investigationRecording = options.investigationMode
    ? {
        mode: options.investigationMode,
        verifiedCleanEffectsEnabled:
          options.investigationVerifiedCleanEffectsEnabled ?? false,
        supports: jest
          .fn()
          .mockReturnValue(options.investigationSupported ?? true),
        execute:
          options.investigationError === undefined
            ? jest.fn().mockResolvedValue(investigationObservationPayload)
            : jest.fn().mockRejectedValue(options.investigationError),
      }
    : undefined;
  if (investigationRecording) {
    Object.assign(dependencies, {
      investigationRecording,
      investigationInvocations: {
        prepare: jest
          .fn()
          .mockImplementation(async ({ workSlot, attemptOrdinal }) => {
            if (options.investigationPrepareError !== undefined) {
              throw options.investigationPrepareError;
            }
            const authoritative = await dependencies.invocations.prepare({
              workSlot,
              attemptOrdinal,
            });
            return {
              ...authoritative,
              manifestFacts: Object.freeze({
                ...authoritative.manifestFacts,
                executionProfile: 'investigation_gateway_v1' as const,
                providerCapabilityHash: hash('investigation-capability'),
                providerRequestEnvelopeHash: hash('investigation-request'),
              }),
            };
          }),
        execute: jest.fn(),
      },
    });
  }
  return {
    controlPlane,
    command,
    dependencies,
    investigationRecording,
    useCase: new RunT0ReviewOrchestration(dependencies),
  };
}

function orchestrationDeadline(
  deadlineEpochMs: number,
  now: () => number
): ExecutionDeadline {
  return new ExecutionDeadline(
    deadlineEpochMs,
    {
      completionReserveMs: 120_000,
      minimumBatchStartWindowMs: 30_000,
      minimumOptionalRetryStartWindowMs: 30_000,
    },
    { now }
  );
}

const authorization: ReviewRunAuthorization = {
  authorizationId: 'authorization-1',
  authorizationToken: 'authorization.token',
  producerReleaseId: 'release-1',
  protocolLimitsProfileId: 'limits-1',
  operationalSloProfileId: 'slo-1',
  mutationEpoch: '1',
  expiresAt: '2026-07-22T13:00:00.000Z',
  limits: {
    maxWorkSlots: 10,
    maxAttemptsPerSlot: 3,
    maxObservationBytes: 100_000,
    maxObservationFindings: 100,
    maxProjectionBytes: 200_000,
    maxProjectionFindings: 100,
    maxPublicationOperations: 100,
    maxPublicationChunks: 20,
    maxPublicationBodyBytes: 200_000,
    maxRequestBatchSize: 20,
    maxLeaseDurationMs: 60_000,
    maxResultReportDurationMs: 60_000,
    maxReconciliationDurationMs: 60_000,
  },
  facts: {
    workspaceId: 'workspace-1',
    repositoryConnectionId: 'connection-1',
    scmRepositoryIdentityId: 'repository-1',
    pullRequestNumber: 252,
    sourceRunId: 'run-1',
    sourceRunAttempt: '1',
    baseSha: '1'.repeat(40),
    mergeBaseSha: '2'.repeat(40),
    headSha: '3'.repeat(40),
    reviewRevisionHash: hash('revision'),
    trustDomain: 'github-actions',
    producerReleaseId: 'release-1',
    selectedProtocolVersion: 'review-action-v2',
    schemaDigest: hash('schema-digest'),
    providerVoteLanes: [
      {
        providerKind: ReviewExecutionProviderKind.Codex,
        providerVoteIdentityHash: hash('vote'),
      },
    ],
  },
};

function renewedAuthorization(
  current: ReviewRunAuthorization,
  validForMsAtResponse: number
) {
  return {
    authorization: {
      ...current,
      authorizationToken: 'authorization.renewed-token',
      expiresAt: new Date(
        Date.parse('2026-07-22T12:00:00.000Z') + validForMsAtResponse
      ).toISOString(),
    },
    validForMsAtResponse,
  };
}

const lease = {
  leaseId: 'lease-1',
  attemptId: 'attempt-1',
  leaseCapability: 'lease.capability',
  fencingToken: '1',
  expiresAt: '2026-07-22T12:10:00.000Z',
  resultReportUntil: '2026-07-22T12:20:00.000Z',
  renewalCeilingReached: false,
};

const sameExecutionAttachment = {
  kind: 'same_execution' as const,
  sourceLeaseId: lease.leaseId,
  sourceFencingToken: lease.fencingToken,
  sourceOwnerIdHash: hash('owner'),
};

const observationPayload = {
  payloadCanonicalJson: '{"findings":[]}',
  payloadHash: hash('{"findings":[]}'),
  byteCount: 15,
  findingCount: 0,
  actualModel: 'gpt-test',
  qualityFlags: [] as readonly string[],
  transportAttemptCount: 1,
  schemaValidated: true,
  fullyConsumed: true,
};

const attestedObservationPayload = {
  ...observationPayload,
  contextDependencyAttestationId: 'attestation-1',
  contextDependencyAttestationHash: hash('attestation-1'),
};

const investigationObservationPayload = {
  ...observationPayload,
  qualityFlags: ['investigation_verified_clean'] as readonly string[],
  investigationCertificateId: 'certificate-1',
  investigationCertificateHash: hash('certificate-1'),
};

const acceptedObservation = {
  ...observationPayload,
  observationId: 'observation-1',
  eligibilityPolicyVersion: 't0-v1',
  providerKind: ReviewExecutionProviderKind.Codex,
  providerInvocationKey: hash('invocation-1'),
  providerVoteIdentityHash: hash('vote'),
};

const projection = {
  artifactId: 'artifact-1',
  artifactHash: hash('artifact'),
  projectionEnvelopeVersion: 1,
  projectionEnvelopeCanonicalJson: '{"findings":[]}',
  projectionHash: hash('projection'),
  lifecycleStateHash: hash('lifecycle'),
  commandLedgerWatermark: '1',
  operationsCanonicalJson: '[]',
  findingCount: 0,
  publicationOperationCount: 0,
  publicationChunkCount: 0,
  coverageComplete: true,
  mergeGateConclusion: MergeGateConclusion.Pass,
};

function coverageManifest(workSlotId: string) {
  return createReviewPromptCoverageManifest({
    workSlotId,
    reviewRevisionHash: hash('revision'),
    assignedPaths: ['src/a.ts'],
    pathCoverage: [
      {
        path: 'src/a.ts',
        kind: ReviewPromptPathCoverageKind.FullPatch,
        contentHash: hash('patch'),
      },
    ],
  });
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function revisionOf(command: RunT0ReviewOrchestrationCommand) {
  return {
    baseSha: command.baseSha,
    mergeBaseSha: command.mergeBaseSha,
    headSha: command.headSha,
    reviewRevisionHash: command.reviewRevisionHash,
    pullRequestState: 'open' as const,
  };
}

function restoredAdmission(
  command: RunT0ReviewOrchestrationCommand,
  slot: {
    readonly state: RestoredReviewWorkSlotState;
    readonly acceptedObservationRefId: string | null;
  }
) {
  return {
    executionId: command.executionId,
    generation: '1',
    streamVersion: '1',
    executionVersion: '1',
    restoredExecution: {
      executionId: command.executionId,
      version: '1',
      streamVersion: '1',
      generation: '1',
      state: RestoredReviewExecutionState.Running,
      authorizationId: authorization.authorizationId,
      reviewRevisionHash: command.reviewRevisionHash,
      planHash: command.planHash,
      workSlots: command.workSlots.map((workSlot) => ({
        workSlotId: workSlot.workSlotId,
        state: slot.state,
        required: workSlot.required,
        providerVoteIdentityHash: workSlot.providerVoteIdentityHash,
        activeLeaseId: null as string | null,
        acceptedObservationRefId: slot.acceptedObservationRefId,
      })),
    },
  };
}

function unattachedAcceptedFixture(withFallback = false) {
  const fixture = createFixture({ workSlotCount: withFallback ? 2 : 1 });
  const workSlots = fixture.command.workSlots.map((slot, index) => ({
    ...slot,
    providerVoteIdentityHash:
      index === 0 ? hash('vote') : hash('fallback-vote'),
  }));
  const originalCommand = {
    ...fixture.command,
    workSlots,
    workSlotsCanonicalJson: canonicalizeReviewWorkSlots(workSlots),
  };
  const workSlot = workSlots[0]!;
  const hint = {
    workSlotId: workSlot.workSlotId,
    manifestCanonicalJson: '{"fixture":true}',
    manifestKey: hash('{"fixture":true}'),
    providerInvocationKey: acceptedObservation.providerInvocationKey,
    providerVoteIdentityHash: workSlot.providerVoteIdentityHash,
    observationId: acceptedObservation.observationId,
    payloadHash: acceptedObservation.payloadHash,
    sourceLeaseId: sameExecutionAttachment.sourceLeaseId,
    sourceFencingToken: sameExecutionAttachment.sourceFencingToken,
    sourceOwnerIdHash: sameExecutionAttachment.sourceOwnerIdHash,
  };
  const restored: RestoredReviewExecution = {
    ...restoredAdmission(originalCommand, {
      state: RestoredReviewWorkSlotState.Exhausted,
      acceptedObservationRefId: null,
    }).restoredExecution,
    workSlots: originalCommand.workSlots.map((slot, index) => ({
      workSlotId: slot.workSlotId,
      state:
        index === 0
          ? RestoredReviewWorkSlotState.Exhausted
          : RestoredReviewWorkSlotState.Pending,
      required: slot.required,
      providerVoteIdentityHash: slot.providerVoteIdentityHash,
      activeLeaseId: null,
      acceptedObservationRefId: null,
    })),
    persistedPlan: {
      planHash: originalCommand.planHash,
      assignmentManifestVersion: 1,
      assignmentManifestHash: originalCommand.assignmentManifestHash ?? null,
      assignmentManifestCanonicalJson:
        originalCommand.assignmentManifestCanonicalJson ?? null,
      workSlots: workSlots.map((slot, index) => ({
        ...slot,
        nextAttemptOrdinal: index === 0 ? 2 : 1,
      })),
      acceptedManifests: [],
      unattachedAcceptedManifests: [hint],
      artifact: null,
    },
  };
  let current = restored;
  fixture.controlPlane.restoreExecution
    .mockReset()
    .mockImplementation(async () => current);
  const hit = {
    kind: ReviewEvidenceLookupKind.Hit,
    observation: acceptedObservation,
    attachment: sameExecutionAttachment,
  } satisfies Awaited<
    ReturnType<ReviewActionV2ControlPlanePort['lookupEvidence']>
  >;
  fixture.controlPlane.lookupEvidence.mockResolvedValue(hit);
  jest
    .mocked(fixture.dependencies.invocationManifestAssembler.assemble)
    .mockResolvedValue(hint);
  fixture.controlPlane.adoptObservation.mockImplementation(async () => {
    current = {
      ...current,
      version: '2',
      streamVersion: '2',
      workSlots: current.workSlots.map((slot) =>
        slot.workSlotId === hint.workSlotId
          ? {
              ...slot,
              state: RestoredReviewWorkSlotState.Satisfied,
              acceptedObservationRefId: observationRef(
                current.executionId,
                slot.workSlotId,
                hint.observationId
              ),
            }
          : slot
      ),
      persistedPlan: {
        ...current.persistedPlan!,
        acceptedManifests: [hint],
        unattachedAcceptedManifests: [],
      },
    };
    return { streamVersion: current.streamVersion };
  });
  let now = 0;
  const deadline = orchestrationDeadline(100_000, () => now);
  Object.assign(fixture.dependencies, { executionDeadline: deadline });
  if (withFallback) {
    Object.assign(fixture.dependencies, {
      reviewerScheduling: {
        providerMode: 'fallback',
        maxParallelReviewers: 1,
        reviewers: workSlots.map((slot, index) => ({
          reviewerId: index === 0 ? 'original' : 'fallback',
          providerVoteIdentityHash: slot.providerVoteIdentityHash,
          concurrencyGroupId: index === 0 ? 'original' : 'fallback',
        })),
        concurrencyGroups: [
          { id: 'original', maxParallel: 1 },
          { id: 'fallback', maxParallel: 1 },
        ],
      },
    });
    // A fallback would have enough time for a real paid attempt if reached.
    Object.assign(fixture.dependencies, {
      executionDeadline: orchestrationDeadline(500_000, () => now),
    });
  }
  return {
    ...fixture,
    command: {
      ...originalCommand,
      restoredExecution: restored,
      restoreOnly: true,
    },
    restored,
    hint,
    hit,
    deadline,
    expire: () => {
      now = 500_000;
    },
    current: () => current,
    setCurrent: (value: RestoredReviewExecution) => {
      current = value;
    },
  };
}

function exhaustedExecution(command: RunT0ReviewOrchestrationCommand) {
  const restored = restoredAdmission(command, {
    state: RestoredReviewWorkSlotState.Exhausted,
    acceptedObservationRefId: null,
  }).restoredExecution;
  return {
    ...restored,
    version: '2',
    streamVersion: '2',
  };
}

function observationRef(
  executionId: string,
  workSlotId: string,
  observationId: string
): string {
  return `obsref:${hash(
    canonicalJson({ executionId, observationId, workSlotId })
  )}`;
}

function canonicalJson(value: unknown): string {
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

describe('exact reviewer concurrency in the parent orchestration', () => {
  it('overlaps two reviewers while keeping each reviewer batch stream serial and finalizing once', async () => {
    const fixture = concurrentFixture(
      ['a', 'a', 'b', 'b'],
      { a: 'shared', b: 'shared' },
      { shared: 2 },
      2
    );
    const gates = new Map(
      fixture.command.workSlots.map((slot) => [
        slot.workSlotId,
        deferred<void>(),
      ])
    );
    const started = new Map(
      fixture.command.workSlots.map((slot) => [
        slot.workSlotId,
        deferred<void>(),
      ])
    );
    const active = new Map<string, number>();
    let maximum = 0;
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockImplementation(async ({ invocation }) => {
        const vote = fixture.command.workSlots.find(
          (slot) => slot.workSlotId === invocation.workSlotId
        )!.providerVoteIdentityHash;
        expect(active.get(vote) ?? 0).toBe(0);
        active.set(vote, 1);
        maximum = Math.max(maximum, active.size);
        started.get(invocation.workSlotId)!.resolve();
        await gates.get(invocation.workSlotId)!.promise;
        active.delete(vote);
        return observationPayload;
      });
    const running = fixture.useCase.execute(fixture.command);
    await Promise.all([
      started.get('slot-1')!.promise,
      started.get('slot-3')!.promise,
    ]);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(2);
    gates.get('slot-3')!.resolve();
    await started.get('slot-4')!.promise;
    gates.get('slot-4')!.resolve();
    gates.get('slot-1')!.resolve();
    await started.get('slot-2')!.promise;
    gates.get('slot-2')!.resolve();
    const result = await running;
    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(maximum).toBe(2);
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.requestPublication).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.attachObservation).toHaveBeenCalledTimes(4);
    expect(fixture.lastFinalizedVersion()).toBe(fixture.currentVersion());
  });

  it('queues a concurrency-one sibling beyond the transport wait budget and admits an independent ready group', async () => {
    const fixture = concurrentFixture(
      ['a', 'b', 'c'],
      { a: 'shared', b: 'shared', c: 'independent' },
      { shared: 1, independent: 1 },
      2
    );
    const gates = ['slot-1', 'slot-2', 'slot-3'].map(() => deferred<void>());
    const started = ['slot-1', 'slot-2', 'slot-3'].map(() => deferred<void>());
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockImplementation(async ({ invocation }) => {
        const index = Number(invocation.workSlotId.slice(5)) - 1;
        started[index].resolve();
        await gates[index].promise;
        return observationPayload;
      });
    const running = fixture.useCase.execute(fixture.command);
    await Promise.all([started[0].promise, started[2].promise]);
    jest
      .mocked(fixture.dependencies.clock.monotonicNowMs)
      .mockReturnValue(180_001);
    expect(
      jest
        .mocked(fixture.dependencies.invocations.execute)
        .mock.calls.map(([request]) => request.invocation.workSlotId)
    ).toEqual(['slot-1', 'slot-3']);
    gates[2].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(2);
    gates[0].resolve();
    await started[1].promise;
    gates[1].resolve();
    expect((await running).status).toBe(
      ReviewOrchestrationResultStatus.Completed
    );
  });

  it('stops and drains an exhausted allocation while another allocation completes its batches', async () => {
    const fixture = concurrentFixture(
      ['a', 'a', 'b', 'c', 'c'],
      { a: 'shared', b: 'shared', c: 'independent' },
      { shared: 2, independent: 1 },
      3
    );
    const started = deferred<void>();
    const fail = deferred<void>();
    const finish = deferred<void>();
    let active = 0;
    let drained = false;
    Object.assign(fixture.dependencies.invocationFailureClassifier, {
      classify: jest.fn(() => ReviewInvocationFailureClass.AdmissionLimited),
      scope: jest.fn((_error, context) =>
        context.workSlot.providerVoteIdentityHash === hash('vote-a')
          ? 'allocation'
          : 'reviewer'
      ),
    });
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockImplementation(async ({ invocation, signal }) => {
        active += 1;
        if (active === 3) started.resolve();
        if (invocation.workSlotId === 'slot-1') {
          await fail.promise;
          active -= 1;
          throw new Error('budget_exhausted');
        }
        if (invocation.workSlotId === 'slot-3')
          return new Promise<never>((_resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => {
                active -= 1;
                drained = true;
                reject(signal.reason);
              },
              { once: true }
            )
          );
        await finish.promise;
        active -= 1;
        return observationPayload;
      });
    const running = fixture.useCase.execute({
      ...fixture.command,
      allowPartial: true,
    });
    await started.promise;
    fail.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(true);
    finish.resolve();
    const result = await running;
    expect(result.status).toBe(
      ReviewOrchestrationResultStatus.PartialCompleted
    );
    expect(active).toBe(0);
    expect(
      jest
        .mocked(fixture.dependencies.invocations.execute)
        .mock.calls.map(([request]) => request.invocation.workSlotId)
    ).not.toContain('slot-2');
    expect(fixture.dependencies.projectionBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({
        exhaustedWorkSlotIds: expect.arrayContaining([
          'slot-1',
          'slot-2',
          'slot-3',
        ]),
      })
    );
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2])(
    'does not retry or reconcile an aborted allocation sibling with attempt budget %i',
    async (maxAttempts) => {
      const fixture = concurrentFixture(
        ['a', 'b', 'c'],
        { a: 'shared', b: 'shared', c: 'independent' },
        { shared: 2, independent: 1 },
        3,
        new Set(),
        maxAttempts
      );
      const started = deferred<void>();
      const fail = deferred<void>();
      let count = 0;
      Object.assign(fixture.dependencies, {
        invocationFailureClassifier: new ProviderInvocationFailureClassifier(
          (context) =>
            context?.reviewerId === 'a'
              ? {
                  code: 'admission_limited',
                  effect: 'not_dispatched',
                  failureScope: 'allocation',
                  concurrencyGroupId: 'shared',
                }
              : undefined
        ),
      });
      jest
        .mocked(fixture.dependencies.invocations.execute)
        .mockImplementation(async ({ invocation, signal }) => {
          if (++count === 3) started.resolve();
          if (invocation.workSlotId === 'slot-1') {
            await fail.promise;
            throw new Error('budget_exhausted');
          }
          if (invocation.workSlotId === 'slot-2')
            return new Promise<never>((_resolve, reject) => {
              // The Codex process returns its own AbortError, not signal.reason.
              const abort = () =>
                reject(
                  Object.assign(new Error('Codex CLI aborted'), {
                    name: 'AbortError',
                  })
                );
              if (signal.aborted) abort();
              else signal.addEventListener('abort', abort, { once: true });
            });
          return observationPayload;
        });
      const running = fixture.useCase.execute(fixture.command);
      await started.promise;
      fail.resolve();
      const result = await running;

      expect(result.status).toBe(
        ReviewOrchestrationResultStatus.PartialCompleted
      );
      expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
        3
      );
      expect(
        jest
          .mocked(fixture.dependencies.invocations.prepare)
          .mock.calls.filter(
            ([request]) => request.workSlot.workSlotId === 'slot-2'
          )
      ).toHaveLength(1);
      expect(
        jest
          .mocked(fixture.dependencies.delay.sleep)
          .mock.calls.some(([delayMs]) => delayMs === 30_000)
      ).toBe(false);
      expect(
        fixture.controlPlane.releaseInvocationLease.mock.calls.filter(
          ([request]) => request.lease.leaseId === 'lease-slot-2'
        )
      ).toHaveLength(1);
      expect(fixture.controlPlane.attachObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          workSlot: expect.objectContaining({ workSlotId: 'slot-3' }),
        })
      );
      expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['admission', 'retry'] as const)(
    'stops an allocation sibling during its %s delay without acquiring again',
    async (phase) => {
      const fixture = concurrentFixture(
        ['a', 'b', 'c'],
        { a: 'shared', b: 'shared', c: 'independent' },
        { shared: 2, independent: 1 },
        3,
        new Set(),
        2
      );
      const waiting = deferred<void>();
      const resumeWait = deferred<void>();
      const stopped = deferred<void>();
      const fail = deferred<void>();
      const progress: NonNullable<
        RunT0ReviewOrchestrationDependencies['progress']
      > = {
        report(event) {
          if (event.type === 'exhausted' && event.workSlotId === 'slot-1')
            stopped.resolve();
        },
      };
      let waitSignal: AbortSignal | undefined;
      const acquire =
        fixture.controlPlane.acquireInvocationLease.getMockImplementation()!;
      let siblingAcquisitions = 0;
      fixture.controlPlane.acquireInvocationLease.mockImplementation(
        async (request) => {
          if (
            phase === 'admission' &&
            request.workSlot.workSlotId === 'slot-2' &&
            ++siblingAcquisitions === 1
          )
            return { status: ReviewInvocationLeaseAcquireOutcomeStatus.Busy };
          return acquire(request);
        }
      );
      const sleep = jest
        .mocked(fixture.dependencies.delay.sleep)
        .getMockImplementation()!;
      jest
        .mocked(fixture.dependencies.delay.sleep)
        .mockImplementation(async (delayMs, signal) => {
          if (delayMs !== (phase === 'admission' ? 500 : 30_000))
            return sleep(delayMs, signal);
          waitSignal = signal;
          waiting.resolve();
          await new Promise<void>((resolve) => {
            const finish = () => {
              signal?.removeEventListener('abort', finish);
              resolve();
            };
            void resumeWait.promise.then(finish);
            if (signal?.aborted) finish();
            else signal?.addEventListener('abort', finish, { once: true });
          });
        });
      Object.assign(fixture.dependencies, {
        progress,
        invocationFailureClassifier: new ProviderInvocationFailureClassifier(
          (context) =>
            context?.reviewerId === 'a'
              ? {
                  code: 'admission_limited',
                  effect: 'not_dispatched',
                  failureScope: 'allocation',
                  concurrencyGroupId: 'shared',
                }
              : undefined
        ),
      });
      jest
        .mocked(fixture.dependencies.invocations.execute)
        .mockImplementation(async ({ invocation }) => {
          if (invocation.workSlotId === 'slot-1') {
            await fail.promise;
            throw new Error('budget_exhausted');
          }
          if (invocation.workSlotId === 'slot-2')
            throw new Error('temporary_provider_failure');
          return observationPayload;
        });
      const running = fixture.useCase.execute(fixture.command);
      await waiting.promise;
      fail.resolve();
      await stopped.promise;
      const cancelledDuringWait = waitSignal?.aborted;
      resumeWait.resolve();
      const result = await running;

      expect(cancelledDuringWait).toBe(true);
      expect(result.status).toBe(
        ReviewOrchestrationResultStatus.PartialCompleted
      );
      expect(
        fixture.controlPlane.acquireInvocationLease.mock.calls.filter(
          ([request]) => request.workSlot.workSlotId === 'slot-2'
        )
      ).toHaveLength(1);
      expect(
        jest
          .mocked(fixture.dependencies.invocations.execute)
          .mock.calls.filter(
            ([request]) => request.invocation.workSlotId === 'slot-2'
          )
      ).toHaveLength(phase === 'admission' ? 0 : 1);
      expect(fixture.controlPlane.attachObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          workSlot: expect.objectContaining({ workSlotId: 'slot-3' }),
        })
      );
    }
  );

  it('cancels queued admission and releases a lease acquired while cancellation was in flight', async () => {
    const fixture = concurrentFixture(
      ['a', 'b'],
      { a: 'a', b: 'b' },
      { a: 1, b: 1 },
      2
    );
    const abort = new AbortController();
    Object.assign(fixture.dependencies, { signal: abort.signal });
    const requested = deferred<void>();
    const respond = deferred<void>();
    const acquire =
      fixture.controlPlane.acquireInvocationLease.getMockImplementation()!;
    fixture.controlPlane.acquireInvocationLease.mockImplementation(
      async (request) => {
        if (request.workSlot.workSlotId === 'slot-1') {
          requested.resolve();
          await respond.promise;
        }
        return acquire(request);
      }
    );
    const running = fixture.useCase.execute(fixture.command);
    await requested.promise;
    // The second lane reaches the parent command queue while the first is in flight.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const abortReason = new Error('run_cancelled');
    abort.abort(abortReason);
    respond.resolve();
    await expect(running).rejects.toBe(abortReason);

    expect(fixture.controlPlane.acquireInvocationLease).toHaveBeenCalledTimes(
      1
    );
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      1
    );
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: expect.objectContaining({ leaseId: 'lease-slot-1' }),
      })
    );
    expect(fixture.dependencies.invocations.execute).not.toHaveBeenCalled();
    expect(fixture.controlPlane.finalizeExecution).not.toHaveBeenCalled();
  });

  it('settles an optional reviewer failure without failing a healthy required reviewer', async () => {
    const fixture = concurrentFixture(
      ['a', 'b'],
      { a: 'a', b: 'b' },
      { a: 1, b: 1 },
      2,
      new Set(['a'])
    );
    Object.assign(fixture.dependencies.invocationFailureClassifier, {
      classify: jest.fn(
        () => ReviewInvocationFailureClass.AuthenticationUnavailable
      ),
      scope: jest.fn(() => 'reviewer'),
    });
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockImplementation(async ({ invocation }) => {
        if (invocation.workSlotId === 'slot-1')
          throw new Error('account_unavailable');
        return observationPayload;
      });
    const result = await fixture.useCase.execute({
      ...fixture.command,
      allowPartial: true,
    });
    expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledWith(
      expect.objectContaining({ allowPartial: false })
    );
    expect(
      fixture.dependencies.invocationFailureClassifier.classify
    ).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        reviewerId: 'a',
        concurrencyGroupId: 'a',
        workSlot: fixture.command.workSlots[0],
        invocation: expect.objectContaining({ workSlotId: 'slot-1' }),
      })
    );
  });

  const quota = {
    provider: 'openrouter' as const,
    limit: 1000,
    remaining: 0 as const,
    resetAt: '2026-11-18T00:00:00.000Z',
  };
  // The server decides the finalized coverage from its own facts.
  const finalizeAs = (
    fixture: ReturnType<typeof concurrentFixture>,
    state: RestoredReviewExecutionState
  ) => {
    const restore =
      fixture.controlPlane.restoreExecution.getMockImplementation()!;
    fixture.controlPlane.restoreExecution.mockImplementation(
      async (request) => {
        const restored = await restore(request);
        return fixture.controlPlane.finalizeExecution.mock.calls.length
          ? { ...restored!, state }
          : restored;
      }
    );
  };
  it.each([
    [
      'skips a required reviewer stopped by confirmed quota',
      ReviewInvocationFailureClass.CapacityUnavailable,
      quota,
      ['slot-1'],
      ReviewOrchestrationResultStatus.Completed,
    ],
    [
      'keeps coverage partial for unconfirmed capacity pressure',
      ReviewInvocationFailureClass.CapacityUnavailable,
      undefined,
      ['slot-1'],
      ReviewOrchestrationResultStatus.PartialCompleted,
    ],
    [
      'keeps coverage partial for an authentication failure',
      ReviewInvocationFailureClass.AuthenticationUnavailable,
      quota,
      ['slot-1'],
      ReviewOrchestrationResultStatus.PartialCompleted,
    ],
    [
      'keeps coverage partial when every reviewer ran out of quota',
      ReviewInvocationFailureClass.CapacityUnavailable,
      quota,
      ['slot-1', 'slot-2'],
      ReviewOrchestrationResultStatus.PartialCompleted,
    ],
  ])('%s', async (_case, failureClass, providerQuota, failing, expected) => {
    const fixture = concurrentFixture(
      ['a', 'b'],
      { a: 'a', b: 'b' },
      { a: 1, b: 1 },
      2
    );
    Object.assign(fixture.dependencies.invocationFailureClassifier, {
      classify: jest.fn(() => failureClass),
      scope: jest.fn(() => 'allocation'),
      providerQuota: jest.fn(() => providerQuota),
    });
    finalizeAs(fixture, RestoredReviewExecutionState.Completed);
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockImplementation(async ({ invocation }) => {
        if (failing.includes(invocation.workSlotId))
          throw new Error('provider_quota_exhausted');
        return observationPayload;
      });
    const result = await fixture.useCase.execute({
      ...fixture.command,
      allowPartial: true,
    });
    const skipped = expected === ReviewOrchestrationResultStatus.Completed;
    expect(result.status).toBe(expected);
    // Open required slots always permit a partial server decision.
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledWith(
      expect.objectContaining({ allowPartial: true })
    );
    expect(
      jest.mocked(fixture.dependencies.projectionBuilder.build).mock.calls[0][0]
        .providerQuotaSkippedVotes
    ).toEqual(skipped ? new Map([[hash('vote-a'), quota]]) : undefined);
    // The server excuses only terminal slots of the skipped reviewer.
    expect(
      fixture.controlPlane.terminalizeWorkSlot.mock.calls.map(([request]) => [
        request.workSlotId,
        request.terminal,
      ])
    ).toEqual(
      skipped
        ? [
            [
              'slot-1',
              {
                terminalState: 'exhausted',
                reasonCode: 'attempt_budget_exhausted',
              },
            ],
          ]
        : []
    );
  });

  it('keeps an earlier non-quota gap when the same reviewer later runs out of quota', async () => {
    const fixture = concurrentFixture(
      ['a', 'a', 'b'],
      { a: 'a', b: 'b' },
      { a: 1, b: 1 },
      2
    );
    Object.assign(fixture.dependencies.invocationFailureClassifier, {
      classify: jest.fn(() => ReviewInvocationFailureClass.CapacityUnavailable),
      scope: jest.fn(() => 'allocation'),
      providerQuota: jest.fn(() => quota),
    });
    finalizeAs(fixture, RestoredReviewExecutionState.Completed);
    // slot-1 of reviewer a already ended without evidence in an earlier attempt.
    const start = fixture.controlPlane.startExecution.getMockImplementation()!;
    fixture.controlPlane.startExecution.mockImplementation(async (request) => {
      const started = await start(request);
      return {
        ...started,
        restoredExecution: {
          ...started.restoredExecution,
          workSlots: started.restoredExecution.workSlots.map((slot) =>
            slot.workSlotId === 'slot-1'
              ? { ...slot, state: RestoredReviewWorkSlotState.Exhausted }
              : slot
          ),
        },
      };
    });
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockImplementation(async ({ invocation }) => {
        if (invocation.workSlotId === 'slot-2')
          throw new Error('provider_quota_exhausted');
        return observationPayload;
      });
    const result = await fixture.useCase.execute({
      ...fixture.command,
      allowPartial: true,
    });
    expect(result.status).toBe(
      ReviewOrchestrationResultStatus.PartialCompleted
    );
    expect(
      jest.mocked(fixture.dependencies.projectionBuilder.build).mock.calls[0][0]
        .providerQuotaSkippedVotes
    ).toBeUndefined();
  });

  it('reports partial coverage when the server does not accept the skip', async () => {
    const fixture = concurrentFixture(
      ['a', 'b'],
      { a: 'a', b: 'b' },
      { a: 1, b: 1 },
      2
    );
    Object.assign(fixture.dependencies.invocationFailureClassifier, {
      classify: jest.fn(() => ReviewInvocationFailureClass.CapacityUnavailable),
      scope: jest.fn(() => 'allocation'),
      providerQuota: jest.fn(() => quota),
    });
    finalizeAs(fixture, RestoredReviewExecutionState.Partial);
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockImplementation(async ({ invocation }) => {
        if (invocation.workSlotId === 'slot-1')
          throw new Error('provider_quota_exhausted');
        return observationPayload;
      });
    const result = await fixture.useCase.execute({
      ...fixture.command,
      allowPartial: true,
    });
    expect(result.status).toBe(
      ReviewOrchestrationResultStatus.PartialCompleted
    );
    expect(result.failureCode).toBe('required_review_coverage_incomplete');
  });

  it('keeps coverage partial when the skipped reviewer cannot be closed on the server', async () => {
    const fixture = concurrentFixture(
      ['a', 'b'],
      { a: 'a', b: 'b' },
      { a: 1, b: 1 },
      2
    );
    Object.assign(fixture.dependencies.invocationFailureClassifier, {
      classify: jest.fn(() => ReviewInvocationFailureClass.CapacityUnavailable),
      scope: jest.fn(() => 'allocation'),
      providerQuota: jest.fn(() => quota),
    });
    fixture.controlPlane.terminalizeWorkSlot.mockRejectedValue(
      new Error('review_action_v2_conflict')
    );
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockImplementation(async ({ invocation }) => {
        if (invocation.workSlotId === 'slot-1')
          throw new Error('provider_quota_exhausted');
        return observationPayload;
      });
    const result = await fixture.useCase.execute({
      ...fixture.command,
      allowPartial: true,
    });
    expect(result.status).toBe(
      ReviewOrchestrationResultStatus.PartialCompleted
    );
    expect(
      jest.mocked(fixture.dependencies.projectionBuilder.build).mock.calls[0][0]
        .providerQuotaSkippedVotes
    ).toBeUndefined();
  });

  describe('ordered fallback', () => {
    // Three reviewers on their own allocations, run one at a time in order.
    const fallbackFixture = (
      groups: Readonly<Record<string, string>> = { a: 'a', b: 'b', c: 'c' }
    ) => {
      const fixture = concurrentFixture(
        ['a', 'b', 'c'],
        groups,
        Object.fromEntries(Object.values(groups).map((group) => [group, 1])),
        1
      );
      Object.assign(fixture.dependencies, {
        reviewerScheduling: {
          ...fixture.dependencies.reviewerScheduling!,
          providerMode: 'fallback',
        },
      });
      finalizeAs(fixture, RestoredReviewExecutionState.Completed);
      return fixture;
    };
    const failing = (
      fixture: ReturnType<typeof concurrentFixture>,
      slots: readonly string[],
      failureClass: ReviewInvocationFailureClass,
      scope: 'reviewer' | 'allocation' = 'reviewer'
    ) => {
      Object.assign(fixture.dependencies.invocationFailureClassifier, {
        classify: jest.fn(() => failureClass),
        scope: jest.fn(() => scope),
      });
      jest
        .mocked(fixture.dependencies.invocations.execute)
        .mockImplementation(async ({ invocation }) => {
          if (slots.includes(invocation.workSlotId))
            throw new Error('reviewer_unavailable');
          return observationPayload;
        });
    };
    const executed = (fixture: ReturnType<typeof concurrentFixture>) =>
      jest
        .mocked(fixture.dependencies.invocations.execute)
        .mock.calls.map(([request]) => request.invocation.workSlotId);
    const fallbackReviewers = (fixture: ReturnType<typeof concurrentFixture>) =>
      jest.mocked(fixture.dependencies.projectionBuilder.build).mock.calls[0][0]
        .fallbackReviewers;

    it('stops at the first reviewer that finishes', async () => {
      const fixture = fallbackFixture();
      failing(fixture, [], ReviewInvocationFailureClass.CapacityUnavailable);
      const result = await fixture.useCase.execute({
        ...fixture.command,
        allowPartial: true,
      });
      expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
      expect(executed(fixture)).toEqual(['slot-1']);
      expect(fallbackReviewers(fixture)).toEqual({
        failedVotes: new Set(),
        unusedVotes: new Set([hash('vote-b'), hash('vote-c')]),
      });
      // The unused reviewers leave open slots the server decides on.
      expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledWith(
        expect.objectContaining({ allowPartial: true })
      );
    });

    it.each([
      ReviewInvocationFailureClass.CapacityUnavailable,
      ReviewInvocationFailureClass.AuthenticationUnavailable,
      ReviewInvocationFailureClass.ConfigurationMismatch,
    ])('starts the next reviewer after %s', async (failureClass) => {
      const fixture = fallbackFixture();
      failing(fixture, ['slot-1'], failureClass);
      const result = await fixture.useCase.execute({
        ...fixture.command,
        allowPartial: true,
      });
      expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
      expect(executed(fixture)).toEqual(['slot-1', 'slot-2']);
      expect(fallbackReviewers(fixture)).toEqual({
        failedVotes: new Set([hash('vote-a')]),
        unusedVotes: new Set([hash('vote-c')]),
      });
    });

    it('hands over on resume when an earlier attempt exhausted the first reviewer', async () => {
      const fixture = fallbackFixture();
      failing(fixture, [], ReviewInvocationFailureClass.CapacityUnavailable);
      const start =
        fixture.controlPlane.startExecution.getMockImplementation()!;
      fixture.controlPlane.startExecution.mockImplementation(
        async (request) => {
          const started = await start(request);
          return {
            ...started,
            restoredExecution: {
              ...started.restoredExecution,
              workSlots: started.restoredExecution.workSlots.map((slot) =>
                slot.workSlotId === 'slot-1'
                  ? { ...slot, state: RestoredReviewWorkSlotState.Exhausted }
                  : slot
              ),
            },
          };
        }
      );
      const result = await fixture.useCase.execute({
        ...fixture.command,
        allowPartial: true,
      });
      expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
      expect(executed(fixture)).toEqual(['slot-2']);
      expect(fallbackReviewers(fixture)).toEqual({
        failedVotes: new Set([hash('vote-a')]),
        unusedVotes: new Set([hash('vote-c')]),
      });
    });

    it('decides the chain from why each reviewer stopped', () => {
      // Used-up attempts cover timeouts and invalid output (attempt budget 1).
      for (const reason of [
        ReviewInvocationFailureClass.CapacityUnavailable,
        ReviewInvocationFailureClass.AuthenticationUnavailable,
        ReviewInvocationFailureClass.ConfigurationMismatch,
        ReviewWorkSlotExhaustionReason.AttemptBudgetExhausted,
      ])
        expect(fallbackLaneOutcome(false, reason)).toBe(
          FallbackLaneOutcome.Failed
        );
      for (const reason of [
        undefined,
        ReviewInvocationFailureClass.AdmissionLimited,
        ReviewWorkSlotExhaustionReason.InvestigationDeferred,
        ReviewWorkSlotExhaustionReason.DeadlineReached,
        ReviewWorkSlotExhaustionReason.ProviderLaneBusy,
      ])
        expect(fallbackLaneOutcome(false, reason)).toBe(
          FallbackLaneOutcome.Stopped
        );
      expect(fallbackLaneOutcome(true, undefined)).toBe(
        FallbackLaneOutcome.Accepted
      );
      // Optional work never makes a reviewer count as finished.
      expect(
        reviewerCompletedRequiredWork(
          [{ workSlotId: 'lifecycle', required: false }],
          [{ workSlotId: 'lifecycle' }]
        )
      ).toBe(false);
      expect(
        orderedFallbackCoverage(
          new Map([
            ['a', FallbackLaneOutcome.Failed],
            ['b', FallbackLaneOutcome.Stopped],
          ])
        )
      ).toBeUndefined();
    });

    // A provider failure used to leave the reviewer's other work as
    // admission_limited, so the summary blamed the admission policy.
    it('records why a stopped reviewer left its work, not an admission limit', async () => {
      const fixture = concurrentFixture(
        ['a', 'a', 'b'],
        { a: 'a', b: 'b' },
        { a: 1, b: 1 },
        2
      );
      finalizeAs(fixture, RestoredReviewExecutionState.Completed);
      failing(
        fixture,
        ['slot-1'],
        ReviewInvocationFailureClass.CapacityUnavailable
      );
      const result = await fixture.useCase.execute({
        ...fixture.command,
        allowPartial: true,
      });
      expect(result.status).toBe(
        ReviewOrchestrationResultStatus.PartialCompleted
      );
      const reasons = jest.mocked(fixture.dependencies.projectionBuilder.build)
        .mock.calls[0][0].exhaustedWorkSlotReasons;
      expect(reasons?.get('slot-1')).toBe(
        ReviewWorkSlotExhaustionReason.AttemptBudgetExhausted
      );
      expect(reasons?.get('slot-2')).toBe(
        ReviewWorkSlotExhaustionReason.AttemptBudgetExhausted
      );
      for (const [reason, expected] of [
        [
          ReviewInvocationFailureClass.AdmissionLimited,
          ReviewWorkSlotExhaustionReason.AdmissionLimited,
        ],
        [
          ReviewWorkSlotExhaustionReason.InvestigationDeferred,
          ReviewWorkSlotExhaustionReason.InvestigationDeferred,
        ],
        [
          ReviewWorkSlotExhaustionReason.DeadlineReached,
          ReviewWorkSlotExhaustionReason.DeadlineReached,
        ],
        [
          ReviewInvocationFailureClass.AuthenticationUnavailable,
          ReviewWorkSlotExhaustionReason.AttemptBudgetExhausted,
        ],
        [undefined, ReviewWorkSlotExhaustionReason.AttemptBudgetExhausted],
      ] as const)
        expect(stoppedReviewerExhaustion(reason)).toBe(expected);
    });

    it('ends the chain when admission limits the review', async () => {
      const fixture = fallbackFixture();
      failing(
        fixture,
        ['slot-1'],
        ReviewInvocationFailureClass.AdmissionLimited
      );
      const result = await fixture.useCase.execute({
        ...fixture.command,
        allowPartial: true,
      });
      expect(result.status).toBe(
        ReviewOrchestrationResultStatus.PartialCompleted
      );
      expect(executed(fixture)).toEqual(['slot-1']);
      expect(fallbackReviewers(fixture)).toBeUndefined();
    });

    it('stays incomplete when every reviewer fails', async () => {
      const fixture = fallbackFixture();
      failing(
        fixture,
        ['slot-1', 'slot-2', 'slot-3'],
        ReviewInvocationFailureClass.CapacityUnavailable
      );
      const result = await fixture.useCase.execute({
        ...fixture.command,
        allowPartial: true,
      });
      expect(result.status).toBe(
        ReviewOrchestrationResultStatus.PartialCompleted
      );
      expect(executed(fixture)).toEqual(['slot-1', 'slot-2', 'slot-3']);
      expect(fallbackReviewers(fixture)).toBeUndefined();
    });

    it('skips a reviewer on the same exhausted account', async () => {
      const fixture = fallbackFixture({ a: 'shared', b: 'shared', c: 'c' });
      failing(
        fixture,
        ['slot-1'],
        ReviewInvocationFailureClass.CapacityUnavailable,
        'allocation'
      );
      const result = await fixture.useCase.execute({
        ...fixture.command,
        allowPartial: true,
      });
      expect(result.status).toBe(ReviewOrchestrationResultStatus.Completed);
      expect(executed(fixture)).toEqual(['slot-1', 'slot-3']);
      expect(fallbackReviewers(fixture)).toEqual({
        failedVotes: new Set([hash('vote-a'), hash('vote-b')]),
        unusedVotes: new Set(),
      });
      // The parallel quota skip does not apply to a fallback chain.
      expect(fixture.controlPlane.terminalizeWorkSlot).not.toHaveBeenCalled();
    });
  });

  it('aborts every child and waits for settlement before returning a parent authority failure', async () => {
    const fixture = concurrentFixture(
      ['a', 'b'],
      { a: 'a', b: 'b' },
      { a: 1, b: 1 },
      2
    );
    const bothStarted = deferred<void>();
    const fail = deferred<void>();
    let count = 0;
    let drained = false;
    Object.assign(fixture.dependencies.invocationFailureClassifier, {
      classify: jest.fn(
        () => ReviewInvocationFailureClass.AuthenticationUnavailable
      ),
      scope: jest.fn(() => 'run'),
    });
    jest
      .mocked(fixture.dependencies.invocations.execute)
      .mockImplementation(async ({ invocation, signal }) => {
        count += 1;
        if (count === 2) bothStarted.resolve();
        if (invocation.workSlotId === 'slot-1') {
          await fail.promise;
          throw new Error('parent_revoked');
        }
        return new Promise<never>((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              drained = true;
              reject(signal.reason);
            },
            { once: true }
          )
        );
      });
    const running = fixture.useCase.execute(fixture.command);
    await bothStarted.promise;
    fail.resolve();
    const result = await running;
    expect(result.status).toBe(ReviewOrchestrationResultStatus.Failed);
    expect(drained).toBe(true);
    expect(fixture.controlPlane.releaseInvocationLease).toHaveBeenCalledTimes(
      2
    );
    expect(fixture.controlPlane.finalizeExecution).not.toHaveBeenCalled();
  });
});

describe('parallel reviewer evidence ownership', () => {
  it('refreshes mixed reused and fresh evidence against authoritative state after reversed reply timing', async () => {
    const fixture = concurrentFixture(
      ['a', 'b'],
      { a: 'a', b: 'b' },
      { a: 1, b: 1 },
      2
    );
    const freshAttached = deferred<void>();
    const attach =
      fixture.controlPlane.attachObservation.getMockImplementation()!;
    fixture.controlPlane.attachObservation.mockImplementation(
      async (request) => {
        const result = await attach(request);
        if (request.workSlot.workSlotId === 'slot-2') freshAttached.resolve();
        return result;
      }
    );
    fixture.controlPlane.lookupEvidence.mockImplementation(async (request) => {
      if (request.workSlot.workSlotId === 'slot-2')
        return { kind: ReviewEvidenceLookupKind.Miss };
      await freshAttached.promise;
      return {
        kind: ReviewEvidenceLookupKind.Hit,
        observation: {
          ...acceptedObservation,
          providerVoteIdentityHash: request.workSlot.providerVoteIdentityHash,
        },
        attachment: sameExecutionAttachment,
      };
    });
    fixture.controlPlane.adoptObservation.mockImplementation(async (request) =>
      fixture.controlPlane.attachObservation({
        ...request,
        attachmentCapability: 'accepted-reuse',
      })
    );
    expect((await fixture.useCase.execute(fixture.command)).status).toBe(
      ReviewOrchestrationResultStatus.Completed
    );
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.adoptObservation).toHaveBeenCalledTimes(1);
    expect(fixture.controlPlane.finalizeExecution).toHaveBeenCalledTimes(1);
    expect(fixture.lastFinalizedVersion()).toBe(fixture.currentVersion());
  });

  it('does not lend a primary investigation grant to an unauthorized same-kind reviewer', async () => {
    const fixture = concurrentFixture(
      ['a', 'b'],
      { a: 'a', b: 'b' },
      { a: 1, b: 1 },
      2
    );
    const recording = createFixture({
      investigationMode: ReviewInvestigationRecordingMode.Authoritative,
      investigationVerifiedCleanEffectsEnabled: true,
    });
    Object.assign(fixture.dependencies, {
      investigationRecording: recording.investigationRecording,
      investigationInvocations: recording.dependencies.investigationInvocations,
      resolveInvestigationRecording: (slot: ReviewWorkSlotPlan) =>
        slot.providerVoteIdentityHash === hash('vote-a')
          ? recording.investigationRecording
          : undefined,
    });
    expect((await fixture.useCase.execute(fixture.command)).status).toBe(
      ReviewOrchestrationResultStatus.Completed
    );
    expect(recording.investigationRecording!.execute).toHaveBeenCalledTimes(1);
    expect(recording.investigationRecording!.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        workSlot: expect.objectContaining({
          workSlotId: 'slot-1',
          providerVoteIdentityHash: hash('vote-a'),
        }),
      })
    );
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.invocations.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({ workSlotId: 'slot-2' }),
      })
    );
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

function concurrentFixture(
  laneNames: readonly string[],
  groupByLane: Readonly<Record<string, string>>,
  permits: Readonly<Record<string, number>>,
  parallel: number,
  optional = new Set<string>(),
  maxAttempts = 1
) {
  const fixture = createFixture({
    workSlotCount: laneNames.length,
    allowPartial: true,
    maxAttempts,
  });
  const workSlots = fixture.command.workSlots.map((slot, index) => ({
    ...slot,
    providerVoteIdentityHash: hash(`vote-${laneNames[index]}`),
    required: !optional.has(laneNames[index]),
  }));
  const command = {
    ...fixture.command,
    workSlots,
    workSlotsCanonicalJson: canonicalizeReviewWorkSlots(workSlots),
  };
  const lanes = [...new Set(laneNames)].map((name) => ({
    reviewerId: name,
    providerVoteIdentityHash: hash(`vote-${name}`),
    concurrencyGroupId: groupByLane[name],
  }));
  Object.assign(fixture.dependencies, {
    reviewerScheduling: {
      maxParallelReviewers: parallel,
      reviewers: lanes,
      concurrencyGroups: Object.entries(permits).map(([id, maxParallel]) => ({
        id,
        maxParallel,
      })),
    },
  });
  const current = restoredAdmission(command, {
    state: RestoredReviewWorkSlotState.Pending,
    acceptedObservationRefId: null,
  }).restoredExecution;
  let server: typeof current | null = null;
  let finalizedVersion: string | undefined;
  const advance = () => {
    server = {
      ...server!,
      version: String(BigInt(server!.version) + 1n),
      streamVersion: String(BigInt(server!.streamVersion) + 1n),
    };
  };
  fixture.controlPlane.startExecution.mockImplementation(async () => {
    server = structuredClone(current);
    return {
      ...restoredAdmission(command, {
        state: RestoredReviewWorkSlotState.Pending,
        acceptedObservationRefId: null,
      }),
      restoredExecution: structuredClone(server),
    };
  });
  fixture.controlPlane.restoreExecution
    .mockReset()
    .mockImplementation(async () => structuredClone(server));
  fixture.controlPlane.acquireInvocationLease.mockImplementation(
    async ({ workSlot }) => {
      advance();
      return {
        status: ReviewInvocationLeaseAcquireOutcomeStatus.Acquired,
        lease: {
          ...lease,
          leaseId: `lease-${workSlot.workSlotId}`,
          attemptId: `attempt-${workSlot.workSlotId}`,
        },
      };
    }
  );
  fixture.controlPlane.commitEvidence.mockImplementation(async (request) => {
    advance();
    return {
      observationId: `observation-${request.lease.attemptId}`,
      historicalOnly: false,
      eligibilityPolicyVersion: 't0-v1',
    };
  });
  fixture.controlPlane.attachObservation.mockImplementation(async (request) => {
    expect(request.execution.streamVersion).toBe(server!.streamVersion);
    advance();
    return { streamVersion: server!.streamVersion };
  });
  fixture.controlPlane.finalizeExecution.mockImplementation(async (request) => {
    finalizedVersion = request.execution.streamVersion;
    expect(finalizedVersion).toBe(server!.streamVersion);
    return { publicationPermit: 'publication.permit' };
  });
  jest
    .mocked(fixture.dependencies.invocationManifestAssembler.assemble)
    .mockImplementation(async (invocation) => ({
      manifestCanonicalJson: '{"fixture":true}',
      manifestKey: hash(`manifest-${invocation.workSlotId}`),
      providerInvocationKey: hash(`invocation-${invocation.workSlotId}`),
      providerVoteIdentityHash: workSlots.find(
        (slot) => slot.workSlotId === invocation.workSlotId
      )!.providerVoteIdentityHash,
    }));
  jest
    .mocked(fixture.dependencies.leaseSupervisor.run)
    .mockImplementation(async ({ lease: grantedLease, operation }) =>
      operation(new AbortController().signal, () => grantedLease)
    );
  jest
    .mocked(fixture.dependencies.delay.sleep)
    .mockImplementation(async (_ms, signal?: AbortSignal) => {
      if (!signal) return;
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
  return {
    ...fixture,
    command,
    useCase: new RunT0ReviewOrchestration(fixture.dependencies),
    currentVersion: () => server?.streamVersion,
    lastFinalizedVersion: () => finalizedVersion,
  };
}
