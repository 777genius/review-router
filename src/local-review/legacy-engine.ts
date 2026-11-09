import { GitReader } from '../cli/git-reader';
import { CLIReviewer } from '../cli/reviewer';
import { setupComponents } from '../setup';
import { LocalReviewOutcome, LocalReviewRunRequest, LocalReviewUsageError, summaryFromFindings } from './contracts';
import { LocalGitSnapshot } from './git-snapshot';
import { ConfigLoader } from '../config/loader';

/** Compatibility adapter only. It does not claim parity with hosted or native OCR. */
export async function runLegacyLocalReview(
  snapshot: LocalGitSnapshot, request: LocalReviewRunRequest, configFile?: string
): Promise<LocalReviewOutcome> {
  if (request.preview) throw new LocalReviewUsageError('Preview mode is supported only by native OCR.');
  if (request.provider || request.model) {
    throw new LocalReviewUsageError('Legacy engine providers come from existing ReviewRouter config / REVIEW_PROVIDERS.');
  }
  if (request.includeUntracked) {
    throw new LocalReviewUsageError('Legacy engine does not safely support untracked file review.');
  }
  const reader = new GitReader();
  const pr = snapshot.scope.kind === 'worktree'
    ? await reader.getUncommittedChanges()
    : snapshot.scope.kind === 'branch'
      ? await reader.getBranchChanges(snapshot.base!, snapshot.head!)
      : await reader.getCommitChanges(snapshot.head!);
  if (pr.files.length === 0) {
    const findings: LocalReviewOutcome['findings'] = [];
    return { schemaVersion: 1, engine: { id: 'legacy', version: null },
      status: snapshot.changedFiles > 0 ? 'partial' : 'skipped',
      input: { scope: snapshot.scope.kind, base: snapshot.base, head: snapshot.head, snapshotDigest: snapshot.digest },
      coverage: { selected: snapshot.changedFiles, reviewed: 0, omitted: [], complete: false },
      provider: { name: null, model: null }, findings, summary: summaryFromFindings(findings), blocking: false,
      warnings: [snapshot.changedFiles > 0
        ? 'Legacy Git diff parser omitted changed files; no clean result is established.'
        : 'No eligible tracked changes for the legacy engine.'] };
  }
  const config = configFile ? ConfigLoader.loadFromPath(configFile) : undefined;
  const components = await setupComponents({ cliMode: true,
    ...(request.dryRun ? { dryRun: true } : {}),
    ...(config ? { config } : {}),
  });
  try {
    const review = await new CLIReviewer(components).review(pr);
    const findings = review.findings.map(f => ({
      path: f.file, line: f.startLine ?? f.line, endLine: f.endLine ?? f.line,
      severity: f.severity, title: f.title, message: f.message,
      ...(f.suggestion ? { suggestion: f.suggestion } : {}),
    }));
    const summary = summaryFromFindings(findings);
    const coverage = review.coverage;
    const reviewed = coverage?.files.filter(f => f.status === 'full' || f.status === 'compacted').length ?? 0;
    const selected = coverage?.totalFiles ?? snapshot.changedFiles;
    // buildReviewCoverage.complete does not by itself reject metadata-only or
    // skipped files; the legacy Git diff parser also has its own file cap.
    const complete = coverage?.complete === true && reviewed === selected &&
      selected === snapshot.changedFiles && pr.files.length === snapshot.changedFiles &&
      review.metrics.providersSuccess > 0 && review.metrics.providersFailed === 0;
    return { schemaVersion: 1, engine: { id: 'legacy', version: null },
      status: complete ? 'complete' : 'partial',
      input: { scope: snapshot.scope.kind, base: snapshot.base, head: snapshot.head, snapshotDigest: snapshot.digest },
      coverage: { selected, reviewed,
        omitted: coverage?.files.filter(f => f.status === 'unreviewed' || f.status === 'skipped').map(f => f.path) ?? [], complete },
      provider: { name: null, model: null }, findings, summary,
      blocking: summary.major > 0 || summary.critical > 0 || review.actionItems.length > 0,
      warnings: complete ? [] : ['Legacy review does not provide verified complete provider/coverage evidence.'],
    };
  } finally {
    components.costTracker.reset();
  }
}

