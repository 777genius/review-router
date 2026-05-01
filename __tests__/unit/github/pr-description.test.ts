import { PullRequestDescriptionUpdater } from '../../../src/github/pr-description';
import { GitHubClient } from '../../../src/github/client';
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
        filename: '.github/workflows/review-router.yml',
        status: 'modified',
        additions: 18,
        deletions: 4,
        changes: 22,
        patch: [
          '@@ -1,6 +1,20 @@',
          '+name: ReviewRouter',
          '+on:',
          '+  pull_request:',
          '+  workflow_dispatch:',
          '+jobs:',
          '+  review:',
          '+    steps:',
          '+      - uses: actions/checkout@v6',
          '+      - name: Restore Codex OAuth',
          '+        env:',
          '+          CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}',
          '+      - name: Run ReviewRouter',
          '+        uses: 777genius/review-router@main',
          '+        with:',
          '+          CODEX_MODEL: gpt-5.5',
          '+          CODEX_REASONING_EFFORT: medium',
        ].join('\n'),
      },
      {
        filename: 'test/main/services/team/TeamProvisioningService.test.ts',
        status: 'modified',
        additions: 2,
        deletions: 0,
        changes: 2,
        patch: [
          '@@ -10,6 +10,8 @@',
          '+describe("TeamProvisioningService", () => {',
          '+  it("skips tmux PID lookup for legacy process markers", () => {});',
        ].join('\n'),
      },
    ],
    ...overrides,
  };
}

describe('PullRequestDescriptionUpdater', () => {
  const updateMock = jest.fn();
  const client = {
    owner: 'owner',
    repo: 'repo',
    octokit: {
      rest: {
        pulls: {
          update: updateMock,
        },
      },
    },
  } as unknown as GitHubClient;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('preserves author text before the generated block', () => {
    const updater = new PullRequestDescriptionUpdater(client, false);
    const block = updater.buildGeneratedBlock(createPR());
    const merged = updater.merge('Manual PR description', block);

    expect(merged.startsWith('Manual PR description')).toBe(true);
    expect(merged).toContain('<!-- review-router-summary:start -->');
    expect(merged).toContain('## Summary');
  });

  it('replaces only the previous generated block', () => {
    const updater = new PullRequestDescriptionUpdater(client, false);
    const oldBody = [
      'Manual PR description',
      '',
      '<!-- review-router-summary:start -->',
      'old generated text',
      '<!-- review-router-summary:end -->',
    ].join('\n');

    const merged = updater.merge(
      oldBody,
      updater.buildGeneratedBlock(createPR())
    );

    expect(merged.startsWith('Manual PR description')).toBe(true);
    expect(merged).not.toContain('old generated text');
    expect(merged.match(/review-router-summary:start/g)).toHaveLength(1);
  });

  it('replaces legacy AI Robot Review generated blocks', () => {
    const updater = new PullRequestDescriptionUpdater(client, false);
    const oldBody = [
      'Manual PR description',
      '',
      '<!-- ai-robot-review-summary:start -->',
      'old generated text',
      '<!-- ai-robot-review-summary:end -->',
    ].join('\n');

    const merged = updater.merge(
      oldBody,
      updater.buildGeneratedBlock(createPR())
    );

    expect(merged.startsWith('Manual PR description')).toBe(true);
    expect(merged).not.toContain('old generated text');
    expect(merged).not.toContain('ai-robot-review-summary');
    expect(merged.match(/review-router-summary:start/g)).toHaveLength(1);
  });


  it('generates file list and walkthrough cohorts', () => {
    const updater = new PullRequestDescriptionUpdater(client, false);
    const block = updater.buildGeneratedBlock(createPR());

    expect(block).toContain('Files selected for processing (2)');
    expect(block).toContain('`.github/workflows/review-router.yml`');
    expect(block).toContain('TeamProvisioningService.test.ts');
    expect(block).toContain('CI workflow');
    expect(block).toContain('Tests');
    expect(block).toContain('## Tests');
    expect(block).toContain('changed test file');
    expect(block).toContain('Walkthrough');
    expect(block).toContain('runs it on pull requests and manual dispatch');
    expect(block).toContain('restores Codex OAuth credentials');
    expect(block).toContain('sets the Codex model');
    expect(block).toContain('sets reasoning effort');
    expect(block).toContain('uses the latest reviewer from the main branch');
    expect(block).toContain('Line stats: 1 modified; +18/-4.');
    expect(block).not.toContain('1 modified with +18/-4 lines.');
  });

  it('puts semantic summary bullets at the top', () => {
    const updater = new PullRequestDescriptionUpdater(client, false);
    const block = updater.buildGeneratedBlock(
      createPR({
        title: 'feat: apple moderation mode #RAZRABOTKA-155',
        additions: 8079,
        deletions: 86,
        files: [
          {
            filename: 'tvolkova_client/lib/src/protocol/user_profile/user_profile.dart',
            status: 'modified',
            additions: 12,
            deletions: 0,
            changes: 12,
            patch: '+  bool? hidePaidFeaturesInfo;',
          },
          {
            filename: 'tvolkova_flutter/lib/admin/users/user_full_info/widgets/hide_paid_features_checkbox.dart',
            status: 'added',
            additions: 36,
            deletions: 0,
            changes: 36,
            patch: '+class HidePaidFeaturesCheckbox extends StatelessWidget {}',
          },
          {
            filename: 'tvolkova_flutter/lib/app/learning/course_locked_stub.dart',
            status: 'modified',
            additions: 8,
            deletions: 3,
            changes: 11,
            patch: '+if (profile.hidePaidFeaturesInfo == true) return const SizedBox();',
          },
          {
            filename: 'tvolkova_server/migrations/20260430152122670/definition.json',
            status: 'added',
            additions: 4214,
            deletions: 0,
            changes: 4214,
            patch: '+{"hidePaidFeaturesInfo": true}',
          },
        ],
      })
    );

    expect(block).toContain('## Summary');
    expect(block).toContain(
      '- add hide paid features info support to user profile models and protocol types'
    );
    expect(block).toContain('- add admin user controls for hide paid features info');
    expect(block).toContain(
      '- update learning and course screens to respect hide paid features info'
    );
    expect(block).toContain(
      '- add generated server artifacts and migration metadata for hide paid features info'
    );
  });

  it('summarizes source files with function and behavior context', () => {
    const updater = new PullRequestDescriptionUpdater(client, false);
    const block = updater.buildGeneratedBlock(
      createPR({
        additions: 2,
        deletions: 5,
        files: [
          {
            filename: 'src/billing.js',
            status: 'modified',
            additions: 2,
            deletions: 5,
            changes: 7,
            patch: [
              '@@ -4,9 +4,6 @@ export async function getBillingSummary(db, plans, planId, email) {',
              '   const plan = findPlan(plans, planId);',
              '   const normalizedEmail = normalizeEmail(email);',
              '-',
              "-  return db.query('select * from billing where email = ? and plan = ?', [",
              '-    normalizedEmail,',
              "-    plan?.id ?? 'free',",
              '-  ]);',
              "+  const rows = await db.query(`select * from billing where email = '${normalizedEmail}' and plan = '${plan.id}' limit 1`);",
              '+  return rows[0] || null;',
              ' }',
            ].join('\n'),
          },
        ],
      })
    );

    expect(block).toContain(
      'Updates getBillingSummary: changes database query construction, fallback/null handling, return value handling.'
    );
    expect(block).not.toContain('source logic around rows');
  });

  it('updates pull request body through GitHub API', async () => {
    updateMock.mockResolvedValue({});
    const updater = new PullRequestDescriptionUpdater(client, false);

    await updater.update(createPR());

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        pull_number: 42,
        body: expect.stringContaining('Author-written context stays first.'),
      })
    );
  });
});
