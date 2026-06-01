import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCodexOAuthRotatingRuntime } from '../../../src/codex-oauth/runtime';
import { runCodexOAuthRotatingAction } from '../../../src/codex-oauth/action';

jest.mock('../../../src/codex-oauth/runtime', () => ({
  runCodexOAuthRotatingRuntime: jest.fn(),
}));

const mockedRuntime = runCodexOAuthRotatingRuntime as jest.MockedFunction<
  typeof runCodexOAuthRotatingRuntime
>;

describe('Codex OAuth rotating setup PR preview', () => {
  const originalEnv = process.env;
  let tempDir: string;
  let eventPath: string;
  let outputPath: string;

  beforeEach(() => {
    process.exitCode = undefined;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-codex-preview-'));
    eventPath = path.join(tempDir, 'event.json');
    outputPath = path.join(tempDir, 'output');
    mockedRuntime.mockReset();
    mockedRuntime.mockResolvedValue({
      status: 'skipped',
      reason: 'stale_queued_secret',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
    process.exitCode = undefined;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('skips setup PR preview before the Codex auth secret is configured', async () => {
    process.env = actionEnv({
      eventPath,
      outputPath,
      headRef: 'reviewrouter/setup',
    });

    await runCodexOAuthRotatingAction();

    expect(mockedRuntime).not.toHaveBeenCalled();
    expect(fs.readFileSync(outputPath, 'utf8')).toContain(
      'reviewrouter_skipped_reason'
    );
    expect(fs.readFileSync(outputPath, 'utf8')).toContain(
      'setup_pr_waiting_for_codex_auth'
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('does not skip ordinary pull requests when the Codex auth secret is missing', async () => {
    process.env = actionEnv({
      eventPath,
      outputPath,
      headRef: 'feature/change',
    });

    await runCodexOAuthRotatingAction();

    expect(mockedRuntime).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(outputPath, 'utf8')).toContain(
      'stale_queued_secret'
    );
  });

  it('does not skip setup PR preview when Codex auth is already configured', async () => {
    process.env = {
      ...actionEnv({
        eventPath,
        outputPath,
        headRef: 'reviewrouter/setup',
      }),
      INPUT_AUTH_JSON: JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { refresh_token: 'refresh-token' },
      }),
    };

    await runCodexOAuthRotatingAction();

    expect(mockedRuntime).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it('fails closed when runtime skips after setup because review did not run', async () => {
    mockedRuntime.mockResolvedValue({
      status: 'skipped',
      reason: 'permission_required',
    });
    process.env = actionEnv({
      eventPath,
      outputPath,
      headRef: 'feature/change',
    });

    await runCodexOAuthRotatingAction();

    expect(mockedRuntime).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(outputPath, 'utf8')).toContain(
      'permission_required'
    );
  });
});

function actionEnv(input: {
  readonly eventPath: string;
  readonly outputPath: string;
  readonly headRef: string;
}): NodeJS.ProcessEnv {
  fs.writeFileSync(
    input.eventPath,
    JSON.stringify({
      repository: { full_name: 'Padelapp-Club/monitoring-service' },
      pull_request: {
        number: 1,
        head: {
          ref: input.headRef,
          repo: { full_name: 'Padelapp-Club/monitoring-service' },
          sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      },
    })
  );

  return {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: input.eventPath,
    GITHUB_OUTPUT: input.outputPath,
    GITHUB_REPOSITORY: 'Padelapp-Club/monitoring-service',
    'INPUT_API-URL': 'https://api.reviewrouter.site',
    'INPUT_PROVIDER-INSTANCE-ID': 'codex-rotating:1196598615',
    'INPUT_WORKFLOW-SCHEMA-VERSION': '1',
  };
}
