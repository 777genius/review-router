export enum ReviewOrchestrationPhase {
  AwaitingAuthorization = 'awaiting_authorization',
  Authorized = 'authorized',
  RevisionConfirmed = 'revision_confirmed',
  ExecutionStarted = 'execution_started',
  RunningWork = 'running_work',
  Finalizing = 'finalizing',
  AwaitingPublication = 'awaiting_publication',
  Completed = 'completed',
  PartialCompleted = 'partial_completed',
  Superseded = 'superseded',
  Failed = 'failed',
}

export enum ReviewWorkSlotProgress {
  Pending = 'pending',
  LookingUp = 'looking_up',
  Leased = 'leased',
  Satisfied = 'satisfied',
  Exhausted = 'exhausted',
}

export type ReviewOrchestrationState = {
  readonly phase: ReviewOrchestrationPhase;
  readonly slots: Readonly<Record<string, ReviewWorkSlotProgress>>;
};

export enum ReviewOrchestrationEventType {
  Authorized = 'authorized',
  RevisionConfirmed = 'revision_confirmed',
  ExecutionStarted = 'execution_started',
  SlotLookupStarted = 'slot_lookup_started',
  SlotLeaseAcquired = 'slot_lease_acquired',
  SlotSatisfied = 'slot_satisfied',
  SlotExhausted = 'slot_exhausted',
  FinalizationStarted = 'finalization_started',
  PublicationRequested = 'publication_requested',
  PublicationCompleted = 'publication_completed',
  Superseded = 'superseded',
  Failed = 'failed',
}

export type ReviewOrchestrationEvent =
  | { readonly type: ReviewOrchestrationEventType.Authorized }
  | { readonly type: ReviewOrchestrationEventType.RevisionConfirmed }
  | { readonly type: ReviewOrchestrationEventType.ExecutionStarted }
  | {
      readonly type:
        | ReviewOrchestrationEventType.SlotLookupStarted
        | ReviewOrchestrationEventType.SlotLeaseAcquired
        | ReviewOrchestrationEventType.SlotSatisfied
        | ReviewOrchestrationEventType.SlotExhausted;
      readonly workSlotId: string;
    }
  | {
      readonly type: ReviewOrchestrationEventType.FinalizationStarted;
    }
  | {
      readonly type: ReviewOrchestrationEventType.PublicationRequested;
      readonly partial: boolean;
    }
  | {
      readonly type: ReviewOrchestrationEventType.PublicationCompleted;
      readonly partial: boolean;
    }
  | {
      readonly type:
        | ReviewOrchestrationEventType.Superseded
        | ReviewOrchestrationEventType.Failed;
    };

export function createReviewOrchestrationState(
  workSlotIds: readonly string[]
): ReviewOrchestrationState {
  if (new Set(workSlotIds).size !== workSlotIds.length) {
    throw new Error('review_orchestration_work_slot_duplicate');
  }
  return {
    phase: ReviewOrchestrationPhase.AwaitingAuthorization,
    slots: Object.freeze(
      Object.fromEntries(
        workSlotIds.map((workSlotId) => [
          requireIdentity(workSlotId),
          ReviewWorkSlotProgress.Pending,
        ])
      )
    ),
  };
}

export function evolveReviewOrchestration(
  state: ReviewOrchestrationState,
  event: ReviewOrchestrationEvent
): ReviewOrchestrationState {
  if (isTerminal(state.phase)) {
    throw new Error('review_orchestration_terminal_transition_forbidden');
  }
  switch (event.type) {
    case ReviewOrchestrationEventType.Authorized:
      requirePhase(state, ReviewOrchestrationPhase.AwaitingAuthorization);
      return withPhase(state, ReviewOrchestrationPhase.Authorized);
    case ReviewOrchestrationEventType.RevisionConfirmed:
      requirePhase(state, ReviewOrchestrationPhase.Authorized);
      return withPhase(state, ReviewOrchestrationPhase.RevisionConfirmed);
    case ReviewOrchestrationEventType.ExecutionStarted:
      requirePhase(state, ReviewOrchestrationPhase.RevisionConfirmed);
      return withPhase(state, ReviewOrchestrationPhase.ExecutionStarted);
    case ReviewOrchestrationEventType.SlotLookupStarted:
      requireWorkPhase(state);
      return withSlot(
        state,
        event.workSlotId,
        [
          ReviewWorkSlotProgress.Pending,
          ReviewWorkSlotProgress.LookingUp,
          ReviewWorkSlotProgress.Leased,
        ],
        ReviewWorkSlotProgress.LookingUp,
        ReviewOrchestrationPhase.RunningWork
      );
    case ReviewOrchestrationEventType.SlotLeaseAcquired:
      return withSlot(
        state,
        event.workSlotId,
        [ReviewWorkSlotProgress.LookingUp],
        ReviewWorkSlotProgress.Leased,
        ReviewOrchestrationPhase.RunningWork
      );
    case ReviewOrchestrationEventType.SlotSatisfied:
      return withSlot(
        state,
        event.workSlotId,
        [ReviewWorkSlotProgress.LookingUp, ReviewWorkSlotProgress.Leased],
        ReviewWorkSlotProgress.Satisfied,
        ReviewOrchestrationPhase.RunningWork
      );
    case ReviewOrchestrationEventType.SlotExhausted:
      return withSlot(
        state,
        event.workSlotId,
        [
          ReviewWorkSlotProgress.Pending,
          ReviewWorkSlotProgress.LookingUp,
          ReviewWorkSlotProgress.Leased,
        ],
        ReviewWorkSlotProgress.Exhausted,
        ReviewOrchestrationPhase.RunningWork
      );
    case ReviewOrchestrationEventType.FinalizationStarted:
      if (
        state.phase !== ReviewOrchestrationPhase.ExecutionStarted &&
        state.phase !== ReviewOrchestrationPhase.RunningWork
      ) {
        throw new Error('review_orchestration_phase_invalid');
      }
      if (
        Object.values(state.slots).some(
          (slot) =>
            slot !== ReviewWorkSlotProgress.Satisfied &&
            slot !== ReviewWorkSlotProgress.Exhausted
        )
      ) {
        throw new Error('review_orchestration_work_incomplete');
      }
      return withPhase(state, ReviewOrchestrationPhase.Finalizing);
    case ReviewOrchestrationEventType.PublicationRequested:
      requirePhase(state, ReviewOrchestrationPhase.Finalizing);
      return withPhase(state, ReviewOrchestrationPhase.AwaitingPublication);
    case ReviewOrchestrationEventType.PublicationCompleted:
      requirePhase(state, ReviewOrchestrationPhase.AwaitingPublication);
      return withPhase(
        state,
        event.partial
          ? ReviewOrchestrationPhase.PartialCompleted
          : ReviewOrchestrationPhase.Completed
      );
    case ReviewOrchestrationEventType.Superseded:
      return withPhase(state, ReviewOrchestrationPhase.Superseded);
    case ReviewOrchestrationEventType.Failed:
      return withPhase(state, ReviewOrchestrationPhase.Failed);
  }
}

function withSlot(
  state: ReviewOrchestrationState,
  workSlotId: string,
  expected: readonly ReviewWorkSlotProgress[],
  next: ReviewWorkSlotProgress,
  phase: ReviewOrchestrationPhase
): ReviewOrchestrationState {
  const current = state.slots[workSlotId];
  if (!current) throw new Error('review_orchestration_work_slot_unknown');
  if (!expected.includes(current)) {
    throw new Error('review_orchestration_work_slot_transition_invalid');
  }
  return {
    phase,
    slots: Object.freeze({ ...state.slots, [workSlotId]: next }),
  };
}

function withPhase(
  state: ReviewOrchestrationState,
  phase: ReviewOrchestrationPhase
): ReviewOrchestrationState {
  return { ...state, phase };
}

function requireWorkPhase(state: ReviewOrchestrationState): void {
  if (
    state.phase !== ReviewOrchestrationPhase.ExecutionStarted &&
    state.phase !== ReviewOrchestrationPhase.RunningWork
  ) {
    throw new Error('review_orchestration_phase_invalid');
  }
}

function requirePhase(
  state: ReviewOrchestrationState,
  expected: ReviewOrchestrationPhase
): void {
  if (state.phase !== expected) {
    throw new Error('review_orchestration_phase_invalid');
  }
}

function isTerminal(phase: ReviewOrchestrationPhase): boolean {
  return (
    phase === ReviewOrchestrationPhase.Completed ||
    phase === ReviewOrchestrationPhase.PartialCompleted ||
    phase === ReviewOrchestrationPhase.Superseded ||
    phase === ReviewOrchestrationPhase.Failed
  );
}

function requireIdentity(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new Error('review_orchestration_identity_invalid');
  }
  return value;
}
