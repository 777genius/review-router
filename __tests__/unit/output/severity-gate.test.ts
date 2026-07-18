import {
  formatBlockingFindingFailure,
  getBlockingFindingBreakdown,
} from '../../../src/output/severity-gate';
import {
  Finding,
  LifecycleThreadRecord,
  Review,
  ReviewFindingProvenance,
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
  previousStillValid: LifecycleThreadRecord[] = [],
  findingProvenance?: ReviewFindingProvenance
): Review =>
  ({
    findings,
    findingProvenance,
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
      'ReviewRouter found 1 blocking major+ finding: 1 major+ finding produced by this review. Review comments were posted before failing this check.'
    );
  });

  it('explains when only previous unresolved findings block the check', () => {
    const input = review([], [previousThread('major')]);

    expect(getBlockingFindingBreakdown(input, 'major')).toEqual({
      current: 0,
      fromCurrentReview: 0,
      carriedForward: 0,
      unclassifiedCurrent: 0,
      previousStillValid: 1,
      total: 1,
    });
    expect(formatBlockingFindingFailure(input, 'major')).toBe(
      'ReviewRouter found 1 blocking major+ finding: 1 previous unresolved major+ finding still valid. No major+ findings were produced by this review. Review comments were posted before failing this check.'
    );
  });

  it('reports carried-forward findings without calling them new', () => {
    const input = review(
      [finding('major'), finding('major'), finding('major')],
      [],
      {
        fromCurrentReview: { critical: 0, major: 0, minor: 0 },
        carriedForward: { critical: 0, major: 3, minor: 0 },
      }
    );

    expect(getBlockingFindingBreakdown(input, 'major')).toEqual({
      current: 3,
      fromCurrentReview: 0,
      carriedForward: 3,
      unclassifiedCurrent: 0,
      previousStillValid: 0,
      total: 3,
    });
    expect(formatBlockingFindingFailure(input, 'major')).toBe(
      'ReviewRouter found 3 blocking major+ findings: 3 carried-forward major+ findings from unchanged files. No major+ findings were produced by this review. Review comments were posted before failing this check.'
    );
  });

  it('reports mixed current and previous unresolved blocking findings', () => {
    const result = formatBlockingFindingFailure(
      review([finding('critical')], [previousThread('major')]),
      'major'
    );

    expect(result).toBe(
      'ReviewRouter found 2 blocking major+ findings: 1 major+ finding produced by this review and 1 previous unresolved major+ finding still valid. Review comments were posted before failing this check.'
    );
  });

  it('does not double-count previous threads linked to current findings', () => {
    const input = review(
      [finding('major')],
      [previousThread('major', ['current_finding_present'])]
    );

    expect(getBlockingFindingBreakdown(input, 'major')).toEqual({
      current: 1,
      fromCurrentReview: 1,
      carriedForward: 0,
      unclassifiedCurrent: 0,
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
