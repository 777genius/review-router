import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { CodexProvider } from '../../../src/providers/codex';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

const spawnMock = spawn as unknown as jest.Mock;

function createMockProcess(onStart?: () => void): any {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  proc.pid = 12345;

  process.nextTick(() => {
    onStart?.();
    proc.emit('close', 0);
  });

  return proc;
}

describe('CodexProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
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
    expect(args).toContain('--output-schema');
    expect(args).toContain('/tmp/codex-schema.json');
    expect(args).toContain('--output-last-message');
    expect(args).toContain('/tmp/codex-output.txt');
    expect(args).toContain('--json');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
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
      suggestion: null,
    });
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
      "export const RATE_POLICIES = { passwordReset: { maxAttemptsPerHour: 3 } };\n"
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
});
