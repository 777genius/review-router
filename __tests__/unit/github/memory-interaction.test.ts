import { parseMemoryInteraction } from '../../../src/github/memory-interaction';

describe('parseMemoryInteraction', () => {
  it('parses direct repository remember commands', () => {
    expect(
      parseMemoryInteraction('/rr remember repo Use compact badges for status.')
    ).toEqual({
      instructions: [
        {
          type: 'candidate',
          intent: 'explicit_command',
          extractionMethod: 'explicit_command',
          requestedScope: 'repository',
          candidateBody: 'Use compact badges for status.',
        },
      ],
    });
  });

  it('parses natural-language workspace memory requests', () => {
    expect(
      parseMemoryInteraction(
        'Remember for this workspace: use quiet operational dashboard layouts.'
      )
    ).toEqual({
      instructions: [
        {
          type: 'candidate',
          intent: 'explicit_natural_language',
          extractionMethod: 'explicit_natural_language',
          requestedScope: 'workspace',
          candidateBody: 'use quiet operational dashboard layouts.',
        },
      ],
    });
  });

  it('parses Russian natural-language repository memory requests', () => {
    expect(
      parseMemoryInteraction(
        'Запомни для проекта: ответы по умолчанию писать по-русски.'
      )
    ).toEqual({
      instructions: [
        {
          type: 'candidate',
          intent: 'explicit_natural_language',
          extractionMethod: 'explicit_natural_language',
          requestedScope: 'repository',
          candidateBody: 'ответы по умолчанию писать по-русски.',
        },
      ],
    });
  });

  it('parses confirmation and cleanup commands', () => {
    expect(parseMemoryInteraction('/rr remember mem_suggestion_abc')).toEqual({
      instructions: [
        {
          type: 'command',
          command: {
            kind: 'confirm_suggestion',
            suggestionId: 'mem_suggestion_abc',
          },
        },
      ],
    });
    expect(parseMemoryInteraction('/rr forget mem_abc')).toEqual({
      instructions: [
        {
          type: 'command',
          command: { kind: 'forget_memory', memoryItemId: 'mem_abc' },
        },
      ],
    });
  });

  it('rejects raw diff and secret-looking memory text', () => {
    expect(
      parseMemoryInteraction('/rr remember repo diff --git a/a.ts b/a.ts')
        .invalidReason
    ).toContain('code, diff, secret material');
    expect(
      parseMemoryInteraction('/rr remember repo github_pat_secret_value')
        .invalidReason
    ).toContain('code, diff, secret material');
  });

  it('does not treat normal discussion as memory', () => {
    expect(parseMemoryInteraction('Why did ReviewRouter flag this?')).toEqual({
      instructions: [],
    });
  });
});
