import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createCapturedReviewSkills,
  reviewSkillsLimits,
} from '../../../src/control-plane/generated/review-action-v2/review-skills-contract';
import {
  LEGACY_REVIEW_SKILLS,
  assertReviewSkillsExecutionInput,
  createMaterializedReviewSkills,
  projectReviewSkillsForPaths,
  renderReviewSkillsForPaths,
  reviewSkillMatchesPath,
  reviewSkillsCacheIdentity,
} from '../../../src/review-skills/review-skills';
import {
  materializeReviewSkills,
  markdownReferences,
  parseGitReviewSkill,
} from '../../../src/review-skills/materialize-review-skills';
import { fetchCapturedReviewSkills } from '../../../src/review-skills/review-skills-transport';
import {
  incrementalCompatibilityPreimage,
  hashIncrementalCompatibility,
} from '../../../src/cache/key-builder';
import { PromptBuilder } from '../../../src/analysis/llm/prompt-builder';
import { prepareCodexReviewPrompt } from '../../../src/review-orchestration/infrastructure/codex-review-invocation-adapter';
import {
  buildOcrControlledRuleText,
  buildOcrSkillsControlledRuleText,
  buildOcrSemanticInvocationPreimage,
} from '../../../src/review-orchestration/infrastructure/ocr-review-invocation-adapter';
import type { PRContext, ReviewConfig } from '../../../src/types';

const baseSha = 'a'.repeat(40);

function fixtureGit(repo: string, args: string[], input?: string): string {
  const execute = (command: string[]) =>
    execFileSync('git', ['-C', repo, ...command], {
      input,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'iliya',
        GIT_AUTHOR_EMAIL: 'iliyazelenkog@gmail.com',
        GIT_COMMITTER_NAME: 'iliya',
        GIT_COMMITTER_EMAIL: 'iliyazelenkog@gmail.com',
      },
    }).trim();
  if (args[0] === 'commit')
    for (const identity of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'])
      expect(execute(['var', identity])).toMatch(
        /^iliya <iliyazelenkog@gmail.com> /
      );
  return execute(args);
}

function treeBudgetFixture(
  scenario: 'entries' | 'bytes' | 'cached aliases' | 'references' | 'two roots'
) {
  const repo = fs.mkdtempSync(
    path.join(os.tmpdir(), 'review-skills-tree-budget-')
  );
  const git = (args: string[], input?: string) => fixtureGit(repo, args, input);
  const listingBytes = (oid: string) =>
    Buffer.byteLength(git(['ls-tree', '-z', oid]));
  git(['init', '-q']);
  const blob = git(['hash-object', '-w', '--stdin'], 'inert fixture\n');
  const directories =
    scenario === 'bytes'
      ? 16
      : scenario === 'two roots'
        ? 17
        : scenario === 'references'
          ? 1
          : 33;
  const files =
    scenario === 'bytes' ? 240 : scenario === 'references' ? 4094 : 128;
  const shared = scenario === 'cached aliases' || scenario === 'two roots';
  const rows: string[] = [];
  let bytes = 0;
  for (let directory = 0; directory < directories; directory++) {
    const content = Array.from(
      { length: files },
      (_, file) =>
        `100644 blob ${blob}\tfile-${shared ? 0 : directory}-${file}-${scenario === 'bytes' ? 'x'.repeat(225) : ''}.md\n`
    ).join('');
    let oid = git(['mktree'], content);
    const size = listingBytes(oid);
    expect(size).toBeLessThan(reviewSkillsLimits.treeBytes);
    expect(files).toBeLessThan(reviewSkillsLimits.treeEntries);
    bytes += size;
    if (scenario === 'references') {
      const instructions = git(
        ['hash-object', '-w', '--stdin'],
        '---\nname: test\ndescription: test\n---\n[resource](nested/file-0-0-.md)'
      );
      oid = git(
        ['mktree'],
        `100644 blob ${instructions}\tSKILL.md\n040000 tree ${oid}\tnested\n`
      );
      bytes += listingBytes(oid);
    }
    rows.push(`040000 tree ${oid}\tdirectory-${directory}\n`);
  }
  const root = git(['mktree'], rows.join(''));
  bytes += listingBytes(root);
  const parent = git(['mktree'], `040000 tree ${root}\tskills\n`);
  const top = git(
    ['mktree'],
    `040000 tree ${parent}\t.agents\n` +
      (scenario === 'two roots' ? `040000 tree ${parent}\t.reviewrouter\n` : '')
  );
  git(['read-tree', top]);
  git(['commit', '-qm', 'test: exercise review Skills tree budget']);
  const base = git(['rev-parse', 'HEAD']);
  return {
    repo,
    bytes,
    entries: directories * (files + 1) + (scenario === 'references' ? 2 : 0),
    capture: createCapturedReviewSkills({
      baseSha: base,
      webSkills: [],
      gitSources:
        scenario === 'two roots'
          ? [{ root: '.agents/skills' }, { root: '.reviewrouter/skills' }]
          : [{ root: '.agents/skills' }],
    }),
  };
}
const web = (
  skillId = 'web-one',
  instructions = 'SKILL_ONE_MARKER',
  includePaths = ['src/**']
) => ({
  skillId,
  revisionId: 'revision-1',
  sourceWorkspaceId: 'source-1',
  name: skillId,
  description: 'Review custom invariants',
  instructions,
  includePaths,
  excludePaths: ['src/ignored.ts'],
});
const captured = (
  webSkills = [web()],
  gitSources: { root: '.agents/skills' }[] = [],
  base = baseSha
) =>
  createCapturedReviewSkills({
    baseSha: base,
    webSkills,
    gitSources,
  });
const config = {
  skipTrivialChanges: false,
  smartDiffCompaction: false,
  diffMaxBytes: 100000,
} as ReviewConfig;
const pr = {
  number: 1,
  title: 'change',
  author: 'a',
  body: '',
  baseSha,
  headSha: 'b'.repeat(40),
  diff: 'diff --git a/src/Foo.ts b/src/Foo.ts\n--- a/src/Foo.ts\n+++ b/src/Foo.ts\n@@ -1 +1 @@\n-old\n+new',
  files: [
    {
      filename: 'src/Foo.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      changes: 2,
      patch: '@@ -1 +1 @@\n-old\n+new',
    },
  ],
} as PRContext;

describe('captured text-only review skills', () => {
  it('composes every matching skill, respects exact case/dotfiles and excludes, and freezes the original', () => {
    const input = captured([
      web(),
      web('web-two', 'SKILL_TWO_MARKER'),
      web('other', 'OTHER_MARKER', ['other/**']),
    ]);
    const bundle = createMaterializedReviewSkills(input, []);
    const projection = projectReviewSkillsForPaths(bundle, [
      'src/Foo.ts',
      'src/ignored.ts',
      'SRC/Foo.ts',
    ]);
    expect(
      projection.find((item) => item.path === 'src/Foo.ts')?.instructions
    ).toMatch(/SKILL_ONE_MARKER[\s\S]*SKILL_TWO_MARKER/);
    expect(
      projection.find((item) => item.path === 'src/Foo.ts')?.instructions
    ).not.toContain('OTHER_MARKER');
    expect(
      projection.find((item) => item.path === 'src/ignored.ts')?.instructions
    ).toBe('');
    expect(
      projection.find((item) => item.path === 'SRC/Foo.ts')?.instructions
    ).toBe('');
    expect(
      reviewSkillMatchesPath(
        { includePaths: ['**'], excludePaths: [] },
        '.config/file.ts'
      )
    ).toBe(true);
    expect(Object.isFrozen(bundle)).toBe(true);
    if (bundle.kind !== 'captured') throw new Error('fixture');
    expect(Object.isFrozen(bundle.bundle.skills[0])).toBe(true);
    expect(() =>
      assertReviewSkillsExecutionInput(
        LEGACY_REVIEW_SKILLS,
        { reviewSkillsVersion: 1 },
        baseSha
      )
    ).toThrow('attachment_required');
    expect(() => assertReviewSkillsExecutionInput(bundle, {}, baseSha)).toThrow(
      'attachment_required'
    );
  });

  it('renders a 39 KiB native Skill once for 200 matching paths, including its resources', () => {
    const instructions = 'LARGE_SKILL_MARKER\n' + 'x'.repeat(31 * 1024);
    const content = 'LARGE_RESOURCE_MARKER\n' + 'y'.repeat(8 * 1024);
    const skills = createMaterializedReviewSkills(captured([]), [
      {
        skillId: 'git-large',
        revisionId: 'git-revision',
        origin: 'git',
        name: 'large',
        description: 'Large text-only review policy',
        instructions,
        includePaths: ['src/**'],
        excludePaths: ['src/ignored.ts'],
        resources: [{ path: 'details.md', content }],
      },
    ]);
    const paths = Array.from(
      { length: 200 },
      (_, index) => `src/file-${String(index).padStart(3, '0')}.ts`
    );
    const rendered = renderReviewSkillsForPaths(skills, [
      ...paths.slice().reverse(),
      paths[0],
      'src/ignored.ts',
      'SRC/file-000.ts',
    ]);
    expect(rendered.split('LARGE_SKILL_MARKER')).toHaveLength(2);
    expect(rendered.split('LARGE_RESOURCE_MARKER')).toHaveLength(2);
    expect(rendered).toContain(instructions);
    expect(rendered).toContain(content);
    expect(rendered).toContain(`Reviewed paths: ${JSON.stringify(paths)}`);
    expect(rendered).not.toContain('src/ignored.ts');
    expect(rendered).not.toContain('SRC/file-000.ts');
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThan(45 * 1024);
    expect(rendered).toBe(renderReviewSkillsForPaths(skills, paths));
    const projected = projectReviewSkillsForPaths(skills, paths);
    expect(projected).toHaveLength(200);
    expect(projected[0]).toEqual({
      path: paths[0],
      instructions:
        '### Review skill "git-large" revision "git-revision"\n' +
        'Name: "large"\nDescription: "Large text-only review policy"\n' +
        instructions +
        '\n#### Markdown reference "details.md"\n' +
        content,
    });
    expect(projected[199].instructions).toBe(projected[0].instructions);
  });

  it('keeps overlapping native scopes exact and deterministic while preserving OCR projection bytes', () => {
    const skills = createMaterializedReviewSkills(
      captured([
        web('second', 'SECOND_BODY', ['src/**']),
        web('first', 'FIRST_BODY', ['src/Foo.ts', 'src/.hidden.ts']),
      ]),
      []
    );
    const paths = [
      'src/foo.ts',
      'src/ignored.ts',
      'src/Foo.ts',
      'SRC/Foo.ts',
      'src/Foo.ts',
      'src/.hidden.ts',
    ];
    const rendered = renderReviewSkillsForPaths(skills, paths);
    expect(rendered).toContain(
      'Reviewed paths: ["src/.hidden.ts","src/Foo.ts"]\n' +
        '### Review skill "first" revision "revision-1"'
    );
    expect(rendered).toContain(
      'Reviewed paths: ["src/.hidden.ts","src/Foo.ts","src/foo.ts"]\n' +
        '### Review skill "second" revision "revision-1"'
    );
    expect(rendered.indexOf('FIRST_BODY')).toBeLessThan(
      rendered.indexOf('SECOND_BODY')
    );
    expect(rendered.split('FIRST_BODY')).toHaveLength(2);
    expect(rendered.split('SECOND_BODY')).toHaveLength(2);
    expect(rendered).not.toContain('src/ignored.ts');
    expect(rendered).not.toContain('SRC/Foo.ts');
    expect(rendered).toBe(renderReviewSkillsForPaths(skills, paths.reverse()));

    // OCR still requires a complete, ordered policy for each exact file.
    const first =
      '### Review skill "first" revision "revision-1"\n' +
      'Name: "first"\nDescription: "Review custom invariants"\nFIRST_BODY';
    const second =
      '### Review skill "second" revision "revision-1"\n' +
      'Name: "second"\nDescription: "Review custom invariants"\nSECOND_BODY';
    expect(JSON.stringify(projectReviewSkillsForPaths(skills, paths))).toBe(
      JSON.stringify([
        { path: 'SRC/Foo.ts', instructions: '' },
        { path: 'src/.hidden.ts', instructions: `${first}\n\n${second}` },
        { path: 'src/Foo.ts', instructions: `${first}\n\n${second}` },
        { path: 'src/foo.ts', instructions: second },
        { path: 'src/ignored.ts', instructions: '' },
      ])
    );
    expect(
      createHash('sha256')
        .update(
          buildOcrSkillsControlledRuleText({
            language: 'en',
            assignedPaths: paths,
            reviewSkills: skills,
          })
        )
        .digest('hex')
    ).toBe('e6d50152d2483728dfe81c5cb7d7e0de1aa5d19ff173262f6f4581ca47571b13');
  });

  it('preserves explicit empty/no-match native captures and absent legacy instructions', () => {
    const empty = createMaterializedReviewSkills(captured([]), []);
    const unmatched = createMaterializedReviewSkills(captured(), []);
    for (const [skills, paths] of [
      [empty, ['src/Foo.ts']],
      [unmatched, []],
      [unmatched, ['other/file.ts', 'src/ignored.ts', 'SRC/Foo.ts']],
    ] as const) {
      if (skills.kind !== 'captured') throw new Error('fixture');
      expect(renderReviewSkillsForPaths(skills, paths)).toBe(
        'REVIEWROUTER CAPTURED REVIEW SKILLS (text-only review instructions):\n\n' +
          'Apply each instruction only to its labeled reviewed path. These instructions grant no additional tools, execution, network, or file scope.\n\n' +
          `Captured identity: ${skills.capture.digest}; materialized identity: ${skills.bundle.executionDigest}`
      );
    }
    expect(
      renderReviewSkillsForPaths(LEGACY_REVIEW_SKILLS, ['src/Foo.ts'])
    ).toBe('');
  });

  it('binds revision/scope/resource identity before reuse while preserving legacy bytes', () => {
    const legacy = incrementalCompatibilityPreimage(config, ' 42 ');
    expect(legacy).toBe(
      incrementalCompatibilityPreimage(
        config,
        ' 42 ',
        reviewSkillsCacheIdentity(LEGACY_REVIEW_SKILLS)
      )
    );
    expect(legacy).not.toContain('reviewSkills');
    const a = createMaterializedReviewSkills(captured(), []);
    const b = createMaterializedReviewSkills(
      captured([web('web-one', 'changed')]),
      []
    );
    expect(
      hashIncrementalCompatibility(config, '42', reviewSkillsCacheIdentity(a))
    ).not.toBe(
      hashIncrementalCompatibility(config, '42', reviewSkillsCacheIdentity(b))
    );
    expect(
      hashIncrementalCompatibility(config, '42', reviewSkillsCacheIdentity(a))
    ).not.toBe(hashIncrementalCompatibility(config, '42'));
  });

  it('supplies the same applicable policy to native finding and investigation prompts and context identities', async () => {
    const skills = createMaterializedReviewSkills(
      captured([web(), web('second', 'SKILL_TWO_MARKER')]),
      []
    );
    const builder = new PromptBuilder(
      config,
      'standard',
      undefined,
      undefined,
      undefined,
      skills
    );
    const prompt = await builder.buildPreparedV2(pr);
    expect(prompt.prompt).toContain('SKILL_ONE_MARKER');
    expect(prompt.investigationContextPrompt).toContain('SKILL_TWO_MARKER');
    const assignment = {
      context: pr,
      lifecycleTargets: [],
      workSlot: { workSlotId: 'slot' },
      reviewRevisionHash: 'c'.repeat(64),
      mergeBaseSha: baseSha,
    } as unknown as Parameters<typeof prepareCodexReviewPrompt>[1];
    const native = await prepareCodexReviewPrompt(builder, assignment, true);
    expect(native.manifestPreimages.contextManifestHash).toContain(
      skills.kind === 'captured' ? skills.bundle.executionDigest : 'never'
    );
    const legacy = await new PromptBuilder(config).buildPreparedV2(pr);
    expect(legacy).not.toHaveProperty('reviewSkills');
    expect(legacy.prompt).not.toContain('CAPTURED REVIEW SKILLS');
  });

  it('preserves historical rr.3 policy/semantic identity and uses a separate corrected supporting branch', () => {
    const text = buildOcrControlledRuleText({
      language: 'en',
      assignedPaths: ['z.ts', 'src/Foo.ts'],
    });
    expect(createHash('sha256').update(text).digest('hex')).toBe(
      '0bed96d046fddbe2cb7d868e68acbd0b0ad3799bbebee41462b0ca9d19b0ab18'
    );
    const semantic = buildOcrSemanticInvocationPreimage({
      revision: { baseSha, mergeBaseSha: baseSha, headSha: 'b'.repeat(40) },
      assignedPaths: ['z.ts', 'src/Foo.ts'],
      ruleText: text,
      backgroundText: null,
      binary: {
        profileRef: 'ocr-managed-v2',
        sha256: '1'.repeat(64),
        packageVersion: '1.13.1-rr.3',
      },
      model: 'fixture',
      ocrEffort: 'medium',
      modelReasoningEffort: null,
      language: 'en',
      limits: { requestTimeoutSec: 600 },
      retryPolicyVersion: 'ocr-managed-no-replay.v1',
      attemptBudget: 1,
    });
    expect(createHash('sha256').update(semantic).digest('hex')).toBe(
      '482319de1123a1cf3552838e72778dce1fe3bfbf531cee53d8b5f11a2d635cc5'
    );
    for (const capture of [captured([]), captured()]) {
      const reviewSkills = createMaterializedReviewSkills(capture, []);
      const corrected = JSON.parse(
        buildOcrSkillsControlledRuleText({
          language: 'en',
          assignedPaths: ['src/[x].ts', 'src/Foo.ts', 'src/foo.ts'],
          reviewSkills,
        })
      );
      expect(corrected.reviewrouter_managed_paths).toEqual([
        'src/Foo.ts',
        'src/[x].ts',
        'src/foo.ts',
      ]);
      expect(
        corrected.rules.every(
          (rule: Record<string, unknown>) =>
            rule.merge_system_rule === true &&
            rule.reviewrouter_exact_path === true &&
            typeof rule.rule === 'string'
        )
      ).toBe(true);
      expect(corrected.rules[0].rule).toContain('introduced or aggravated');
    }
  });

  it('reads exact trusted Git objects, including references, despite malicious checkout HEAD changes', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-skills-git-'));
    const git = (...args: string[]) => fixtureGit(repo, args);
    const dir = path.join(repo, '.agents/skills/quality');
    try {
      git('init', '-q');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        '---\nname: quality\ndescription: review quality\n---\nTRUSTED_MARKER [check](details.md#anchor)'
      );
      fs.writeFileSync(path.join(dir, 'details.md'), 'TRUSTED_RESOURCE');
      git('add', '.');
      git('commit', '-qm', 'trusted');
      const base = git('rev-parse', 'HEAD');
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        '---\nname: evil\ndescription: evil\n---\nHEAD_EVIL_MARKER'
      );
      fs.writeFileSync(path.join(dir, 'details.md'), 'HEAD_EVIL_RESOURCE');
      git('commit', '-qam', 'untrusted');
      const materialized = await materializeReviewSkills({
        capture: captured([], [{ root: '.agents/skills' }], base),
        baseSha: base,
        checkoutRoot: repo,
      });
      expect(JSON.stringify(materialized)).toContain('TRUSTED_MARKER');
      expect(JSON.stringify(materialized)).toContain('TRUSTED_RESOURCE');
      expect(JSON.stringify(materialized)).not.toContain('HEAD_EVIL');
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        '---\nname: quality\ndescription: quality\n---\n[escape](../../../private.md)'
      );
      git('commit', '-qam', 'bad reference');
      const bad = git('rev-parse', 'HEAD');
      await expect(
        materializeReviewSkills({
          capture: captured([], [{ root: '.agents/skills' }], bad),
          baseSha: bad,
          checkoutRoot: repo,
        })
      ).rejects.toThrow('reference_traversal');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects execution frontmatter and unsupported refs; never fetches external URLs', () => {
    expect(() =>
      parseGitReviewSkill(
        '---\nname: a\ndescription: a\nallowed-tools: shell\n---\nbody'
      )
    ).toThrow('frontmatter_unsupported');
    expect(() =>
      parseGitReviewSkill('---\nname: &a test\ndescription: *a\n---\nbody')
    ).toThrow('frontmatter_invalid');
    expect(
      markdownReferences(
        '[link](https://example.com/a.md) [anchor](#a) [ref][x]\n[x]: doc.md#section'
      )
    ).toEqual(['doc.md']);
    expect(() => markdownReferences('[bad](doc%20name.md)')).toThrow(
      'reference_unsupported'
    );
  });

  it('rejects used local Markdown shortcuts without treating other link forms as shortcuts', () => {
    expect(() =>
      markdownReferences('Follow [checks].\n\n[checks]: required.md')
    ).toThrow('reference_unsupported');
    expect(() =>
      markdownReferences('Follow [ CHECKS ].\n\n[checks]: required.md#section')
    ).toThrow('reference_unsupported');
    expect(
      markdownReferences(
        '[inline](inline.md) [full][checks] [collapsed][] [docs] [anchor]\n' +
          '[checks]: required.md\n[collapsed]: collapsed.md\n' +
          '[docs]: https://example.com/docs.md\n[anchor]: #section\n' +
          '[unused]: unused.md'
      )
    ).toEqual(['collapsed.md', 'inline.md', 'required.md']);
    expect(
      markdownReferences(
        '`[checks]` ``[checks]`` \\[checks]\n' +
          '```md\n[checks]\n[example](missing.md)\n```\n' +
          '~~~md\n[checks]\n[example](missing.md)\n~~~\n' +
          '[checks]: required.md'
      )
    ).toEqual([]);
  });

  it.each(['cycle', 'symlink', 'oversize', 'count'] as const)(
    'fails closed before inference on Git %s',
    async (scenario) => {
      const repo = fs.mkdtempSync(
        path.join(os.tmpdir(), 'review-skills-bounds-')
      );
      const git = (...args: string[]) => fixtureGit(repo, args);
      const prefix = '---\nname: test\ndescription: test\n---\n';
      try {
        git('init', '-q');
        const directory = path.join(repo, '.agents/skills/test');
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
          path.join(directory, 'SKILL.md'),
          prefix + '[reference](details.md)'
        );
        if (scenario === 'cycle')
          fs.writeFileSync(
            path.join(directory, 'details.md'),
            '[cycle](SKILL.md)'
          );
        if (scenario === 'symlink')
          fs.symlinkSync('/etc/passwd', path.join(directory, 'details.md'));
        if (scenario === 'oversize')
          fs.writeFileSync(
            path.join(directory, 'details.md'),
            'x'.repeat(16 * 1024 + 1)
          );
        if (scenario === 'count')
          for (let i = 0; i < 33; i++) {
            const other = path.join(repo, '.agents/skills', `skill-${i}`);
            fs.mkdirSync(other);
            fs.writeFileSync(
              path.join(other, 'SKILL.md'),
              'INVALID BODY MUST NOT BE PARSED'
            );
          }
        git('add', '.');
        git('commit', '-qm', 'fixture');
        const base = git('rev-parse', 'HEAD');
        await expect(
          materializeReviewSkills({
            capture: captured([], [{ root: '.agents/skills' }], base),
            baseSha: base,
            checkoutRoot: repo,
          })
        ).rejects.toThrow(
          scenario === 'cycle'
            ? 'reference_cycle'
            : scenario === 'symlink'
              ? 'git_nonregular'
              : scenario === 'count'
                ? 'count_invalid'
                : 'blob_too_large'
        );
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    }
  );

  it.each(['entries', 'bytes', 'cached aliases', 'references'] as const)(
    'bounds cumulative Git tree %s during materialization',
    async (scenario) => {
      const fixture = treeBudgetFixture(scenario);
      try {
        if (scenario === 'bytes') {
          expect(fixture.entries).toBeLessThan(reviewSkillsLimits.treeEntries);
          expect(fixture.bytes).toBeGreaterThan(reviewSkillsLimits.treeBytes);
        } else {
          expect(fixture.entries).toBeGreaterThan(
            reviewSkillsLimits.treeEntries
          );
          expect(fixture.bytes).toBeLessThan(reviewSkillsLimits.treeBytes);
        }
        await expect(
          materializeReviewSkills({
            capture: fixture.capture,
            baseSha: fixture.capture.baseSha,
            checkoutRoot: fixture.repo,
          })
        ).rejects.toThrow('review_skills_git_tree_too_large');
      } finally {
        fs.rmSync(fixture.repo, { recursive: true, force: true });
      }
    }
  );

  it('keeps independent Git root budgets when object IDs are shared', async () => {
    const fixture = treeBudgetFixture('two roots');
    try {
      expect(fixture.entries).toBeLessThan(reviewSkillsLimits.treeEntries);
      expect(fixture.entries * 2).toBeGreaterThan(
        reviewSkillsLimits.treeEntries
      );
      const result = await materializeReviewSkills({
        capture: fixture.capture,
        baseSha: fixture.capture.baseSha,
        checkoutRoot: fixture.repo,
      });
      expect(result.kind).toBe('captured');
      if (result.kind === 'captured') expect(result.bundle.skills).toEqual([]);
    } finally {
      fs.rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it('fetches only a bounded run-authorized companion and rejects base/digest/stream corruption', async () => {
    const capture = captured();
    const mocked = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        new Response(JSON.stringify(capture), {
          headers: { 'content-type': 'application/json' },
        })
      );
    expect(
      await fetchCapturedReviewSkills({
        apiUrl: 'https://api.example.test',
        authorizationToken: 'run-token',
        baseSha,
        fetchImpl: mocked,
      })
    ).toEqual(capture);
    expect(mocked.mock.calls[0][0].toString()).toBe(
      'https://api.example.test/api/action/v2/skills'
    );
    expect(mocked.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      body: '{}',
      redirect: 'error',
      cache: 'no-store',
      headers: { authorization: 'Bearer run-token' },
    });
    const response = (value: string | Uint8Array) => async () =>
      new Response(
        typeof value === 'string' ? value : new Uint8Array(value).buffer,
        { headers: { 'content-type': 'application/json' } }
      );
    await expect(
      fetchCapturedReviewSkills({
        apiUrl: 'https://api.example.test',
        authorizationToken: 'run-token',
        baseSha: 'b'.repeat(40),
        fetchImpl: response(JSON.stringify(capture)),
      })
    ).rejects.toThrow('capture_mismatch');
    await expect(
      fetchCapturedReviewSkills({
        apiUrl: 'https://api.example.test',
        authorizationToken: 'run-token',
        baseSha,
        fetchImpl: response(' '.repeat(256 * 1024 + 1)),
      })
    ).rejects.toThrow('response_too_large');
    await expect(
      fetchCapturedReviewSkills({
        apiUrl: 'https://api.example.test',
        authorizationToken: 'run-token',
        baseSha,
        fetchImpl: response(new Uint8Array([255])),
      })
    ).rejects.toThrow();
    let cancelled = false;
    const hanging = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      fetchCapturedReviewSkills({
        apiUrl: 'https://api.example.test',
        authorizationToken: 'run-token',
        baseSha,
        timeoutMs: 10,
        fetchImpl: async () =>
          new Response(hanging, {
            headers: { 'content-type': 'application/json' },
          }),
      })
    ).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
});
