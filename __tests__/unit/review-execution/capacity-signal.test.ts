import {
  CapacitySignal,
  classifyProviderCapacitySignal,
} from '../../../src/review-execution/domain/capacity-signal';

describe('classifyProviderCapacitySignal', () => {
  it.each([
    [{ status: 'capacity_unavailable' }],
    [{ status: 'rate-limited' }],
    [{ status: 'quota_exceeded' }],
    [{ status: 'error', error: new Error('HTTP 429 from provider') }],
    [{ status: 'error', error: 'Rate limit exceeded' }],
    [{ status: 'error', error: { message: 'Monthly quota exhausted' } }],
    [
      {
        status: 'error',
        error: { error: { code: 429, message: 'rate limit exceeded' } },
      },
    ],
  ])(
    'classifies capacity pressure from status and error messages',
    (result) => {
      expect(classifyProviderCapacitySignal(result)).toBe(
        CapacitySignal.CapacityPressure
      );
    }
  );

  it('rejects structured-output noise but recognizes known JSON error fields', () => {
    expect(
      classifyProviderCapacitySignal({
        status: 'error',
        error: new Error(
          'Malformed JSON response: rate limit field was absent'
        ),
      })
    ).toBe(CapacitySignal.Neutral);
    expect(
      classifyProviderCapacitySignal({
        status: 'error',
        error: '{"error":{"code":429,"message":"quota exceeded"}}',
      })
    ).toBe(CapacitySignal.CapacityPressure);
    expect(
      classifyProviderCapacitySignal({
        status: 'error',
        error: '{"metadata":"rate limit text is not an error"}',
      })
    ).toBe(CapacitySignal.Neutral);
    expect(
      classifyProviderCapacitySignal({
        status: 'error',
        error:
          '{"error":{"code":429,"message":"structured output rate limit exceeded"}}',
      })
    ).toBe(CapacitySignal.CapacityPressure);
    expect(
      classifyProviderCapacitySignal({
        status: 'error',
        error: '{"error":{"message":"structured output rate limit exceeded"}}',
      })
    ).toBe(CapacitySignal.Neutral);
  });

  it('reports healthy only when every provider result succeeds', () => {
    expect(
      classifyProviderCapacitySignal([
        { status: 'success' },
        { status: 'success' },
      ])
    ).toBe(CapacitySignal.Healthy);
    expect(
      classifyProviderCapacitySignal([
        { status: 'success' },
        { status: 'error', error: new Error('invalid response') },
      ])
    ).toBe(CapacitySignal.Neutral);
  });
});
