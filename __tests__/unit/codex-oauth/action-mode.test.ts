import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as gatewayRuntime from '../../../src/codex-oauth/account-gateway-runtime';
import * as core from '../../../src/actions/core';
import { ReviewSkillsMaterializationError } from '../../../src/review-skills/review-skills-error';
import { ReviewActionV2RuntimeMode } from '../../../src/control-plane/review-action-v2-contract';
import {
  CODEX_OAUTH_ROTATING_MODE,
  readPullRequestEvent,
  shouldEnterCodexOAuthRotatingAction,
  runAccountGatewayAction,
} from '../../../src/codex-oauth/action';

describe('Codex OAuth rotating action mode', () => {
  it('publishes typed Git diagnostics to the actual Gateway Actions summary without a PR reporter', async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'rr-skills-action-')
    );
    const event = path.join(directory, 'event.json');
    const summary = path.join(directory, 'summary.md');
    fs.writeFileSync(
      event,
      JSON.stringify({
        repository: { full_name: 'fixture/repo' },
        inputs: { pr_number: '1', review_head_sha: 'a'.repeat(40) },
      })
    );
    const originalEnv = process.env;
    const originalExit = process.exitCode;
    process.env = {
      ...originalEnv,
      GITHUB_EVENT_PATH: event,
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REPOSITORY: 'fixture/repo',
      GITHUB_STEP_SUMMARY: summary,
      REVIEWROUTER_CONTROL_PLANE_URL: 'https://fixture.example',
      INPUT_PROVIDER_INSTANCE_ID: 'provider',
      INPUT_WORKFLOW_SCHEMA_VERSION: '2',
    };
    const failure = new ReviewSkillsMaterializationError(
      'review_skills_reference_missing',
      {
        baseSha: 'b'.repeat(40),
        path: '.agents/skills/[x](url)|<details>@team/SKILL.md',
        field: 'reference',
        reference: 'missing.md',
      }
    );
    const runtime = jest
      .spyOn(gatewayRuntime, 'runAccountGatewayRuntime')
      .mockImplementation(async (_input, ports) => {
        await ports.terminalFailure(failure, { authorized: true });
      });
    const failed = jest
      .spyOn(core, 'setFailed')
      .mockImplementation(() => undefined);
    const output = jest
      .spyOn(core, 'setOutput')
      .mockImplementation(() => undefined);
    try {
      await runAccountGatewayAction({
        reviewActionV2Activation: {
          mode: ReviewActionV2RuntimeMode.T0,
          handoff: {} as never,
        },
      });
      const text = fs.readFileSync(summary, 'utf8');
      expect(text).toContain('Repository Skills need attention');
      expect(text).toContain('review_skills_reference_missing');
      expect(text).toContain('missing.md');
      expect(text).toContain('correct its relative link');
      expect(text).not.toContain('terminal_result_missing');
      expect(text).not.toContain('<details>@team');
      expect(text).not.toContain('[x](url)');
      expect(text).toContain('&#124;');
      expect(failed).toHaveBeenCalledWith('review_skills_reference_missing');
    } finally {
      runtime.mockRestore();
      failed.mockRestore();
      output.mockRestore();
      process.env = originalEnv;
      process.exitCode = originalExit;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
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
