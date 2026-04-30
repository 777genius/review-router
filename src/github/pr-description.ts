import { FileChange, PRContext } from '../types';
import { GitHubClient } from './client';
import { logger } from '../utils/logger';

const START_MARKER = '<!-- ai-robot-review-summary:start -->';
const END_MARKER = '<!-- ai-robot-review-summary:end -->';

type FileCohort = {
  key: string;
  title: string;
  files: FileChange[];
};

type PatchLines = {
  additions: string[];
  deletions: string[];
};

export class PullRequestDescriptionUpdater {
  constructor(
    private readonly client: GitHubClient,
    private readonly dryRun: boolean = false
  ) {}

  async update(pr: PRContext): Promise<void> {
    const nextBody = this.merge(pr.body || '', this.buildGeneratedBlock(pr));

    if (nextBody === (pr.body || '')) {
      logger.debug('PR description already up to date');
      return;
    }

    if (this.dryRun) {
      logger.info(
        `[DRY RUN] Would update PR #${pr.number} description with AI Robot Review summary`
      );
      return;
    }

    await this.client.octokit.rest.pulls.update({
      owner: this.client.owner,
      repo: this.client.repo,
      pull_number: pr.number,
      body: nextBody,
    });

    logger.info(
      `Updated PR #${pr.number} description with AI Robot Review summary`
    );
  }

  buildGeneratedBlock(pr: PRContext): string {
    const cohorts = this.groupFiles(pr.files);
    const changedFiles = pr.files.length;
    const summaryBullets = this.buildSummaryBullets(pr, cohorts);

    const lines: string[] = [
      START_MARKER,
      '## Summary by AI Robot Review',
      '',
      ...summaryBullets.map((item) => `- ${item}`),
      '',
      ...this.formatTestsSection(cohorts),
      '',
      this.formatFilesDetails(pr.files),
      '',
      '<details>',
      '<summary>📝 Walkthrough</summary>',
      '',
      '## Walkthrough',
      '',
      this.buildWalkthrough(pr, cohorts),
      '',
      '## Changes',
      '',
      '| Cohort / File(s) | Summary |',
      '|---|---|',
      ...cohorts.map((cohort) => this.formatCohortRow(cohort)),
      '',
      '</details>',
      END_MARKER,
    ];

    if (changedFiles === 0) {
      lines.splice(
        3,
        0,
        '- no changed files were available for summary generation'
      );
    }

    return lines.join('\n').trim();
  }

  merge(existingBody: string, generatedBlock: string): string {
    const preserved = this.removeExistingBlock(existingBody).trim();
    return preserved ? `${preserved}\n\n${generatedBlock}` : generatedBlock;
  }

  private removeExistingBlock(body: string): string {
    const start = body.indexOf(START_MARKER);
    const end = body.indexOf(END_MARKER);

    if (start === -1 || end === -1 || end < start) {
      return body;
    }

    return `${body.slice(0, start)}${body.slice(end + END_MARKER.length)}`;
  }

  private buildSummaryBullets(pr: PRContext, cohorts: FileCohort[]): string[] {
    const bullets: string[] = [];
    const statusCounts = this.countBy(pr.files, (file) => file.status);
    const statusText = Object.entries(statusCounts)
      .map(([status, count]) => `${count} ${status}`)
      .join(', ');

    bullets.push(
      `change ${pr.files.length} file${pr.files.length === 1 ? '' : 's'} (${statusText || 'no file status'}) with +${pr.additions}/-${pr.deletions} lines`
    );

    for (const cohort of cohorts.slice(0, 3)) {
      bullets.push(
        `${this.verbForCohort(cohort)} ${cohort.files.length} ${this.cohortPhrase(cohort)} file${cohort.files.length === 1 ? '' : 's'}`
      );
    }

    return bullets;
  }

  private buildWalkthrough(pr: PRContext, cohorts: FileCohort[]): string {
    if (pr.files.length === 0) {
      return 'No changed files were available from the pull request payload.';
    }

    const cohortText = cohorts
      .slice(0, 4)
      .map((cohort) => `${cohort.files.length} ${this.cohortPhrase(cohort)}`)
      .join(', ');

    return `This PR updates ${pr.files.length} file${pr.files.length === 1 ? '' : 's'} across ${cohortText}. The generated summary is based on the GitHub pull request file list and diff metadata, and the author's description above is preserved.`;
  }

  private formatFilesDetails(files: FileChange[]): string {
    const lines = [
      '<details>',
      `<summary>📒 Files selected for processing (${files.length})</summary>`,
      '',
    ];

    for (const file of files.slice(0, 50)) {
      lines.push(`* \`${file.filename}\``);
    }

    if (files.length > 50) {
      lines.push(`* ...and ${files.length - 50} more`);
    }

    lines.push('', '</details>');
    return lines.join('\n');
  }

  private formatTestsSection(cohorts: FileCohort[]): string[] {
    const tests = cohorts.find((cohort) => cohort.key === 'tests');
    if (!tests || tests.files.length === 0) {
      return [];
    }

    return [
      '## Tests',
      '',
      ...tests.files
        .slice(0, 10)
        .map((file) => `- changed test file: \`${file.filename}\``),
      ...(tests.files.length > 10
        ? [`- and ${tests.files.length - 10} more test files`]
        : []),
    ];
  }

  private formatCohortRow(cohort: FileCohort): string {
    const fileList = cohort.files
      .slice(0, 5)
      .map((file) => `\`${file.filename}\``)
      .join('<br>');
    const overflow =
      cohort.files.length > 5 ? `<br>and ${cohort.files.length - 5} more` : '';

    return `| **${cohort.title}** <br> ${fileList}${overflow} | ${this.formatCohortSummary(cohort)} |`;
  }

  private formatCohortSummary(cohort: FileCohort): string {
    const summaries = this.unique(
      cohort.files.slice(0, 3).map((file) => this.summarizeFile(file))
    );
    const overflow =
      cohort.files.length > 3
        ? `<br>Also updates ${cohort.files.length - 3} more file${cohort.files.length === 4 ? '' : 's'}.`
        : '';

    return `${summaries.join('<br>')}${overflow}<br>${this.lineStats(cohort.files)}`;
  }

  private summarizeFile(file: FileChange): string {
    if (file.status === 'removed') {
      return `Removes ${this.fileKind(file)}.`;
    }

    if (file.status === 'renamed') {
      const previous = file.previousFilename
        ? ` from \`${file.previousFilename}\``
        : '';
      return `Renames ${this.fileKind(file)}${previous}.`;
    }

    const key = this.cohortKey(file.filename);
    const patch = this.extractPatchLines(file.patch);

    if (key === 'ci') return this.summarizeWorkflowFile(file, patch);
    if (key === 'tests') return this.summarizeTestFile(file, patch);
    if (key === 'docs') return this.summarizeDocsFile(file, patch);
    if (key === 'dependencies')
      return this.summarizeDependencyFile(file, patch);
    if (key === 'config' || key === 'github')
      return this.summarizeConfigFile(file, patch);
    return this.summarizeSourceFile(file, patch);
  }

  private summarizeWorkflowFile(file: FileChange, patch: PatchLines): string {
    const added = patch.additions.join('\n').toLowerCase();
    const parts: string[] = [];

    if (file.filename.toLowerCase().includes('ai-robot-review')) {
      parts.push(
        `${this.changeVerb(file)} the AI Robot Review GitHub Actions workflow`
      );
    } else {
      parts.push(`${this.changeVerb(file)} a GitHub Actions workflow`);
    }

    if (added.includes('pull_request') && added.includes('workflow_dispatch')) {
      parts.push('runs it on pull requests and manual dispatch');
    } else if (added.includes('pull_request')) {
      parts.push('runs it on pull requests');
    } else if (added.includes('workflow_dispatch')) {
      parts.push('allows manual dispatch');
    }

    if (
      added.includes('codex_auth_json') ||
      added.includes('codex_config_toml')
    ) {
      parts.push('restores Codex OAuth credentials');
    }

    if (added.includes('openai_api_key')) {
      parts.push('supports OpenAI API-key auth');
    }

    if (added.includes('openrouter_api_key')) {
      parts.push('supports OpenRouter API-key auth');
    }

    if (added.includes('codex_model') || added.includes('gpt-5.5')) {
      parts.push('sets the Codex model');
    }

    if (
      added.includes('codex_reasoning_effort') ||
      added.includes('reasoning_effort')
    ) {
      parts.push('sets reasoning effort');
    }

    if (added.includes('create-github-app-token')) {
      parts.push('mints a GitHub App token for bot comments');
    } else if (
      added.includes('github_token') ||
      added.includes('github-token')
    ) {
      parts.push('posts comments with the repository GitHub token');
    }

    if (
      added.includes('multi-provider-code-review@main') ||
      added.includes('ai-robot-review@main')
    ) {
      parts.push('uses the latest reviewer from the main branch');
    }

    return this.sentenceFromParts(parts);
  }

  private summarizeTestFile(file: FileChange, patch: PatchLines): string {
    const symbols = this.extractSymbols(patch.additions);
    const target = this.basenameWithoutExtension(file.filename);

    if (symbols.length > 0) {
      return `${this.changeVerb(file)} test coverage for ${symbols.slice(0, 2).join(', ')}.`;
    }

    return `${this.changeVerb(file)} ${target} test coverage.`;
  }

  private summarizeDocsFile(file: FileChange, patch: PatchLines): string {
    const headings = patch.additions
      .map((line) => line.match(/^#{1,4}\s+(.+)/)?.[1]?.trim())
      .filter((heading): heading is string => Boolean(heading))
      .slice(0, 2);

    if (headings.length > 0) {
      return `${this.changeVerb(file)} documentation for ${headings.join(', ')}.`;
    }

    return `${this.changeVerb(file)} documentation content.`;
  }

  private summarizeDependencyFile(file: FileChange, patch: PatchLines): string {
    const additions = patch.additions.filter(
      (line) => line.trim() && !line.trim().startsWith('#')
    ).length;
    const deletions = patch.deletions.filter(
      (line) => line.trim() && !line.trim().startsWith('#')
    ).length;

    if (additions > 0 && deletions > 0) {
      return `${this.changeVerb(file)} dependency lock entries and version metadata.`;
    }

    if (additions > 0) {
      return `${this.changeVerb(file)} dependency entries.`;
    }

    return `${this.changeVerb(file)} dependency metadata.`;
  }

  private summarizeConfigFile(file: FileChange, patch: PatchLines): string {
    const symbols = this.extractConfigKeys(patch.additions).slice(0, 3);

    if (symbols.length > 0) {
      return `${this.changeVerb(file)} configuration for ${symbols.join(', ')}.`;
    }

    return `${this.changeVerb(file)} project configuration.`;
  }

  private summarizeSourceFile(file: FileChange, patch: PatchLines): string {
    const symbols = this.extractSymbols(patch.additions);

    if (symbols.length > 0) {
      return `${this.changeVerb(file)} source logic around ${symbols.slice(0, 3).join(', ')}.`;
    }

    return `${this.changeVerb(file)} source implementation in ${this.basenameWithoutExtension(file.filename)}.`;
  }

  private extractPatchLines(patch?: string): PatchLines {
    if (!patch) return { additions: [], deletions: [] };

    const additions: string[] = [];
    const deletions: string[] = [];

    for (const line of patch.split('\n')) {
      if (
        line.startsWith('+++') ||
        line.startsWith('---') ||
        line.startsWith('@@')
      ) {
        continue;
      }
      if (line.startsWith('+')) {
        additions.push(line.slice(1).trim());
      } else if (line.startsWith('-')) {
        deletions.push(line.slice(1).trim());
      }
    }

    return { additions, deletions };
  }

  private extractSymbols(lines: string[]): string[] {
    const symbols: string[] = [];
    const patterns = [
      /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
      /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
      /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
      /\b(?:describe|it|test)\(['"`]([^'"`]+)['"`]/,
    ];

    for (const line of lines) {
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match?.[1]) {
          symbols.push(this.truncate(match[1], 60));
          break;
        }
      }
    }

    return this.unique(symbols).slice(0, 5);
  }

  private extractConfigKeys(lines: string[]): string[] {
    const keys: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      const match = trimmed.match(/^["']?([A-Za-z0-9_.-]+)["']?\s*[:=]/);
      if (match?.[1] && !match[1].match(/^\d+$/)) {
        keys.push(this.truncate(match[1], 48));
      }
    }

    return this.unique(keys);
  }

  private sentenceFromParts(parts: string[]): string {
    if (parts.length === 0) return 'Updates pull request automation.';

    const [first, ...rest] = parts;
    if (rest.length === 0) return `${first}.`;

    return `${first}; ${rest.join('; ')}.`;
  }

  private lineStats(files: FileChange[]): string {
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    return `Line stats: ${this.statusSummary(files)}; +${additions}/-${deletions}.`;
  }

  private changeVerb(file: FileChange): string {
    if (file.status === 'added') return 'Adds';
    if (file.status === 'removed') return 'Removes';
    return 'Updates';
  }

  private fileKind(file: FileChange): string {
    const key = this.cohortKey(file.filename);
    if (key === 'ci') return 'GitHub Actions workflow';
    if (key === 'tests') return 'test file';
    if (key === 'docs') return 'documentation file';
    if (key === 'dependencies') return 'dependency file';
    if (key === 'config') return 'configuration file';
    return 'source file';
  }

  private basenameWithoutExtension(filename: string): string {
    const basename = filename.split('/').pop() || filename;
    return basename.replace(/\.[^.]+$/, '');
  }

  private truncate(value: string, maxLength: number): string {
    return value.length > maxLength
      ? `${value.slice(0, maxLength - 1)}...`
      : value;
  }

  private unique(values: string[]): string[] {
    return Array.from(new Set(values.filter(Boolean)));
  }

  private statusSummary(files: FileChange[]): string {
    return Object.entries(this.countBy(files, (file) => file.status))
      .map(([status, count]) => `${count} ${status}`)
      .join(', ');
  }

  private groupFiles(files: FileChange[]): FileCohort[] {
    const groups = new Map<string, FileCohort>();

    for (const file of files) {
      const key = this.cohortKey(file.filename);
      const title = this.cohortTitle(key);
      if (!groups.has(key)) {
        groups.set(key, { key, title, files: [] });
      }
      groups.get(key)!.files.push(file);
    }

    return Array.from(groups.values()).sort((a, b) => {
      const diff = b.files.length - a.files.length;
      return diff || a.title.localeCompare(b.title);
    });
  }

  private cohortKey(filename: string): string {
    const lower = filename.toLowerCase();
    if (lower.startsWith('.github/workflows/')) return 'ci';
    if (
      /\b(test|tests|spec|__tests__)\b/.test(lower) ||
      /\.(test|spec)\.[jt]sx?$/.test(lower)
    )
      return 'tests';
    if (lower.endsWith('.md') || lower.startsWith('docs/')) return 'docs';
    if (
      /(package-lock|yarn.lock|pnpm-lock|pubspec.lock|gemfile.lock|poetry.lock|requirements\.txt)$/.test(
        lower
      )
    )
      return 'dependencies';
    if (
      /(^|\/)(package\.json|pubspec\.yaml|pom\.xml|build\.gradle|cargo\.toml|go\.mod)$/.test(
        lower
      )
    )
      return 'config';
    if (lower.startsWith('.github/')) return 'github';
    if (/\.(yml|yaml|json|toml|ini|env|config\.[jt]s)$/.test(lower))
      return 'config';
    return 'source';
  }

  private cohortTitle(key: string): string {
    const titles: Record<string, string> = {
      ci: 'CI workflow',
      tests: 'Tests',
      docs: 'Documentation',
      dependencies: 'Dependencies',
      config: 'Configuration',
      github: 'GitHub automation',
      source: 'Source',
    };
    return titles[key] || 'Other';
  }

  private verbForCohort(cohort: FileCohort): string {
    if (cohort.key === 'tests') return 'update';
    if (cohort.key === 'docs') return 'document';
    if (cohort.key === 'dependencies') return 'adjust';
    if (cohort.key === 'ci' || cohort.key === 'github') return 'configure';
    return 'update';
  }

  private cohortPhrase(cohort: FileCohort): string {
    if (cohort.key === 'ci') return 'CI workflow';
    if (cohort.key === 'github') return 'GitHub automation';
    return cohort.title.toLowerCase();
  }

  private countBy<T extends string>(
    files: FileChange[],
    selector: (file: FileChange) => T
  ): Record<T, number> {
    return files.reduce<Record<T, number>>(
      (acc, file) => {
        const key = selector(file);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      },
      {} as Record<T, number>
    );
  }
}
