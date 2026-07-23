import {
  createReviewOrchestrationState,
  evolveReviewOrchestration,
  ReviewOrchestrationEventType,
  ReviewOrchestrationPhase,
  ReviewWorkSlotProgress,
} from '../../../src/review-orchestration/domain';

describe('review orchestration state', () => {
  it('rejects duplicate work slots and transitions after terminal state', () => {
    expect(() => createReviewOrchestrationState(['slot-1', 'slot-1'])).toThrow(
      'review_orchestration_work_slot_duplicate'
    );
    let state = createReviewOrchestrationState(['slot-1']);
    state = evolveReviewOrchestration(state, {
      type: ReviewOrchestrationEventType.Superseded,
    });
    expect(state.phase).toBe(ReviewOrchestrationPhase.Superseded);
    expect(() =>
      evolveReviewOrchestration(state, {
        type: ReviewOrchestrationEventType.Authorized,
      })
    ).toThrow('review_orchestration_terminal_transition_forbidden');
  });

  it('does not finalize while a slot is still pending', () => {
    const state = startExecutionState();

    expect(() =>
      evolveReviewOrchestration(state, {
        type: ReviewOrchestrationEventType.FinalizationStarted,
      })
    ).toThrow('review_orchestration_work_incomplete');
  });

  it.each([
    [false, ReviewOrchestrationPhase.Completed],
    [true, ReviewOrchestrationPhase.PartialCompleted],
  ])('follows the complete publication path (partial=%s)', (partial, phase) => {
    let state = startExecutionState();
    state = evolveReviewOrchestration(state, {
      type: ReviewOrchestrationEventType.SlotLookupStarted,
      workSlotId: 'slot-1',
    });
    state = evolveReviewOrchestration(state, {
      type: ReviewOrchestrationEventType.SlotSatisfied,
      workSlotId: 'slot-1',
    });
    state = evolveReviewOrchestration(state, {
      type: ReviewOrchestrationEventType.FinalizationStarted,
    });
    state = evolveReviewOrchestration(state, {
      type: ReviewOrchestrationEventType.PublicationRequested,
      partial,
    });
    state = evolveReviewOrchestration(state, {
      type: ReviewOrchestrationEventType.PublicationCompleted,
      partial,
    });

    expect(state.phase).toBe(phase);
    expect(state.slots['slot-1']).toBe(ReviewWorkSlotProgress.Satisfied);
  });

  it('permits a new lookup after a leased attempt fails', () => {
    let state = startExecutionState();
    state = evolveReviewOrchestration(state, {
      type: ReviewOrchestrationEventType.SlotLookupStarted,
      workSlotId: 'slot-1',
    });
    state = evolveReviewOrchestration(state, {
      type: ReviewOrchestrationEventType.SlotLeaseAcquired,
      workSlotId: 'slot-1',
    });
    state = evolveReviewOrchestration(state, {
      type: ReviewOrchestrationEventType.SlotLookupStarted,
      workSlotId: 'slot-1',
    });

    expect(state.phase).toBe(ReviewOrchestrationPhase.RunningWork);
    expect(state.slots['slot-1']).toBe(ReviewWorkSlotProgress.LookingUp);
  });

  it.each([
    ReviewOrchestrationEventType.SlotLeaseAcquired,
    ReviewOrchestrationEventType.SlotSatisfied,
  ] as const)('rejects %s before lookup', (type) => {
    const state = startExecutionState();

    expect(() =>
      evolveReviewOrchestration(state, { type, workSlotId: 'slot-1' })
    ).toThrow('review_orchestration_work_slot_transition_invalid');
  });
});

function startExecutionState() {
  let state = createReviewOrchestrationState(['slot-1']);
  state = evolveReviewOrchestration(state, {
    type: ReviewOrchestrationEventType.Authorized,
  });
  state = evolveReviewOrchestration(state, {
    type: ReviewOrchestrationEventType.RevisionConfirmed,
  });
  return evolveReviewOrchestration(state, {
    type: ReviewOrchestrationEventType.ExecutionStarted,
  });
}
