import { Provider } from './base';
import { Finding, ReviewResult } from '../types';
import { logger } from '../utils/logger';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { estimateTokensSimple } from '../utils/token-estimation';
import { buildCliSafeEnv } from './cli-env';
import {
  buildReviewFindingsSchema,
  parseReviewOutputStrict,
  parseReviewFindingsStrict,
} from './review-output';
import {
  createPreparedProviderInvocation,
  type PreparedProviderInvocation,
  type ProviderCredentialLease,
  ProviderKind,
  requirePreparedProviderInvocation,
} from './prepared-invocation';

const CLAUDE_STDIN_LIMIT_BYTES = 10 * 1024 * 1024;
const CLAUDE_CODE_OAUTH_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

type ClaudeCodeProviderOptions = {
  readonly agenticContext?: boolean;
};

type ClaudeCodePreparedRequest = {
  readonly binary: string;
  readonly prompt: string;
  readonly argsTemplate: readonly string[];
  readonly forkArgsTemplate: readonly string[];
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly forkSandbox: boolean;
  readonly forkSafeSettings: unknown | null;
};

const CLAUDE_SETTINGS_FILE_PLACEHOLDER = '{reviewrouter_settings_file}';

export class ClaudeCodeProvider extends Provider {
  constructor(
    private readonly model: string,
    private readonly options: ClaudeCodeProviderOptions = {}
  ) {
    super(`claude/${model}`);
  }

  // Lightweight health check: verify CLI is available
  async healthCheck(_timeoutMs: number = 5000): Promise<boolean> {
    const timeoutMs = Math.max(500, _timeoutMs ?? 5000);

    let timeoutId: NodeJS.Timeout;
    let isTimedOut = false;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        isTimedOut = true;
        reject(
          new Error(`Claude Code health check timed out after ${timeoutMs}ms`)
        );
      }, timeoutMs);
    });

    try {
      await Promise.race([
        this.resolveBinary().then(() => {
          if (isTimedOut) {
            logger.debug(
              `Claude Code binary resolved after timeout (${this.name})`
            );
          }
        }),
        timeoutPromise,
      ]);
      clearTimeout(timeoutId!);
      return true;
    } catch (error) {
      if (timeoutId!) {
        clearTimeout(timeoutId);
      }
      logger.warn(
        `Claude Code health check failed for ${this.name}: ${(error as Error).message}`
      );
      return false;
    }
  }

  async review(prompt: string, timeoutMs: number): Promise<ReviewResult> {
    const oauthToken = this.readClaudeCodeOAuthToken();
    const invocation = await this.prepareInvocation(prompt, timeoutMs);
    const result = await this.executePreparedInvocation(invocation, {
      bearerToken: oauthToken,
    });
    return {
      ...result,
      usage: this.estimateUsage(prompt, result.content),
    };
  }

  async prepareInvocation(
    prompt: string,
    timeoutMs: number
  ): Promise<PreparedProviderInvocation<ClaudeCodePreparedRequest>> {
    const forkSandbox = this.isForkSandboxMode();
    const agenticContext = this.options.agenticContext === true || forkSandbox;
    const reviewPrompt = agenticContext
      ? this.wrapReadOnlyAgenticPrompt(prompt)
      : prompt;
    this.assertPromptWithinStdinLimit(reviewPrompt);
    const binary = await this.resolveBinary();
    const argsTemplate = [
      '--model',
      this.model,
      '--print',
      '--no-session-persistence',
      '--setting-sources',
      'user',
      '--disable-slash-commands',
      '--no-chrome',
      ...this.buildToolArgs(agenticContext),
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(buildReviewFindingsSchema()),
    ];

    return createPreparedProviderInvocation({
      providerKind: ProviderKind.ClaudeCodeCli,
      providerName: this.name,
      requestedModel: this.model,
      timeoutMs,
      request: {
        binary,
        prompt: reviewPrompt,
        argsTemplate,
        forkArgsTemplate: forkSandbox
          ? this.buildForkSafeArgs(CLAUDE_SETTINGS_FILE_PLACEHOLDER)
          : [],
        environment: this.buildSafeEnv({ forkSandbox }),
        forkSandbox,
        forkSafeSettings: forkSandbox ? this.buildForkSafeSettings() : null,
      },
    });
  }

  async executePreparedInvocation(
    invocation: PreparedProviderInvocation,
    credentialLease?: ProviderCredentialLease
  ): Promise<ReviewResult> {
    const prepared =
      requirePreparedProviderInvocation<ClaudeCodePreparedRequest>(
        invocation,
        ProviderKind.ClaudeCodeCli,
        this.name
      );
    const request = prepared.request;
    const started = Date.now();

    logger.info(
      `Running Claude Code CLI safely: ${request.binary} --model ${prepared.requestedModel} --print --output-format json ...`
    );

    try {
      const { stdout, stderr } = await this.runCliWithStdin(
        request,
        prepared.timeoutMs,
        credentialLease?.bearerToken
      );
      const content = this.extractReviewContent(stdout);
      const durationSeconds = (Date.now() - started) / 1000;
      logger.info(
        `Claude Code CLI output for ${this.name}: final=${content.length} bytes, stdout=${stdout.length} bytes, stderr=${stderr.length} bytes, duration=${durationSeconds.toFixed(1)}s`
      );
      if (!content) {
        throw new Error(
          `Claude Code CLI returned no output${stderr ? `; stderr: ${stderr.slice(0, 200)}` : ''}`
        );
      }
      const parsed = parseReviewOutputStrict(content, 'Claude Code CLI');
      return {
        content,
        durationSeconds,
        usage: this.estimateUsage(request.prompt, content),
        findings: parsed.findings,
        revalidations: parsed.revalidations,
      };
    } catch (error) {
      logger.error(`Claude Code provider failed: ${this.name}`, error as Error);
      throw error;
    }
  }

  private estimateUsage(prompt: string, content: string) {
    const promptTokens = estimateTokensSimple(prompt).tokens;
    const completionTokens = estimateTokensSimple(content).tokens;

    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }

  private assertPromptWithinStdinLimit(prompt: string): void {
    const promptBytes = Buffer.byteLength(prompt, 'utf8');
    if (promptBytes <= CLAUDE_STDIN_LIMIT_BYTES) {
      return;
    }

    throw new Error(
      `Claude Code CLI stdin input is ${promptBytes} bytes, above the ${CLAUDE_STDIN_LIMIT_BYTES} byte limit. Reduce DIFF_MAX_BYTES or split the review into smaller batches.`
    );
  }

  private buildToolArgs(agenticContext: boolean): string[] {
    if (!agenticContext) {
      return ['--tools', ''];
    }

    return [
      '--tools',
      'Read,Grep,Glob',
      '--allowedTools',
      'Read,Grep,Glob',
      '--max-turns',
      '4',
    ];
  }

  private wrapReadOnlyAgenticPrompt(prompt: string): string {
    return [
      'You are running inside ReviewRouter Claude read-only context mode.',
      'You may inspect repository files only with Read, Grep, and Glob.',
      'Do not use Bash, shell commands, MCP tools, Edit, Write, or any mutation-capable tool.',
      'Do not modify files, create files, update git state, install packages, or persist a session.',
      'Report findings only for changed lines that are supported by the supplied PR diff and any read-only file inspection.',
      '',
      prompt,
    ].join('\n');
  }

  private readClaudeCodeOAuthToken(): string | undefined {
    const rawToken = process.env[CLAUDE_CODE_OAUTH_TOKEN_ENV];
    if (rawToken === undefined) {
      return undefined;
    }

    const token = rawToken.trim();
    if (!token) {
      throw new Error(
        `${CLAUDE_CODE_OAUTH_TOKEN_ENV} is set but empty. Run \`claude setup-token\` and store only the printed token as the GitHub Actions secret.`
      );
    }

    if (this.looksLikeShellInputInsteadOfToken(token)) {
      throw new Error(
        `${CLAUDE_CODE_OAUTH_TOKEN_ENV} does not look like a Claude setup-token value. ` +
          'It appears to contain whitespace, a pipe, or shell command text. ' +
          'GitHub secrets store stdin exactly, so copy only the token printed by `claude setup-token`, not the `gh secret set` command.'
      );
    }

    if (!this.hasExpectedClaudeCodeOAuthTokenShape(token)) {
      throw new Error(
        `${CLAUDE_CODE_OAUTH_TOKEN_ENV} does not look like a Claude setup-token value. ` +
          'Expected a token starting with `sk-ant-oat01-` and containing no quotes or surrounding text.'
      );
    }

    return token;
  }

  private looksLikeShellInputInsteadOfToken(token: string): boolean {
    return (
      /[\s|]/.test(token) ||
      /\b(?:pbpaste|gh\s+secret\s+set|claude\s+setup-token)\b/i.test(token) ||
      token.includes(CLAUDE_CODE_OAUTH_TOKEN_ENV)
    );
  }

  private hasExpectedClaudeCodeOAuthTokenShape(token: string): boolean {
    return /^sk-ant-oat01-[A-Za-z0-9._-]+$/.test(token);
  }

  private async runCliWithStdin(
    request: Readonly<ClaudeCodePreparedRequest>,
    timeoutMs: number,
    oauthToken?: string
  ): Promise<{ stdout: string; stderr: string }> {
    const runId = crypto.randomBytes(8).toString('hex');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-'));
    await fs.chmod(tmpDir, 0o700);
    const promptFile = path.join(tmpDir, `prompt-${runId}.txt`);
    const claudeConfigDir = path.join(tmpDir, 'config');
    let fd: fs.FileHandle | undefined;

    try {
      await fs.mkdir(claudeConfigDir, { mode: 0o700 });
      await fs.writeFile(promptFile, request.prompt, {
        encoding: 'utf8',
        mode: 0o600,
      });
      fd = await fs.open(promptFile, 'r');
      const fdNum = fd.fd;
      const effectiveArgs = [...request.argsTemplate];
      if (request.forkSandbox) {
        const settingsPath = path.join(tmpDir, 'fork-safe-settings.json');
        await fs.writeFile(
          settingsPath,
          JSON.stringify(request.forkSafeSettings),
          { encoding: 'utf8', mode: 0o600 }
        );
        effectiveArgs.push(
          ...request.forkArgsTemplate.map((argument) =>
            argument.replace(CLAUDE_SETTINGS_FILE_PLACEHOLDER, settingsPath)
          )
        );
      }

      return await new Promise((resolve, reject) => {
        const proc = spawn(request.binary, effectiveArgs, {
          stdio: [fdNum, 'pipe', 'pipe'],
          detached: true,
          env: this.buildExecutionEnv(request.environment, {
            claudeConfigDir: oauthToken ? claudeConfigDir : undefined,
            oauthToken,
          }),
        });

        if (proc.unref) {
          proc.unref();
        }

        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          logger.warn(
            `Claude Code CLI timeout (${timeoutMs}ms), killing process and all children`
          );

          try {
            if (proc.pid) {
              process.kill(-proc.pid, 'SIGKILL');
            }
          } catch {
            proc.kill('SIGKILL');
          }

          reject(new Error(`Claude Code CLI timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        proc.stdout?.on('data', (chunk) => {
          stdout += chunk.toString();
        });
        proc.stderr?.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        proc.on('error', (err) => {
          if (!timedOut) {
            clearTimeout(timer);
            reject(err);
          }
        });
        proc.on('close', (code) => {
          if (!timedOut) {
            clearTimeout(timer);
            if (code !== 0) {
              reject(
                new Error(
                  `Claude Code CLI exited with code ${code}: ${this.formatCliError(stderr, stdout)}`
                )
              );
            } else {
              resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
            }
          }
        });
      });
    } finally {
      try {
        if (fd) {
          await fd.close();
        }
        await fs.unlink(promptFile);
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors.
      }
    }
  }

  private buildSafeEnv(options: { forkSandbox: boolean }): NodeJS.ProcessEnv {
    return buildCliSafeEnv({
      includeWorkspaceEnv: !options.forkSandbox,
    });
  }

  private buildExecutionEnv(
    baseEnvironment: Readonly<NodeJS.ProcessEnv>,
    options: { claudeConfigDir?: string; oauthToken?: string } = {}
  ): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...baseEnvironment };
    if (options.claudeConfigDir) {
      environment.CLAUDE_CONFIG_DIR = options.claudeConfigDir;
    }
    if (options.oauthToken) {
      environment[CLAUDE_CODE_OAUTH_TOKEN_ENV] = options.oauthToken;
    }
    return environment;
  }

  private isForkSandboxMode(): boolean {
    return this.parseBooleanEnv(
      process.env.REVIEWROUTER_FORK_AGENTIC_SANDBOX,
      false
    );
  }

  private parseBooleanEnv(
    value: string | undefined,
    defaultValue: boolean
  ): boolean {
    if (value === undefined || value === '') return defaultValue;
    return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
  }

  private buildForkSafeArgs(settingsPath: string): string[] {
    return [
      '--safe-mode',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--permission-mode',
      'dontAsk',
      '--settings',
      settingsPath,
      '--disallowedTools',
      'Bash,Edit,Write,mcp__*',
    ];
  }

  private buildForkSafeSettings(): unknown {
    return {
      permissions: {
        defaultMode: 'dontAsk',
        disableBypassPermissionsMode: 'disable',
        allow: ['Read', 'Grep', 'Glob'],
        deny: [
          'Bash',
          'Edit',
          'Write',
          'mcp__*',
          'Read(../.reviewrouter-codex-home/**)',
          'Read(../.git/**)',
          'Read(.git/**)',
          'Read(./.git/**)',
          'Read(.claude/**)',
          'Read(./.claude/**)',
          'Read(CLAUDE.md)',
          'Read(./CLAUDE.md)',
          'Read(**/CLAUDE.md)',
          'Read(**/.env)',
          'Read(**/.env.*)',
          'Read(**/auth.json)',
          'Read(**/.aws/**)',
          'Read(**/.ssh/**)',
          'Read(**/.config/gh/**)',
        ],
      },
    };
  }

  private formatCliError(stderr: string, stdout: string): string {
    const text = `${stderr || stdout || 'no output'}`.trim();
    const hint = this.authHintFor(text);
    const message = hint ? `${text}\n${hint}` : text;
    return message.length > 1600
      ? `${message.slice(0, 1600)}\n... truncated ...`
      : message;
  }

  private authHintFor(message: string): string {
    const lower = message.toLowerCase();
    if (
      lower.includes('not logged in') ||
      lower.includes('authentication') ||
      lower.includes('oauth') ||
      lower.includes('unauthorized') ||
      lower.includes('401') ||
      lower.includes('403')
    ) {
      return 'Hint: for Claude subscription OAuth in CI, generate a token with `claude setup-token` and expose it as `CLAUDE_CODE_OAUTH_TOKEN`. Do not pass `--bare`, because bare mode does not read Claude OAuth tokens.';
    }
    return '';
  }

  private extractReviewContent(stdout: string): string {
    const trimmed = stdout.trim();
    if (!trimmed) return '';

    try {
      const parsed = JSON.parse(trimmed) as {
        result?: unknown;
        structured_output?: unknown;
      };

      if (parsed.structured_output !== undefined) {
        return JSON.stringify(parsed.structured_output);
      }
      if (typeof parsed.result === 'string') {
        return parsed.result.trim();
      }
    } catch {
      // Fall back to plain JSON/text parsing below.
    }

    return trimmed;
  }

  private async resolveBinary(): Promise<string> {
    // Try claude command directly
    if (await this.canRun('claude', ['--version'])) {
      return 'claude';
    }
    // Try /usr/local/bin/claude
    if (await this.canRun('/usr/local/bin/claude', ['--version'])) {
      return '/usr/local/bin/claude';
    }
    // Try ~/.local/bin/claude
    const homeDir = os.homedir();
    const localBin = path.join(homeDir, '.local', 'bin', 'claude');
    if (await this.canRun(localBin, ['--version'])) {
      return localBin;
    }
    throw new Error(
      'Claude Code CLI is not available (tried: claude, /usr/local/bin/claude, ~/.local/bin/claude)'
    );
  }

  private async canRun(cmd: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(cmd, args, { stdio: 'ignore' });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
  }

  private extractFindingsStrict(content: string): Finding[] {
    return parseReviewFindingsStrict(content, 'Claude Code CLI');
  }
}
