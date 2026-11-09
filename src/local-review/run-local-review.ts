import { LocalReviewOutcome, LocalReviewRunRequest, LocalReviewUsageError, summaryFromFindings } from './contracts';
import { LocalGitSnapshotReader, LocalGitSnapshot } from './git-snapshot';
import { NativeOcrEngine } from './native-ocr';
import { runLegacyLocalReview } from './legacy-engine';

/** Minimal application use case: frozen scope -> engine -> frozen scope check. */
export async function runLocalReview(
  request: LocalReviewRunRequest,
  dependencies: {
    git?: LocalGitSnapshotReader;
    ocr?: Pick<NativeOcrEngine, 'run'>;
    legacy?: typeof runLegacyLocalReview;
    configFile?: string;
  } = {}
): Promise<LocalReviewOutcome> {
  const git = dependencies.git ?? new LocalGitSnapshotReader();
  // Prevent an unsupported mode from falling through to another engine.
  if (request.engine === 'legacy' && request.preview) {
    throw new LocalReviewUsageError('Preview requires --engine ocr.');
  }
  if (request.engine === 'legacy' && request.includeUntracked) {
    throw new LocalReviewUsageError('Legacy review cannot include untracked files.');
  }
  const before = git.capture(request.scope, request.includeUntracked);
  if (request.engine === 'ocr' && request.scope.kind === 'worktree' && before.untrackedFiles > 0 && !request.includeUntracked) {
    throw new LocalReviewUsageError(
      `${before.untrackedFiles} untracked file(s) would be included by native OCR. Re-run with --include-untracked to explicitly allow them.`
    );
  }
  if (request.engine === 'ocr' && request.scope.kind !== 'worktree' && before.dirty) {
    throw new LocalReviewUsageError('Native OCR branch/commit review requires a clean working tree; its agent reads local context files.');
  }
  if (before.changedFiles === 0) return emptyOutcome(before, request.engine);
  let result: LocalReviewOutcome;
  try {
    result = request.engine === 'ocr'
      ? await (dependencies.ocr ?? new NativeOcrEngine()).run(before, request)
      : await (dependencies.legacy ?? runLegacyLocalReview)(before, request, dependencies.configFile);
  } catch (error) {
    // CLI callers preserve errors as failures, never a green no-finding result.
    throw error;
  }
  const after = git.capture(request.scope, request.includeUntracked);
  if (after.digest !== before.digest || after.root !== before.root) {
    result = { ...result, status: 'stale', coverage: { ...result.coverage, complete: false },
      warnings: [...result.warnings, 'Git files or refs changed during the review. Rerun on a stable snapshot.'] };
  }
  return result;
}

function emptyOutcome(snapshot: LocalGitSnapshot, engine: LocalReviewRunRequest['engine']): LocalReviewOutcome {
  const findings: LocalReviewOutcome['findings'] = [];
  return { schemaVersion: 1, engine: { id: engine, version: null }, status: 'skipped',
    input: { scope: snapshot.scope.kind, base: snapshot.base, head: snapshot.head, snapshotDigest: snapshot.digest },
    coverage: { selected: 0, reviewed: 0, omitted: [], complete: false },
    provider: { name: null, model: null }, findings, summary: summaryFromFindings(findings), blocking: false,
    warnings: ['There are no changes in the selected Git scope; no model was called.'] };
}

