import {
  CODEX_OAUTH_ROTATING_MODE,
  shouldEnterCodexOAuthRotatingAction,
} from '../../../src/codex-oauth/action';

describe('Codex OAuth rotating action mode', () => {
  it('enters rotating bootstrap for the top-level rotating action', () => {
    expect(
      shouldEnterCodexOAuthRotatingAction({
        requestedMode: CODEX_OAUTH_ROTATING_MODE,
        env: {},
      })
    ).toBe(true);
  });

  it('does not re-enter rotating bootstrap inside the static review runtime', () => {
    expect(
      shouldEnterCodexOAuthRotatingAction({
        requestedMode: CODEX_OAUTH_ROTATING_MODE,
        env: { REVIEWROUTER_RUNTIME_CONFIG_MODE: 'static' },
      })
    ).toBe(false);
  });

  it('ignores non-rotating modes', () => {
    expect(
      shouldEnterCodexOAuthRotatingAction({
        requestedMode: 'runtime-preflight',
        env: {},
      })
    ).toBe(false);
  });
});
