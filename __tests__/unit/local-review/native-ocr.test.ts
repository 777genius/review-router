import * as path from 'path';
import { NativeOcrEngine, normalizeNativeOcrResult, runNativeProcess, type NativeProcessRunner } from '../../../src/local-review/native-ocr';
import type { LocalGitSnapshot } from '../../../src/local-review/git-snapshot';
import type { LocalReviewRunRequest } from '../../../src/local-review/contracts';

const snapshot: LocalGitSnapshot = {
  root: '/tmp/rr-local-ocr-test', scope: { kind: 'worktree' },
  base: null, head: 'a'.repeat(40), digest: 'sha256:' + 'c'.repeat(64),
  changedFiles: 1, dirty: true, untrackedFiles: 0, untrackedPaths: [],
};
const item = { item_id: 'b'.repeat(64), path: 'src/index.ts' };
const preview = { files: [{ path: item.path, status: 'modified', will_review: true }], reviewable_count: 1 };
function native(status: string = 'complete') {
  return { status, llm: { provider: 'test', model: 'test-v1' }, comments: [
    { path: item.path, start_line: 7, end_line: 8, content: 'Problem in modified code', severity: 'high', thinking: 'secret reasoning' },
  ], manifest: { schema_version: 'ocr.run-manifest/v1', terminal_state: status, operation: 'review',
    input: { mode: 'workspace' }, execution: { provider: 'test', model: 'test-v1' },
    coverage: { selected: [item], completed: status === 'complete' ? [item] : [],
      reused: [], failed: status === 'partial' ? [item] : [], waived: [] } } };
}
const runner = (payload: unknown, onRequest?: (args: readonly string[]) => void): NativeProcessRunner => async (_cmd, args) => {
  onRequest?.(args);
  return { exitCode: 0, signal: null, stderr: '',
    stdout: args[0] === 'version' ? 'OpenCodeReview v1.13.1' : args.includes('--preview') ? JSON.stringify(preview) : JSON.stringify(payload),
  };
};
const request: LocalReviewRunRequest = { engine: 'ocr', scope: { kind: 'worktree' }, includeUntracked: false, preview: false };

describe('native OCR adapter', () => {
  const previousBinary = process.env.REVIEWROUTER_OCR_BINARY;
  beforeAll(() => {
    // The injected fake process runner must not depend on a real installation.
    process.env.REVIEWROUTER_OCR_BINARY = path.resolve('fixture-ocr-not-executed');
  });
  afterAll(() => {
    if (previousBinary === undefined) delete process.env.REVIEWROUTER_OCR_BINARY;
    else process.env.REVIEWROUTER_OCR_BINARY = previousBinary;
  });
  it('uses native CLI, preserves the real model and strips private thinking', async () => {
    const argv: string[][] = [];
    const result = await new NativeOcrEngine(runner(native(), a => argv.push([...a]))).run(snapshot, request);
    expect(result.status).toBe('complete');
    expect(result.summary.major).toBe(1);
    expect(result.provider.model).toBe('test-v1');
    expect(result.findings[0].nativeSeverity).toBe('high');
    expect(JSON.stringify(result)).not.toContain('secret reasoning');
    expect(argv[2]).toContain('--audience');
    expect(argv[2]).not.toContain('--reviewrouter-managed');
  });
  it('reports partial coverage even with exit-0', async () => {
    const result = await new NativeOcrEngine(runner(native('partial'))).run(snapshot, request);
    expect(result.status).toBe('partial');
    expect(result.coverage.omitted).toEqual([item.path]);
  });
  it('refuses a native manifest with wrong schema, unknown file, or missing coverage', () => {
    const malformed = native();
    malformed.manifest.schema_version = 'ocr.run-manifest/v2';
    expect(() => normalizeNativeOcrResult(malformed, [item.path], snapshot, '1.13.1')).toThrow(/schema/);
    const missing = native(); missing.manifest.coverage.completed = [];
    expect(() => normalizeNativeOcrResult(missing, [item.path], snapshot, '1.13.1')).toThrow(/exhaustive/);
    const foreign = native(); foreign.comments[0].path = '../private';
    expect(() => normalizeNativeOcrResult(foreign, [item.path], snapshot, '1.13.1')).toThrow(/path/);
  });
  it('refuses mismatched model attribution and unexpected native paths', () => {
    const mismatch = native();
    mismatch.manifest.execution.model = 'other-model';
    expect(() => normalizeNativeOcrResult(mismatch, [item.path], snapshot, '1.13.1')).toThrow(/attribution/);
    const unsafe = native(); unsafe.comments[0].path = 'src/\x1b[2Jbad.ts';
    expect(() => normalizeNativeOcrResult(unsafe, [item.path], snapshot, '1.13.1')).toThrow(/unsafe/);
  });
  it('never reports complete when native warnings or model provenance are absent', () => {
    const withWarnings = { ...native(), warnings: [{ file: item.path, reason: 'subagent warning' }] };
    const partial = normalizeNativeOcrResult(withWarnings, [item.path], snapshot, '1.13.1');
    expect(partial.status).toBe('partial');
    expect(partial.coverage.complete).toBe(false);
    const withoutModel = native();
    withoutModel.llm = {} as { provider: string; model: string };
    withoutModel.manifest.execution.model = '';
    const unknown = normalizeNativeOcrResult(withoutModel, [item.path], snapshot, '1.13.1');
    expect(unknown.status).toBe('partial');
    expect(unknown.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/model identity/)]));
  });
  it('rejects provider substitution or absent provenance for an explicit provider choice', async () => {
    await expect(new NativeOcrEngine(runner(native())).run(snapshot, {
      ...request, provider: 'different-provider',
    })).rejects.toThrow(/provider differed/);
    const withoutProvider = native();
    withoutProvider.llm.provider = '';
    withoutProvider.manifest.execution.provider = '';
    await expect(new NativeOcrEngine(runner(withoutProvider)).run(snapshot, {
      ...request, provider: 'test',
    })).rejects.toThrow(/provider differed/);
  });
  it('does not accept malformed or contradictory native warning/failure envelopes', () => {
    const malformedWarnings = { ...native(), warnings: 'not an array' };
    expect(() => normalizeNativeOcrResult(malformedWarnings, [item.path], snapshot, '1.13.1'))
      .toThrow(/warnings field/);

    const malformedFailure = { ...native(), manifest: {
      ...native().manifest, run_failure: true,
    } };
    expect(() => normalizeNativeOcrResult(malformedFailure, [item.path], snapshot, '1.13.1'))
      .toThrow(/run failure field/);

    const reportedFailure = { ...native(), manifest: {
      ...native().manifest, run_failure: { classification: 'provider', reason: 'synthetic_failure' },
    } };
    const result = normalizeNativeOcrResult(reportedFailure, [item.path], snapshot, '1.13.1');
    expect(result.status).toBe('partial');
    expect(result.coverage.complete).toBe(false);
  });
  it('rejects skipped manifests that conceal reviewed work or provider failures', () => {
    const reviewedButSkipped = native('skipped');
    reviewedButSkipped.manifest.coverage.completed = [item];
    expect(() => normalizeNativeOcrResult(reviewedButSkipped, [item.path], snapshot, '1.13.1'))
      .toThrow(/skipped result contradicts/);

    const skipped = native('skipped');
    const failedEnvelope = { ...skipped, comments: [], manifest: {
      ...skipped.manifest,
      coverage: { ...skipped.manifest.coverage, waived: [item] },
      run_failure: { classification: 'provider', reason: 'failed' },
    } };
    expect(() => normalizeNativeOcrResult(failedEnvelope, [item.path], snapshot, '1.13.1'))
      .toThrow(/skipped result contradicts/);
  });
  it('preserves native file-level findings when OCR could not verify a line', () => {
    const unanchored = native();
    unanchored.comments[0].start_line = 0;
    unanchored.comments[0].end_line = 0;
    const result = normalizeNativeOcrResult(unanchored, [item.path], snapshot, '1.13.1');
    expect(result.status).toBe('partial');
    expect(result.findings[0]).toMatchObject({ path: item.path, line: null, endLine: null });
    expect(result.warnings.join(' ')).toMatch(/verified source location/);
  });
  it('fails closed when OCR excludes a changed file as too large, preserving its reason', async () => {
    const custom: NativeProcessRunner = async (cmd, args, options) => {
      const response = await runner(native())(cmd, args, options);
      if (!args.includes('--preview')) return response;
      return { ...response, stdout: JSON.stringify({
        files: [
          ...preview.files,
          { path: 'src/large.ts', status: 'modified', will_review: false, exclude_reason: 'too_large' },
        ],
        reviewable_count: 1, excluded_count: 1, total_files: 2,
      }) };
    };
    const result = await new NativeOcrEngine(custom).run(snapshot, request);
    expect(result.status).toBe('partial');
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.omitted).toContain('src/large.ts');
    expect(result.warnings.join(' ')).toMatch(/src\/large.ts \(too_large\)/);
  });
  it('reports policy-excluded files but does not count them as inference failures', async () => {
    const custom: NativeProcessRunner = async (cmd, args, options) => {
      const response = await runner(native())(cmd, args, options);
      if (!args.includes('--preview')) return response;
      return { ...response, stdout: JSON.stringify({
        files: [
          ...preview.files,
          { path: 'src/secret.env', status: 'modified', will_review: false, exclude_reason: 'secret_exclude' },
        ],
        reviewable_count: 1, excluded_count: 1, total_files: 2,
      }) };
    };
    const result = await new NativeOcrEngine(custom).run(snapshot, request);
    expect(result.status).toBe('complete');
    expect(result.coverage.omitted).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/intentionally excluded/);
  });
  it('bounds a child that does not terminate gracefully', async () => {
    await expect(runNativeProcess(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], {
      cwd: process.cwd(), timeoutMs: 100, maxOutput: 16384,
    })).rejects.toThrow(/timeout/);
  });
  it('does not call the model when only a preview was requested', async () => {
    const requests: readonly string[][] = [] as string[][];
    const result = await new NativeOcrEngine(runner(native(), a => (requests as string[][]).push([...a]))).run(snapshot, { ...request, preview: true });
    expect(result.status).toBe('skipped');
    expect(requests.length).toBe(2);
    expect(result.coverage.selectedPaths).toEqual([item.path]);
    expect(result.coverage.omitted).toEqual([]);
  });
});
