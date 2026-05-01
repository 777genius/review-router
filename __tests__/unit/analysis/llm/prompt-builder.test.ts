import { PromptBuilder } from '../../../../src/analysis/llm/prompt-builder';
import { PRContext } from '../../../../src/types';
import { DEFAULT_CONFIG } from '../../../../src/config/defaults';

describe('PromptBuilder', () => {
  const mockPR: PRContext = {
    number: 123,
    title: 'Test PR',
    body: 'Test description',
    author: 'test-user',
    draft: false,
    labels: [],
    files: [
      {
        filename: 'src/test.ts',
        status: 'modified',
        additions: 10,
        deletions: 5,
        changes: 15,
      },
    ],
    diff: 'diff --git a/src/test.ts b/src/test.ts\n@@ -1,5 +1,5 @@\n-old line\n+new line\n',
    additions: 10,
    deletions: 5,
    baseSha: 'abc123',
    headSha: 'def456',
  };

  describe('build()', () => {
    it('includes suggestion field in JSON schema', async () => {
      const builder = new PromptBuilder(DEFAULT_CONFIG);
      const prompt = await builder.build(mockPR);

      expect(prompt).toContain('suggestion');
      expect(prompt).toContain('Return JSON: [{file, line, severity, title, message, suggestion}]');
    });

    it('includes fixable issue type guidance', async () => {
      const builder = new PromptBuilder(DEFAULT_CONFIG);
      const prompt = await builder.build(mockPR);

      expect(prompt).toContain('SUGGESTION FIELD');
      expect(prompt).toContain('Fixable:');
      expect(prompt).toContain('NOT fixable:');
    });

    it('includes example JSON with suggestion field', async () => {
      const builder = new PromptBuilder(DEFAULT_CONFIG);
      const prompt = await builder.build(mockPR);

      expect(prompt).toContain('"suggestion":');
    });

    it('specifies fixable issue types', async () => {
      const builder = new PromptBuilder(DEFAULT_CONFIG);
      const prompt = await builder.build(mockPR);

      expect(prompt).toContain('null reference');
      expect(prompt).toContain('type error');
      expect(prompt).toContain('off-by-one');
      expect(prompt).toContain('missing null check');
      expect(prompt).toContain('resource leak');
    });

    it('treats clear user-visible regressions as reportable bugs', async () => {
      const builder = new PromptBuilder(DEFAULT_CONFIG);
      const prompt = await builder.build(mockPR);

      expect(prompt).toContain('user-visible functional regressions');
      expect(prompt).toContain('permanent loading');
      expect(prompt).toContain('dead-end navigation');
      expect(prompt).toContain('wrong access control state');
    });

    it('specifies non-fixable issue types', async () => {
      const builder = new PromptBuilder(DEFAULT_CONFIG);
      const prompt = await builder.build(mockPR);

      expect(prompt).toContain('architectural issues');
      expect(prompt).toContain('design suggestions');
      expect(prompt).toContain('unclear requirements');
    });

    it('includes instructions that suggestion must be exact replacement code', async () => {
      const builder = new PromptBuilder(DEFAULT_CONFIG);
      const prompt = await builder.build(mockPR);

      expect(prompt).toContain('EXACT replacement code');
      expect(prompt).toContain('Include ONLY the fixed code');
    });

    it('marks suggestion field as optional', async () => {
      const builder = new PromptBuilder(DEFAULT_CONFIG);
      const prompt = await builder.build(mockPR);

      expect(prompt).toContain('SUGGESTION FIELD (optional)');
      expect(prompt).toContain('Only include "suggestion" for FIXABLE issues');
    });

    it('summarizes low-signal large diffs in the prompt', async () => {
      const builder = new PromptBuilder({
        ...DEFAULT_CONFIG,
        smartDiffCompaction: true,
        maxFullDiffFileBytes: 1000,
      });
      const pr: PRContext = {
        ...mockPR,
        files: [
          ...mockPR.files,
          {
            filename: 'server/migrations/20260430/definition.json',
            status: 'added',
            additions: 1000,
            deletions: 0,
            changes: 1000,
          },
        ],
        diff: [
          mockPR.diff,
          'diff --git a/server/migrations/20260430/definition.json b/server/migrations/20260430/definition.json',
          '@@',
          `+${'{"table":"users"}\n+'.repeat(1000)}`,
        ].join('\n'),
      };

      const prompt = await builder.build(pr);

      expect(prompt).toContain('SMART DIFF COMPACTION');
      expect(prompt).toContain('summary-only in prompt: migration artifact');
      expect(prompt).toContain('full diff omitted from primary prompt');
      expect(prompt).toContain('git diff --');
      expect(prompt).not.toContain('{"table":"users"}');
      expect(prompt).toContain('+new line');
    });
  });

  describe('token-aware suggestion instructions', () => {
    it('includes suggestion instructions for small diffs', async () => {
      const builder = new PromptBuilder(DEFAULT_CONFIG);
      const smallDiff = 'diff --git a/test.ts b/test.ts\n+const x = 1;';
      const smallPR = { ...mockPR, diff: smallDiff };

      const prompt = await builder.build(smallPR);

      expect(prompt).toContain('SUGGESTION FIELD');
      expect(prompt).toContain('suggestion}]');
    });

    it('excludes suggestion instructions for large diffs', async () => {
      const builder = new PromptBuilder(DEFAULT_CONFIG);
      // Generate a diff that exceeds 50k tokens (~200k characters)
      const largeDiff = 'diff --git a/test.ts b/test.ts\n' + '+const x = 1;\n'.repeat(60000);
      const largePR = { ...mockPR, diff: largeDiff };

      const prompt = await builder.build(largePR);

      expect(prompt).not.toContain('SUGGESTION FIELD');
      // Should have original schema without suggestion
      expect(prompt).toContain('Return JSON: [{file, line, severity, title, message}]');
    });
  });
});
