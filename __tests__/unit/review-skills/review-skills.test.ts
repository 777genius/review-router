import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCapturedReviewSkills } from '../../../src/control-plane/generated/review-action-v2/review-skills-contract';
import {
  LEGACY_REVIEW_SKILLS,
  assertReviewSkillsExecutionInput,
  createMaterializedReviewSkills,
  projectReviewSkillsForPaths,
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
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Fixture',
          GIT_AUTHOR_EMAIL: 'fixture@example.test',
          GIT_COMMITTER_NAME: 'Fixture',
          GIT_COMMITTER_EMAIL: 'fixture@example.test',
        },
      }).trim();
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

  it.each(['cycle', 'symlink', 'oversize', 'count'] as const)(
    'fails closed before inference on Git %s',
    async (scenario) => {
      const repo = fs.mkdtempSync(
        path.join(os.tmpdir(), 'review-skills-bounds-')
      );
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', repo, ...args], {
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Fixture',
            GIT_AUTHOR_EMAIL: 'fixture@example.test',
            GIT_COMMITTER_NAME: 'Fixture',
            GIT_COMMITTER_EMAIL: 'fixture@example.test',
          },
        }).trim();
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
