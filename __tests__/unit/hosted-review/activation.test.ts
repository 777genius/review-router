import {
  resolveHostedV4Activation,
  HOSTED_V4_MODE,
} from '../../../src/hosted-review/activation';

describe('hosted v4 activation and public main boundary', () => {
  const originalEnv = process.env;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    process.env = { REVIEW_ROUTER_MODE: HOSTED_V4_MODE };
    process.exitCode = undefined;
  });
  afterAll(() => {
    process.env = originalEnv;
    process.exitCode = originalExitCode;
  });

  it('is default off and refuses selected hosted mode before transport calls', async () => {
    expect(() =>
      resolveHostedV4Activation({
        requestedMode: HOSTED_V4_MODE,
        env: process.env,
      })
    ).toThrow('hosted_v4_adapter_disabled');
    const observed = await runMain();
    expect(observed.failed).toHaveBeenCalledWith('hosted_v4_adapter_disabled');
    expect(observed.action).not.toHaveBeenCalled();
    expect(observed.rotating).not.toHaveBeenCalled();
    expect(observed.failurePublisher).not.toHaveBeenCalled();
    expect(observed.components).not.toHaveBeenCalled();
  });

  it('requires the verified T0 handoff even with the exact flag', () => {
    process.env.REVIEW_ROUTER_HOSTED_V4_ADAPTER_ENABLED = '1';
    expect(() =>
      resolveHostedV4Activation({
        requestedMode: HOSTED_V4_MODE,
        env: process.env,
      })
    ).toThrow('hosted_v4_verified_t0_handoff_required');
    process.env.REVIEWROUTER_ACTION_V2_MODE = 't0';
    expect(
      resolveHostedV4Activation({
        requestedMode: HOSTED_V4_MODE,
        env: process.env,
      })?.handoff.schemaDigest
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it('routes selected hosted before rotating guard and closes publisher on denial', async () => {
    process.env.REVIEW_ROUTER_HOSTED_V4_ADAPTER_ENABLED = '1';
    process.env.REVIEWROUTER_ACTION_V2_MODE = 't0';
    const observed = await runMain(
      new Error('hosted_v4_paid_turn_unavailable')
    );
    expect(observed.action).toHaveBeenCalledTimes(1);
    expect(observed.failed).toHaveBeenCalledWith(
      'hosted_v4_paid_turn_unavailable'
    );
    expect(observed.rotating).not.toHaveBeenCalled();
    expect(observed.failurePublisher).not.toHaveBeenCalled();
    expect(observed.components).not.toHaveBeenCalled();
  });

  it('redacts an unexpected selected-hosted error and still skips failure publishing', async () => {
    process.env.REVIEW_ROUTER_HOSTED_V4_ADAPTER_ENABLED = '1';
    process.env.REVIEWROUTER_ACTION_V2_MODE = 't0';
    const observed = await runMain(new Error('synthetic-authorization-token'));
    expect(observed.failed).toHaveBeenCalledWith('hosted_v4_failed_closed');
    expect(observed.failurePublisher).not.toHaveBeenCalled();
    expect(observed.components).not.toHaveBeenCalled();
  });

  it.each([
    'hosted_v4_oidc_denied\nSYNTHETIC_PRIVATE_BODY',
    'review_action_v2_authorization_denied\rSYNTHETIC_PRIVATE_BODY',
    'hosted_v4_read_authority_denied\tSYNTHETIC_PRIVATE_BODY',
    'hosted_v4_read_authority_denied\u2003SYNTHETIC_PRIVATE_BODY',
    'hosted_v4_arbitrary_private_code',
    `hosted_v4_oidc_denied${'SYNTHETIC_PRIVATE_BODY'.repeat(100)}`,
  ])(
    'emits only a fixed safe code for untrusted error text',
    async (message) => {
      process.env.REVIEW_ROUTER_HOSTED_V4_ADAPTER_ENABLED = '1';
      process.env.REVIEWROUTER_ACTION_V2_MODE = 't0';
      const observed = await runMain(new Error(message));
      expect(observed.failed).toHaveBeenCalledTimes(1);
      expect(observed.failed).toHaveBeenCalledWith('hosted_v4_failed_closed');
      expect(observed.failurePublisher).not.toHaveBeenCalled();
      expect(observed.commentToken).not.toHaveBeenCalled();
      expect(observed.rotating).not.toHaveBeenCalled();
      expect(observed.components).not.toHaveBeenCalled();
    }
  );

  it('closes malformed activation before any hosted or legacy I/O', async () => {
    process.env.REVIEW_ROUTER_HOSTED_V4_ADAPTER_ENABLED = '1';
    const observed = await runMain();
    expect(observed.failed).toHaveBeenCalledWith(
      'hosted_v4_verified_t0_handoff_required'
    );
    expect(observed.action).not.toHaveBeenCalled();
    expect(observed.commentToken).not.toHaveBeenCalled();
    expect(observed.failurePublisher).not.toHaveBeenCalled();
    expect(observed.components).not.toHaveBeenCalled();
  });
});

async function runMain(actionError?: Error) {
  jest.resetModules();
  const action = jest.fn(async () => {
    if (actionError) throw actionError;
  });
  const rotating = jest.fn();
  const failurePublisher = jest.fn();
  const commentToken = jest.fn();
  const components = jest.fn();
  jest.doMock('../../../src/setup', () => ({ createComponents: components }));
  jest.doMock('../../../src/hosted-review/action', () => ({
    runHostedV4ActionFromEnvironment: action,
  }));
  jest.doMock('../../../src/github/failure-summary', () => ({
    clearReviewFailureSummaries: jest.fn(),
    postReviewFailureSummary: failurePublisher,
  }));
  jest.doMock('../../../src/control-plane/comment-token', () => ({
    resolveGitHubCommentToken: commentToken,
  }));
  jest.doMock('../../../src/codex-oauth/action', () => ({
    shouldEnterCodexOAuthRotatingAction: jest.fn(() => false),
    runCodexOAuthRotatingAction: rotating,
  }));
  const core =
    require('../../../src/actions/core') as typeof import('../../../src/actions/core');
  const failed = jest
    .spyOn(core, 'setFailed')
    .mockImplementation(() => undefined);
  require('../../../src/main');
  await new Promise((resolve) => setImmediate(resolve));
  return {
    action,
    rotating,
    failurePublisher,
    commentToken,
    components,
    failed,
  };
}
