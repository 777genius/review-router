import { Provider } from './base';
import { Finding, ReviewResult } from '../types';
import { logger } from '../utils/logger';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { estimateTokensSimple } from '../utils/token-estimation';

export interface CodexProviderOptions {
  agenticContext?: boolean;
  eventAudit?: boolean;
}

type CodexRunOptions = {
  healthCheck: boolean;
  outputSchema?: unknown;
  eventAudit?: boolean;
  cwd?: string;
  includeWorkspaceEnv?: boolean;
  disableTools?: boolean;
  skipGitRepoCheck?: boolean;
};

type CodexRunResult = {
  stdout: string;
  stderr: string;
  lastMessage: string;
};

export class CodexProvider extends Provider {
  constructor(
    private readonly model: string,
    private readonly options: CodexProviderOptions = {}
  ) {
    super(`codex/${model}`);
  }

  // Verify the CLI is available. Model/auth failures are surfaced by the real
  // review call; a model-exec health check costs an extra Codex subscription
  // request and can exhaust limited OAuth usage before review starts.
  async healthCheck(_timeoutMs: number = 5000): Promise<boolean> {
    const timeoutMs = Math.max(500, _timeoutMs ?? 5000);
    const mode = (process.env.CODEX_HEALTHCHECK_MODE || 'binary').toLowerCase();

    let timeoutId: NodeJS.Timeout;
    let isTimedOut = false;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        isTimedOut = true;
        reject(new Error(`Codex health check timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      const binary = await Promise.race([
        this.resolveBinary().then((resolved) => {
          if (isTimedOut) {
            logger.debug(`Codex binary resolved after timeout (${this.name})`);
          }
          return resolved;
        }),
        timeoutPromise,
      ]);
      clearTimeout(timeoutId!);

      if (mode === 'none' || mode === 'binary') {
        return true;
      }

      const result = await this.runCliWithStdin(
        binary,
        'Respond with exactly: codex-health-ok',
        timeoutMs,
        { healthCheck: true }
      );
      const output = result.lastMessage || result.stdout;

      if (!output.includes('codex-health-ok')) {
        logger.warn(
          `Codex health check returned unexpected output for ${this.name}`
        );
        return false;
      }

      return true;
    } catch (error) {
      if (timeoutId!) {
        clearTimeout(timeoutId);
      }
      logger.warn(
        `Codex health check failed for ${this.name}: ${(error as Error).message}`
      );
      return false;
    }
  }

  async review(prompt: string, timeoutMs: number): Promise<ReviewResult> {
    const started = Date.now();

    const binary = await this.resolveBinary();

    const agenticContext = this.shouldUseAgenticContext();
    const promptForCodex = agenticContext
      ? await this.wrapAgenticReviewPrompt(prompt)
      : this.wrapPromptOnlyReviewPrompt(prompt);

    logger.info(
      `Running Codex CLI safely: codex exec --model ${this.model} --sandbox read-only --ephemeral ...`
    );

    try {
      const { stdout, stderr, lastMessage } = await this.runCliWithStdin(
        binary,
        promptForCodex,
        timeoutMs,
        {
          healthCheck: false,
          outputSchema: this.buildFindingsSchema(),
          eventAudit: this.shouldUseEventAudit(),
        }
      );
      const content = this.sanitizeReviewContent(
        (lastMessage || stdout).trim()
      );
      const durationSeconds = (Date.now() - started) / 1000;
      logger.info(
        `Codex CLI output for ${this.name}: final=${content.length} bytes, stdout=${stdout.length} bytes, stderr=${stderr.length} bytes, duration=${durationSeconds.toFixed(1)}s`
      );
      if (!content) {
        throw new Error(
          `Codex CLI returned no output${stderr ? `; stderr: ${stderr.slice(0, 200)}` : ''}`
        );
      }
      const findings = this.parseFindingsStrict(content);

      return {
        content,
        durationSeconds,
        usage: this.estimateUsage(prompt, content),
        findings,
      };
    } catch (error) {
      const normalized = this.normalizeCodexError(error);
      logger.error(`Codex provider failed: ${this.name}`, normalized);
      throw normalized;
    }
  }

  async runStructuredPrompt(
    prompt: string,
    outputSchema: unknown,
    timeoutMs: number,
    options: {
      cwd?: string;
      eventAudit?: boolean;
      includeWorkspaceEnv?: boolean;
      skipGitRepoCheck?: boolean;
    } = {}
  ): Promise<string> {
    const binary = await this.resolveBinary();
    const { stdout, stderr, lastMessage } = await this.runCliWithStdin(
      binary,
      prompt,
      timeoutMs,
      {
        healthCheck: false,
        outputSchema,
        eventAudit: options.eventAudit,
        cwd: options.cwd,
        includeWorkspaceEnv: options.includeWorkspaceEnv,
        disableTools: true,
        skipGitRepoCheck: options.skipGitRepoCheck,
      }
    );
    const content = this.sanitizeReviewContent((lastMessage || stdout).trim());
    if (!content) {
      throw new Error(
        `Codex CLI returned no output${stderr ? `; stderr: ${stderr.slice(0, 200)}` : ''}`
      );
    }
    return content;
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

  private buildExecArgs(options: {
    healthCheck: boolean;
    outputLastMessageFile: string;
    outputSchemaFile?: string;
    eventAudit?: boolean;
    disableTools?: boolean;
    skipGitRepoCheck?: boolean;
  }): string[] {
    // The top-level `codex` command starts the interactive TUI and fails in CI.
    const args = [
      'exec',
      '--model',
      this.model,
      '--sandbox',
      'read-only',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '-c',
      'approval_policy=never',
      '--output-last-message',
      options.outputLastMessageFile,
    ];

    if (options.skipGitRepoCheck) {
      args.splice(1, 0, '--skip-git-repo-check');
    }

    if (options.disableTools) {
      args.push(
        '--disable',
        'shell_tool',
        '--disable',
        'unified_exec',
        '--disable',
        'browser_use',
        '--disable',
        'computer_use',
        '--disable',
        'js_repl',
        '--disable',
        'tool_search',
        '--disable',
        'web_search_request',
        '--disable',
        'plugins'
      );
    }

    if (options.outputSchemaFile) {
      args.push('--output-schema', options.outputSchemaFile);
    }

    if (options.eventAudit) {
      args.push('--json');
    }

    const effort = options.healthCheck
      ? process.env.CODEX_HEALTHCHECK_REASONING_EFFORT || 'low'
      : process.env.CODEX_REASONING_EFFORT;

    if (effort) {
      const normalized = effort.trim().toLowerCase();
      if (/^[a-z]+$/.test(normalized)) {
        args.push('-c', `model_reasoning_effort="${normalized}"`);
      }
    }

    args.push('-');
    return args;
  }

  private async runCliWithStdin(
    bin: string,
    stdin: string,
    timeoutMs: number,
    options: CodexRunOptions
  ): Promise<CodexRunResult> {
    // Write prompt to temporary file to avoid TTY check issues
    // Use restrictive permissions (0600) since prompt may contain sensitive PR diffs
    const runId = crypto.randomBytes(8).toString('hex');
    const tmpFile = path.join(os.tmpdir(), `codex-prompt-${runId}.txt`);
    const outputFile = path.join(os.tmpdir(), `codex-output-${runId}.txt`);
    const schemaFile = options.outputSchema
      ? path.join(os.tmpdir(), `codex-schema-${runId}.json`)
      : undefined;
    let fd: fs.FileHandle | undefined;
    try {
      await fs.writeFile(tmpFile, stdin, { encoding: 'utf8', mode: 0o600 });
      await fs.writeFile(outputFile, '', { encoding: 'utf8', mode: 0o600 });
      if (schemaFile) {
        await fs.writeFile(schemaFile, JSON.stringify(options.outputSchema), {
          encoding: 'utf8',
          mode: 0o600,
        });
      }

      const args = this.buildExecArgs({
        healthCheck: options.healthCheck,
        outputLastMessageFile: outputFile,
        outputSchemaFile: schemaFile,
        eventAudit: options.eventAudit && !options.healthCheck,
        disableTools: options.disableTools,
      });

      // Use stdin redirection via file descriptor instead of shell
      // This avoids both "stdin is not a terminal" error and shell injection
      fd = await fs.open(tmpFile, 'r');
      const fdNum = fd.fd;

      const { stdout, stderr } = await new Promise<{
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const proc = spawn(bin, args, {
          stdio: [fdNum, 'pipe', 'pipe'],
          detached: true,
          cwd: options.cwd || process.cwd(),
          env: this.buildSafeEnv(options.includeWorkspaceEnv !== false),
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          logger.warn(
            `Codex CLI timeout (${timeoutMs}ms), killing process and all children`
          );

          try {
            if (proc.pid) {
              process.kill(-proc.pid, 'SIGKILL');
            }
          } catch {
            proc.kill('SIGKILL');
          }

          reject(new Error(`Codex CLI timed out after ${timeoutMs}ms`));
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
                  `Codex CLI failed with exit code ${code}: ${this.formatCliError(stderr, stdout)}`
                )
              );
            } else {
              resolve({ stdout, stderr });
            }
          }
        });
      });

      const lastMessage = await this.readOptionalFile(outputFile);
      if (options.eventAudit && !options.healthCheck) {
        this.logEventAudit(stdout);
      }

      return { stdout, stderr, lastMessage };
    } finally {
      // Clean up temp file and file descriptor
      try {
        if (fd) {
          await fd.close();
        }
        await fs.unlink(tmpFile);
        await fs.unlink(outputFile);
        if (schemaFile) {
          await fs.unlink(schemaFile);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  private shouldUseAgenticContext(): boolean {
    if (this.options.agenticContext !== undefined) {
      return this.options.agenticContext;
    }
    return this.parseBooleanEnv(process.env.CODEX_AGENTIC_CONTEXT, true);
  }

  private shouldUseEventAudit(): boolean {
    if (this.options.eventAudit !== undefined) {
      return this.options.eventAudit;
    }
    return this.parseBooleanEnv(process.env.CODEX_EVENT_AUDIT, false);
  }

  private parseBooleanEnv(
    value: string | undefined,
    defaultValue: boolean
  ): boolean {
    if (value === undefined || value === '') return defaultValue;
    return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
  }

  private async wrapAgenticReviewPrompt(prompt: string): Promise<string> {
    const contextSeed = await this.buildRepositoryContextSeed(prompt);

    return [
      'You are running as review-router inside GitHub Actions.',
      '',
      'Use the deterministic PR context below as the source of truth for review scope.',
      contextSeed,
      contextSeed ? '' : '',
      'You may inspect related repository files before producing findings, but only with read-only shell commands such as rg, sed, cat, git diff, git show, git grep, ls, find, and pwd.',
      'Before deciding whether findings is empty or non-empty, run read-only exploration commands: inspect changed source files with git diff/sed, then use rg/git grep on imported or changed symbols to find related files.',
      'Inspect at least one directly related file when available, such as imports, called modules, schema/config files, tests, or callers.',
      'For CRUD, realtime, cache, or repository-state changes, explicitly compare create/update/delete side effects, broadcasts, invalidation, and listener update paths.',
      'When a changed file uses framework APIs from a dependency, you may inspect read-only language package caches referenced by lockfiles, such as ~/.pub-cache/git, but never inspect secrets or credentials.',
      'Do not produce the final JSON until this context exploration is complete.',
      'When a finding depends on related context, cite the concrete related file evidence in the message.',
      'Use repository-relative paths only. Do not include absolute local filesystem paths in findings.',
      'Do not read environment variables, secret files, ~/.codex, git credentials, or GitHub token files.',
      'Do not run package installation, tests, builds, formatters, network commands, or commands that write files.',
      'Only report real bugs on changed lines from the diff: crashes, data loss, security vulnerabilities, or clear user-visible functional regressions such as permanent loading, stale UI state, dead-end navigation, hidden required content, or wrong access control state.',
      'A repeated local repository pattern, adjacent implementation, generated protocol/schema file, or direct dependency source counts as concrete evidence. If there is still no concrete evidence after exploration, return no finding rather than guessing.',
      '',
      '<deterministic_review_prompt>',
      prompt,
      '</deterministic_review_prompt>',
      '',
      'FINAL OUTPUT CONTRACT:',
      'Return exactly one JSON object matching this shape: {"findings":[{"file":"path","line":1,"severity":"major","title":"short","message":"specific evidence","suggestion":null}]}',
      'The "findings" array may be empty. "severity" must be one of "critical", "major", or "minor".',
      'The "suggestion" field is required by schema; use null unless there is an exact safe replacement.',
      'Do not return markdown, prose, or a bare JSON array.',
    ]
      .filter((line) => line !== undefined)
      .join('\n');
  }

  private wrapPromptOnlyReviewPrompt(prompt: string): string {
    return [
      'Use the deterministic PR context below. Do not assume access to extra context.',
      '',
      '<deterministic_review_prompt>',
      prompt,
      '</deterministic_review_prompt>',
      '',
      'FINAL OUTPUT CONTRACT:',
      'Return exactly one JSON object matching this shape: {"findings":[{"file":"path","line":1,"severity":"major","title":"short","message":"specific evidence","suggestion":null}]}',
      'The "findings" array may be empty. The "suggestion" field is required and may be null.',
      'Do not return markdown, prose, or a bare JSON array.',
    ].join('\n');
  }

  private buildFindingsSchema(): unknown {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['findings'],
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'file',
              'line',
              'severity',
              'title',
              'message',
              'suggestion',
            ],
            properties: {
              file: { type: 'string' },
              line: { type: 'integer' },
              severity: {
                type: 'string',
                enum: ['critical', 'major', 'minor'],
              },
              title: { type: 'string' },
              message: { type: 'string' },
              suggestion: { type: ['string', 'null'] },
            },
          },
        },
      },
    };
  }

  private buildSafeEnv(includeWorkspaceEnv = true): NodeJS.ProcessEnv {
    const allowed = [
      'PATH',
      'HOME',
      'CODEX_HOME',
      'TMPDIR',
      'TEMP',
      'TMP',
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'CI',
      'OPENAI_API_KEY',
    ];
    if (includeWorkspaceEnv) {
      allowed.push('GITHUB_WORKSPACE');
    }

    const env: NodeJS.ProcessEnv = {};
    for (const key of allowed) {
      const value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }

    return env;
  }

  private sanitizeReviewContent(content: string): string {
    const cwd = process.cwd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return content
      .replace(new RegExp(`${cwd}/?`, 'g'), '')
      .replace(/\/home\/runner\/work\/[^/\s")]+\/[^/\s")]+\//g, '')
      .replace(/\/private\/tmp\/[^/\s")]+\//g, '');
  }

  private async buildRepositoryContextSeed(prompt: string): Promise<string> {
    const changedFiles = this.extractChangedFiles(prompt)
      .filter((file) => this.isContextReadableFile(file))
      .slice(0, 5);

    if (changedFiles.length === 0) {
      return '';
    }

    const snippets: string[] = [];
    const relatedFiles = new Set<string>();

    for (const file of changedFiles) {
      const content = await this.readRepoFileSnippet(file);
      if (!content) continue;

      snippets.push(this.formatContextSnippet(file, 'changed', content));
      for (const related of this.extractRelatedImportFiles(file, content)) {
        if (this.isContextReadableFile(related)) {
          relatedFiles.add(related);
        }
      }
    }

    for (const related of this.findIdentifierRelatedFiles(changedFiles)) {
      if (this.isContextReadableFile(related)) {
        relatedFiles.add(related);
      }
    }

    for (const file of [...relatedFiles]
      .filter((file) => !changedFiles.includes(file))
      .slice(0, 8)) {
      const content = await this.readRepoFileSnippet(file);
      if (content) {
        snippets.push(this.formatContextSnippet(file, 'related', content));
      }
    }

    if (snippets.length === 0) {
      return '';
    }

    return [
      'DETERMINISTIC REPOSITORY CONTEXT SEED:',
      'These snippets were read before Codex agentic exploration. Use them as evidence, but only comment on changed lines.',
      ...snippets,
      'END DETERMINISTIC REPOSITORY CONTEXT SEED',
    ].join('\n');
  }

  private extractChangedFiles(prompt: string): string[] {
    const files = new Set<string>();
    const fileListPattern =
      /^- ([^\s]+) \((?:added|modified|removed|renamed|changed)/gm;
    let match;

    while ((match = fileListPattern.exec(prompt)) !== null) {
      files.add(match[1]);
    }

    const diffPattern = /^diff --git a\/(.+?) b\/(.+?)$/gm;
    while ((match = diffPattern.exec(prompt)) !== null) {
      files.add(match[2]);
    }

    return [...files];
  }

  private isContextReadableFile(file: string): boolean {
    const normalized = this.normalizeRepoPath(file);
    if (!normalized) return false;
    const lower = normalized.toLowerCase();

    if (
      lower.includes('/.git/') ||
      lower.includes('/.codex/') ||
      lower.includes('.env') ||
      lower.includes('secret') ||
      lower.includes('credential') ||
      lower.endsWith('.pem') ||
      lower.endsWith('.key') ||
      lower.endsWith('auth.json')
    ) {
      return false;
    }

    return /\.(?:[cm]?js|jsx|tsx?|py|go|rs|java|kt|kts|dart|rb|php|cs|cpp|c|h|hpp|swift|scala|json|ya?ml|toml|sql|graphql|proto)$/i.test(
      normalized
    );
  }

  private normalizeRepoPath(file: string): string | null {
    if (!file || file.includes('\0') || path.isAbsolute(file)) {
      return null;
    }

    const normalized = path.normalize(file).replace(/\\/g, '/');
    if (
      normalized === '.' ||
      normalized.startsWith('../') ||
      normalized === '..'
    ) {
      return null;
    }

    return normalized;
  }

  private async readRepoFileSnippet(file: string): Promise<string> {
    const normalized = this.normalizeRepoPath(file);
    if (!normalized) return '';

    const repoRoot = process.cwd();
    const fullPath = path.resolve(repoRoot, normalized);
    if (!fullPath.startsWith(repoRoot + path.sep)) {
      return '';
    }

    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isFile() || stat.size > 200_000) {
        return '';
      }

      const content = await fs.readFile(fullPath, 'utf8');
      return content.split(/\r?\n/).slice(0, 220).join('\n').slice(0, 16_000);
    } catch {
      return '';
    }
  }

  private extractRelatedImportFiles(
    fromFile: string,
    content: string
  ): string[] {
    const imports = new Set<string>();
    const importPattern =
      /(?:import\s+(?:[^'"]+\s+from\s+)?|export\s+[^'"]+\s+from\s+|require\(|import\s+|export\s+)\s*['"]([^'"]+)['"]/g;
    let match;

    while ((match = importPattern.exec(content)) !== null) {
      const specifier = match[1];
      const resolved = specifier.startsWith('.')
        ? this.resolveRelativeImport(fromFile, specifier)
        : this.resolvePackageImport(specifier);
      if (resolved) imports.add(resolved);
    }

    return [...imports];
  }

  private resolveRelativeImport(
    fromFile: string,
    specifier: string
  ): string | null {
    const base = path.dirname(fromFile);
    const raw = this.normalizeRepoPath(path.join(base, specifier));
    if (!raw) return null;

    const candidates = [
      raw,
      ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'].map(
        (ext) => `${raw}${ext}`
      ),
      ...['.ts', '.tsx', '.js', '.jsx', '.json'].map((ext) =>
        path.posix.join(raw, `index${ext}`)
      ),
    ];

    for (const candidate of candidates) {
      const normalized = this.normalizeRepoPath(candidate);
      if (!normalized || !this.isContextReadableFile(normalized)) continue;
      try {
        const fullPath = path.resolve(process.cwd(), normalized);
        if (fullPath.startsWith(process.cwd() + path.sep)) {
          const stat = fsSync.statSync(fullPath);
          if (stat.isFile()) return normalized;
        }
      } catch {
        // Try next candidate.
      }
    }

    return null;
  }

  private resolvePackageImport(specifier: string): string | null {
    const match = /^package:([^/]+)\/(.+)$/.exec(specifier);
    if (!match) return null;

    const [, packageName, packagePath] = match;
    const roots = this.getWorkspacePackageRoots();
    const root = roots.get(packageName);
    if (!root) return null;

    return this.resolveImportCandidate(path.posix.join(root, packagePath));
  }

  private getWorkspacePackageRoots(): Map<string, string> {
    const roots = new Map<string, string>();

    for (const pubspec of this.findPubspecFiles(process.cwd(), 3)) {
      try {
        const content = fsSync.readFileSync(pubspec, 'utf8');
        const name = /^name:\s*['"]?([^'"\s#]+)['"]?/m.exec(content)?.[1];
        if (!name) continue;

        const packageDir = path.relative(process.cwd(), path.dirname(pubspec))
          .replace(/\\/g, '/');
        const libDir = packageDir === ''
          ? 'lib'
          : path.posix.join(packageDir, 'lib');
        roots.set(name, libDir);
      } catch {
        // Ignore malformed or unreadable pubspec files.
      }
    }

    return roots;
  }

  private findPubspecFiles(root: string, maxDepth: number): string[] {
    const found: string[] = [];

    const walk = (dir: string, depth: number) => {
      if (depth > maxDepth || found.length >= 50) return;

      let entries: fsSync.Dirent[];
      try {
        entries = fsSync.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      if (entries.some(entry => entry.isFile() && entry.name === 'pubspec.yaml')) {
        found.push(path.join(dir, 'pubspec.yaml'));
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (this.shouldSkipContextDirectory(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
      }
    };

    walk(root, 0);
    return found;
  }

  private findIdentifierRelatedFiles(changedFiles: string[]): string[] {
    const changedContents = changedFiles
      .map(file => this.readRepoFileSync(file))
      .filter(Boolean)
      .join('\n');
    if (!changedContents) return [];

    const identifiers = this.extractContextIdentifiers(changedContents);
    if (identifiers.length === 0) return [];

    const candidates = this.findContextCandidateFiles(process.cwd(), 5);
    const changed = new Set(changedFiles);
    const scored: Array<{ file: string; score: number }> = [];

    for (const file of candidates) {
      if (changed.has(file)) continue;

      const content = this.readRepoFileSync(file);
      if (!content) continue;

      let score = 0;
      for (const identifier of identifiers) {
        if (content.includes(identifier)) score += this.contextIdentifierWeight(identifier);
      }

      if (score > 0) {
        scored.push({ file, score });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
      .slice(0, 8)
      .map(item => item.file);
  }

  private extractContextIdentifiers(content: string): string[] {
    const identifiers = new Set<string>();
    const importantPatterns = [
      /\b[A-Z][A-Za-z0-9_]*(?:Config|Provider|Repository|Endpoint|Widget|Dialog|Service)\b/g,
      /\bDw[A-Za-z0-9_]+\b/g,
      /\bUpdateChannels\.[A-Za-z0-9_]+\b/g,
      /\b[a-z][A-Za-z0-9_]*(?:Config|Provider|Repository|Endpoint|Channel|Model|Wrapper)\b/g,
    ];

    for (const pattern of importantPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        identifiers.add(match[0]);
      }
    }

    return [...identifiers]
      .filter(identifier => identifier.length >= 5)
      .filter(identifier => !this.isNoisyContextIdentifier(identifier))
      .slice(0, 40);
  }

  private contextIdentifierWeight(identifier: string): number {
    if (identifier.startsWith('Dw')) return 4;
    if (identifier.startsWith('UpdateChannels.')) return 4;
    if (/(Config|Repository|Endpoint|Wrapper)$/.test(identifier)) return 3;
    return 1;
  }

  private isNoisyContextIdentifier(identifier: string): boolean {
    return [
      'BuildContext',
      'ConsumerWidget',
      'ConsumerState',
      'ConsumerStatefulWidget',
      'TextEditingController',
      'StatefulWidget',
      'StatelessWidget',
      'Widget',
    ].includes(identifier);
  }

  private findContextCandidateFiles(root: string, maxDepth: number): string[] {
    const files: string[] = [];

    const walk = (dir: string, depth: number) => {
      if (depth > maxDepth || files.length >= 2000) return;

      let entries: fsSync.Dirent[];
      try {
        entries = fsSync.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!this.shouldSkipContextDirectory(entry.name)) {
            walk(fullPath, depth + 1);
          }
          continue;
        }

        if (!entry.isFile()) continue;

        const relative = path.relative(root, fullPath).replace(/\\/g, '/');
        if (!this.isContextReadableFile(relative)) continue;

        try {
          const stat = fsSync.statSync(fullPath);
          if (stat.size <= 200_000) files.push(relative);
        } catch {
          // Ignore files that disappear during traversal.
        }
      }
    };

    walk(root, 0);
    return files;
  }

  private shouldSkipContextDirectory(name: string): boolean {
    return [
      '.git',
      '.codex',
      '.dart_tool',
      'node_modules',
      'build',
      'dist',
      'coverage',
      '.next',
      '.turbo',
    ].includes(name);
  }

  private readRepoFileSync(file: string): string {
    const normalized = this.normalizeRepoPath(file);
    if (!normalized) return '';

    const repoRoot = process.cwd();
    const fullPath = path.resolve(repoRoot, normalized);
    if (!fullPath.startsWith(repoRoot + path.sep)) return '';

    try {
      const stat = fsSync.statSync(fullPath);
      if (!stat.isFile() || stat.size > 200_000) return '';
      return fsSync.readFileSync(fullPath, 'utf8');
    } catch {
      return '';
    }
  }

  private resolveImportCandidate(raw: string): string | null {
    const candidates = [
      raw,
      ...['.dart', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'].map(
        (ext) => `${raw}${ext}`
      ),
      ...['.dart', '.ts', '.tsx', '.js', '.jsx', '.json'].map((ext) =>
        path.posix.join(raw, `index${ext}`)
      ),
    ];

    for (const candidate of candidates) {
      const normalized = this.normalizeRepoPath(candidate);
      if (!normalized || !this.isContextReadableFile(normalized)) continue;
      try {
        const fullPath = path.resolve(process.cwd(), normalized);
        if (fullPath.startsWith(process.cwd() + path.sep)) {
          const stat = fsSync.statSync(fullPath);
          if (stat.isFile()) return normalized;
        }
      } catch {
        // Try next candidate.
      }
    }

    return null;
  }

  private formatContextSnippet(
    file: string,
    role: 'changed' | 'related',
    content: string
  ): string {
    return [
      `<context-file path="${file}" role="${role}">`,
      content,
      '</context-file>',
    ].join('\n');
  }

  private async readOptionalFile(file: string): Promise<string> {
    try {
      return await fs.readFile(file, 'utf8');
    } catch {
      return '';
    }
  }

  private logEventAudit(stdout: string): void {
    const audit = this.extractEventAudit(stdout);
    if (audit.commandCount === 0) {
      logger.info('Codex event audit: no shell commands recorded');
      return;
    }

    const commands =
      audit.commandNames.length > 0 ? audit.commandNames.join(', ') : 'unknown';
    const files = audit.fileCount > 0 ? `, files=${audit.fileCount}` : '';
    logger.info(
      `Codex event audit: commands=${audit.commandCount}, commandNames=${commands}${files}`
    );
  }

  private extractEventAudit(stdout: string): {
    commandCount: number;
    commandNames: string[];
    fileCount: number;
  } {
    const commandNames = new Set<string>();
    const files = new Set<string>();
    let commandCount = 0;

    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);
        const item = event?.item;
        if (
          item?.type !== 'command_execution' ||
          typeof item.command !== 'string'
        ) {
          continue;
        }

        commandCount += 1;
        const commandName = this.extractCommandName(item.command);
        if (commandName) commandNames.add(commandName);
        for (const file of this.extractLikelyFilePaths(item.command)) {
          files.add(file);
        }
      } catch {
        // Ignore non-JSON progress lines.
      }
    }

    return {
      commandCount,
      commandNames: [...commandNames].sort(),
      fileCount: files.size,
    };
  }

  private extractCommandName(command: string): string | null {
    const shellMatch = command.match(
      /(?:^|\s)(?:\/[^\s]+\/)?(?:bash|zsh|sh)\s+-lc\s+["']?([^"']+)/
    );
    const normalized = shellMatch?.[1] || command;
    const match = normalized.trim().match(/^([A-Za-z0-9_.-]+)/);
    return match?.[1] || null;
  }

  private extractLikelyFilePaths(command: string): string[] {
    const matches = command.matchAll(
      /(?:^|[\s"'`])((?:\.{0,2}\/)?[A-Za-z0-9_@./:+-]+\.(?:[cm]?js|tsx?|jsx|py|go|rs|java|kt|kts|dart|rb|php|cs|cpp|c|h|hpp|swift|scala|json|ya?ml|toml|md|sh|sql|graphql|proto))(?:$|[\s"'`])/g
    );
    return [...matches].map((match) => match[1]).filter(Boolean);
  }

  private formatCliError(stderr: string, stdout: string): string {
    const raw = (stderr || stdout || 'no output')
      .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
      .replace(
        /www_authenticate_header:\s*"[^"]+"/gi,
        'www_authenticate_header: "[redacted]"'
      )
      .replace(/authorization_uri="[^"]+"/gi, 'authorization_uri="[redacted]"')
      .replace(
        /authorization_uri=\\?"[^"\\]*(?:\\.[^"\\]*)*\\?"/gi,
        'authorization_uri="[redacted]"'
      )
      .replace(/https?:\/\/[^\s",)]+/gi, '[redacted-url]')
      .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[redacted-openai-key]')
      .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[redacted-github-token]')
      .replace(/github_pat_[A-Za-z0-9_]+/g, '[redacted-github-token]')
      .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"[redacted]"')
      .replace(
        /"refresh_token"\s*:\s*"[^"]+"/gi,
        '"refresh_token":"[redacted]"'
      )
      .replace(/session id:\s*[a-f0-9-]+/gi, 'session id: [redacted]')
      .replace(/thread\s+[a-f0-9-]{8,}/gi, 'thread [redacted]');

    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter(
        (line) =>
          !line.startsWith('user') && !line.includes('Respond with exactly:')
      );

    const jsonMessages = Array.from(raw.matchAll(/"message"\s*:\s*"([^"]+)"/gi))
      .map((match) => match[1])
      .filter(Boolean);
    if (jsonMessages.length > 0) {
      return this.truncateCliError([...new Set(jsonMessages)].join(' '));
    }

    const important = lines.filter((line) =>
      /not supported|invalid_request_error|auth|error|failed|timed out|timeout/i.test(
        line
      )
    );
    const summary = (important.length > 0 ? important : lines).join(' ');

    return this.truncateCliError(summary);
  }

  private truncateCliError(message: string): string {
    return message.length > 800 ? `${message.slice(0, 800)}...` : message;
  }

  private normalizeCodexError(error: unknown): Error {
    const err = error instanceof Error ? error : new Error(String(error));
    const rawMessage = this.truncateCliError(
      this.sanitizeReviewContent(this.formatCliError(err.message, ''))
    );
    const message = this.withActionableAuthHint(rawMessage);
    const normalized = new Error(message || 'Codex CLI failed');
    normalized.name = err.name || 'CodexProviderError';
    normalized.stack = err.stack;
    return normalized;
  }

  private withActionableAuthHint(message: string): string {
    if (!message) return message;
    if (
      !/(401|unauthorized|access token|refresh token|auth|login)/i.test(message)
    ) {
      return message;
    }

    const hint =
      'Codex authentication failed. If using ChatGPT subscription OAuth, reseed auth.json by running `codex login` on a trusted machine and updating CODEX_AUTH_JSON. If using API-key mode, verify OPENAI_API_KEY.';

    return message.includes('reseed auth.json')
      ? message
      : this.truncateCliError(`${message} ${hint}`);
  }

  private async resolveBinary(): Promise<string> {
    // Try codex command directly
    if (await this.canRun('codex', ['--version'])) {
      return 'codex';
    }
    // Try codex-cli
    if (await this.canRun('codex-cli', ['--version'])) {
      return 'codex-cli';
    }
    throw new Error('Codex CLI is not available (tried: codex, codex-cli)');
  }

  private async canRun(cmd: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(cmd, args, { stdio: 'ignore' });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
  }

  private extractFindings(content: string): Finding[] {
    try {
      return this.parseFindingsStrict(content);
    } catch (error) {
      logger.debug(
        'Failed to parse findings from Codex response',
        error as Error
      );
    }
    return [];
  }

  private parseFindingsStrict(content: string): Finding[] {
    const parsed = this.parseReviewJson(content);
    const findings = Array.isArray(parsed)
      ? parsed
      : (parsed as { findings?: unknown })?.findings;

    if (!Array.isArray(findings)) {
      throw new Error(
        'Codex CLI returned invalid review JSON: expected an object with a findings array'
      );
    }

    return findings.map((item, index) => {
      if (!item || typeof item !== 'object') {
        throw new Error(
          `Codex CLI returned invalid review JSON: findings[${index}] must be an object`
        );
      }

      const raw = item as Record<string, unknown>;
      const severity = raw.severity;

      if (
        typeof raw.file !== 'string' ||
        !raw.file ||
        !Number.isInteger(raw.line) ||
        !['critical', 'major', 'minor'].includes(String(severity)) ||
        typeof raw.title !== 'string' ||
        !raw.title ||
        typeof raw.message !== 'string' ||
        !raw.message
      ) {
        throw new Error(
          `Codex CLI returned invalid review JSON: findings[${index}] is missing required file, line, severity, title, or message`
        );
      }

      const finding: Finding = {
        file: raw.file,
        line: raw.line as number,
        severity: severity as Finding['severity'],
        title: raw.title,
        message: raw.message,
      };

      if (typeof raw.suggestion === 'string' && raw.suggestion.trim()) {
        finding.suggestion = raw.suggestion;
      }

      return finding;
    });
  }

  private parseReviewJson(content: string): unknown {
    const trimmed = content.trim();
    const match = trimmed.match(/```json\s*([\s\S]*?)```/i);
    const source = match?.[1] ?? trimmed;

    try {
      return JSON.parse(source);
    } catch {
      throw new Error(
        'Codex CLI returned invalid review JSON: response was not valid JSON'
      );
    }
  }
}
