import { parseLocalReviewOptions } from '../../../src/local-review/cli-options';

const parse = (...args: string[]) => parseLocalReviewOptions(args);

describe('engine-neutral local review arguments', () => {
  it('preserves the legacy tracked-only default without implicit model selection', () => {
    expect(parse()).toEqual({ format: 'text', request: { engine: 'legacy', scope: { kind: 'worktree' }, includeUntracked: false, preview: false } });
  });
  it('parses explicit OCR scopes and agent JSON', () => {
    expect(parse('--engine=ocr', '--scope=branch', '--base=origin/main', '--format=json').request)
      .toMatchObject({ engine: 'ocr', scope: { kind: 'branch', base: 'origin/main' } });
    expect(parse('--engine', 'ocr', '--scope', 'commit', '--ref', 'HEAD').request.scope)
      .toEqual({ kind: 'commit', ref: 'HEAD' });
  });
  it.each([
    ['--engine=other'], ['--engine=ocr', '--scope=branch'], ['--engine=ocr', '--scope=commit'],
    ['--engine=ocr', '--base=HEAD'], ['--engine=ocr', '--include-untracked', '--scope=commit', '--ref=HEAD'],
    ['--engine=ocr', '--config=a.yml'], ['--engine=legacy', '--preview'], ['--engine=legacy', '--model=x'],
    ['--engine=ocr', '--engine=ocr'], ['--engine=ocr', '--bad-option'],
    ['--engine=ocr', '--format=yaml'], ['--engine=ocr', '--scope=branch', '--base=HEAD', '--ref=HEAD'],
  ])('rejects invalid arguments before inference: %j', (...args) => {
    expect(() => parse(...args)).toThrow();
  });
});
