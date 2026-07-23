import { Provider } from './base';
import { ReviewResult } from '../types';
import { logger } from '../utils/logger';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { parseReviewOutputStrict } from './review-output';
import {
  createPreparedProviderInvocation,
  mergeCredentialEnvironment,
  type PreparedProviderInvocation,
  type ProviderCredentialLease,
  ProviderKind,
  requirePreparedProviderInvocation,
  snapshotCredentialEnvironment,
  splitProviderEnvironment,
} from './prepared-invocation';

type OpenCodePreparedRequest = {
  readonly binary: string;
  readonly argsTemplate: readonly string[];
  readonly prompt: string;
  readonly cwd: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly environmentContract: Readonly<Record<string, string>>;
};

const OPENCODE_PROMPT_FILE_PLACEHOLDER = '{reviewrouter_prompt_file}';

export class OpenCodeProvider extends Provider {
  constructor(private readonly modelId: string) {
    super(`opencode/${modelId}`);
  }

  // Lightweight health check: verify CLI is available; skip full review run
  async healthCheck(_timeoutMs: number = 5000): Promise<boolean> {
    const timeoutMs = Math.max(500, _timeoutMs ?? 5000);

    // Use timeout tracking to detect promise leaks
    let timeoutId: NodeJS.Timeout;
    let isTimedOut = false;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        isTimedOut = true;
        reject(
          new Error(`OpenCode health check timed out after ${timeoutMs}ms`)
        );
      }, timeoutMs);
    });

    try {
      await Promise.race([
        this.resolveBinary().then(() => {
          // If timeout already fired, we still succeeded - log for debugging
          if (isTimedOut) {
            logger.debug(
              `OpenCode binary resolved after timeout (${this.name})`
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
        `OpenCode health check failed for ${this.name}: ${(error as Error).message}`
      );
      return false;
    }
  }

  async review(prompt: string, timeoutMs: number): Promise<ReviewResult> {
    const environment = splitProviderEnvironment(
      snapshotCredentialEnvironment()
    );
    const invocation = await this.prepareInvocationWithEnvironment(
      prompt,
      timeoutMs,
      environment
    );
    return this.executePreparedInvocation(invocation, {
      environment: environment.credentialEnvironment,
    });
  }

  async prepareInvocation(
    prompt: string,
    timeoutMs: number
  ): Promise<PreparedProviderInvocation<OpenCodePreparedRequest>> {
    return this.prepareInvocationWithEnvironment(
      prompt,
      timeoutMs,
      splitProviderEnvironment(snapshotCredentialEnvironment())
    );
  }

  private async prepareInvocationWithEnvironment(
    prompt: string,
    timeoutMs: number,
    environment: ReturnType<typeof splitProviderEnvironment>
  ): Promise<PreparedProviderInvocation<OpenCodePreparedRequest>> {
    const { bin, args: baseArgs } = await this.resolveBinary();
    const cliModel = this.modelId.startsWith('opencode/')
      ? this.modelId
      : `opencode/${this.modelId}`;
    return createPreparedProviderInvocation({
      providerKind: ProviderKind.OpenCodeCli,
      providerName: this.name,
      requestedModel: cliModel,
      timeoutMs,
      request: {
        binary: bin,
        argsTemplate: [
          ...baseArgs,
          'run',
          '-m',
          cliModel,
          '--file',
          OPENCODE_PROMPT_FILE_PLACEHOLDER,
          '--',
          'Review the attached PR context and provide structured findings.',
        ],
        prompt,
        cwd: process.cwd(),
        environment: environment.runtimeEnvironment,
        environmentContract: environment.contract,
      },
    });
  }

  async executePreparedInvocation(
    invocation: PreparedProviderInvocation,
    credentialLease?: ProviderCredentialLease
  ): Promise<ReviewResult> {
    const prepared = requirePreparedProviderInvocation<OpenCodePreparedRequest>(
      invocation,
      ProviderKind.OpenCodeCli,
      this.name
    );
    const request = prepared.request;
    if (!credentialLease?.environment) {
      throw new Error('opencode_credential_lease_missing');
    }
    const started = Date.now();

    // Write prompt to temp file to avoid command line length limits
    const tmpRoot = path.join(request.cwd, '.reviewrouter-opencode');
    await fs.mkdir(tmpRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(tmpRoot, 0o700).catch(() => undefined);
    const tmpDir = await fs.mkdtemp(path.join(tmpRoot, 'opencode-'));
    await fs.chmod(tmpDir, 0o700);
    const promptFile = path.join(
      tmpDir,
      `prompt-${crypto.randomBytes(8).toString('hex')}.txt`
    );
    await fs.writeFile(promptFile, request.prompt, {
      encoding: 'utf8',
      mode: 0o600,
    });

    const args = request.argsTemplate.map((argument) =>
      argument.replace(OPENCODE_PROMPT_FILE_PLACEHOLDER, promptFile)
    );

    logger.info(
      `Running OpenCode CLI: ${request.binary} ${args.slice(0, 3).join(' ')} …`
    );

    try {
      const { stdout, stderr } = await this.runCli(
        request.binary,
        args,
        prepared.timeoutMs,
        request.cwd,
        mergeCredentialEnvironment(
          request.environment,
          credentialLease.environment
        )
      );
      const content = stdout.trim();
      const durationSeconds = (Date.now() - started) / 1000;
      logger.info(
        `OpenCode CLI output for ${this.name}: stdout=${stdout.length} bytes, stderr=${stderr.length} bytes, duration=${durationSeconds.toFixed(1)}s`
      );
      if (!content) {
        throw new Error(
          `OpenCode CLI returned no output${stderr ? `; stderr: ${stderr.slice(0, 200)}` : ''}`
        );
      }
      const parsedOutput = parseReviewOutputStrict(content, 'OpenCode CLI');
      return {
        content,
        durationSeconds,
        findings: parsedOutput.findings,
        revalidations: parsedOutput.revalidations,
      };
    } catch (error) {
      logger.error(`OpenCode provider failed: ${this.name}`, error as Error);
      throw error;
    } finally {
      // Clean up temp file
      try {
        await fs.unlink(promptFile);
        await fs.rmdir(tmpDir);
        await fs.rmdir(tmpRoot);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  private runCli(
    bin: string,
    args: string[],
    timeoutMs: number,
    cwd?: string,
    environment?: Readonly<NodeJS.ProcessEnv>
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      // Use detached: true to create a new process group
      // This allows killing the entire process tree when needed
      const proc = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        ...(cwd ? { cwd } : {}),
        ...(environment ? { env: environment } : {}),
      });

      // Unref to avoid keeping parent alive (if available)
      if (proc.unref) {
        proc.unref();
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        logger.warn(
          `OpenCode CLI timeout (${timeoutMs}ms), killing process and all children`
        );

        // Kill the entire process group to ensure child processes are terminated
        // On Unix: negative PID kills the process group
        try {
          if (proc.pid) {
            process.kill(-proc.pid, 'SIGKILL');
          }
        } catch {
          // Fallback: kill just the main process
          proc.kill('SIGKILL');
        }

        reject(new Error(`OpenCode CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      proc.stderr.on('data', (chunk) => {
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
                `OpenCode CLI exited with code ${code}: ${stderr || stdout || 'no output'}`
              )
            );
          } else {
            resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
          }
        }
      });
    });
  }

  private async resolveBinary(): Promise<{ bin: string; args: string[] }> {
    if (await this.canRun('opencode', ['--version'])) {
      return { bin: 'opencode', args: [] };
    }
    if (await this.canRun('npx', ['--yes', 'opencode-ai', '--version'])) {
      return { bin: 'npx', args: ['--yes', 'opencode-ai'] };
    }
    throw new Error(
      'OpenCode CLI is not available (opencode or npx opencode-ai)'
    );
  }

  private async canRun(cmd: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(cmd, args, { stdio: 'ignore' });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
  }
}
