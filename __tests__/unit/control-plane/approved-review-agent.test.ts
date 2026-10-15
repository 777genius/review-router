import { bundledReviewAgentForTransport } from '../../../src/control-plane/approved-review-agent';
import profiles from '../../../src/control-plane/review-agent-profiles.json';

describe('bundled approved T0 agent', () => {
  afterEach(() => jest.resetModules());

  it('qualifies the same pinned toolchain for both supported transports', () => {
    expect(bundledReviewAgentForTransport('provider_api')).toEqual(
      bundledReviewAgentForTransport('account_gateway')
    );
    expect(bundledReviewAgentForTransport('provider_api').binarySha256).toBe(
      'cb0a15567e9a60a5820d54b0f6ae86d504dc3805c1eab21a47f70e3eb7b73a40'
    );
  });

  it.each([
    [{ ...profiles[0], agentKind: 'claude' }],
    [profiles[0], { ...profiles[0], profileRef: 'ambiguous-codex' }],
  ])(
    'refuses a missing or ambiguous qualified Codex profile: %j',
    (...rows) => {
      jest.isolateModules(() => {
        jest.doMock(
          '../../../src/control-plane/review-agent-profiles.json',
          () => rows
        );
        const module = jest.requireActual(
          '../../../src/control-plane/approved-review-agent'
        );
        expect(() =>
          module.bundledReviewAgentForTransport('provider_api')
        ).toThrow('review_agent_profile_unavailable');
      });
      jest.dontMock('../../../src/control-plane/review-agent-profiles.json');
    }
  );
});
