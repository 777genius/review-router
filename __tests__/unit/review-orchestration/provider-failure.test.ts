import {
  confirmedProviderFailure,
  providerFailureMessage,
} from '../../../src/review-execution/domain/provider-failure';

describe('unknown request outcome diagnostics', () => {
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
      })
    ).toBeUndefined();
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
