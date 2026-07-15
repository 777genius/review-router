import { GitHubClient } from './client';
import { FileChange, PRContext } from '../types';
import { logger } from '../utils/logger';

const FILES_PER_PAGE = 100;
const MAX_GITHUB_FILES = 3000;
const MAX_RAW_DIFF_FILES = 300;
const MAX_SYNTHESIZED_DIFF_BYTES = 8 * 1024 * 1024;

export class PullRequestLoader {
  constructor(private readonly client: GitHubClient) {}

  async load(prNumber: number): Promise<PRContext> {
    const { octokit, owner, repo } = this.client;

    const prResponse = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    const pr = prResponse.data;

    const files: FileChange[] = [];
    for (let page = 1; files.length < MAX_GITHUB_FILES; page += 1) {
      const res = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: prNumber,
        page,
        per_page: FILES_PER_PAGE,
      });

      const remaining = MAX_GITHUB_FILES - files.length;
      files.push(
        ...res.data.slice(0, remaining).map((file) => ({
          filename: file.filename,
          status: (file.status as FileChange['status']) || 'modified',
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          patch: file.patch || undefined,
          previousFilename: file.previous_filename || undefined,
        }))
      );

      if (res.data.length < FILES_PER_PAGE) {
        break;
      }
    }

    if (files.length === MAX_GITHUB_FILES) {
      logger.warn(
        `PR #${prNumber} reached GitHub's ${MAX_GITHUB_FILES}-file API limit; additional files cannot be reviewed.`
      );
    }

    const diff = await this.fetchDiff(owner, repo, prNumber, files);

    return {
      number: pr.number,
      title: pr.title || '',
      body: pr.body || '',
      author: pr.user?.login || 'unknown',
      draft: Boolean(pr.draft),
      labels: (pr.labels || []).map((label) =>
        typeof label === 'string' ? label : label.name || ''
      ),
      files,
      diff,
      additions: pr.additions || 0,
      deletions: pr.deletions || 0,
      baseSha: pr.base?.sha || '',
      headSha: pr.head?.sha || '',
    };
  }

  private async fetchDiff(
    owner: string,
    repo: string,
    prNumber: number,
    files: FileChange[]
  ): Promise<string> {
    if (files.length > MAX_RAW_DIFF_FILES) {
      logger.warn(
        `PR #${prNumber} exceeds GitHub's ${MAX_RAW_DIFF_FILES}-file raw diff limit; using paginated file patches.`
      );
      return this.synthesizeDiff(prNumber, files);
    }

    const { octokit } = this.client;
    try {
      const res = await octokit.request(
        'GET /repos/{owner}/{repo}/pulls/{pull_number}',
        {
          owner,
          repo,
          pull_number: prNumber,
          headers: { accept: 'application/vnd.github.v3.diff' },
        }
      );
      return typeof res.data === 'string' ? res.data : '';
    } catch (error) {
      if (!this.isDiffTooLargeError(error)) {
        throw error;
      }
      logger.warn(
        `GitHub rejected the raw diff for PR #${prNumber} as too large; using paginated file patches.`
      );
      return this.synthesizeDiff(prNumber, files);
    }
  }

  private synthesizeDiff(prNumber: number, files: FileChange[]): string {
    const blocks: string[] = [];
    let byteCount = 0;

    for (const file of files) {
      const oldPath = file.previousFilename || file.filename;
      const fromPath = file.status === 'added' ? '/dev/null' : `a/${oldPath}`;
      const toPath =
        file.status === 'removed' ? '/dev/null' : `b/${file.filename}`;
      const patch =
        file.patch || 'Binary file or patch unavailable from GitHub API';
      const block = [
        `diff --git a/${oldPath} b/${file.filename}`,
        `--- ${fromPath}`,
        `+++ ${toPath}`,
        patch,
        '',
      ].join('\n');
      const blockBytes = Buffer.byteLength(block, 'utf8');

      if (byteCount + blockBytes > MAX_SYNTHESIZED_DIFF_BYTES) {
        logger.warn(
          `Synthesized diff for PR #${prNumber} reached the ${MAX_SYNTHESIZED_DIFF_BYTES}-byte safety limit; remaining patches were omitted.`
        );
        break;
      }

      blocks.push(block);
      byteCount += blockBytes;
    }

    return blocks.join('\n');
  }

  private isDiffTooLargeError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const candidate = error as {
      status?: number;
      message?: string;
      response?: {
        data?: { message?: string; errors?: Array<{ code?: string }> };
      };
    };
    const message = `${candidate.message || ''} ${candidate.response?.data?.message || ''}`;
    const hasTooLargeCode = candidate.response?.data?.errors?.some(
      ({ code }) => code === 'too_large'
    );

    return (
      candidate.status === 422 &&
      (Boolean(hasTooLargeCode) ||
        /diff exceeded|maximum number of files|too large/i.test(message))
    );
  }
}
