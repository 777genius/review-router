import {
  confirmedProviderFailure,
  partialRunStop,
  providerFailureMessage,
} from '../../../src/review-execution/domain/provider-failure';

describe('unknown request outcome diagnostics', () => {
  it('explains a semantic invalid response without inventing a transport failure', () => {
    const message = providerFailureMessage('output_invalid', true)!;
    expect(message).toContain(
      'verification response did not satisfy the required format'
    );
    expect(message).toContain('The affected findings remain unverified');
    expect(message).not.toMatch(/unreachable|unknown|retry|quota/i);
  });
  it.each(['effect_unknown', 'dispatch_started', 'response_started'])(
    'explains %s without inventing an upstream cause',
    (effect) => {
      const notice = confirmedProviderFailure({ code: 'unrecognized', effect });
      expect(notice).toBe('request_outcome_unknown');
      const message = providerFailureMessage(notice, true)!;
      expect(message).toContain('The request may have reached the provider.');
      expect(message).toContain('Automatic retry was withheld');
      expect(message).toContain('This review is incomplete');
      expect(message).not.toMatch(/502|503|quota|exhausted/);
    }
  );

  it('names a refused request-budget claim as a partial stop, never an unknown outcome', () => {
    const fact = {
      code: 'model_dispatch_budget_exhausted',
      effect: 'not_dispatched',
    };
    expect(confirmedProviderFailure(fact)).toBe('request_budget_reached');
    expect(partialRunStop(fact)).toBe('request_budget_reached');
    const message = providerFailureMessage('request_budget_reached', true)!;
    expect(message).toContain('whole allowance of model requests');
    expect(message).toContain('This review is incomplete');
    expect(message).not.toMatch(/may have reached|retry|start a new review/i);
    // The same code with an uncertain effect stays an unknown outcome.
    expect(
      confirmedProviderFailure({ ...fact, effect: 'effect_unknown' })
    ).toBe('request_outcome_unknown');
    expect(
      partialRunStop({ ...fact, effect: 'effect_unknown' })
    ).toBeUndefined();
  });

  it.each(['none', 'completed', 'not_dispatched', 'invented'])(
    'does not invent an unknown result from %s',
    (effect) => {
      expect(
        confirmedProviderFailure({ code: 'relay_unknown', effect })
      ).toBeUndefined();
    }
  );

  it('keeps quota handling separate and never renders untrusted error text', () => {
    expect(
      confirmedProviderFailure({
        code: 'provider_quota_exhausted',
        effect: 'effect_unknown',
        providerQuota: {
          provider: 'openrouter',
          limit: 1000,
          remaining: 0,
          resetAt: '2026-11-05T00:00:00.000Z',
        },
      })
    ).toBeUndefined();
    expect(
      confirmedProviderFailure({
        code: 'provider_quota_exhausted',
        effect: 'effect_unknown',
      })
    ).toBe('request_outcome_unknown');
    expect(
      confirmedProviderFailure({
        code: 'provider_quota_exhausted',
        effect: 'effect_unknown',
        providerQuota: { remaining: 1 },
      })
    ).toBe('request_outcome_unknown');
    const fact = {
      code: 'secret-provider-body',
      effect: 'effect_unknown',
      message: 'secret-token',
    };
    expect(
      providerFailureMessage(confirmedProviderFailure(fact))
    ).not.toContain('secret');
    expect(providerFailureMessage('secret-token')).toBeUndefined();
  });
});
