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

const CLAUDE_STDIN_LIMIT_BYTES = 10 * 1024 * 1024;
const CLAUDE_CODE_OAUTH_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

export class ClaudeCodeProvider extends Provider {
  constructor(private readonly model: string) {
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
    const started = Date.now();

    this.assertPromptWithinStdinLimit(prompt);
    const oauthToken = this.readClaudeCodeOAuthToken();

    const binary = await this.resolveBinary();
    const schema = JSON.stringify(buildReviewFindingsSchema());
    const args = [
      '--model',
      this.model,
      '--print',
      '--no-session-persistence',
      '--setting-sources',
      'user',
      '--disable-slash-commands',
      '--no-chrome',
      '--tools',
      '',
      '--output-format',
      'json',
      '--json-schema',
      schema,
    ];

    logger.info(
      `Running Claude Code CLI safely: ${binary} --model ${this.model} --print --output-format json ...`
    );

    try {
      const { stdout, stderr } = await this.runCliWithStdin(
        binary,
        args,
        prompt,
        timeoutMs,
        oauthToken
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
        usage: this.estimateUsage(prompt, content),
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
    bin: string,
    args: string[],
    stdin: string,
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
      await fs.writeFile(promptFile, stdin, { encoding: 'utf8', mode: 0o600 });
      fd = await fs.open(promptFile, 'r');
      const fdNum = fd.fd;

      return await new Promise((resolve, reject) => {
        const proc = spawn(bin, args, {
          stdio: [fdNum, 'pipe', 'pipe'],
          detached: true,
          env: this.buildSafeEnv({
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

  private buildSafeEnv(
    options: { claudeConfigDir?: string; oauthToken?: string } = {}
  ): NodeJS.ProcessEnv {
    const overrides: NodeJS.ProcessEnv = {};
    if (options.claudeConfigDir) {
      overrides.CLAUDE_CONFIG_DIR = options.claudeConfigDir;
    }
    if (options.oauthToken) {
      overrides[CLAUDE_CODE_OAUTH_TOKEN_ENV] = options.oauthToken;
    }

    return buildCliSafeEnv({
      extraAllowedKeys: [CLAUDE_CODE_OAUTH_TOKEN_ENV],
      overrides,
    });
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
