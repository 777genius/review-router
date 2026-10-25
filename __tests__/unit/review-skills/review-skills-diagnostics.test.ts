import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCapturedReviewSkills } from '../../../src/control-plane/generated/review-action-v2/review-skills-contract';
import {
  materializeReviewSkills,
  materializeReviewSkillsWithDiagnostics,
} from '../../../src/review-skills/materialize-review-skills';
import { ReviewSkillsMaterializationError } from '../../../src/review-skills/review-skills-error';

describe('repository Skills diagnostic boundaries', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'user.name=iliya',
        '-c',
        'user.email=iliyazelenkog@gmail.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'iliya',
          GIT_AUTHOR_EMAIL: 'iliyazelenkog@gmail.com',
          GIT_COMMITTER_NAME: 'iliya',
          GIT_COMMITTER_EMAIL: 'iliyazelenkog@gmail.com',
        },
      }
    ).trim();
  const commit = () => {
    git('add', '.');
    for (const identity of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'])
      expect(git('var', identity)).toMatch(
        /^iliya <iliyazelenkog@gmail\.com> /
      );
    git('commit', '-qm', 'test: review skills diagnostic fixture');
    return git('rev-parse', 'HEAD');
  };
  const source = '.agents/skills/review/SKILL.md';
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-skills-diagnostic-'));
    git('init', '-q');
    fs.mkdirSync(path.join(repo, '.agents/skills/review'), { recursive: true });
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));
  const run = (baseSha: string) =>
    materializeReviewSkillsWithDiagnostics({
      capture: createCapturedReviewSkills({
        baseSha,
        webSkills: [],
        gitSources: [
          { root: '.agents/skills' },
          { root: '.reviewrouter/skills' },
        ],
      }),
      baseSha,
      checkoutRoot: repo,
    });
  it('returns missing/empty/loaded roots outside the unchanged hashed bundle', async () => {
    fs.writeFileSync(path.join(repo, '.agents/skills/.keep'), '');
    let base = commit();
    expect((await run(base)).gitRoots).toEqual([
      { root: '.agents/skills', status: 'empty', skillCount: 0 },
      { root: '.reviewrouter/skills', status: 'missing', skillCount: 0 },
    ]);
    fs.writeFileSync(
      path.join(repo, source),
      '---\nname: review\ndescription: Review code\n---\nCheck code.'
    );
    base = commit();
    const materialized = await run(base);
    expect(materialized.gitRoots[0]).toEqual({
      root: '.agents/skills',
      status: 'loaded',
      skillCount: 1,
    });
    expect(materialized.executionInput).toEqual(
      await materializeReviewSkills({
        capture: createCapturedReviewSkills({
          baseSha: base,
          webSkills: [],
          gitSources: [
            { root: '.agents/skills' },
            { root: '.reviewrouter/skills' },
          ],
        }),
        baseSha: base,
        checkoutRoot: repo,
      })
    );
    expect(JSON.stringify(materialized.executionInput)).not.toContain(
      'gitRoots'
    );
  });
  it.each([
    ['name', '---\nname: 42\ndescription: Review\n---\nSECRET_BODY'],
    ['description', '---\nname: review\ndescription: ""\n---\nSECRET_BODY'],
    ['instructions', '---\nname: review\ndescription: Review\n---\n'],
    ['frontmatter', '---\nname: [invalid\n---\nSECRET_BODY'],
  ])('attributes %s without exposing parser bodies', async (field, text) => {
    fs.writeFileSync(path.join(repo, source), text);
    const base = commit();
    const error = await run(base).catch((value) => value);
    expect(error).toBeInstanceOf(ReviewSkillsMaterializationError);
    expect(error.diagnostic).toEqual({ baseSha: base, path: source, field });
    expect(error.message).toBe('review_skills_frontmatter_invalid');
    expect(JSON.stringify(error)).not.toContain('SECRET_BODY');
  });
  it.each(['skill', 'reference'])(
    'attributes fatal UTF-8 in %s blobs without raw decoder errors',
    async (kind) => {
      fs.writeFileSync(
        path.join(repo, source),
        kind === 'skill'
          ? Buffer.from([255])
          : '---\nname: review\ndescription: Review\n---\nRead [rules](rules.md).'
      );
      if (kind === 'reference')
        fs.writeFileSync(
          path.join(repo, '.agents/skills/review/rules.md'),
          Buffer.from([255])
        );
      const base = commit();
      const error = await run(base).catch((value) => value);
      expect(error).toBeInstanceOf(ReviewSkillsMaterializationError);
      expect(error.code).toBe('review_skills_git_text_invalid');
      expect(error.diagnostic.path).toBe(source);
      if (kind === 'reference')
        expect(error.diagnostic.reference).toBe('rules.md');
    }
  );
  it('attributes a missing reference to its source file and reference target', async () => {
    fs.writeFileSync(
      path.join(repo, source),
      '---\nname: review\ndescription: Review\n---\nRead [rules](missing.md).'
    );
    const base = commit();
    await expect(run(base)).rejects.toMatchObject({
      code: 'review_skills_reference_missing',
      diagnostic: {
        baseSha: base,
        path: source,
        field: 'reference',
        reference: 'missing.md',
      },
    });
  });

  it('preserves cancellation during a Markdown reference read', async () => {
    fs.writeFileSync(
      path.join(repo, source),
      '---\nname: review\ndescription: Review\n---\nRead [rules](rules.md).'
    );
    fs.writeFileSync(
      path.join(repo, '.agents/skills/review/rules.md'),
      'Reference instructions.'
    );
    const baseSha = commit();
    const referenceOid = git(
      'rev-parse',
      `${baseSha}:.agents/skills/review/rules.md`
    );
    const controller = new AbortController();
    const reason = new Error('account_gateway_cancelled');
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('node:util', () => {
          const actual =
            jest.requireActual<typeof import('node:util')>('node:util');
          return {
            ...actual,
            promisify: (fn: Parameters<typeof actual.promisify>[0]) => {
              const invoke = actual.promisify(fn);
              return (...args: unknown[]) => {
                const argv = args[1];
                if (
                  Array.isArray(argv) &&
                  argv.includes('cat-file') &&
                  argv.includes('blob') &&
                  argv.at(-1) === referenceOid
                )
                  controller.abort(reason);
                return invoke(...args);
              };
            },
          };
        });
        const materializer =
          await import('../../../src/review-skills/materialize-review-skills');
        await expect(
          materializer.materializeReviewSkillsWithDiagnostics({
            capture: createCapturedReviewSkills({
              baseSha,
              webSkills: [],
              gitSources: [{ root: '.agents/skills' }],
            }),
            baseSha,
            checkoutRoot: repo,
            signal: controller.signal,
          })
        ).rejects.toBe(reason);
        expect(controller.signal.aborted).toBe(true);
      });
    } finally {
      jest.dontMock('node:util');
    }
  });

  it('attributes fatal UTF-8 at the tree enumeration boundary', async () => {
    fs.writeFileSync(
      Buffer.concat([Buffer.from(`${repo}/`), Buffer.from([255])]),
      'inert'
    );
    const base = commit();
    await expect(run(base)).rejects.toMatchObject({
      code: 'review_skills_git_text_invalid',
      diagnostic: { baseSha: base, field: 'root' },
    });
  });
});
