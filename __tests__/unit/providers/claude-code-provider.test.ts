import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import { ClaudeCodeProvider } from '../../../src/providers/claude-code';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

const spawnMock = spawn as unknown as jest.Mock;

function createMockProcess(onStart?: (proc: any) => void, closeCode = 0): any {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  proc.unref = jest.fn();
  proc.pid = 12345;

  process.nextTick(() => {
    onStart?.(proc);
    proc.emit('close', closeCode);
  });

  return proc;
}

describe('ClaudeCodeProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-synthetic-default';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('rejects missing selected subscription token before spawning', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-unselected-api-key';
    const provider = new ClaudeCodeProvider('sonnet', { authMode: 'claude-oauth' });
    await expect(provider.review('synthetic prompt', 1000)).rejects.toThrow(
      'CLAUDE_CODE_OAUTH_TOKEN is required'
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('uses binary-only health checks by default to avoid consuming Claude usage', async () => {
    spawnMock.mockImplementation((_cmd: string, _args: string[]) =>
      createMockProcess()
    );

    const provider = new ClaudeCodeProvider('sonnet');
    await expect(provider.healthCheck(1000)).resolves.toBe(true);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe('claude');
    expect(spawnMock.mock.calls[0][1]).toEqual(['--version']);
  });

  it('runs Claude Code through stdin with schema output and sanitized env', async () => {
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/runner';
    process.env.USER = 'runner';
    process.env.LOGNAME = 'runner';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-oauth-secret';
    process.env.GITHUB_TOKEN = 'gh-token';
    process.env.INPUT_GITHUB_TOKEN = 'input-token';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess((proc) => {
        proc.stdout.emit(
          'data',
          JSON.stringify({
            type: 'result',
            result: '{"findings":[]}',
            structured_output: { findings: [] },
          })
        );
      });
    });

    const provider = new ClaudeCodeProvider('sonnet');
    const result = await provider.review('review prompt', 1000);
    const runCall = spawnMock.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1].includes('--json-schema')
    );

    expect(result.content).toBe('{"findings":[]}');
    expect(result.findings).toEqual([]);
    expect(runCall).toBeTruthy();
    expect(runCall?.[1]).toEqual(
      expect.arrayContaining([
        '--model',
        'sonnet',
        '--print',
        '--no-session-persistence',
        '--setting-sources',
        'user',
        '--tools',
        '',
        '--output-format',
        'json',
        '--json-schema',
      ])
    );
    expect(runCall?.[2]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      'sk-ant-oat01-oauth-secret'
    );
    expect(runCall?.[2]?.env.CLAUDE_CONFIG_DIR).toContain('claude-code-');
    expect(runCall?.[2]?.env.GITHUB_TOKEN).toBeUndefined();
    expect(runCall?.[2]?.env.INPUT_GITHUB_TOKEN).toBeUndefined();
    expect(runCall?.[2]?.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('enables only read-only Claude tools when agentic context is enabled', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-oauth-secret';

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess((proc) => {
        proc.stdout.emit(
          'data',
          JSON.stringify({
            structured_output: { findings: [] },
          })
        );
      });
    });

    const provider = new ClaudeCodeProvider('sonnet', {
      agenticContext: true,
    });
    await provider.review('review prompt', 1000);

    const runCall = spawnMock.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1].includes('--json-schema')
    );
    const args = runCall?.[1] as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        '--tools',
        'Read,Grep,Glob',
        '--allowedTools',
        'Read,Grep,Glob',
        '--max-turns',
        '4',
        '--no-session-persistence',
      ])
    );
    expect(args.join(' ')).not.toMatch(/\b(Bash|Edit|Write)\b/);
  });

  it('forces read-only context and fork-safe Claude settings in fork sandbox mode', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-oauth-secret';
    process.env.REVIEWROUTER_FORK_AGENTIC_SANDBOX = 'true';
    process.env.GITHUB_WORKSPACE = '/home/runner/work/repo/repo';
    let forkSafeSettings: any;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      const settingsPath = args[args.indexOf('--settings') + 1];
      forkSafeSettings = JSON.parse(readFileSync(settingsPath, 'utf8'));

      return createMockProcess((proc) => {
        proc.stdout.emit(
          'data',
          JSON.stringify({
            structured_output: { findings: [] },
          })
        );
      });
    });

    const provider = new ClaudeCodeProvider('sonnet', {
      agenticContext: false,
    });
    await provider.review('review prompt', 1000);

    const runCall = spawnMock.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1].includes('--json-schema')
    );
    const args = runCall?.[1] as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        '--tools',
        'Read,Grep,Glob',
        '--allowedTools',
        'Read,Grep,Glob',
        '--safe-mode',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--permission-mode',
        'dontAsk',
        '--disallowedTools',
        'Bash,Edit,Write,mcp__*',
      ])
    );
    expect(args).toContain('--settings');
    expect(forkSafeSettings.permissions.allow).toEqual([
      'Read',
      'Grep',
      'Glob',
    ]);
    expect(forkSafeSettings.permissions.deny).toEqual(
      expect.arrayContaining([
        'Bash',
        'Edit',
        'Write',
        'mcp__*',
        'Read(.git/**)',
        'Read(.claude/**)',
        'Read(**/CLAUDE.md)',
        'Read(**/.env)',
      ])
    );
    expect(args.join(' ')).not.toMatch(/dangerously-skip-permissions/);
    expect(runCall?.[2]?.env.GITHUB_WORKSPACE).toBeUndefined();
    expect(runCall?.[2]?.env.GITHUB_TOKEN).toBeUndefined();
    expect(runCall?.[2]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      'sk-ant-oat01-oauth-secret'
    );
  });

  it('trims surrounding whitespace from Claude OAuth tokens before spawning', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = '  sk-ant-oat01-oauth-secret\n';

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess((proc) => {
        proc.stdout.emit(
          'data',
          JSON.stringify({
            structured_output: { findings: [] },
          })
        );
      });
    });

    const provider = new ClaudeCodeProvider('sonnet');
    await provider.review('review prompt', 1000);

    const runCall = spawnMock.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1].includes('--json-schema')
    );
    expect(runCall?.[2]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      'sk-ant-oat01-oauth-secret'
    );
  });

  it('rejects shell command text stored as a Claude OAuth token', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN =
      'pbpaste | gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo owner/repo';

    const provider = new ClaudeCodeProvider('sonnet');

    await expect(provider.review('review prompt', 1000)).rejects.toThrow(
      'does not look like a Claude setup-token value'
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects quoted or non-Claude OAuth token values before spawning', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = '"sk-ant-oat01-oauth-secret"';

    const provider = new ClaudeCodeProvider('sonnet');

    await expect(provider.review('review prompt', 1000)).rejects.toThrow(
      'Expected a token starting with `sk-ant-oat01-`'
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('uses the JSON result field when structured output is absent', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess((proc) => {
        proc.stdout.emit(
          'data',
          JSON.stringify({
            result: JSON.stringify({
              findings: [
                {
                  file: 'src/app.ts',
                  startLine: null,
                  line: 12,
                  endLine: null,
                  severity: 'major',
                  title: 'Crash',
                  message: 'This can crash.',
                  suggestion: null,
                },
              ],
            }),
          })
        );
      });
    });

    const provider = new ClaudeCodeProvider('sonnet');
    const result = await provider.review('review prompt', 1000);

    expect(result.findings).toHaveLength(1);
    expect(result.findings?.[0]).toMatchObject({
      file: 'src/app.ts',
      line: 12,
      severity: 'major',
    });
  });

  it('fails before spawning Claude when prompt exceeds stdin limit', async () => {
    const provider = new ClaudeCodeProvider('sonnet');
    const oversizedPrompt = 'x'.repeat(10 * 1024 * 1024 + 1);

    await expect(provider.review(oversizedPrompt, 1000)).rejects.toThrow(
      'above the 10485760 byte limit'
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('fails review when Claude returns invalid review JSON', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess((proc) => {
        proc.stdout.emit('data', JSON.stringify({ result: 'not json' }));
      });
    });

    const provider = new ClaudeCodeProvider('sonnet');

    await expect(provider.review('review prompt', 1000)).rejects.toThrow(
      'Claude Code CLI returned invalid review JSON'
    );
  });

  it('passes only the explicitly selected API key into the same isolated Claude CLI', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-synthetic-allowed-key';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-ignored-subscription';
    process.env.ANTHROPIC_AUTH_TOKEN = 'ambient-invalid';
    process.env.GITHUB_TOKEN = 'ambient-github';

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) return createMockProcess();
      return createMockProcess((proc) => {
        proc.stdout.emit('data', JSON.stringify({
          structured_output: { findings: [], revalidations: [] },
        }));
      });
    });
    const provider = new ClaudeCodeProvider('sonnet', {
      authMode: 'claude-api-key',
      agenticContext: true,
    });
    const result = await provider.review('review synthetic PR', 1000);
    expect(result.findings).toEqual([]);
    const invocation = spawnMock.mock.calls.find((call) =>
      (call[1] as string[]).includes('--json-schema')
    );
    expect(invocation).toBeDefined();
    expect(invocation?.[2]?.env.ANTHROPIC_API_KEY).toBe(
      'sk-ant-api03-synthetic-allowed-key'
    );
    expect(invocation?.[2]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(invocation?.[2]?.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(invocation?.[2]?.env.GITHUB_TOKEN).toBeUndefined();
    expect(invocation?.[2]?.env.CLAUDE_CONFIG_DIR).toContain('claude-code-');
    expect(invocation?.[1]).toContain('--allowedTools');
  });

  it('fails closed with no API key instead of falling back to subscription OAuth', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-valid-but-not-selected';
    const provider = new ClaudeCodeProvider('sonnet', {
      authMode: 'claude-api-key',
    });
    await expect(provider.review('synthetic prompt', 1000)).rejects.toThrow(
      'ANTHROPIC_API_KEY is required'
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    'pbpaste | gh secret set ANTHROPIC_API_KEY --repo example/test',
    '"sk-ant-api03-quoted-key"',
    'sk-ant-oat01-wrong-credential-kind',
    'sk-ant-api03-has whitespace',
    'not-an-api-key',
  ])('rejects invalid selected API credential before running CLI (%s)', async (value) => {
    process.env.ANTHROPIC_API_KEY = value;
    const provider = new ClaudeCodeProvider('sonnet', {
      authMode: 'claude-api-key',
    });
    await expect(provider.review('synthetic prompt', 1000)).rejects.toThrow(
      'ANTHROPIC_API_KEY is missing or invalid'
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('keeps selected API-key mode in the immutable prepared request', async () => {
    const provider = new ClaudeCodeProvider('sonnet', {
      authMode: 'claude-api-key',
    });
    Object.defineProperty(provider, 'resolveBinary', {
      configurable: true,
      value: jest.fn().mockResolvedValue('claude-fixture'),
    });
    const prepared = await provider.prepareInvocation('synthetic prompt', 1000);
    expect(prepared.request).toMatchObject({ authMode: 'claude-api-key' });
    expect(prepared.observableInputPreimage).not.toContain('sk-ant-api03');
    Object.defineProperty(provider, 'options', {
      configurable: true,
      value: { authMode: 'claude-oauth' },
    });
    const fakeRun = jest.fn().mockResolvedValue({
      stdout: JSON.stringify({ structured_output: { findings: [] } }),
      stderr: '',
    });
    Object.defineProperty(provider, 'runCliWithStdin', {
      configurable: true,
      value: fakeRun,
    });
    await expect(
      provider.executePreparedInvocation(prepared, {
        bearerToken: 'sk-ant-oat01-wrong-kind',
      })
    ).rejects.toThrow('ANTHROPIC_API_KEY is missing or invalid');
    expect(fakeRun).not.toHaveBeenCalled();
    await provider.executePreparedInvocation(prepared, {
      bearerToken: 'sk-ant-api03-lease-key',
    });
    expect(fakeRun).toHaveBeenCalledWith(
      expect.objectContaining({ authMode: 'claude-api-key' }),
      1000,
      'sk-ant-api03-lease-key'
    );
  });

  it('redacts API-key values echoed by a failed synthetic CLI process', async () => {
    const apiKey = 'sk-ant-api03-synthetic-secret-key';
    process.env.ANTHROPIC_API_KEY = apiKey;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) return createMockProcess();
      return createMockProcess((proc) => {
        proc.stderr.emit('data', 'Unauthorized token ' + apiKey);
      }, 1);
    });
    const provider = new ClaudeCodeProvider('sonnet', {
      authMode: 'claude-api-key',
    });
    let message = '';
    try {
      await provider.review('synthetic prompt', 1000);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('[REDACTED]');
    expect(message).not.toContain(apiKey);
  });
  it('redacts selected credentials when the CLI exits zero without output', async () => {
    const apiKey = 'sk-ant-api03-synthetic-no-output-secret';
    process.env.ANTHROPIC_API_KEY = apiKey;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) return createMockProcess();
      return createMockProcess((proc) => {
        proc.stderr.emit('data', 'Provider message included ' + apiKey);
      });
    });
    const provider = new ClaudeCodeProvider('sonnet', {
      authMode: 'claude-api-key',
    });
    await expect(provider.review('synthetic input', 1000)).rejects.toThrow(
      'Claude Code CLI returned no output'
    );
    let thrown: string | undefined;
    try {
      await provider.review('synthetic input', 1000);
    } catch (error) {
      thrown = (error as Error).message;
    }
    expect(thrown).toContain('[REDACTED]');
    expect(thrown).not.toContain(apiKey);
  });

});
