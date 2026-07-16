import { Octokit } from '@octokit/rest';

export enum PullRequestHeadVerificationStatus {
  Current = 'current',
  Changed = 'changed',
  Unverifiable = 'unverifiable',
}

export interface PullRequestHeadVerification {
  readonly status: PullRequestHeadVerificationStatus;
  readonly actualHeadSha?: string;
  readonly body?: string;
  readonly error?: unknown;
}

export async function verifyPullRequestHead(
  octokit: Pick<Octokit, 'rest'>,
  input: {
    readonly owner: string;
    readonly repo: string;
    readonly prNumber: number;
    readonly expectedHeadSha: string;
  }
): Promise<PullRequestHeadVerification> {
  try {
    const response = await octokit.rest.pulls.get({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.prNumber,
    });
    const actualHeadSha = response.data.head?.sha?.trim();
    if (!actualHeadSha) {
      return { status: PullRequestHeadVerificationStatus.Unverifiable };
    }

    return {
      status:
        actualHeadSha.toLowerCase() ===
        input.expectedHeadSha.trim().toLowerCase()
          ? PullRequestHeadVerificationStatus.Current
          : PullRequestHeadVerificationStatus.Changed,
      actualHeadSha,
      body: response.data.body ?? '',
    };
  } catch (error) {
    return {
      status: PullRequestHeadVerificationStatus.Unverifiable,
      error,
    };
  }
}
