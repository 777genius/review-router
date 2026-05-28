import {
  formatBlockingFindingFailure,
  getBlockingFindingBreakdown,
} from '../../../src/output/severity-gate';
import {
  Finding,
  LifecycleThreadRecord,
  Review,
  Severity,
} from '../../../src/types';

const finding = (severity: Severity): Finding => ({
  file: 'src/app.ts',
  line: 10,
  severity,
  title: `${severity} finding`,
  message: 'Specific evidence.',
});

const previousThread = (
  severity: Severity,
  reasonCodes: LifecycleThreadRecord['reasonCodes'] = ['still_valid_vote']
): LifecycleThreadRecord =>
  ({
    target: {
      severity,
    },
    reasonCodes,
  }) as LifecycleThreadRecord;

const review = (
  findings: Finding[],
  previousStillValid: LifecycleThreadRecord[] = []
): Review =>
  ({
    findings,
    threadLifecycle: {
      previousStillValid,
    },
  }) as Review;

describe('severity gate formatting', () => {
  it('reports new current blocking findings separately', () => {
    const result = formatBlockingFindingFailure(
      review([finding('major')]),
      'major'
    );

    expect(result).toBe(
      'ReviewRouter found 1 blocking major+ finding: 1 new current major+ finding. Review comments were posted before failing this check.'
    );
  });

  it('explains when only previous unresolved findings block the check', () => {
    const input = review([], [previousThread('major')]);

    expect(getBlockingFindingBreakdown(input, 'major')).toEqual({
      current: 0,
      previousStillValid: 1,
      total: 1,
    });
    expect(formatBlockingFindingFailure(input, 'major')).toBe(
      'ReviewRouter found 1 blocking major+ finding: 1 previous unresolved major+ finding still valid. No new current major+ findings were kept after filtering. Review comments were posted before failing this check.'
    );
  });

  it('reports mixed current and previous unresolved blocking findings', () => {
    const result = formatBlockingFindingFailure(
      review([finding('critical')], [previousThread('major')]),
      'major'
    );

    expect(result).toBe(
      'ReviewRouter found 2 blocking major+ findings: 1 new current major+ finding and 1 previous unresolved major+ finding still valid. Review comments were posted before failing this check.'
    );
  });

  it('does not double-count previous threads linked to current findings', () => {
    const input = review(
      [finding('major')],
      [previousThread('major', ['current_finding_present'])]
    );

    expect(getBlockingFindingBreakdown(input, 'major')).toEqual({
      current: 1,
      previousStillValid: 0,
      total: 1,
    });
  });

  it('does not block when the threshold is off', () => {
    expect(
      formatBlockingFindingFailure(review([finding('critical')]), 'off')
    ).toBe(undefined);
  });
});
