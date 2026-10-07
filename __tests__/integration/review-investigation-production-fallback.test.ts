import {
  ReviewInvestigationControlPlaneError,
  ReviewInvestigationControlPlaneFailureClass,
  ReviewInvestigationLegacyFallbackGate,
  ReviewInvestigationLegacyFallbackReason,
  ReviewInvestigationLegacyFallbackSignal,
  RunInvestigationWorkSlot,
} from '../../src/review-investigation';
import { LegacyFallbackBeforeInvestigationAuthorityControlPlane } from '../../src/review-orchestration/infrastructure/production-t0-review-runner';

describe('production investigation legacy fallback boundary', () => {
  it.each([
    [
      ReviewInvestigationControlPlaneFailureClass.CapabilityDisabled,
      ReviewInvestigationLegacyFallbackReason.CapabilityDisabledBeforeOpen,
    ],
    [
      ReviewInvestigationControlPlaneFailureClass.Unavailable,
      ReviewInvestigationLegacyFallbackReason.InfrastructureUnavailableBeforeOpen,
    ],
    [
      ReviewInvestigationControlPlaneFailureClass.CapacityLimited,
      ReviewInvestigationLegacyFallbackReason.InfrastructureUnavailableBeforeOpen,
    ],
  ])(
    'preserves %s legacy fallback before replay and investigation effects',
    async (failureClass, reason) => {
      const legacyFallbackGate = new ReviewInvestigationLegacyFallbackGate();
      const controlPlane =
        new LegacyFallbackBeforeInvestigationAuthorityControlPlane(
          {
            open: jest
              .fn()
              .mockRejectedValue(
                new ReviewInvestigationControlPlaneError(
                  failureClass,
                  'safe_initial_open_failure'
                )
              ),
          } as never,
          legacyFallbackGate
        );
      const runner = new RunInvestigationWorkSlot({
        controlPlane,
        legacyFallbackGate,
        delay: {} as never,
        leases: {} as never,
        turnRunner: {} as never,
      });

      await expect(runner.execute({} as never)).rejects.toMatchObject({
        name: 'ReviewInvestigationLegacyFallbackSignal',
        reason,
      });
    }
  );

  it('fails closed when capability is disabled after replay commits a proof', async () => {
    const openFailure = new ReviewInvestigationControlPlaneError(
      ReviewInvestigationControlPlaneFailureClass.CapabilityDisabled,
      'capability_disabled_after_replay'
    );
    const open = jest.fn().mockRejectedValue(openFailure);
    const commitReceiptReplay = jest.fn().mockResolvedValue({
      replayProofId: 'proof-1',
    });
    const delegate = {
      open,
      commitReceiptReplay,
    } as never;
    const legacyFallbackGate = new ReviewInvestigationLegacyFallbackGate();
    const controlPlane =
      new LegacyFallbackBeforeInvestigationAuthorityControlPlane(
        delegate,
        legacyFallbackGate
      );
    let proofCommitted = false;
    const runner = new RunInvestigationWorkSlot({
      controlPlane,
      legacyFallbackGate,
      replay: {
        execute: jest.fn(async () => {
          await controlPlane.commitReceiptReplay({} as never);
          proofCommitted = true;
          return null;
        }),
      },
      delay: {} as never,
      leases: {} as never,
      turnRunner: {} as never,
    });

    const execution = runner.execute({
      targetRevision: {},
      targetScope: {},
      providerManifestCanonicalJson: '{}',
      providerManifestHash: 'manifest-hash',
    } as never);

    await expect(execution).rejects.toBe(openFailure);
    expect(openFailure).not.toBeInstanceOf(
      ReviewInvestigationLegacyFallbackSignal
    );
    expect(proofCommitted).toBe(true);
    expect(commitReceiptReplay).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
