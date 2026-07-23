import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CODEX_OAUTH_ROTATING_MODE,
  readPullRequestEvent,
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

  it('binds workflow_dispatch reviews to the server-selected PR and head', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-dispatch-'));
    const eventPath = path.join(directory, 'event.json');
    fs.writeFileSync(
      eventPath,
      JSON.stringify({
        repository: { full_name: '777genius/agent-teams-ai' },
        inputs: {
          pr_number: '252',
          review_head_sha: 'a'.repeat(40),
        },
      })
    );
    const previous = {
      eventPath: process.env.GITHUB_EVENT_PATH,
      eventName: process.env.GITHUB_EVENT_NAME,
      repository: process.env.GITHUB_REPOSITORY,
    };
    process.env.GITHUB_EVENT_PATH = eventPath;
    process.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
    process.env.GITHUB_REPOSITORY = '777genius/agent-teams-ai';

    try {
      expect(readPullRequestEvent()).toEqual({
        repository: '777genius/agent-teams-ai',
        number: 252,
        headSha: 'a'.repeat(40),
        headRef: '',
        eventName: 'workflow_dispatch',
      });
    } finally {
      restoreEnv('GITHUB_EVENT_PATH', previous.eventPath);
      restoreEnv('GITHUB_EVENT_NAME', previous.eventName);
      restoreEnv('GITHUB_REPOSITORY', previous.repository);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
