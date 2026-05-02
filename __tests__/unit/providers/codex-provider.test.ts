import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { CodexProvider } from '../../../src/providers/codex';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  spawnSync: jest.fn(),
}));

const spawnMock = spawn as unknown as jest.Mock;
const spawnSyncMock = spawnSync as unknown as jest.Mock;

function createMockProcess(onStart?: (proc: any) => void, closeCode = 0): any {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  proc.pid = 12345;

  process.nextTick(() => {
    onStart?.(proc);
    proc.emit('close', closeCode);
  });

  return proc;
}

describe('CodexProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('builds read-only agentic exec args without dangerous sandbox bypass', () => {
    const provider = new CodexProvider('gpt-5.4-mini');
    const args = (provider as any).buildExecArgs({
      healthCheck: false,
      outputLastMessageFile: '/tmp/codex-output.txt',
      outputSchemaFile: '/tmp/codex-schema.json',
      eventAudit: true,
    });

    expect(args).toContain('exec');
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--ignore-rules');
    expect(args).toContain('--output-schema');
    expect(args).toContain('/tmp/codex-schema.json');
    expect(args).toContain('--output-last-message');
    expect(args).toContain('/tmp/codex-output.txt');
    expect(args).toContain('--json');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('uses binary-only health checks by default to avoid consuming Codex usage', async () => {
    spawnMock.mockImplementation((_cmd: string, _args: string[]) =>
      createMockProcess()
    );

    const provider = new CodexProvider('gpt-5.4-mini');
    await expect(provider.healthCheck(1000)).resolves.toBe(true);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe('codex');
    expect(spawnMock.mock.calls[0][1]).toEqual(['--version']);
    expect(
      spawnMock.mock.calls.some(
        (call) => Array.isArray(call[1]) && call[1][0] === 'exec'
      )
    ).toBe(false);
  });

  it('supports explicit exec health checks when requested', async () => {
    process.env.CODEX_HEALTHCHECK_MODE = 'exec';
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess(() => {
        const outputIndex = args.indexOf('--output-last-message');
        fs.writeFileSync(args[outputIndex + 1], 'codex-health-ok');
      });
    });

    const provider = new CodexProvider('gpt-5.4-mini');
    await expect(provider.healthCheck(1000)).resolves.toBe(true);

    const execCall = spawnMock.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1][0] === 'exec'
    );
    expect(execCall).toBeTruthy();
    expect(execCall?.[1]).toContain('gpt-5.4-mini');
  });

  it('can disable interactive/tool features for isolated discussion prompts', () => {
    const provider = new CodexProvider('gpt-5.4-mini');
    const args = (provider as any).buildExecArgs({
      healthCheck: false,
      outputLastMessageFile: '/tmp/codex-output.txt',
      outputSchemaFile: '/tmp/codex-schema.json',
      disableTools: true,
      skipGitRepoCheck: true,
    });

    expect(args).toEqual(
      expect.arrayContaining([
        '--skip-git-repo-check',
        '--disable',
        'shell_tool',
        'unified_exec',
        'browser_use',
        'computer_use',
        'plugins',
      ])
    );
    expect(args.indexOf('--skip-git-repo-check')).toBe(1);
  });

  it('sanitizes spawned Codex environment', () => {
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/runner';
    process.env.CODEX_HOME = '/tmp/codex';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.GITHUB_TOKEN = 'gh-token';
    process.env.INPUT_GITHUB_TOKEN = 'input-token';
    process.env.OPENROUTER_API_KEY = 'or-key';

    const provider = new CodexProvider('gpt-5.4-mini');
    const env = (provider as any).buildSafeEnv();

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/runner');
    expect(env.CODEX_HOME).toBe('/tmp/codex');
    expect(env.OPENAI_API_KEY).toBe('sk-test');
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.INPUT_GITHUB_TOKEN).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('allows agentic review findings for concrete user-visible regressions', async () => {
    const provider = new CodexProvider('gpt-5.4-mini');
    const prompt = await (provider as any).wrapAgenticReviewPrompt(
      'review prompt'
    );

    expect(prompt).toContain('user-visible functional regressions');
    expect(prompt).toContain('permanent loading');
    expect(prompt).toContain('stale UI state');
    expect(prompt).toContain('create/update/delete side effects');
    expect(prompt).toContain('dead-end navigation');
    expect(prompt).toContain('wrong access control state');
    expect(prompt).toContain('Universal context discovery checklist');
    expect(prompt).toContain('package.json');
    expect(prompt).toContain('pubspec.lock');
    expect(prompt).toContain('go.mod');
    expect(prompt).toContain('pyproject.toml');
    expect(prompt).toContain('Cargo.toml');
    expect(prompt).toContain('trace the nearest imports/includes/exports');
    expect(prompt).toContain('treat the issue as insufficiently proven');
  });

  it('parses strict schema findings with nullable suggestion', () => {
    const provider = new CodexProvider('gpt-5.4-mini');
    const findings = (provider as any).extractFindings(
      JSON.stringify({
        findings: [
          {
            file: 'src/app.ts',
            line: 42,
            severity: 'major',
            title: 'Crash',
            message: 'This can crash.',
            suggestion: null,
          },
        ],
      })
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'src/app.ts',
      line: 42,
      severity: 'major',
    });
    expect(findings[0].suggestion).toBeUndefined();
  });

  it('reads final review content from --output-last-message instead of stdout', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess(() => {
        const outputIndex = args.indexOf('--output-last-message');
        const outputFile = args[outputIndex + 1];
        fs.writeFileSync(outputFile, '{"findings":[]}');
      });
    });

    const provider = new CodexProvider('gpt-5.4-mini', {
      agenticContext: true,
      eventAudit: false,
    });
    const result = await provider.review('review prompt', 1000);
    const execCall = spawnMock.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1][0] === 'exec'
    );

    expect(result.content).toBe('{"findings":[]}');
    expect(result.findings).toEqual([]);
    expect(execCall).toBeTruthy();
    expect(execCall?.[1]).toContain('--output-schema');
    expect(execCall?.[1]).not.toContain(
      '--dangerously-bypass-approvals-and-sandbox'
    );
  });

  it('fails review when Codex returns invalid JSON instead of silently passing', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess(() => {
        const outputIndex = args.indexOf('--output-last-message');
        fs.writeFileSync(args[outputIndex + 1], 'not json');
      });
    });

    const provider = new CodexProvider('gpt-5.4-mini', {
      agenticContext: false,
    });

    await expect(provider.review('review prompt', 1000)).rejects.toThrow(
      'Codex CLI returned invalid review JSON'
    );
  });

  it('sanitizes Codex CLI failure messages before surfacing them', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return createMockProcess();
      }

      return createMockProcess((proc) => {
        proc.stderr.emit(
          'data',
          [
            'invalid_request_error: auth failed',
            'https://auth.openai.com/device?user_code=secret',
            'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
            '"refresh_token":"refresh-secret"',
          ].join('\n')
        );
      }, 1);
    });

    const provider = new CodexProvider('gpt-5.4-mini', {
      agenticContext: false,
    });

    let thrown: Error | undefined;
    try {
      await provider.review('review prompt', 1000);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toContain('Codex CLI failed with exit code 1');
    expect(thrown?.message).not.toContain('auth.openai.com');
    expect(thrown?.message).not.toContain(
      'sk-proj-abcdefghijklmnopqrstuvwxyz123456'
    );
    expect(thrown?.message).not.toContain('refresh-secret');
  });

  it('redacts secrets from raw Codex CLI error text', () => {
    const provider = new CodexProvider('gpt-5.4-mini');
    const formatted = (provider as any).formatCliError(
      [
        'https://auth.openai.com/device?user_code=secret',
        'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
        '"refresh_token":"refresh-secret"',
      ].join('\n'),
      ''
    );

    expect(formatted).toContain('[redacted-url]');
    expect(formatted).toContain('[redacted-openai-key]');
    expect(formatted).toContain('"refresh_token":"[redacted]"');
    expect(formatted).not.toContain('auth.openai.com');
    expect(formatted).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz123456');
    expect(formatted).not.toContain('refresh-secret');
  });

  it('passes only sanitized env to review spawn', async () => {
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/runner';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.GITHUB_TOKEN = 'gh-token';
    process.env.INPUT_GITHUB_TOKEN = 'input-token';
    process.env.OPENROUTER_API_KEY = 'or-key';

    spawnMock.mockImplementation(
      (_cmd: string, args: string[], _options: any) => {
        if (args.includes('--version')) {
          return createMockProcess();
        }

        return createMockProcess(() => {
          const outputIndex = args.indexOf('--output-last-message');
          fs.writeFileSync(args[outputIndex + 1], '{"findings":[]}');
        });
      }
    );

    const provider = new CodexProvider('gpt-5.4-mini');
    await provider.review('review prompt', 1000);

    const execCall = spawnMock.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1][0] === 'exec'
    );
    const env = execCall?.[2]?.env;

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/runner');
    expect(env.OPENAI_API_KEY).toBe('sk-test');
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.INPUT_GITHUB_TOKEN).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('runs structured prompts in isolated cwd without workspace env or tools', async () => {
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/runner';
    process.env.GITHUB_WORKSPACE = '/home/runner/work/repo/repo';

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-structured-cwd-'));
    spawnMock.mockImplementation(
      (_cmd: string, args: string[], _options: any) => {
        if (args.includes('--version')) {
          return createMockProcess();
        }

        return createMockProcess(() => {
          const outputIndex = args.indexOf('--output-last-message');
          fs.writeFileSync(args[outputIndex + 1], '{"ok":true}');
        });
      }
    );

    try {
      const provider = new CodexProvider('gpt-5.4-mini');
      const content = await provider.runStructuredPrompt(
        'Return JSON',
        {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: { ok: { type: 'boolean' } },
        },
        1000,
        { cwd, includeWorkspaceEnv: false }
      );

      const execCall = spawnMock.mock.calls.find(
        (call) => Array.isArray(call[1]) && call[1][0] === 'exec'
      );
      expect(content).toBe('{"ok":true}');
      expect(execCall?.[2]?.cwd).toBe(cwd);
      expect(execCall?.[2]?.env.GITHUB_WORKSPACE).toBeUndefined();
      expect(execCall?.[1]).toEqual(
        expect.arrayContaining([
          '--ignore-rules',
          '--disable',
          'shell_tool',
          'unified_exec',
          'browser_use',
          'plugins',
        ])
      );
      expect(execCall?.[1]).not.toContain('--skip-git-repo-check');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('builds deterministic repository context seed from changed files and relative imports', async () => {
    const oldCwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-context-seed-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src/passwordReset.js'),
      "import { getPolicy } from './ratePolicies.js';\nconst policy = getPolicy('marketingEmailPreview');\n"
    );
    fs.writeFileSync(
      path.join(dir, 'src/ratePolicies.js'),
      'export const RATE_POLICIES = { passwordReset: { maxAttemptsPerHour: 3 } };\n'
    );

    try {
      process.chdir(dir);
      const provider = new CodexProvider('gpt-5.4-mini');
      const seed = await (provider as any).buildRepositoryContextSeed(
        [
          'Files changed:',
          '- src/passwordReset.js (modified, +1/-1)',
          '',
          'Diff:',
          'diff --git a/src/passwordReset.js b/src/passwordReset.js',
        ].join('\n')
      );

      expect(seed).toContain('DETERMINISTIC REPOSITORY CONTEXT SEED');
      expect(seed).toContain('role="changed"');
      expect(seed).toContain('src/passwordReset.js');
      expect(seed).toContain('role="related"');
      expect(seed).toContain('src/ratePolicies.js');
      expect(seed).toContain('maxAttemptsPerHour: 3');
    } finally {
      process.chdir(oldCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds Dart package imports and identifier-related files to context seed', async () => {
    const oldCwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dart-context-'));
    fs.mkdirSync(path.join(dir, 'app/lib/src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'app/lib/data'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'server/lib/src/crud'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app/pubspec.yaml'), 'name: app\n');
    fs.writeFileSync(path.join(dir, 'server/pubspec.yaml'), 'name: server\n');
    fs.writeFileSync(
      path.join(dir, 'app/lib/data/repository_actions_extension.dart'),
      'class DwRepository { static Future<bool> deleteModel(Object model) async => true; }\n'
    );
    fs.writeFileSync(
      path.join(dir, 'server/lib/src/crud/lesson_crud_config.dart'),
      'final lessonCrudConfig = DwDeleteConfig(afterDelete: notifyGeneralUpdates);\n'
    );
    fs.writeFileSync(
      path.join(dir, 'server/lib/src/crud/course_crud_config.dart'),
      [
        "import 'package:app/data/repository_actions_extension.dart';",
        'final courseCrudConfig = DwDeleteConfig(allowDelete: canDelete);',
        'final channel = UpdateChannels.generalUpdatesChannel;',
      ].join('\n')
    );

    try {
      process.chdir(dir);
      const provider = new CodexProvider('gpt-5.4-mini');
      const seed = await (provider as any).buildRepositoryContextSeed(
        [
          'Files changed:',
          '- server/lib/src/crud/course_crud_config.dart (modified, +1/-1)',
          '',
          'Diff:',
          'diff --git a/server/lib/src/crud/course_crud_config.dart b/server/lib/src/crud/course_crud_config.dart',
        ].join('\n')
      );

      expect(seed).toContain('server/lib/src/crud/course_crud_config.dart');
      expect(seed).toContain('app/lib/data/repository_actions_extension.dart');
      expect(seed).toContain('server/lib/src/crud/lesson_crud_config.dart');
      expect(seed).toContain('afterDelete: notifyGeneralUpdates');
    } finally {
      process.chdir(oldCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses git dependency metadata from pubspec.lock for dependency context', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lock-'));
    const lockfile = path.join(dir, 'pubspec.lock');
    fs.writeFileSync(
      lockfile,
      [
        'packages:',
        '  dartway_serverpod_core_server:',
        '    dependency: "direct main"',
        '    description:',
        '      path: "packages/dartway_serverpod_core/dartway_serverpod_core_server"',
        '      ref: master',
        '      resolved-ref: "39ec91e397daec37f5252cd1291c9aa72e434ea1"',
        '      url: "https://github.com/dartway/dartway.git"',
        '    source: git',
        '    version: "0.0.0"',
      ].join('\n')
    );

    try {
      const provider = new CodexProvider('gpt-5.4-mini');
      expect(
        (provider as any).parseGitDependencyFromLockfile(
          lockfile,
          'dartway_serverpod_core_server'
        )
      ).toEqual({
        url: 'https://github.com/dartway/dartway.git',
        ref: '39ec91e397daec37f5252cd1291c9aa72e434ea1',
        path: 'packages/dartway_serverpod_core/dartway_serverpod_core_server',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sanitizes absolute workspace paths from model output', () => {
    const provider = new CodexProvider('gpt-5.4-mini');
    const content = (provider as any).sanitizeReviewContent(
      '{"message":"See [src/ratePolicies.js](/home/runner/work/repo/repo/src/ratePolicies.js)"}'
    );

    expect(content).toContain('[src/ratePolicies.js](src/ratePolicies.js)');
    expect(content).not.toContain('/home/runner/work/');
  });
});
