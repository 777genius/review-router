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
      logger.info(`[DRY RUN] Would update PR #${pr.number} description with AI Robot Review summary`);
      return;
    }

    await this.client.octokit.rest.pulls.update({
      owner: this.client.owner,
      repo: this.client.repo,
      pull_number: pr.number,
      body: nextBody,
    });

    logger.info(`Updated PR #${pr.number} description with AI Robot Review summary`);
  }

  buildGeneratedBlock(pr: PRContext): string {
    const cohorts = this.groupFiles(pr.files);
    const changedFiles = pr.files.length;
    const summaryBullets = this.buildSummaryBullets(pr, cohorts);

    const lines: string[] = [
      START_MARKER,
      '## Summary by AI Robot Review',
      '',
      ...summaryBullets.map(item => `- ${item}`),
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
      ...cohorts.map(cohort => this.formatCohortRow(cohort)),
      '',
      '</details>',
      END_MARKER,
    ];

    if (changedFiles === 0) {
      lines.splice(3, 0, '- no changed files were available for summary generation');
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
    const statusCounts = this.countBy(pr.files, file => file.status);
    const statusText = Object.entries(statusCounts)
      .map(([status, count]) => `${count} ${status}`)
      .join(', ');

    bullets.push(
      `change ${pr.files.length} file${pr.files.length === 1 ? '' : 's'} (${statusText || 'no file status'}) with +${pr.additions}/-${pr.deletions} lines`
    );

    for (const cohort of cohorts.slice(0, 3)) {
      bullets.push(`${this.verbForCohort(cohort)} ${cohort.files.length} ${this.cohortPhrase(cohort)} file${cohort.files.length === 1 ? '' : 's'}`);
    }

    return bullets;
  }

  private buildWalkthrough(pr: PRContext, cohorts: FileCohort[]): string {
    if (pr.files.length === 0) {
      return 'No changed files were available from the pull request payload.';
    }

    const cohortText = cohorts
      .slice(0, 4)
      .map(cohort => `${cohort.files.length} ${this.cohortPhrase(cohort)}`)
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
    const tests = cohorts.find(cohort => cohort.key === 'tests');
    if (!tests || tests.files.length === 0) {
      return [];
    }

    return [
      '## Tests',
      '',
      ...tests.files.slice(0, 10).map(file => `- changed test file: \`${file.filename}\``),
      ...(tests.files.length > 10 ? [`- and ${tests.files.length - 10} more test files`] : []),
    ];
  }

  private formatCohortRow(cohort: FileCohort): string {
    const fileList = cohort.files
      .slice(0, 5)
      .map(file => `\`${file.filename}\``)
      .join('<br>');
    const overflow = cohort.files.length > 5 ? `<br>and ${cohort.files.length - 5} more` : '';
    const additions = cohort.files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = cohort.files.reduce((sum, file) => sum + file.deletions, 0);

    return `| **${cohort.title}** <br> ${fileList}${overflow} | ${this.statusSummary(cohort.files)} with +${additions}/-${deletions} lines. |`;
  }

  private statusSummary(files: FileChange[]): string {
    return Object.entries(this.countBy(files, file => file.status))
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
    if (/\b(test|tests|spec|__tests__)\b/.test(lower) || /\.(test|spec)\.[jt]sx?$/.test(lower)) return 'tests';
    if (lower.endsWith('.md') || lower.startsWith('docs/')) return 'docs';
    if (/(package-lock|yarn.lock|pnpm-lock|pubspec.lock|gemfile.lock|poetry.lock|requirements\.txt)$/.test(lower)) return 'dependencies';
    if (/(^|\/)(package\.json|pubspec\.yaml|pom\.xml|build\.gradle|cargo\.toml|go\.mod)$/.test(lower)) return 'config';
    if (lower.startsWith('.github/')) return 'github';
    if (/\.(yml|yaml|json|toml|ini|env|config\.[jt]s)$/.test(lower)) return 'config';
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

  private countBy<T extends string>(files: FileChange[], selector: (file: FileChange) => T): Record<T, number> {
    return files.reduce<Record<T, number>>((acc, file) => {
      const key = selector(file);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {} as Record<T, number>);
  }
}
