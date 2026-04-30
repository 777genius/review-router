import { PullRequestDescriptionUpdater } from '../../../src/github/pr-description';
import { PRContext } from '../../../src/types';

function createPR(overrides: Partial<PRContext> = {}): PRContext {
  return {
    number: 42,
    title: 'Add reviewer workflow',
    body: 'Author-written context stays first.',
    author: 'alice',
    draft: false,
    labels: [],
    additions: 20,
    deletions: 4,
    baseSha: 'base',
    headSha: 'head',
    diff: '',
    files: [
      {
        filename: '.github/workflows/ai-robot-review.yml',
        status: 'modified',
        additions: 18,
        deletions: 4,
        changes: 22,
      },
      {
        filename: 'test/main/services/team/TeamProvisioningService.test.ts',
        status: 'modified',
        additions: 2,
        deletions: 0,
        changes: 2,
      },
    ],
    ...overrides,
  };
}

describe('PullRequestDescriptionUpdater', () => {
  const client = {
    owner: 'owner',
    repo: 'repo',
    octokit: {
      rest: {
        pulls: {
          update: jest.fn(),
        },
      },
    },
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('preserves author text before the generated block', () => {
    const updater = new PullRequestDescriptionUpdater(client, false);
    const block = updater.buildGeneratedBlock(createPR());
    const merged = updater.merge('Manual PR description', block);

    expect(merged.startsWith('Manual PR description')).toBe(true);
    expect(merged).toContain('<!-- ai-robot-review-summary:start -->');
    expect(merged).toContain('## Summary by AI Robot Review');
  });

  it('replaces only the previous generated block', () => {
    const updater = new PullRequestDescriptionUpdater(client, false);
    const oldBody = [
      'Manual PR description',
      '',
      '<!-- ai-robot-review-summary:start -->',
      'old generated text',
      '<!-- ai-robot-review-summary:end -->',
    ].join('\n');

    const merged = updater.merge(oldBody, updater.buildGeneratedBlock(createPR()));

    expect(merged.startsWith('Manual PR description')).toBe(true);
    expect(merged).not.toContain('old generated text');
    expect(merged.match(/ai-robot-review-summary:start/g)).toHaveLength(1);
  });

  it('generates file list and walkthrough cohorts', () => {
    const updater = new PullRequestDescriptionUpdater(client, false);
    const block = updater.buildGeneratedBlock(createPR());

    expect(block).toContain('Files selected for processing (2)');
    expect(block).toContain('`.github/workflows/ai-robot-review.yml`');
    expect(block).toContain('TeamProvisioningService.test.ts');
    expect(block).toContain('CI workflow');
    expect(block).toContain('Tests');
    expect(block).toContain('## Tests');
    expect(block).toContain('changed test file');
    expect(block).toContain('Walkthrough');
  });

  it('updates pull request body through GitHub API', async () => {
    client.octokit.rest.pulls.update.mockResolvedValue({});
    const updater = new PullRequestDescriptionUpdater(client, false);

    await updater.update(createPR());

    expect(client.octokit.rest.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        pull_number: 42,
        body: expect.stringContaining('Author-written context stays first.'),
      })
    );
  });
});
