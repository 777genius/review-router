import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeCodeProvider } from '../../src/providers/claude-code';

describe('Claude CLI credential isolation - actual subprocess / synthetic output', () => {
  const originalEnv = process.env;
  let dir: string;
  let cli: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-claude-dual-auth-'));
    cli = path.join(dir, 'synthetic-claude');
    // This executable is NOT Claude Code: it verifies the actual OS spawn,
    // sanitized environment, stdin, flags and reply parser without an upstream.
    await fs.writeFile(cli, [
      '#!/usr/bin/env node',
      'const fs = require("fs");',
      'const env = process.env;',
      'const api = env.ANTHROPIC_API_KEY;',
      'const oauth = env.CLAUDE_CODE_OAUTH_TOKEN;',
      'const args = process.argv.slice(2);',
      'const input = fs.readFileSync(0, "utf8");',
      'const fail = (reason) => { process.stderr.write(reason); process.exit(9); };',
      'if (Boolean(api) === Boolean(oauth)) fail("exactly one auth method required");',
      'if (!env.CLAUDE_CONFIG_DIR) fail("isolated credential directory missing");',
      'if (env.ANTHROPIC_AUTH_TOKEN || env.GITHUB_TOKEN || env.INPUT_GITHUB_TOKEN) fail("ambient credentials leaked");',
      'if (!args.includes("--print") || !args.includes("--json-schema") || args.includes("--bare")) fail("unsafe CLI flags");',
      'if (!input.includes("synthetic review input")) fail("stdin not connected");',
      'process.stdout.write(JSON.stringify({structured_output:{findings:[],revalidations:[]}}));',
    ].join('\n') + '\n', { mode: 0o700 });
    await fs.chmod(cli, 0o700);
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.ANTHROPIC_AUTH_TOKEN = 'must-never-reach-child';
    process.env.GITHUB_TOKEN = 'must-never-reach-child';
    process.env.INPUT_GITHUB_TOKEN = 'must-never-reach-child';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it.each([
    {
      mode: 'claude-api-key' as const,
      credential: 'sk-ant-api03-synthetic-key-only',
    },
    {
      mode: 'claude-oauth' as const,
      credential: 'sk-ant-oat01-synthetic-subscription-only',
    },
  ])('runs the same real process and review decoder with $mode', async ({
    mode,
    credential,
  }) => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-other-unselected';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-other-unselected';
    process.env[
      mode === 'claude-api-key' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN'
    ] = credential;

    const provider = new ClaudeCodeProvider('sonnet', { authMode: mode });
    Object.defineProperty(provider, 'resolveBinary', {
      configurable: true,
      value: async () => cli,
    });
    const result = await provider.review('synthetic review input', 9000);
    expect(result.findings).toEqual([]);
    expect(result.revalidations).toEqual([]);
    expect(result.content).toEqual('{"findings":[],"revalidations":[]}');
  }, 15000);
});
